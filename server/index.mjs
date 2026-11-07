import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspaceServer } from "./app.mjs";

const database = resolve(
  process.env.DATABASE_PATH ||
    fileURLToPath(new URL("./data/workspace.sqlite", import.meta.url)),
);
mkdirSync(dirname(database), { recursive: true });
const server = createWorkspaceServer({
  origin: process.env.APP_ORIGIN || "http://localhost:3000",
  clientId: process.env.TELEGRAM_CLIENT_ID,
  clientSecret: process.env.TELEGRAM_CLIENT_SECRET,
  allowlist: (process.env.TELEGRAM_ALLOWED_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleAllowedEmails: (process.env.GOOGLE_ALLOWED_EMAILS || "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean),
  legacyOwnerId: process.env.WORKSPACE_LEGACY_OWNER_ID,
  database,
  staticDir:
    process.env.STATIC_DIR ||
    fileURLToPath(new URL("../excalidraw-app/build", import.meta.url)),
});
server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
  console.log("Workspace server listening"),
);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
