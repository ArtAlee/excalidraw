import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

export class TelegramAuthError extends Error {
  constructor(code, details) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export const token = () => randomBytes(32).toString("base64url");
export const digest = (value) =>
  createHash("sha256").update(value).digest("base64url");
export const issuer = "https://oauth.telegram.org";

export async function verifyTelegramToken(
  jwt,
  clientId,
  nonce,
  fetcher = fetch,
) {
  if (typeof jwt !== "string" || jwt.length > 20000) {
    throw new TelegramAuthError("invalid_token");
  }
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new TelegramAuthError("invalid_token");
  }
  const [headerPart, payloadPart, signature] = parts;
  const header = JSON.parse(Buffer.from(headerPart, "base64url"));
  const claims = JSON.parse(Buffer.from(payloadPart, "base64url"));
  // Keep BotFather's default signing algorithm: RS256.
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new TelegramAuthError("unsupported_algorithm");
  }
  const response = await fetcher(`${issuer}/.well-known/jwks.json`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new TelegramAuthError("keys_unavailable");
  }
  const { keys } = await response.json();
  const key = keys.find(
    (item) =>
      item.kid === header.kid &&
      item.kty === "RSA" &&
      (!item.use || item.use === "sig") &&
      (!item.alg || item.alg === "RS256"),
  );
  if (
    !key ||
    !verify(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    )
  ) {
    throw new TelegramAuthError("invalid_signature");
  }
  const now = Math.floor(Date.now() / 1000);
  // Telegram's live OIDC discovery advertises a public `sub` claim; some
  // token variants also include `id`. Never replace a present but invalid ID.
  const identity = Object.hasOwn(claims, "id") ? claims.id : claims.sub;
  const userId =
    typeof identity === "number" &&
    Number.isSafeInteger(identity) &&
    identity > 0
      ? String(identity)
      : typeof identity === "string" &&
        /^[1-9]\d*$/.test(identity) &&
        Number.isSafeInteger(Number(identity))
      ? identity
      : null;
  const checks = [
    [claims.iss === issuer, "issuer_mismatch"],
    [claims.aud === clientId, "audience_mismatch"],
    [typeof claims.exp === "number" && claims.exp > now, "token_expired"],
    [
      typeof claims.iat === "number" &&
        claims.iat <= now + 60 &&
        claims.iat >= now - 600,
      "token_age_invalid",
    ],
    [claims.nonce === nonce, "nonce_mismatch"],
    [userId !== null, "user_id_invalid"],
  ];
  for (const [valid, code] of checks) {
    if (!valid) {
      throw new TelegramAuthError(
        code,
        code === "user_id_invalid"
          ? {
              idType: typeof claims.id,
              subjectType: typeof claims.sub,
              subjectIsDecimal:
                typeof claims.sub === "string" && /^[1-9]\d*$/.test(claims.sub),
            }
          : undefined,
      );
    }
  }
  return {
    id: userId,
    name: String(claims.name || claims.preferred_username || claims.id),
  };
}

export const googleIssuer = "https://accounts.google.com";
export const normalizeEmail = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

export async function verifyGoogleToken(jwt, clientId, nonce, fetcher = fetch) {
  const invalid = (code) => {
    throw new TelegramAuthError(code);
  };
  if (typeof jwt !== "string" || jwt.length > 20000) invalid("invalid_token");
  const parts = jwt.split(".");
  if (parts.length !== 3) invalid("invalid_token");
  const [headerPart, payloadPart, signature] = parts;
  const header = JSON.parse(Buffer.from(headerPart, "base64url"));
  const claims = JSON.parse(Buffer.from(payloadPart, "base64url"));
  if (header.alg !== "RS256" || typeof header.kid !== "string")
    invalid("unsupported_algorithm");
  const response = await fetcher("https://www.googleapis.com/oauth2/v3/certs", {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) invalid("keys_unavailable");
  const { keys } = await response.json();
  const key = keys.find(
    (item) =>
      item.kid === header.kid &&
      item.kty === "RSA" &&
      (!item.use || item.use === "sig") &&
      (!item.alg || item.alg === "RS256"),
  );
  if (
    !key ||
    !verify(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    )
  )
    invalid("invalid_signature");
  const now = Math.floor(Date.now() / 1000);
  if (![googleIssuer, "accounts.google.com"].includes(claims.iss))
    invalid("issuer_mismatch");
  if (claims.aud !== clientId || (claims.azp && claims.azp !== clientId))
    invalid("audience_mismatch");
  if (!Number.isFinite(claims.exp) || claims.exp <= now)
    invalid("token_expired");
  if (
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 60 ||
    claims.iat < now - 600
  )
    invalid("token_age_invalid");
  if (claims.nonce !== nonce) invalid("nonce_mismatch");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255)
    invalid("user_id_invalid");
  const email = normalizeEmail(claims.email);
  // Gmail and managed Workspace domains are authoritative Google identities.
  if (
    claims.email_verified !== true ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    (!email.endsWith("@gmail.com") &&
      !(typeof claims.hd === "string" && claims.hd))
  )
    invalid("email_invalid");
  return {
    id: `google:${claims.sub}`,
    name: String(claims.name || email),
    email,
  };
}
