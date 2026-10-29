import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "./logger";
import { getSession, SESSION_COOKIE } from "./auth";
import { attachDeviceSocket } from "../deviceWs";

const DASHBOARD_WS_PATH = "/api/ws";
const DEVICE_WS_PATH = "/api/device-ws";
const HEARTBEAT_MS = 25_000;

let dashboardWss: WebSocketServer | null = null;
let deviceWss: WebSocketServer | null = null;

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

async function isDashboardAuthenticated(req: IncomingMessage): Promise<boolean> {
  const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (!sid) return false;
  try {
    return Boolean((await getSession(sid))?.user?.id);
  } catch {
    return false;
  }
}

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

type Beating = WebSocket & { isAlive?: boolean };

/** Ping every socket periodically so idle proxies keep the connection and dead peers are dropped. */
function startHeartbeat(wss: WebSocketServer): void {
  const timer = setInterval(() => {
    for (const client of wss.clients as Set<Beating>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        /* socket already closing */
      }
    }
  }, HEARTBEAT_MS);
  timer.unref();
  wss.on("close", () => clearInterval(timer));
}

function trackPong(socket: Beating): void {
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });
}

/**
 * Serves two WebSocket endpoints on the one HTTP(S) port (required on hosts
 * that expose a single port, e.g. Render):
 *   /api/ws         live dashboard events (browser, requires a login session)
 *   /api/device-ws  RFID controllers (ESP32), authenticated by device token
 */
export function initWebSocketServer(server: HttpServer): void {
  dashboardWss = new WebSocketServer({ noServer: true });
  deviceWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  dashboardWss.on("connection", (socket: Beating) => {
    trackPong(socket);
    logger.info("WebSocket client connected");
    socket.send(JSON.stringify({ type: "connected" }));
    socket.on("close", () => logger.info("WebSocket client disconnected"));
  });

  deviceWss.on("connection", (socket: Beating, req: IncomingMessage) => {
    trackPong(socket);
    attachDeviceSocket(socket, req);
  });

  startHeartbeat(dashboardWss);
  startHeartbeat(deviceWss);

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");

    if (pathname === DEVICE_WS_PATH) {
      // Device auth happens in-band (auth_request packet), like the TCP protocol.
      deviceWss!.handleUpgrade(req, socket, head, (ws) => deviceWss!.emit("connection", ws, req));
      return;
    }

    if (pathname === DASHBOARD_WS_PATH) {
      isDashboardAuthenticated(req).then((ok) => {
        if (!ok) return reject(socket, "401 Unauthorized");
        dashboardWss!.handleUpgrade(req, socket, head, (ws) =>
          dashboardWss!.emit("connection", ws, req),
        );
      });
      return;
    }

    reject(socket, "404 Not Found");
  });
}

export function broadcast(type: string, payload: unknown): void {
  if (!dashboardWss) return;
  const message = JSON.stringify({ type, payload });
  for (const client of dashboardWss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}
