import { mergeElements } from "../excalidraw-app/workspace/mergeElements.mjs";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import {
  digest,
  issuer,
  token,
  verifyTelegramToken,
  TelegramAuthError,
  verifyGoogleToken,
  normalizeEmail,
} from "./auth.mjs";

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};
const cookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie || "").split(";").map((part) => part.trim().split("=")),
  );
const nameOf = (value) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 160) {
    fail(400, "Название должно содержать от 1 до 160 символов");
  }
  return value.trim();
};
async function bodyOf(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    fail(415, "Ожидается JSON");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) {
      fail(413, "Доска превышает 25 МБ");
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      fail(400, "Ожидается JSON объект");
    }
    return body;
  } catch {
    fail(400, "Некорректный JSON");
  }
}
function validateScene(scene) {
  if (
    !scene ||
    !Array.isArray(scene.elements) ||
    !scene.appState ||
    typeof scene.appState !== "object" ||
    Array.isArray(scene.appState) ||
    !scene.files ||
    typeof scene.files !== "object" ||
    Array.isArray(scene.files)
  ) {
    fail(400, "Некорректная доска");
  }
  if (
    scene.elements.length > 100000 ||
    scene.elements.some(
      (el) => !el || typeof el.id !== "string" || typeof el.type !== "string",
    )
  ) {
    fail(400, "Некорректные элементы");
  }
  for (const [id, file] of Object.entries(scene.files)) {
    if (
      !file ||
      file.id !== id ||
      typeof file.dataURL !== "string" ||
      !/^data:image\/(png|jpeg|gif|webp|svg\+xml|avif|bmp|x-icon|jfif);base64,/.test(
        file.dataURL,
      )
    ) {
      fail(400, "Некорректное изображение");
    }
  }
  return JSON.stringify({
    elements: scene.elements,
    appState: scene.appState,
    files: scene.files,
  });
}

