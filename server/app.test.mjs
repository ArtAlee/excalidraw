import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer } from "./app.mjs";
import {
  issuer,
  googleIssuer,
  verifyGoogleToken,
  verifyTelegramToken,
} from "./auth.mjs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "test-key",
  use: "sig",
  alg: "RS256",
};
const jwt = (overrides = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: "bot-id",
      id: 12345,
      name: "Owner",
      iat: now,
      exp: now + 300,
      nonce: "test-nonce",
      ...overrides,
    }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign(
    "RSA-SHA256",
    Buffer.from(input),
    privateKey,
  ).toString("base64url")}`;
};
const keyFetcher = async () => Response.json({ keys: [jwk] });
const origin = "http://localhost:3000";
const emptyScene = { elements: [], appState: {}, files: {} };
async function fixture(
  t,
  database = ":memory:",
  {
    tokenError,
    subjectOnly,
    google = false,
    allowedEmails = ["Owner@gmail.com"],
    allowedIds = ["12345"],
    legacyOwnerId,
  } = {},
) {
  const authEvents = [];
  let claims = {};
  const fetcher = async (url, options) => {
    if (url.endsWith("jwks.json") || url.endsWith("/certs")) {
      return keyFetcher();
    }
    assert.equal(
      url,
      google ? "https://oauth2.googleapis.com/token" : `${issuer}/token`,
    );
    if (google) {
      assert.equal(options.body.get("client_secret"), "google-secret");
      assert.equal(
        options.body.get("redirect_uri"),
        `${origin}/api/auth/google/callback`,
      );
    } else
      assert.equal(
        options.headers.Authorization,
        `Basic ${Buffer.from("bot-id:secret").toString("base64")}`,
      );
    return Response.json(
      tokenError
        ? { error: tokenError }
        : {
            id_token: jwt(
              google
                ? {
                    iss: googleIssuer,
                    aud: "google-client",
                    sub: "google-owner",
                    email: "owner@gmail.com",
                    email_verified: true,
                    ...claims,
                  }
                : subjectOnly
                ? { ...claims, sub: String(claims.id ?? 12345), id: undefined }
                : claims,
            ),
          },
    );
  };
  const config = {
    origin,
    ...(google
      ? {
          googleClientId: "google-client",
          googleClientSecret: "google-secret",
          googleAllowedEmails: allowedEmails,
        }
      : {
          clientId: "bot-id",
          clientSecret: "secret",
          allowlist: allowedIds,
        }),
    database,
    legacyOwnerId,
    staticDir: "/nonexistent",
  };
  const server = createWorkspaceServer(config, {
    fetcher,
    onAuthEvent: (event) => authEvents.push(event),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    if (!server.listening) {
      return;
    }
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  };
  t.after(close);
  const request = (
    path,
    { method = "GET", cookie, body, requestOrigin = origin } = {},
  ) =>
    fetch(`${base}/api${path}`, {
      method,
      redirect: "manual",
      headers: {
        Origin: requestOrigin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const begin = async () => {
    const response = await request(google ? "/auth/google" : "/auth/telegram");
    assert.equal(response.status, 302);
    const url = new URL(response.headers.get("location"));
    assert.equal(url.origin, google ? googleIssuer : issuer);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    claims = { nonce: url.searchParams.get("nonce") };
    return {
      cookie: response.headers.getSetCookie()[0].split(";")[0],
      state: url.searchParams.get("state"),
    };
  };
  const login = async (id = 12345, overrides = {}) => {
    const attempt = await begin();
    claims = { ...claims, id, ...overrides };
    const response = await request(
      `${google ? "/auth/google/callback" : "/auth/callback"}?code=test&state=${
        attempt.state
      }`,
      { cookie: attempt.cookie },
    );
    const session = response.headers
      .getSetCookie()
      .find((item) => item.startsWith("workspace_session="));
    return { response, cookie: session?.split(";")[0] };
  };
  const create = async (cookie, kind, body) => {
    const response = await request(`/${kind}`, {
      method: "POST",
      cookie,
      body,
    });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).id;
  };
  return { request, begin, login, create, close, server, authEvents };
}

test("validates Telegram signature, nonce, issuer, audience, expiry and numeric user ID", async () => {
  assert.equal(
    (await verifyTelegramToken(jwt(), "bot-id", "test-nonce", keyFetcher)).id,
    "12345",
  );
  assert.equal(
    (
      await verifyTelegramToken(
        jwt({ id: "12345" }),
        "bot-id",
        "test-nonce",
        keyFetcher,
      )
    ).id,
    "12345",
  );
  for (const override of [
    { iss: "https://attacker.test" },
    { aud: "other" },
    { exp: 1 },
    { nonce: "wrong" },
    { id: "012345" },
    { id: "-12345" },
    { id: "9007199254740992" },
    { iat: 1 },
    { id: -1 },
  ]) {
    await assert.rejects(
      verifyTelegramToken(jwt(override), "bot-id", "test-nonce", keyFetcher),
    );
  }
  const parts = jwt().split(".");
  parts[1] = Buffer.from(JSON.stringify({ id: 999 })).toString("base64url");
  await assert.rejects(
    verifyTelegramToken(parts.join("."), "bot-id", "test-nonce", keyFetcher),
  );
});

test("login is browser-bound, single-use, allowlisted and logout invalidates session", async (t) => {
  const f = await fixture(t);
  const attempt = await f.begin();
  let response = await f.request(
    `/auth/callback?code=x&state=${attempt.state}`,
  );
  assert.equal(response.headers.get("location"), "/?login=failed");
  response = await f.request(`/auth/callback?code=x&state=${attempt.state}`, {
    cookie: attempt.cookie,
  });
  assert.equal(response.headers.get("location"), "/");
  response = await f.request(`/auth/callback?code=x&state=${attempt.state}`, {
    cookie: attempt.cookie,
  });
  assert.equal(response.headers.get("location"), "/?login=failed");
  const denied = await f.login(99999);
  assert.equal(denied.response.headers.get("location"), "/?login=denied");
  assert.equal(denied.cookie, undefined);
  const { cookie, response: loginResponse } = await f.login();
  assert.match(
    loginResponse.headers.getSetCookie().join(";"),
    /HttpOnly; SameSite=Lax/,
  );
  assert.equal((await f.request("/me", { cookie })).status, 200);
  assert.equal(
    (await f.request("/logout", { cookie, method: "POST" })).status,
    200,
  );
  assert.equal((await f.request("/me", { cookie })).status, 401);
});

test("private API requires login and rejects cross-origin mutations", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/workspace")).status, 401);
  assert.equal(
    (
      await f.request("/projects", {
        method: "POST",
        body: { name: "Private" },
      })
    ).status,
    401,
  );
  const { cookie } = await f.login();
  assert.equal(
    (
      await f.request("/projects", {
        cookie,
        method: "POST",
        body: { name: "Bad" },
        requestOrigin: "https://attacker.test",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/projects", {
        cookie,
        method: "POST",
        body: { name: " " },
      })
    ).status,
    400,
  );
});

test("stores scenes and images, detects stale writes and enforces project-folder membership", async (t) => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  const project = await f.create(cookie, "projects", { name: "Project" });
  const otherProject = await f.create(cookie, "projects", { name: "Other" });
  const folder = await f.create(cookie, "folders", {
    name: "Folder",
    project_id: project,
  });
  assert.equal(
    (
      await f.request("/boards", {
        cookie,
        method: "POST",
        body: { name: "Invalid", project_id: otherProject, folder_id: folder },
      })
    ).status,
    400,
  );
  const id = await f.create(cookie, "boards", {
    name: "Board",
    project_id: project,
    folder_id: folder,
  });
  const scene = {
    elements: [{ id: "image", type: "image", fileId: "file" }],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {
      file: {
        id: "file",
        dataURL: "data:image/png;base64,aGVsbG8=",
        mimeType: "image/png",
        created: 1,
      },
    },
  };
  const save = await f.request(`/boards/${id}`, {
    cookie,
    method: "PUT",
    body: { revision: 0, scene },
  });
  assert.equal(save.status, 200);
  assert.equal((await save.json()).revision, 1);
  assert.deepEqual(
    (await (await f.request(`/boards/${id}`, { cookie })).json()).scene,
    scene,
  );
  assert.equal(
    (
      await f.request(`/boards/${id}`, {
        cookie,
        method: "PUT",
        body: { revision: 0, scene: emptyScene },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request(`/boards/${id}`, {
        cookie,
        method: "PUT",
        body: { revision: 1, scene: {} },
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request(`/boards/${id}`, { cookie })).headers.get("cache-control"),
    "no-store",
  );
  await f.request(`/folders/${folder}`, { cookie, method: "DELETE" });
  assert.equal((await f.request(`/boards/${id}`, { cookie })).status, 404);
});

test("public links are read-only, exportable, rotated, revocable and removed on project deletion", async (t) => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  const project = await f.create(cookie, "projects", {
    name: "Private project",
  });
  const id = await f.create(cookie, "boards", {
    name: "Shared board",
    project_id: project,
  });
  assert.equal((await f.request(`/boards/${id}`)).status, 401);
  const publish = async () => {
    const response = await f.request(`/boards/${id}/share`, {
      cookie,
      method: "POST",
    });
    return new URL((await response.json()).url).pathname.replace(
      "/s/",
      "/public/",
    );
  };
  const link = await publish();
  let response = await f.request(link);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).name, "Shared board");
  assert.equal(
    (await f.request(link, { method: "PUT", body: {} })).status,
    405,
  );
  await f.request(`/boards/${id}`, {
    cookie,
    method: "PUT",
    body: {
      revision: 0,
      scene: { ...emptyScene, elements: [{ id: "rect", type: "rectangle" }] },
    },
  });
  assert.equal((await (await f.request(link)).json()).revision, 1);
  const rotated = await publish();
  assert.equal((await f.request(link)).status, 404);
  assert.equal((await f.request(rotated)).status, 200);
  await f.request(`/boards/${id}/share`, { cookie, method: "DELETE" });
  assert.equal((await f.request(rotated)).status, 404);
  const finalLink = await publish();
  await f.request(`/projects/${project}`, { cookie, method: "DELETE" });
  assert.equal((await f.request(finalLink)).status, 404);
});

test("database survives a server restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, "data.sqlite");
  const first = await fixture(t, database);
  const { cookie } = await first.login();
  const project = await first.create(cookie, "projects", { name: "Persisted" });
  const id = await first.create(cookie, "boards", {
    name: "Persistent board",
    project_id: project,
  });
  await first.request(`/boards/${id}`, {
    cookie,
    method: "PUT",
    body: { scene: emptyScene, revision: 0 },
  });
  await first.close();
  const second = await fixture(t, database);
  const response = await second.request(`/boards/${id}`, { cookie });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 1);
});

test("classifies Telegram HTTP 200 OAuth errors without logging credentials or granting a session", async (t) => {
  const f = await fixture(t, ":memory:", { tokenError: "invalid_grant" });
  const { response, cookie } = await f.login();
  assert.equal(response.headers.get("location"), "/?login=failed");
  assert.equal(cookie, undefined);
  assert.deepEqual(f.authEvents, [
    { event: "token_exchange_failed", status: 200, reason: "invalid_grant" },
  ]);
});

test("accepts Telegram public subject when id is absent, preserves explicit id and rejects malformed subjects", async () => {
  assert.equal(
    (
      await verifyTelegramToken(
        jwt({ id: undefined, sub: "12345" }),
        "bot-id",
        "test-nonce",
        keyFetcher,
      )
    ).id,
    "12345",
  );
  assert.equal(
    (
      await verifyTelegramToken(
        jwt({ id: 99999, sub: "12345" }),
        "bot-id",
        "test-nonce",
        keyFetcher,
      )
    ).id,
    "99999",
  );
  for (const sub of [
    undefined,
    "",
    "012345",
    "-12345",
    "12.3",
    "9007199254740992",
  ]) {
    await assert.rejects(
      verifyTelegramToken(
        jwt({ id: undefined, sub }),
        "bot-id",
        "test-nonce",
        keyFetcher,
      ),
    );
  }
  await assert.rejects(
    verifyTelegramToken(
      jwt({ id: "invalid", sub: "12345" }),
      "bot-id",
      "test-nonce",
      keyFetcher,
    ),
  );
});

test("authenticates a sub-only owner token and still rejects other Telegram users", async (t) => {
  const f = await fixture(t, ":memory:", { subjectOnly: true });
  const owner = await f.login();
  assert.equal(owner.response.headers.get("location"), "/");
  assert.equal((await f.request("/me", { cookie: owner.cookie })).status, 200);
  const stranger = await f.login(99999);
  assert.equal(stranger.response.headers.get("location"), "/?login=denied");
  assert.equal(stranger.cookie, undefined);
});

test("owner and anonymous guests merge concurrent drawings, images and deletions", async (t) => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  const project = await f.create(cookie, "projects", { name: "Project" });
  const id = await f.create(cookie, "boards", {
    name: "Session",
    project_id: project,
  });
  const publish = await f.request(`/boards/${id}/session`, {
    cookie,
    method: "POST",
  });
  const link = new URL((await publish.json()).url).pathname.replace(
    "/c/",
    "/session/",
  );
  const ownerPath = `/boards/${id}/sync`;
  const rect = {
    id: "rect",
    type: "rectangle",
    version: 1,
    versionNonce: 10,
    index: "a0",
  };
  const image = {
    id: "image",
    type: "image",
    version: 1,
    versionNonce: 20,
    index: "a1",
    fileId: "file",
  };
  const file = { id: "file", dataURL: "data:image/png;base64,aGVsbG8=" };
  const responses = await Promise.all([
    f.request(ownerPath, {
      cookie,
      method: "PUT",
      body: { scene: { ...emptyScene, elements: [rect] } },
    }),
    f.request(link, {
      method: "PUT",
      body: { scene: { ...emptyScene, elements: [image], files: { file } } },
    }),
  ]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  );
  let board = await (await f.request(link)).json();
  assert.deepEqual(
    board.scene.elements.map((e) => e.id),
    ["rect", "image"],
  );
  assert.deepEqual(board.scene.files.file, file);
  assert.deepEqual(
    (await (await f.request(ownerPath, { cookie })).json()).scene,
    board.scene,
  );
  const unchanged = await (
    await f.request(`${link}?revision=${board.revision}`)
  ).json();
  assert.equal(unchanged.scene, undefined);
  const deleted = { ...rect, version: 2, versionNonce: 30, isDeleted: true };
  await f.request(link, {
    method: "PUT",
    body: { scene: { ...emptyScene, elements: [deleted] } },
  });
  // A stale participant saves their old snapshot after another deletes an element.
  await f.request(ownerPath, {
    cookie,
    method: "PUT",
    body: { scene: { ...emptyScene, elements: [rect] } },
  });
  board = await (await f.request(link)).json();
  assert.equal(
    board.scene.elements.find((e) => e.id === "rect").isDeleted,
    true,
  );
  assert.equal(board.scene.elements.length, 2);
  assert.deepEqual(board.scene.files.file, file);
  assert.equal(
    (
      await f.request(link, {
        method: "PUT",
        requestOrigin: "https://evil.example",
        body: { scene: emptyScene },
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request(ownerPath, { method: "PUT", body: { scene: emptyScene } }))
      .status,
    401,
  );
  assert.equal((await f.request("/workspace")).status, 401);
  await f.request(`/boards/${id}/session`, { cookie, method: "POST" });
  assert.equal(
    (await f.request(link, { method: "PUT", body: { scene: emptyScene } }))
      .status,
    404,
  );
});

test("sessions stream scene changes and cursors; read-only links cannot join or write; revocations are independent", async (t) => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  const project = await f.create(cookie, "projects", { name: "Live" });
  const id = await f.create(cookie, "boards", {
    name: "Board",
    project_id: project,
  });
  const publish = async (mode) => {
    const response = await f.request(`/boards/${id}/${mode}`, {
      cookie,
      method: "POST",
    });
    return new URL((await response.json()).url).pathname.split("/").pop();
  };
  const sessionToken = await publish("session");
  const shareToken = await publish("share");
  const session = `/session/${sessionToken}`;
  const share = `/public/${shareToken}`;
  // Reading a public link never confers mutation or session capabilities.
  assert.equal(
    (
      await f.request(share, {
        method: "PUT",
        cookie,
        body: { scene: emptyScene },
      })
    ).status,
    405,
  );
  assert.equal((await f.request(`/session/${shareToken}`)).status, 404);
  assert.equal((await f.request(`/public/${sessionToken}`)).status, 404);
  const exported = await f.request(`${share}/export`);
  assert.equal(
    exported.headers.get("access-control-allow-origin"),
    "https://excalidraw.com",
  );
  assert.equal((await exported.json()).type, "excalidraw");

  const connect = async (path, options) => {
    const response = await f.request(`${path}/live`, options);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader();
    t.after(() => reader.cancel().catch(() => {}));
    let buffer = "";
    const decoder = new TextDecoder();
    return async (wanted) => {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith(`event: ${wanted}\n`))
            return JSON.parse(frame.split("\ndata: ")[1]);
        } else {
          const { done, value } = await reader.read();
          assert.equal(done, false, `Stream closed before ${wanted}`);
          buffer += decoder.decode(value, { stream: true });
        }
      }
    };
  };
  const ownerEvent = await connect(`/boards/${id}`, { cookie });
  const guestEvent = await connect(session);
  assert.equal((await ownerEvent("ready")).active, true);
  const guest = await guestEvent("ready");
  const pointer = { x: 100, y: -50, tool: "pointer" };
  assert.equal(
    (
      await f.request(`${session}/pointer`, {
        method: "POST",
        body: { id: guest.id, pointer, button: "down" },
      })
    ).status,
    200,
  );
  assert.deepEqual(await ownerEvent("pointer"), {
    id: guest.id,
    pointer,
    button: "down",
  });
  await f.request(session, {
    method: "PUT",
    body: {
      scene: {
        ...emptyScene,
        elements: [{ id: "rect", type: "rectangle", version: 1 }],
      },
    },
  });
  assert.equal((await ownerEvent("scene")).revision, 1);
  const copy = await (await f.request(`${share}/export`)).json();
  assert.equal(copy.elements[0].id, "rect");
  assert.equal(copy.collaborators, undefined);
  await f.request(`/boards/${id}/share`, { cookie, method: "DELETE" });
  assert.equal((await f.request(share)).status, 404);
  assert.equal((await f.request(session)).status, 200);
  const nextShare = await publish("share");
  await f.request(`/boards/${id}/session`, { cookie, method: "DELETE" });
  await guestEvent("revoked");
  assert.equal(
    (await f.request(session, { method: "PUT", body: { scene: emptyScene } }))
      .status,
    404,
  );
  assert.equal((await f.request(`/public/${nextShare}`)).status, 200);
});

test("Google token requires signature, verified authoritative email and OIDC claims", async () => {
  const googleToken = (overrides = {}) =>
    jwt({
      iss: googleIssuer,
      aud: "google-client",
      sub: "subject",
      email: "Owner@Gmail.com",
      email_verified: true,
      ...overrides,
    });
  const verify = (overrides = {}) =>
    verifyGoogleToken(
      googleToken(overrides),
      "google-client",
      "test-nonce",
      keyFetcher,
    );
  assert.deepEqual(await verify(), {
    id: "google:subject",
    name: "Owner",
    email: "owner@gmail.com",
  });
  assert.equal(
    (await verify({ iss: "accounts.google.com" })).email,
    "owner@gmail.com",
  );
  assert.equal(
    (await verify({ email: "user@example.com", hd: "example.com" })).email,
    "user@example.com",
  );
  for (const overrides of [
    { email_verified: false },
    { email_verified: "true" },
    { email: "user@example.com" },
    { email: "" },
    { sub: "" },
    { nonce: "wrong" },
    { aud: "wrong" },
    { azp: "wrong" },
    { iss: issuer },
    { exp: 0 },
    { iat: 0 },
  ]) {
    await assert.rejects(verify(overrides));
  }
  const parts = googleToken().split(".");
  parts[1] = Buffer.from(
    JSON.stringify({ email: "attacker@gmail.com" }),
  ).toString("base64url");
  await assert.rejects(
    verifyGoogleToken(
      parts.join("."),
      "google-client",
      "test-nonce",
      keyFetcher,
    ),
  );
});

test("Google-only login allowlists email, binds provider, consumes state, and logs out", async (t) => {
  const f = await fixture(t, ":memory:", { google: true });
  assert.deepEqual(await (await f.request("/auth/providers")).json(), {
    google: true,
    telegram: false,
  });
  assert.equal((await f.request("/auth/telegram")).status, 404);
  const denied = await f.login(12345, { email: "other@gmail.com" });
  assert.equal(denied.response.headers.get("location"), "/?login=denied");
  assert.equal(denied.cookie, undefined);
  const unverified = await f.login(12345, { email_verified: false });
  assert.equal(unverified.response.headers.get("location"), "/?login=failed");
  const wrongProvider = await f.begin();
  assert.equal(
    (
      await f.request(`/auth/callback?code=test&state=${wrongProvider.state}`, {
        cookie: wrongProvider.cookie,
      })
    ).headers.get("location"),
    "/?login=failed",
  );
  const attempt = await f.begin();
  const callback = `/auth/google/callback?code=test&state=${attempt.state}`;
  assert.equal(
    (await f.request(callback, { cookie: attempt.cookie })).headers.get(
      "location",
    ),
    "/",
  );
  assert.equal(
    (await f.request(callback, { cookie: attempt.cookie })).headers.get(
      "location",
    ),
    "/?login=failed",
  );
  const { cookie } = await f.login();
  assert.ok(cookie);
  assert.equal(
    (await (await f.request("/me", { cookie })).json()).email,
    "owner@gmail.com",
  );
  assert.equal((await f.request("/workspace", { cookie })).status, 200);
  await f.request("/logout", { method: "POST", cookie });
  assert.equal((await f.request("/me", { cookie })).status, 401);
});

test("removing Google email revokes an existing persisted session", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-google-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, "workspace.sqlite");
  const first = await fixture(t, database, { google: true });
  const { cookie } = await first.login();
  await first.close();
  const second = await fixture(t, database, {
    google: true,
    allowedEmails: ["another@gmail.com"],
  });
  assert.equal((await second.request("/me", { cookie })).status, 401);
});

test("accounts have isolated workspaces and cannot access another owner's resources", async (t) => {
  for (const google of [false, true]) {
    const f = await fixture(t, ":memory:", {
      google,
      allowedIds: ["12345", "99999"],
      allowedEmails: ["owner@gmail.com", "other@gmail.com"],
    });
    const owner = await f.login();
    const other = await f.login(
      99999,
      google ? { sub: "other", email: "other@gmail.com" } : {},
    );
    assert.ok(other.cookie);
    const project = await f.create(owner.cookie, "projects", { name: "Owner" });
    const folder = await f.create(owner.cookie, "folders", {
      name: "Folder",
      project_id: project,
    });
    const board = await f.create(owner.cookie, "boards", {
      name: "Private",
      project_id: project,
      folder_id: folder,
    });
    const otherProject = await f.create(other.cookie, "projects", {
      name: "Other",
    });
    const otherBoard = await f.create(other.cookie, "boards", {
      name: "Other board",
      project_id: otherProject,
    });
    const workspace = await (
      await f.request("/workspace", { cookie: other.cookie })
    ).json();
    assert.deepEqual(
      workspace.projects.map((p) => p.id),
      [otherProject],
    );
    assert.deepEqual(workspace.folders, []);
    assert.deepEqual(
      workspace.boards.map((b) => b.id),
      [otherBoard],
    );
    for (const path of [
      `/projects/${project}`,
      `/folders/${folder}`,
      `/boards/${board}`,
    ]) {
      for (const method of ["GET", "PATCH", "DELETE", "PUT"]) {
        const response = await f.request(path, {
          cookie: other.cookie,
          method,
          body:
            method === "PATCH"
              ? { name: "Stolen" }
              : method === "PUT"
              ? { revision: 0, scene: emptyScene }
              : undefined,
        });
        assert.equal(response.status, 404, `${method} ${path}`);
      }
    }
    for (const suffix of ["/share", "/session"]) {
      for (const method of ["POST", "DELETE"]) {
        assert.equal(
          (
            await f.request(`/boards/${board}${suffix}`, {
              cookie: other.cookie,
              method,
            })
          ).status,
          404,
        );
      }
    }
    for (const [suffix, method, body] of [
      ["/sync", "GET"],
      ["/sync", "PUT", { scene: emptyScene }],
      ["/live", "GET"],
      ["/pointer", "POST", {}],
    ]) {
      assert.equal(
        (
          await f.request(`/boards/${board}${suffix}`, {
            cookie: other.cookie,
            method,
            body,
          })
        ).status,
        404,
      );
    }
    for (const kind of ["folders", "boards"]) {
      assert.equal(
        (
          await f.request(`/${kind}`, {
            cookie: other.cookie,
            method: "POST",
            body: { name: "Injected", project_id: project },
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await f.request("/boards", {
          cookie: other.cookie,
          method: "POST",
          body: {
            name: "Injected",
            project_id: otherProject,
            folder_id: folder,
          },
        })
      ).status,
      400,
    );
    // An owner-created link still intentionally grants access to other accounts.
    for (const [suffix, prefix, apiPrefix] of [
      ["share", "/s/", "/public/"],
      ["session", "/c/", "/session/"],
    ]) {
      const published = await f.request(`/boards/${board}/${suffix}`, {
        cookie: owner.cookie,
        method: "POST",
      });
      const link = new URL((await published.json()).url).pathname.replace(
        prefix,
        apiPrefix,
      );
      assert.equal(
        (await f.request(link, { cookie: other.cookie })).status,
        200,
      );
      assert.equal(
        (await f.request(`/boards/${board}`, { cookie: other.cookie })).status,
        404,
      );
    }
    const sameOwner = await f.login();
    assert.equal(
      (await f.request(`/boards/${board}`, { cookie: sameOwner.cookie }))
        .status,
      200,
    );
    assert.equal(
      (await f.request(`/boards/${board}`, { cookie: owner.cookie })).status,
      200,
    );
    await f.close();
  }
});

test("legacy projects stay private until explicitly assigned and ownership survives restarts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-legacy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, "data.sqlite");
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  const project = "p".repeat(43);
  db.prepare("INSERT INTO projects VALUES (?, ?)").run(project, "Legacy");
  db.close();
  const options = { allowedIds: ["12345", "99999"] };
  const first = await fixture(t, database, options);
  const owner = await first.login();
  const other = await first.login(99999);
  for (const cookie of [owner.cookie, other.cookie]) {
    assert.deepEqual(
      (await (await first.request("/workspace", { cookie })).json()).projects,
      [],
    );
    assert.equal(
      (
        await first.request(`/projects/${project}`, {
          cookie,
          method: "DELETE",
        })
      ).status,
      404,
    );
  }
  await first.close();
  const second = await fixture(t, database, {
    ...options,
    legacyOwnerId: "12345",
  });
  const board = await second.create(owner.cookie, "boards", {
    name: "Preserved",
    project_id: project,
  });
  assert.deepEqual(
    (
      await (
        await second.request("/workspace", { cookie: owner.cookie })
      ).json()
    ).projects,
    [{ id: project, name: "Legacy" }],
  );
  assert.equal(
    (await second.request(`/boards/${board}`, { cookie: other.cookie })).status,
    404,
  );
  await second.close();
  // Changing the migration setting never transfers already owned projects.
  const third = await fixture(t, database, {
    ...options,
    legacyOwnerId: "99999",
  });
  assert.equal(
    (await third.request(`/boards/${board}`, { cookie: owner.cookie })).status,
    200,
  );
  assert.equal(
    (await third.request(`/boards/${board}`, { cookie: other.cookie })).status,
    404,
  );
});
