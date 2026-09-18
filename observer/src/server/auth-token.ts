import type { Request, Response, NextFunction, Express } from "express";

/**
 * Optional shared secret for remote Observer access.
 * If ABO_API_TOKEN is unset/empty → open (local-dev friendly).
 * If set → require header `X-ABO-Token` or `?token=` on mutating / sensitive routes.
 */
export function createTokenGate(): {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  tokenConfigured: boolean;
} {
  const token = (process.env.ABO_API_TOKEN ?? "").trim();
  const tokenConfigured = token.length > 0;

  function middleware(req: Request, res: Response, next: NextFunction): void {
    if (!tokenConfigured) {
      next();
      return;
    }
    if (req.method === "OPTIONS") {
      next();
      return;
    }
    // Allow health + static dashboard without token for ops ping
    if (req.method === "GET" && (req.path === "/health" || req.path === "/")) {
      next();
      return;
    }
    const header = String(req.header("x-abo-token") ?? "");
    const query = typeof req.query.token === "string" ? req.query.token : "";
    if (header === token || query === token) {
      next();
      return;
    }
    res.status(401).json({
      error: "Unauthorized — set X-ABO-Token header (same as ABO_API_TOKEN)",
    });
  }

  return { middleware, tokenConfigured };
}

export function mountTokenGate(app: Express): boolean {
  const { middleware, tokenConfigured } = createTokenGate();
  app.use(middleware);
  return tokenConfigured;
}
