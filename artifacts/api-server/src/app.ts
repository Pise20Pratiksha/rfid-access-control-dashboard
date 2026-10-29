import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";
import { requireAuth } from "./middlewares/requireAuth";

const app: Express = express();

// Behind Render's (or any) reverse proxy: use X-Forwarded-* for client IP and protocol.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// The dashboard is served from this same origin in production, so CORS is only
// needed for local development or explicitly listed origins.
const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors({
    credentials: true,
    origin: process.env.NODE_ENV === "production" ? allowedOrigins : true,
  }),
);
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware);

app.use("/api", requireAuth, router);

// ── Static dashboard (single-service deployment) ──────────────────────────────
const staticDir =
  process.env.STATIC_DIR ??
  path.resolve(process.cwd(), "artifacts/rfid-dashboard/dist/public");

if (fs.existsSync(path.join(staticDir, "index.html"))) {
  logger.info({ staticDir }, "Serving dashboard static files");
  app.use(express.static(staticDir, { index: false, maxAge: "1h" }));
  app.use((req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

export default app;
