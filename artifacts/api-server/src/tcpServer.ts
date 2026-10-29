import net from "net";
import { eq, and } from "drizzle-orm";
import {
  db,
  accessLogsTable,
  vehiclesTable,
  rfidCardsTable,
} from "@workspace/db";
import { broadcast } from "./lib/ws";
import { logger } from "./lib/logger";
import {
  registerOrUpdateDevice,
  associateSocket,
  markDeviceOffline,
  verifyDeviceAuth,
  resolveDevice,
  sendDeviceCommand,
  getLiveDevices,
  type RegisteredDevice,
} from "./deviceRegistry";

const TCP_PORT = Number(process.env.TCP_PORT ?? 5001);
const DEFAULT_DEVICE_NAME = "ESP32 Gate Logger";

export interface ConnectedClient {
  transport?: "tcp" | "ws";
  socket: net.Socket;
  remoteAddress: string;
  remotePort: number;
  connectedAt: Date;
  lastActive: Date;
  authenticated: boolean;
  deviceId?: string;
}

const connectedClients = new Map<string, ConnectedClient>();
let tcpServerInstance: net.Server | null = null;

/**
 * Format Date into DD/MM/YYYY HH:MM:SS format expected by ESP32 DS3231 RTC
 */
export function formatESP32DateTime(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

/**
 * Parse date and time strings received from ESP32 into a JavaScript Date object
 */
export function parseESP32DateTime(dateStr?: string, timeStr?: string): Date {
  if (!dateStr || !timeStr) return new Date();
  try {
    const parts = dateStr.split("/").map(Number);
    const timeParts = timeStr.split(":").map(Number);
    if (parts.length === 3 && timeParts.length === 3) {
      const [day, month, year] = parts;
      const [hour, minute, second] = timeParts;
      if (![day, month, year, hour, minute, second].some((n) => isNaN(n))) {
        const d = new Date(year, month - 1, day, hour, minute, second);
        if (!isNaN(d.getTime())) return d;
      }
    }
    return new Date();
  } catch {
    return new Date();
  }
}

/**
 * Retrieve list of connected ESP32 client sockets
 */
export function getConnectedClients(): Array<{
  ip: string;
  port: number;
  deviceId?: string;
  authenticated: boolean;
  connectedAt: Date;
  lastActive: Date;
}> {
  return Array.from(connectedClients.values()).map((c) => ({
    ip: c.remoteAddress,
    port: c.remotePort,
    deviceId: c.deviceId,
    authenticated: c.authenticated,
    connectedAt: c.connectedAt,
    lastActive: c.lastActive,
  }));
}

/**
 * Backward-compatible command sender
 */
export function sendESP32Command(packet: Record<string, unknown>, targetIp?: string): boolean {
  const res = sendDeviceCommand(targetIp, packet);
  return res.success;
}

/**
 * Process a single RFID tag detection record:
 * - Validates registered card & active authorization status in PostgreSQL
 * - Checks for duplicate scans (same card, direction, timestamp)
 * - Inserts access log into PostgreSQL
 * - Broadcasts real-time events to WebSockets (Live Dashboard)
 * - Sends bidirectional auth feedback back to ESP32 firmware
 */
async function processDetectionRecord(
  packet: any,
  remoteAddress: string,
  clientInfo?: ConnectedClient
): Promise<void> {
  const epc = (packet.epc || packet.cardUid || "").trim();
  if (!epc) {
    logger.warn("[TCP Server] Detection packet missing EPC / card UID");
    return;
  }

  const deviceId =
    packet.deviceId || clientInfo?.deviceId || `ESP32-GATE-${remoteAddress.replace(/\./g, "")}`;
  const readerName = packet.readerId || packet.deviceName || DEFAULT_DEVICE_NAME;
  const direction = (packet.direction || packet.dir || "IN").toUpperCase() === "OUT" ? "OUT" : "IN";
  const timestamp = parseESP32DateTime(packet.date, packet.time);

  logger.info(
    `[TCP Server] Tag Detection -> EPC: ${epc}, Direction: ${direction}, Device: ${deviceId}, Time: ${timestamp.toISOString()}`
  );

  try {
    // Get device info from registry or ensure registered
    const device = await registerOrUpdateDevice({
      deviceId,
      name: readerName,
      ipAddress: remoteAddress,
      status: "online",
    });

    const dbDeviceId = device.dbId ?? null;

    // Prevent duplicate entries for exact same card scan at identical timestamp
    const [existing] = await db
      .select()
      .from(accessLogsTable)
      .where(
        and(
          eq(accessLogsTable.cardUid, epc),
          eq(accessLogsTable.direction, direction),
          eq(accessLogsTable.timestamp, timestamp)
        )
      )
      .limit(1);

    if (existing) {
      logger.debug(`[TCP Server] Duplicate scan detected for ${epc}, skipping DB insertion`);
      return;
    }

    // Lookup RFID card status in PostgreSQL
    const [card] = await db
      .select()
      .from(rfidCardsTable)
      .where(eq(rfidCardsTable.cardUid, epc))
      .limit(1);

    const isRegistered = Boolean(card);
    const authorized = Boolean(card?.active);

    // Insert access log
    const [inserted] = await db
      .insert(accessLogsTable)
      .values({
        cardUid: epc,
        direction,
        deviceId: dbDeviceId,
        vehicleId: card?.vehicleId ?? null,
        authorized,
        timestamp,
      })
      .returning();

    // Query enriched log with vehicle plate and owner
    const [enriched] = await db
      .select({
        id: accessLogsTable.id,
        cardUid: accessLogsTable.cardUid,
        vehicleId: accessLogsTable.vehicleId,
        plateNumber: vehiclesTable.plateNumber,
        ownerName: vehiclesTable.ownerName,
        carDetails: vehiclesTable.carDetails,
        direction: accessLogsTable.direction,
        authorized: accessLogsTable.authorized,
        deviceId: accessLogsTable.deviceId,
        timestamp: accessLogsTable.timestamp,
      })
      .from(accessLogsTable)
      .leftJoin(vehiclesTable, eq(accessLogsTable.vehicleId, vehiclesTable.id))
      .where(eq(accessLogsTable.id, inserted.id))
      .limit(1);

    if (enriched) {
      const payload = {
        ...enriched,
        deviceName: readerName,
        isRegistered,
      };

      // Broadcast live updates to Frontend dashboard & WebSocket subscribers
      broadcast("access_log_created", payload);
      broadcast("access-log-created", payload);
      broadcast("tag_detected", {
        cardUid: epc,
        isRegistered,
        authorized,
        direction,
        deviceId: dbDeviceId,
        deviceName: readerName,
        plateNumber: enriched.plateNumber,
        ownerName: enriched.ownerName,
        carDetails: enriched.carDetails,
        timestamp: timestamp.toISOString(),
      });
    }

    // BIDIRECTIONAL RESPONSE: Send authorization result back to ESP32 firmware
    const socket = clientInfo?.socket;
    if (socket && !socket.destroyed) {
      const authFeedback = {
        type: "auth_result",
        cardUid: epc,
        authorized,
        isRegistered,
        direction,
        plateNumber: enriched?.plateNumber || "",
        ownerName: enriched?.ownerName || "",
        action: authorized ? "open_gate" : "deny",
        timestamp: timestamp.toISOString(),
      };

      socket.write(JSON.stringify(authFeedback) + "\n");
      logger.info(
        `[TCP Server] Sent auth_result to ESP32: authorized=${authorized}, plate=${enriched?.plateNumber || "N/A"}, action=${authFeedback.action}`
      );
    }
  } catch (err: any) {
    logger.error({ err: err.message }, "[TCP Server] Error processing detection record");
  }
}

/**
 * Handle incoming parsed JSON packet from ESP32 socket
 */
export async function handleIncomingPacket(
  packet: any,
  remoteAddress: string,
  clientInfo: ConnectedClient
): Promise<void> {
  const socket = clientInfo.socket;
  const type = (packet.type || packet.event || packet.cmd || "").toLowerCase();

  // 1. Device Authentication Handshake
  if (type === "auth_request" || type === "authenticate") {
    const deviceId =
      packet.deviceId || packet.client || `ESP32-GATE-${remoteAddress.replace(/\./g, "")}`;
    const token = packet.token || packet.authKey || "";
    const deviceName = packet.name || packet.deviceName || DEFAULT_DEVICE_NAME;
    const macAddress = packet.mac || packet.macAddress;
    const firmwareVersion = packet.version || packet.firmwareVersion || "2.1.0";
    const nvsCount = Number(packet.nvsCount ?? packet.recordsCount ?? 0);

    const isValid = verifyDeviceAuth(deviceId, token);

    if (isValid) {
      clientInfo.authenticated = true;
      clientInfo.deviceId = deviceId;

      await registerOrUpdateDevice({
        deviceId,
        name: deviceName,
        ipAddress: remoteAddress,
        port: clientInfo.remotePort,
        macAddress,
        firmwareVersion,
        status: "online",
        authenticated: true,
        nvsRecordsCount: nvsCount,
        socket,
        transport: clientInfo.transport ?? "tcp",
      });

      associateSocket(deviceId, socket, remoteAddress, clientInfo.remotePort);

      logger.info(
        `[TCP Server] Device "${deviceId}" (${deviceName}) AUTHENTICATED successfully from ${remoteAddress}`
      );

      // Send authentication response with synchronized time
      const nowStr = formatESP32DateTime();
      const authResp = {
        type: "auth_response",
        status: "authenticated",
        serverId: "RFID-SERVER-CORE",
        serverTime: nowStr,
        syncTime: true,
        deviceId,
      };
      socket.write(JSON.stringify(authResp) + "\n");

      // If device has cached offline records, automatically request historical dump
      if (nvsCount > 0) {
        logger.info(
          `[TCP Server] Device "${deviceId}" has ${nvsCount} offline records. Requesting dump...`
        );
        socket.write(JSON.stringify({ type: "cmd", cmd: "dump" }) + "\n");
      }
    } else {
      logger.warn(
        `[TCP Server] Device "${deviceId}" FAILED authentication from ${remoteAddress}. Invalid token!`
      );
      const authFailResp = {
        type: "auth_response",
        status: "unauthorized",
        error: "Invalid authentication credentials",
      };
      socket.write(JSON.stringify(authFailResp) + "\n");
      // Destroy socket after brief delay to prevent brute-force hammering
      setTimeout(() => {
        try {
          socket.destroy();
        } catch {}
      }, 1000);
    }
    return;
  }

  // 2. Status Announcement / Legacy Device Online Announcement
  if (type === "device_connected" || type === "status" || packet.status === "online") {
    const deviceId =
      packet.deviceId || clientInfo.deviceId || `ESP32-GATE-${remoteAddress.replace(/\./g, "")}`;
    const deviceName = packet.readerId || packet.deviceName || DEFAULT_DEVICE_NAME;
    const ip = packet.ip || remoteAddress;

    logger.info(`[TCP Server] Device online status: "${deviceId}" (${deviceName}) from IP ${ip}`);

    // If device didn't perform auth_request, check if it supplied a token here
    if (!clientInfo.authenticated) {
      if (verifyDeviceAuth(deviceId, packet.token || "")) {
        clientInfo.authenticated = true;
        clientInfo.deviceId = deviceId;
      }
    }

    await registerOrUpdateDevice({
      deviceId,
      name: deviceName,
      ipAddress: ip,
      port: clientInfo.remotePort,
      macAddress: packet.mac,
      status: "online",
      authenticated: clientInfo.authenticated,
      socket,
      transport: clientInfo.transport ?? "tcp",
    });

    associateSocket(deviceId, socket, ip, clientInfo.remotePort);

    const nowStr = formatESP32DateTime();
    const ackPayload = {
      type: "ack",
      event: "device_connected",
      status: "connected",
      serverTime: nowStr,
      syncTime: true,
      authenticated: clientInfo.authenticated,
    };
    socket.write(JSON.stringify(ackPayload) + "\n");

    const nvsCount = Number(packet.recordsCount ?? 0);
    if (nvsCount > 0) {
      logger.info(
        `[TCP Server] Device has ${nvsCount} offline records. Requesting dump...`
      );
      socket.write(JSON.stringify({ type: "cmd", cmd: "dump" }) + "\n");
    }
    return;
  }

  // Internet (WebSocket) connections must authenticate before sending data.
  // Raw TCP is LAN-only (disabled in the cloud), so older firmware that never
  // sends auth_request keeps working exactly as before.
  if (
    clientInfo.transport === "ws" &&
    !clientInfo.authenticated &&
    ["detection", "sync_response", "ping"].includes(type)
  ) {
    logger.warn(`[Device] Ignoring unauthenticated "${type}" packet from ${remoteAddress}`);
    return;
  }

  // 3. Real-time Tag Detection
  if (type === "detection") {
    await processDetectionRecord(packet, remoteAddress, clientInfo);
    return;
  }

  // 4. Keepalive Heartbeat Ping from Firmware
  if (type === "ping") {
    const deviceId = packet.deviceId || clientInfo.deviceId;
    if (deviceId) {
      registerOrUpdateDevice({
        deviceId,
        ipAddress: remoteAddress,
        status: "online",
      });
    }

    const pongResponse = {
      type: "pong",
      timestamp: Date.now(),
      seq: packet.seq,
    };
    socket.write(JSON.stringify(pongResponse) + "\n");
    return;
  }

  // 5. Batch Sync of Offline Records (response to dump command)
  if (type === "sync_response" && Array.isArray(packet.records)) {
    logger.info(
      `[TCP Server] Received offline sync dump with ${packet.records.length} records from ${remoteAddress}`
    );
    for (const record of packet.records) {
      await processDetectionRecord(record, remoteAddress, clientInfo);
    }

    if (packet.records.length > 0) {
      logger.info("[TCP Server] Offline sync completed. Sending clear command to ESP32...");
      socket.write(JSON.stringify({ type: "cmd", cmd: "clear" }) + "\n");
    }
    return;
  }

  // 6. Pong response from firmware
  if (type === "pong") {
    logger.debug(`[TCP Server] Received pong from ${remoteAddress}`);
    return;
  }

  // 7. Generic Command Acknowledgment
  if (type === "cmd_ack") {
    logger.info(
      `[TCP Server] ESP32 acknowledged command "${packet.cmd}": status=${packet.status}`
    );
    return;
  }

  logger.warn({ packet }, "[TCP Server] Received unrecognized packet type");
}

/**
 * Initializes and starts the bidirectional TCP Server
 */
export function startTCPServer(): void {
  if (tcpServerInstance) {
    logger.warn("[TCP Server] TCP server already running");
    return;
  }

  const server = net.createServer((socket) => {
    const remoteAddress = socket.remoteAddress?.replace("::ffff:", "") ?? "unknown";
    const remotePort = socket.remotePort ?? 0;
    const clientKey = `${remoteAddress}:${remotePort}`;

    socket.setKeepAlive(true, 10000);
    socket.setNoDelay(true);
    socket.setTimeout(60000); // 60s inactivity timeout

    const clientInfo: ConnectedClient = {
      socket,
      remoteAddress,
      remotePort,
      connectedAt: new Date(),
      lastActive: new Date(),
      authenticated: false,
    };
    connectedClients.set(clientKey, clientInfo);

    logger.info(`[TCP Server] ESP32 TCP client connected from ${clientKey}`);

    let buffer = "";

    socket.on("data", async (chunk) => {
      clientInfo.lastActive = new Date();
      buffer += chunk.toString("utf8");

      // Split incoming stream by newline delimiter
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const packet = JSON.parse(trimmed);
          await handleIncomingPacket(packet, remoteAddress, clientInfo);
        } catch (err: any) {
          logger.error(
            { err: err.message, rawLine: trimmed },
            "[TCP Server] Invalid JSON received from socket"
          );
        }
      }
    });

    socket.on("timeout", () => {
      logger.debug(`[TCP Server] Socket inactivity timeout on ${clientKey}. Sending ping check...`);
      if (!socket.destroyed) {
        socket.write(JSON.stringify({ type: "ping", check: true }) + "\n");
      }
    });

    socket.on("close", async () => {
      logger.warn(`[TCP Server] ESP32 TCP client disconnected: ${clientKey}`);
      connectedClients.delete(clientKey);

      // If this device has an ID, mark it offline
      if (clientInfo.deviceId) {
        await markDeviceOffline(clientInfo.deviceId);
      } else {
        const hasOtherSockets = Array.from(connectedClients.values()).some(
          (c) => c.remoteAddress === remoteAddress
        );
        if (!hasOtherSockets) {
          await markDeviceOffline(remoteAddress);
        }
      }
    });

    socket.on("error", (err) => {
      logger.error({ err: err.message, clientKey }, "[TCP Server] Socket error");
    });
  });

  server.listen(TCP_PORT, "0.0.0.0", () => {
    logger.info(`[TCP Server] RFID TCP server listening on 0.0.0.0:${TCP_PORT}`);
  });

  server.on("error", (err) => {
    logger.error({ err: err.message }, `[TCP Server] Server error on port ${TCP_PORT}`);
  });

  tcpServerInstance = server;
}

/**
 * Cleanly stops the TCP server and closes all active client connections
 */
export function stopTCPServer(): void {
  for (const client of connectedClients.values()) {
    try {
      client.socket.destroy();
    } catch {}
  }
  connectedClients.clear();

  if (tcpServerInstance) {
    tcpServerInstance.close();
    tcpServerInstance = null;
    logger.info("[TCP Server] TCP server stopped");
  }
}
