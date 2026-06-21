// E2E-only SPA build: enables compile-time Scout fixture hook (VITE_ENABLE_SCOUT_E2E).
import { spawnSync } from "node:child_process";

const env = { ...process.env, VITE_ENABLE_SCOUT_E2E: "1" };
const sync = spawnSync("npm", ["run", "sync-engine"], { stdio: "inherit", shell: true, env });
if (sync.status !== 0) process.exit(sync.status ?? 1);

const build = spawnSync("npx", ["vite", "build"], { stdio: "inherit", shell: true, env });
process.exit(build.status ?? 1);