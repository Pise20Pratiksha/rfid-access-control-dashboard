import type { IncomingMessage } from "http";
import type net from "net";
import type { WebSocket } from "ws";
import { logger } from "./lib/logger";
import { markDeviceOffline } from "./deviceRegistry";
import { handleIncomingPacket, type ConnectedClient } from "./tcpServer";

/**
 * Minimal net.Socket look-alike so the existing device registry / packet
 * handlers (written for raw TCP) work unchanged over a WebSocket.
 * Protocol is identical: one JSON object per text frame.
 */
class WsSocketAdapter {
  constructor(private readonly ws: WebSocket) {}

  get destroyed(): boolean {
    return this.ws.readyState !== this.ws.OPEN;
  }

  write(data: string): boolean {
    if (this.destroyed) return false;
    this.ws.send(data.endsWith("\n") ? data.slice(0, -1) : data);
    return true;
  }

  destroy(): void {
    this.ws.terminate();
  }
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return (first || req.socket.remoteAddress || "unknown").replace("::ffff:", "");
}

export function attachDeviceSocket(ws: WebSocket, req: IncomingMessage): void {
  const remoteAddress = clientIp(req);
  const adapter = new WsSocketAdapter(ws);

  const client: ConnectedClient = {
    socket: adapter as unknown as net.Socket,
    remoteAddress,
    remotePort: req.socket.remotePort ?? 0,
    connectedAt: new Date(),
    lastActive: new Date(),
    authenticated: false,
    transport: "ws",
  };

  logger.info(`[Device WS] controller connected from ${remoteAddress}`);

  // Drop connections that never authenticate.
  const authTimer = setTimeout(() => {
    if (!client.authenticated) {
      logger.warn(`[Device WS] ${remoteAddress} did not authenticate in time, closing`);
      ws.terminate();
    }
  }, 15_000);

  ws.on("message", async (raw) => {
    client.lastActive = new Date();
    // Tolerate several newline-delimited JSON objects in a single frame.
    for (const line of raw.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        await handleIncomingPacket(JSON.parse(trimmed), remoteAddress, client);
      } catch (err) {
        logger.error({ err: (err as Error).message }, "[Device WS] invalid packet");
      }
    }
  });

  ws.on("close", async () => {
    clearTimeout(authTimer);
    logger.warn(`[Device WS] controller disconnected: ${client.deviceId ?? remoteAddress}`);
    if (client.deviceId) await markDeviceOffline(client.deviceId);
  });

  ws.on("error", (err) => {
    logger.error({ err: err.message }, "[Device WS] socket error");
  });
}
