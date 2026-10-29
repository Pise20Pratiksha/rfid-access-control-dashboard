import crypto from "crypto";
import { type Request, type Response, type NextFunction } from "express";
import { DEVICE_AUTH_SECRET } from "../deviceRegistry";

// Routes reachable without a login session (paths are relative to /api).
const PUBLIC_ROUTES = new Set([
  "GET /healthz",
  "GET /auth/user",
  "POST /login",
  "GET /login",
  "GET /callback",
  "GET /logout",
  "POST /mobile-auth/token-exchange",
  "POST /mobile-auth/logout",
]);

// Endpoints a controller may call over HTTP using the device key instead of a login.
const DEVICE_ROUTES = [/^POST \/access-logs$/, /^POST \/esp-devices\/\d+\/heartbeat$/];

function hasValidDeviceKey(req: Request): boolean {
  const header = req.headers["x-device-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) return false;
  const a = crypto.createHash("sha256").update(key).digest();
  const b = crypto.createHash("sha256").update(DEVICE_AUTH_SECRET).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Mounted on /api: every route needs a dashboard login unless explicitly public. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const route = `${req.method} ${req.path}`;
  if (PUBLIC_ROUTES.has(route) || req.isAuthenticated()) {
    next();
    return;
  }
  if (DEVICE_ROUTES.some((re) => re.test(route)) && hasValidDeviceKey(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Authentication required" });
}
