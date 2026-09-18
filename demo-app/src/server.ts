import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authenticate } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "../public");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "demo-app", bugFixed: process.env.DEMO_BUG_FIXED === "1" });
});

app.post("/api/login", (req, res) => {
  const username = String(req.body?.username ?? "");
  const password = String(req.body?.password ?? "");
  // Never log password
  const result = authenticate({ username, password });
  if (result.ok) {
    res.json({ ok: true, redirectTo: result.redirectTo });
    return;
  }
  res.status(result.status).json({ ok: false, error: result.error });
});

app.get("/dashboard", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html><html><body>
    <h1>Dashboard</h1>
    <p id="welcome">Welcome — login succeeded.</p>
    <a href="/">Back</a>
  </body></html>`);
});

const port = Number(process.env.DEMO_APP_PORT ?? 3000);
const host = process.env.DEMO_APP_HOST ?? "127.0.0.1";

if (process.env.DEMO_APP_NO_LISTEN !== "1") {
  app.listen(port, host, () => {
    console.log(`[demo-app] http://${host}:${port}/`);
  });
}

export { app };