export function createWorkspaceServer(
  config,
  {
    fetcher = fetch,
    onAuthEvent = (event) =>
      console.info("workspace-auth", JSON.stringify(event)),
  } = {},
) {
  const origin = new URL(config.origin).origin;
  const secure = origin.startsWith("https:");
  const allowlist = new Set(config.allowlist || []);
  const googleAllowlist = new Set(
    (config.googleAllowedEmails || []).map(normalizeEmail),
  );
  const telegramEnabled = !!(
    config.clientId &&
    config.clientSecret &&
    allowlist.size
  );
  const googleEnabled = !!(
    config.googleClientId &&
    config.googleClientSecret &&
    googleAllowlist.size
  );
  if (
    (allowlist.size &&
      (!telegramEnabled ||
        [...allowlist].some((id) => !/^[1-9]\d*$/.test(id)))) ||
    ((config.clientId || config.clientSecret) && !telegramEnabled) ||
    ((config.googleClientId ||
      config.googleClientSecret ||
      googleAllowlist.size) &&
      !googleEnabled) ||
    [...googleAllowlist].some(
      (email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    ) ||
    (!telegramEnabled && !googleEnabled)
  ) {
    throw new Error(
      "Configure Telegram credentials + TELEGRAM_ALLOWED_IDS and/or Google credentials + GOOGLE_ALLOWED_EMAILS",
    );
  }
  if (
    !secure &&
    !["localhost", "127.0.0.1"].includes(new URL(origin).hostname)
  ) {
    throw new Error("APP_ORIGIN must use HTTPS");
  }
  const db = new DatabaseSync(config.database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE, name TEXT NOT NULL, scene TEXT NOT NULL DEFAULT '{"elements":[],"appState":{},"files":{}}', revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, share_hash TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS logins (hash TEXT PRIMARY KEY, state TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL);
    `);
  if (
    !db
      .prepare("PRAGMA table_info(boards)")
      .all()
      .some((column) => column.name === "session_hash")
  ) {
    db.exec("ALTER TABLE boards ADD COLUMN session_hash TEXT");
  }
  if (
    !db
      .prepare("PRAGMA table_info(logins)")
      .all()
      .some((column) => column.name === "provider")
  ) {
    db.exec(
      "ALTER TABLE logins ADD COLUMN provider TEXT NOT NULL DEFAULT 'telegram'",
    );
  }
  if (
    !db
      .prepare("PRAGMA table_info(sessions)")
      .all()
      .some((column) => column.name === "email")
  ) {
    db.exec("ALTER TABLE sessions ADD COLUMN email TEXT");
  }
  // Ownership lives on projects; folders and boards inherit it through project_id.
  if (
    !db
      .prepare("PRAGMA table_info(projects)")
      .all()
      .some((column) => column.name === "owner_id")
  ) {
    db.exec("ALTER TABLE projects ADD COLUMN owner_id TEXT");
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id); PRAGMA user_version=2;",
  );
  // Old shared data has no reliable owner. Only an explicit administrator choice
  // may assign it; NULL-owned projects stay stored but inaccessible to accounts.
  if (config.legacyOwnerId) {
    db.prepare("UPDATE projects SET owner_id = ? WHERE owner_id IS NULL").run(
      config.legacyOwnerId,
    );
  }
  const isAllowed = (user) =>
    user.id.startsWith("google:")
      ? googleEnabled && googleAllowlist.has(user.email)
      : telegramEnabled && allowlist.has(user.id);
  // Presence is ephemeral: it never enters SQLite or exported board files.
  const clients = new Map();
  const send = (client, event, data) => {
    if (client.res.writableLength > 1024 * 1024) {
      client.res.destroy();
      return;
    }
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = (boardId, event, data) => {
    for (const client of clients.values()) {
      if (client.boardId !== boardId) continue;
      const row = client.lookup();
      if (!row) {
        send(client, "revoked", {});
        client.res.end();
      } else {
        send(client, event, data);
      }
    }
  };
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const ownedItem = (kind, id, userId) =>
    get(
      kind === "projects"
        ? "SELECT * FROM projects WHERE id = ? AND owner_id = ?"
        : `SELECT * FROM ${kind} WHERE id = ? AND project_id IN (SELECT id FROM projects WHERE owner_id = ?)`,
      id,
      userId,
    );
  const cookie = (name, value, age) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${
      secure ? "; Secure" : ""
    }`;
  const redirect = (res, location) => {
    res.writeHead(302, { Location: location });
    res.end();
  };
  const boardMeta =
    "id, project_id, folder_id, name, revision, updated_at, (share_hash IS NOT NULL) AS shared, (session_hash IS NOT NULL) AS session_active";
  const syncBoard = async (req, res, lookup) => {
    const body = req.method === "PUT" ? await bodyOf(req) : null;
    if (body) {
      validateScene(body.scene);
    }
    // Read authorization and the latest scene AFTER the request body, since
    // access may have been revoked or another participant saved while reading.
    const row = lookup();
    if (!row) {
      fail(404, "Доступ к доске закрыт или ссылка не существует");
    }
    if (body) {
      const current = JSON.parse(row.scene);
      const scene = {
        elements: mergeElements(current.elements, body.scene.elements),
        appState: { ...current.appState, ...body.scene.appState },
        files: { ...current.files, ...body.scene.files },
      };
      const serialized = validateScene(scene);
      if (Buffer.byteLength(serialized) > 25 * 1024 * 1024) {
        fail(413, "Доска превышает 25 МБ");
      }
      if (serialized !== row.scene) {
        run(
          "UPDATE boards SET scene = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
          serialized,
          Date.now(),
          row.id,
        );
        row.scene = serialized;
        row.revision++;
        broadcast(row.id, "scene", { revision: row.revision });
      }
    }
    const revision = new URL(req.url, origin).searchParams.get("revision");
    json(res, 200, {
      name: row.name,
      revision: row.revision,
      ...(revision === String(row.revision) && !body
        ? {}
        : { scene: JSON.parse(row.scene) }),
    });
  };
  const live = async (req, res, lookup, suffix) => {
    let row = lookup();
    if (!row) fail(404, "Сеанс завершён или доска удалена");
    if (suffix === "/live" && req.method === "GET") {
      const id = token();
      const client = {
        id,
        boardId: row.id,
        res,
        lookup,
        pointer: null,
        lastPointer: 0,
      };
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      clients.set(id, client);
      send(client, "ready", { id, active: !!row.session_hash });
      for (const peer of clients.values()) {
        if (
          row.session_hash &&
          peer.boardId === row.id &&
          peer.pointer &&
          peer.lookup()
        )
          send(client, "pointer", { id: peer.id, ...peer.pointer });
      }
      const heartbeat = setInterval(() => {
        const current = lookup();
        if (!current) {
          send(client, "revoked", {});
          res.end();
        } else res.write(": heartbeat\n\n");
      }, 15000);
      res.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(id);
        broadcast(row.id, "leave", { id });
      });
      return;
    }
    if (suffix === "/pointer" && req.method === "POST") {
      const body = await bodyOf(req);
      row = lookup();
      if (!row || !row.session_hash) fail(404, "Сеанс завершён");
      const client = clients.get(body.id);
      if (!client || client.boardId !== row.id || !client.lookup())
        fail(404, "Участник отключён");
      const { pointer, button } = body;
      if (
        !pointer ||
        !Number.isFinite(pointer.x) ||
        !Number.isFinite(pointer.y) ||
        !["pointer", "laser"].includes(pointer.tool) ||
        !["up", "down"].includes(button)
      )
        fail(400, "Некорректный курсор");
      if (Date.now() - client.lastPointer >= 45) {
        client.lastPointer = Date.now();
        client.pointer = {
          pointer: { x: pointer.x, y: pointer.y, tool: pointer.tool },
          button,
        };
        broadcast(row.id, "pointer", { id: client.id, ...client.pointer });
      }
      json(res, 200, { ok: true });
      return;
    }
    fail(405, "Метод не поддерживается");
  };
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "no-store");
    try {
      const url = new URL(req.url, origin);
      const path = url.pathname;
      if (
        path.startsWith("/api/") &&
        !["GET", "HEAD"].includes(req.method) &&
        req.headers.origin !== origin
      ) {
        fail(403, "Недопустимый источник запроса");
      }
      if (path === "/api/health" && req.method === "GET") {
        json(res, 200, { ok: true });
        return;
      }
      if (path === "/api/auth/providers" && req.method === "GET") {
        json(res, 200, { telegram: telegramEnabled, google: googleEnabled });
        return;
      }
      const authProvider = path === "/api/auth/google" ? "google" : "telegram";
      const isGoogle = authProvider === "google";
      if (
        ["/api/auth/telegram", "/api/auth/google"].includes(path) &&
        req.method === "GET"
      ) {
        if (!(isGoogle ? googleEnabled : telegramEnabled))
          fail(404, "Способ входа не настроен");
        // One short-lived, browser-bound, single-use authorization attempt.
        run("DELETE FROM logins WHERE expires < ?", Date.now());
        run("DELETE FROM sessions WHERE expires < ?", Date.now());
        if (get("SELECT count(*) AS count FROM logins").count > 1000) {
          fail(429, "Повторите вход позже");
        }
        const browserToken = token();
        const state = token();
        const verifier = token();
        const nonce = token();
        run(
          "INSERT INTO logins (hash, state, verifier, nonce, expires, provider) VALUES (?, ?, ?, ?, ?, ?)",
          digest(browserToken),
          state,
          verifier,
          nonce,
          Date.now() + 600000,
          authProvider,
        );
        res.setHeader(
          "Set-Cookie",
          cookie("workspace_login", browserToken, 600),
        );
        const auth = new URL(
          isGoogle
            ? "https://accounts.google.com/o/oauth2/v2/auth"
            : `${issuer}/auth`,
        );
        auth.search = new URLSearchParams({
          client_id: isGoogle ? config.googleClientId : config.clientId,
          redirect_uri: `${origin}${
            isGoogle ? "/api/auth/google/callback" : "/api/auth/callback"
          }`,
          ...(isGoogle ? { prompt: "select_account" } : {}),
          response_type: "code",
          scope: isGoogle ? "openid email profile" : "openid profile",
          state,
          nonce,
          code_challenge: digest(verifier),
          code_challenge_method: "S256",
        }).toString();
        redirect(res, auth.href);
        return;
      }
      if (
        ["/api/auth/callback", "/api/auth/google/callback"].includes(path) &&
        req.method === "GET"
      ) {
        const googleCallback = path === "/api/auth/google/callback";
        const provider = googleCallback ? "google" : "telegram";
        const clientId = googleCallback
          ? config.googleClientId
          : config.clientId;
        const clientSecret = googleCallback
          ? config.googleClientSecret
          : config.clientSecret;
        const hash = digest(cookies(req).workspace_login || "");
        const login = get("SELECT * FROM logins WHERE hash = ?", hash);
        run("DELETE FROM logins WHERE hash = ?", hash);
        res.setHeader("Set-Cookie", cookie("workspace_login", "", 0));
        if (
          !login ||
          login.provider !== provider ||
          login.expires < Date.now() ||
          url.searchParams.get("state") !== login.state ||
          !url.searchParams.get("code")
        ) {
          onAuthEvent({
            event: "failed",
            reason: !login
              ? "login_cookie_missing"
              : login.provider !== provider
              ? "provider_mismatch"
              : login.expires < Date.now()
              ? "login_expired"
              : url.searchParams.get("state") !== login.state
              ? "state_mismatch"
              : "authorization_code_missing",
          });
          redirect(res, "/?login=failed");
          return;
        }
        try {
          const response = await fetcher(
            googleCallback
              ? "https://oauth2.googleapis.com/token"
              : `${issuer}/token`,
            {
              method: "POST",
              signal: AbortSignal.timeout(10000),
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                ...(googleCallback
                  ? {}
                  : {
                      Authorization: `Basic ${Buffer.from(
                        `${clientId}:${clientSecret}`,
                      ).toString("base64")}`,
                    }),
              },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code: url.searchParams.get("code"),
                redirect_uri: `${origin}${path}`,
                client_id: clientId,
                ...(googleCallback ? { client_secret: clientSecret } : {}),
                code_verifier: login.verifier,
              }),
            },
          );
          const result = await response.json();
          if (!response.ok || result.error || !result.id_token) {
            const allowed = [
              "invalid_client",
              "invalid_grant",
              "invalid_request",
              "unauthorized_client",
              "unsupported_grant_type",
            ];
            onAuthEvent({
              event: "token_exchange_failed",
              status: response.status,
              reason: allowed.includes(result.error)
                ? result.error
                : "provider_error",
            });
            redirect(res, "/?login=failed");
            return;
          }
          const user = await (googleCallback
            ? verifyGoogleToken
            : verifyTelegramToken)(
            result.id_token,
            clientId,
            login.nonce,
            fetcher,
          );
          if (!isAllowed(user)) {
            onAuthEvent({ event: "failed", reason: "not_allowlisted" });
            redirect(res, "/?login=denied");
            return;
          }
          const session = token();
          const previous = cookies(req).workspace_session;
          if (previous) {
            run("DELETE FROM sessions WHERE hash = ?", digest(previous));
          }
          run(
            "INSERT INTO sessions (hash, user_id, name, expires, email) VALUES (?, ?, ?, ?, ?)",
            digest(session),
            user.id,
            user.name,
            Date.now() + 7 * 86400000,
            user.email || null,
          );
          res.setHeader("Set-Cookie", [
            cookie("workspace_login", "", 0),
            cookie("workspace_session", session, 7 * 86400),
          ]);
          onAuthEvent({ event: "authenticated" });
          redirect(res, "/");
        } catch (error) {
          onAuthEvent({
            event: "failed",
            ...(error instanceof TelegramAuthError && error.details
              ? error.details
              : {}),
            reason:
              error instanceof TelegramAuthError
                ? error.code
                : error.name === "TimeoutError"
                ? "provider_timeout"
                : "provider_or_response_error",
          });
          redirect(res, "/?login=failed");
        }
        return;
      }
      const publicMatch = path.match(/^\/api\/public\/([\w-]{43})(\/export)?$/);
      if (publicMatch) {
        if (req.method !== "GET") fail(405, "Доска доступна только для чтения");
        const row = get(
          "SELECT * FROM boards WHERE share_hash = ?",
          digest(publicMatch[1]),
        );
        if (!row) fail(404, "Доступ к доске закрыт или ссылка не существует");
        if (publicMatch[2]) {
          res.setHeader(
            "Access-Control-Allow-Origin",
            "https://excalidraw.com",
          );
          res.setHeader(
            "Content-Disposition",
            "attachment; filename=board.excalidraw",
          );
          json(res, 200, {
            type: "excalidraw",
            version: 2,
            source: origin,
            ...JSON.parse(row.scene),
          });
        } else
          await syncBoard(req, res, () =>
            get(
              "SELECT * FROM boards WHERE share_hash = ?",
              digest(publicMatch[1]),
            ),
          );
        return;
      }
      const sessionMatch = path.match(
        /^\/api\/session\/([\w-]{43})(\/live|\/pointer)?$/,
      );
      if (sessionMatch) {
        const lookup = () =>
          get(
            "SELECT * FROM boards WHERE session_hash = ?",
            digest(sessionMatch[1]),
          );
        if (sessionMatch[2]) await live(req, res, lookup, sessionMatch[2]);
        else if (["GET", "PUT"].includes(req.method))
          await syncBoard(req, res, lookup);
        else fail(405, "Метод не поддерживается");
        return;
      }
      if (path.startsWith("/api/")) {
        const sessionHash = digest(cookies(req).workspace_session || "");
        const user = get(
          "SELECT user_id AS id, name, email FROM sessions WHERE hash = ? AND expires > ?",
          sessionHash,
          Date.now(),
        );
        if (!user || !isAllowed(user)) {
          fail(401, "Требуется вход");
        }
        if (path === "/api/me" && req.method === "GET") {
          json(res, 200, user);
          return;
        }
        if (path === "/api/logout" && req.method === "POST") {
          run("DELETE FROM sessions WHERE hash = ?", sessionHash);
          res.setHeader("Set-Cookie", cookie("workspace_session", "", 0));
          json(res, 200, { ok: true });
          return;
        }
        if (path === "/api/workspace" && req.method === "GET") {
          json(res, 200, {
            projects: db
              .prepare(
                "SELECT id, name FROM projects WHERE owner_id = ? ORDER BY rowid",
              )
              .all(user.id),
            folders: db
              .prepare(
                "SELECT * FROM folders WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?) ORDER BY rowid",
              )
              .all(user.id),
            boards: db
              .prepare(
                `SELECT ${boardMeta} FROM boards WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?) ORDER BY updated_at DESC`,
              )
              .all(user.id),
          });
          return;
        }
        const collection = path.match(/^\/api\/(projects|folders|boards)$/);
        if (collection && req.method === "POST") {
          const kind = collection[1];
          const body = await bodyOf(req);
          const name = nameOf(body.name);
          const id = token();
          if (kind === "projects") {
            run(
              "INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)",
              id,
              name,
              user.id,
            );
          } else {
            if (!ownedItem("projects", body.project_id || "", user.id)) {
              fail(400, "Проект не найден");
            }
            if (kind === "folders") {
              run(
                "INSERT INTO folders VALUES (?, ?, ?)",
                id,
                body.project_id,
                name,
              );
            } else {
              if (
                body.folder_id &&
                !get(
                  "SELECT id FROM folders WHERE id = ? AND project_id = ?",
                  body.folder_id,
                  body.project_id,
                )
              ) {
                fail(400, "Папка не принадлежит проекту");
              }
              run(
                "INSERT INTO boards (id, project_id, folder_id, name, updated_at) VALUES (?, ?, ?, ?, ?)",
                id,
                body.project_id,
                body.folder_id || null,
                name,
                Date.now(),
              );
            }
          }
          json(res, 201, { id });
          return;
        }
        const liveMatch = path.match(
          /^\/api\/boards\/([\w-]{43})(\/live|\/pointer)$/,
        );
        if (liveMatch) {
          await live(
            req,
            res,
            () => {
              const authorized = get(
                "SELECT * FROM sessions WHERE hash = ? AND expires > ?",
                sessionHash,
                Date.now(),
              );
              return authorized && ownedItem("boards", liveMatch[1], user.id);
            },
            liveMatch[2],
          );
          return;
        }
        const syncMatch = path.match(/^\/api\/boards\/([\w-]{43})\/sync$/);
        if (syncMatch && ["GET", "PUT"].includes(req.method)) {
          await syncBoard(req, res, () =>
            ownedItem("boards", syncMatch[1], user.id),
          );
          return;
        }
        const item = path.match(
          /^\/api\/(projects|folders|boards)\/([\w-]{43})(\/share|\/session)?$/,
        );
        if (item) {
          const [, kind, id, share] = item;
          const row = ownedItem(kind, id, user.id);
          if (!row) {
            fail(404, "Объект не найден");
          }
          const accessColumn =
            share === "/session" ? "session_hash" : "share_hash";
          if (kind === "boards" && share && req.method === "POST") {
            const value = token();
            run(
              `UPDATE boards SET ${accessColumn} = ? WHERE id = ?`,
              digest(value),
              id,
            );
            if (share === "/session") {
              for (const client of clients.values()) {
                if (client.boardId === id) client.pointer = null;
              }
              broadcast(id, "session", { active: req.method === "POST" });
            }
            json(res, 200, {
              url: `${origin}/${share === "/session" ? "c" : "s"}/${value}`,
            });
            return;
          }
          if (kind === "boards" && share && req.method === "DELETE") {
            run(`UPDATE boards SET ${accessColumn} = NULL WHERE id = ?`, id);
            if (share === "/session") {
              for (const client of clients.values()) {
                if (client.boardId === id) client.pointer = null;
              }
              broadcast(id, "session", { active: req.method === "POST" });
            }
            json(res, 200, { ok: true });
            return;
          }
          if (!share && req.method === "DELETE") {
            run(`DELETE FROM ${kind} WHERE id = ?`, id);
            for (const client of clients.values()) {
              if (!client.lookup()) {
                send(client, "revoked", {});
                client.res.end();
              }
            }
            json(res, 200, { ok: true });
            return;
          }
          if (!share && req.method === "PATCH") {
            const body = await bodyOf(req);
            run(
              `UPDATE ${kind} SET name = ? WHERE id = ?`,
              nameOf(body.name),
              id,
            );
            json(res, 200, { ok: true });
            return;
          }
          if (kind === "boards" && !share && req.method === "GET") {
            json(res, 200, {
              id: row.id,
              name: row.name,
              scene: JSON.parse(row.scene),
              revision: row.revision,
              session_active: !!row.session_hash,
            });
            return;
          }
          if (kind === "boards" && !share && req.method === "PUT") {
            const body = await bodyOf(req);
            if (!Number.isSafeInteger(body.revision) || body.revision < 0) {
              fail(400, "Некорректная версия доски");
            }
            const scene = validateScene(body.scene);
            const result = run(
              "UPDATE boards SET scene = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
              scene,
              Date.now(),
              id,
              body.revision,
            );
            if (!result.changes) {
              fail(
                409,
                "Доска изменена в другой вкладке. Экспортируйте текущую доску в файл и откройте серверную версию заново.",
              );
            }
            broadcast(id, "scene", { revision: body.revision + 1 });
            json(res, 200, { revision: body.revision + 1 });
            return;
          }
        }
        fail(404, "Не найдено");
      }
      if (!["GET", "HEAD"].includes(req.method)) {
        fail(405, "Метод не поддерживается");
      }
      const root = resolve(config.staticDir);
      const requested = resolve(root, `.${decodeURIComponent(path)}`);
      if (requested !== root && !requested.startsWith(`${root}${sep}`)) {
        fail(404, "Не найдено");
      }
      const file =
        existsSync(requested) && statSync(requested).isFile()
          ? requested
          : resolve(root, "index.html");
      if (!existsSync(file)) {
        fail(404, "Frontend is not built");
      }
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
        ".webmanifest": "application/manifest+json",
        ".wasm": "application/wasm",
      };
      res.setHeader(
        "Content-Type",
        types[extname(file)] || "application/octet-stream",
      );
      if (req.method === "HEAD") {
        res.end();
      } else {
        createReadStream(file).pipe(res);
      }
    } catch (error) {
      if (!res.headersSent) {
        json(res, error.status || 500, {
          error: error.status ? error.message : "Ошибка сервера",
        });
      } else {
        res.end();
      }
      if (!error.status) {
        console.error("Workspace request failed:", error.message);
      }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on("close", () => db.close());
  return server;
}
