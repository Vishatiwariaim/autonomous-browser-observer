import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

dotenv.config({ path: path.join(repoRoot, ".env") });
dotenv.config();

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  host: process.env.OBSERVER_HOST ?? "127.0.0.1",
  port: intEnv("OBSERVER_PORT", 3847),
  dataDir: path.resolve(
    process.cwd(),
    process.env.OBSERVER_DATA_DIR ?? "./data",
  ),
  maxScreenshotBytes: intEnv("OBSERVER_MAX_SCREENSHOT_BYTES", 2 * 1024 * 1024),
  logLevel: process.env.OBSERVER_LOG_LEVEL ?? "info",
  /** Public URL clients/extensions should use (may differ from bind host) */
  publicUrl: (
    process.env.OBSERVER_PUBLIC_URL ??
    `http://${process.env.OBSERVER_HOST ?? "127.0.0.1"}:${intEnv("OBSERVER_PORT", 3847)}`
  ).replace(/\/$/, ""),
  apiTokenConfigured: Boolean((process.env.ABO_API_TOKEN ?? "").trim()),
  /** Read-only observation is the Phase 1 default — no code/OS mutation APIs */
  mode: "observe-readonly" as const,
};
