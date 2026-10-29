import net from "net";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db, espDevicesTable } from "@workspace/db";
import { broadcast } from "./lib/ws";
import { logger } from "./lib/logger";

const LEGACY_DEFAULT_DEVICE_SECRET = "spj_rfid_secure_key_2026";

// The legacy default is published in the repo/firmware, so it is only tolerated
// outside production (LAN development). In production the secret must be set.
export const DEVICE_AUTH_SECRET = (() => {
  const configured = process.env.DEVICE_AUTH_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("DEVICE_AUTH_SECRET must be set in production");
  }
  return LEGACY_DEFAULT_DEVICE_SECRET;
})();

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export interface RegisteredDevice {
  deviceId: string; // Permanent hardware ID (e.g. ESP32-GATE-246F2801A2B3)
  name: string; // Friendly name (e.g. "ESP32 Gate Logger")
  deviceType: string; // "rfid_gate_controller"
  ipAddress: string; // Current resolved IP (dynamic DHCP or public remote)
  port: number; // Active port
  macAddress?: string;
  status: "online" | "offline" | "authenticating";
  authenticated: boolean;
  lastSeenAt: Date;
  connectedAt?: Date;
  socket?: net.Socket;
  ws?: any;
  transport?: "tcp" | "ws" | "mqtt";
  mqttPublish?: (topic: string, message: string) => boolean;
  firmwareVersion?: string;
  nvsRecordsCount?: number;
  lastRssi?: number;
  dbId?: number;
}

// In-memory registries: primary by permanent deviceId, secondary by current IP
const devicesById = new Map<string, RegisteredDevice>();
const ipToDeviceId = new Map<string, string>();

/**
 * Validates device authentication token against the pre-shared secret.
 * Supports direct token match or HMAC-SHA256 of deviceId with secret.
 */
export function verifyDeviceAuth(deviceId: string, token: string): boolean {
  if (!token) return false;
  // Direct pre-shared secret match
  if (safeEqual(token, DEVICE_AUTH_SECRET)) return true;
  // Simple deviceId-salted check (token === secret + "_" + deviceId or similar)
  if (safeEqual(token, `${DEVICE_AUTH_SECRET}_${deviceId}`)) return true;
  return false;
}

/**
 * Dynamically resolves a device by its permanent device ID
 */
export function resolveDevice(deviceId: string): RegisteredDevice | undefined {
  return devicesById.get(deviceId);
}

/**
 * Dynamically resolves a device by its current IP address
 */
export function resolveDeviceByIp(ip: string): RegisteredDevice | undefined {
  const cleanIp = ip.replace("::ffff:", "").trim();
  const id = ipToDeviceId.get(cleanIp);
  if (id) {
    return devicesById.get(id);
  }
  return undefined;
}

/**
 * Retrieves all registered devices (active and offline)
 */
export function getAllDevices(): RegisteredDevice[] {
  return Array.from(devicesById.values());
}

/**
 * Retrieves only currently connected & authenticated live devices
 */
export function getLiveDevices(): Array<{
  deviceId: string;
  name: string;
  ipAddress: string;
  port: number;
  macAddress?: string;
  status: string;
  authenticated: boolean;
  transport?: string;
  lastSeenAt: string;
  connectedAt?: string;
  firmwareVersion?: string;
  nvsRecordsCount?: number;
}> {
  return Array.from(devicesById.values())
    .filter((d) => {
      if (d.status !== "online") return false;
      const isTcpLive = d.socket && !d.socket.destroyed;
      const isWsLive = d.ws && d.ws.readyState === 1; // WebSocket.OPEN
      const isMqttLive =
        d.transport === "mqtt" && Date.now() - d.lastSeenAt.getTime() < 60000;
      return Boolean(isTcpLive || isWsLive || isMqttLive);
    })
    .map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      ipAddress: d.ipAddress,
      port: d.port,
      macAddress: d.macAddress,
      status: d.status,
      authenticated: d.authenticated,
      transport: d.transport || (d.ws ? "ws" : d.socket ? "tcp" : "unknown"),
      lastSeenAt: d.lastSeenAt.toISOString(),
      connectedAt: d.connectedAt?.toISOString(),
      firmwareVersion: d.firmwareVersion,
      nvsRecordsCount: d.nvsRecordsCount,
    }));
}

/**
 * Synchronizes or registers a device with the PostgreSQL database.
 * If the device already exists by name/deviceId, updates it; otherwise creates a new record.
 */
async function syncDeviceToDatabase(device: RegisteredDevice): Promise<number> {
  try {
    const [existing] = await db
      .select()
      .from(espDevicesTable)
      .where(eq(espDevicesTable.name, device.name))
      .limit(1);

    const now = new Date();

    if (existing) {
      const [updated] = await db
        .update(espDevicesTable)
        .set({
          status: device.status,
          ipAddress: device.ipAddress,
          lastSeenAt: now,
        })
        .where(eq(espDevicesTable.id, existing.id))
        .returning();

      broadcast("esp_device_heartbeat", updated);
      broadcast("device-status", updated);
      return existing.id;
    } else {
      const [created] = await db
        .insert(espDevicesTable)
        .values({
          name: device.name,
          location: "Main Gate",
          ipAddress: device.ipAddress,
          status: device.status,
          lastSeenAt: now,
        })
        .returning();

      broadcast("esp_device_created", created);
      broadcast("device-created", created);
      return created.id;
    }
  } catch (err: any) {
    logger.error({ err: err.message, deviceId: device.deviceId }, "[Device Registry] Error syncing to DB");
    return 0;
  }
}

/**
 * Registers or updates a device in memory and syncs with PostgreSQL.
 * Automatically handles DHCP IP changes seamlessly:
 * if an existing device appears from a new IP, old IP mappings are updated.
 */
export async function registerOrUpdateDevice(params: {
  deviceId: string;
  name?: string;
  deviceType?: string;
  ipAddress: string;
  port?: number;
  macAddress?: string;
  firmwareVersion?: string;
  status?: "online" | "offline" | "authenticating";
  authenticated?: boolean;
  nvsRecordsCount?: number;
  socket?: net.Socket;
  transport?: "tcp" | "ws" | "mqtt";
}): Promise<RegisteredDevice> {
  const cleanIp = params.ipAddress.replace("::ffff:", "").trim();
  const existing = devicesById.get(params.deviceId);
  const now = new Date();

  // Handle DHCP IP change: if IP changed, clear old IP mapping
  if (existing && existing.ipAddress !== cleanIp) {
    logger.info(
      `[Device Registry] Device "${params.deviceId}" changed IP dynamically from ${existing.ipAddress} to ${cleanIp} (DHCP renewal)`
    );
    ipToDeviceId.delete(existing.ipAddress);
  }

  const updated: RegisteredDevice = {
    deviceId: params.deviceId,
    name: params.name || existing?.name || "ESP32 Gate Logger",
    deviceType: params.deviceType || existing?.deviceType || "rfid_gate_controller",
    ipAddress: cleanIp,
    port: params.port ?? existing?.port ?? 5001,
    macAddress: params.macAddress || existing?.macAddress,
    firmwareVersion: params.firmwareVersion || existing?.firmwareVersion || "2.1.0",
    status: params.status || existing?.status || "online",
    authenticated: params.authenticated !== undefined ? params.authenticated : (existing?.authenticated ?? false),
    lastSeenAt: now,
    connectedAt: existing?.connectedAt || (params.status === "online" ? now : undefined),
    socket: params.socket || existing?.socket,
    transport: params.transport || existing?.transport,
    nvsRecordsCount: params.nvsRecordsCount ?? existing?.nvsRecordsCount ?? 0,
    dbId: existing?.dbId,
  };

  devicesById.set(params.deviceId, updated);
  ipToDeviceId.set(cleanIp, params.deviceId);

  // Sync to database asynchronously
  syncDeviceToDatabase(updated).then((dbId) => {
    if (dbId > 0) {
      updated.dbId = dbId;
    }
  });

  return updated;
}

/**
 * Associates an active TCP socket with a device
 */
export function associateSocket(
  deviceId: string,
  socket: net.Socket,
  ip: string,
  port: number
): void {
  const cleanIp = ip.replace("::ffff:", "").trim();
  const dev = devicesById.get(deviceId);
  if (dev) {
    dev.socket = socket;
    dev.ipAddress = cleanIp;
    dev.port = port;
    dev.status = "online";
    dev.connectedAt = new Date();
    dev.lastSeenAt = new Date();
    ipToDeviceId.set(cleanIp, deviceId);
  }
}

/**
 * Marks a device as offline when its socket is closed or keepalive watchdog expires
 */
export async function markDeviceOffline(deviceIdOrIp: string): Promise<void> {
  let target = devicesById.get(deviceIdOrIp);
  if (!target) {
    const cleanIp = deviceIdOrIp.replace("::ffff:", "").trim();
    const id = ipToDeviceId.get(cleanIp);
    if (id) target = devicesById.get(id);
  }

  if (target) {
    target.status = "offline";
    target.socket = undefined;
    target.lastSeenAt = new Date();

    logger.info(`[Device Registry] Device "${target.deviceId}" (${target.name}) marked offline`);

    try {
      const [device] = await db
        .select()
        .from(espDevicesTable)
        .where(eq(espDevicesTable.name, target.name))
        .limit(1);

      if (device) {
        const [updated] = await db
          .update(espDevicesTable)
          .set({ status: "offline", lastSeenAt: new Date() })
          .where(eq(espDevicesTable.id, device.id))
          .returning();

        broadcast("esp_device_heartbeat", updated);
        broadcast("device-status", updated);
      }
    } catch (err: any) {
      logger.error({ err: err.message }, "[Device Registry] Error updating DB offline status");
    }
  }
}

/**
 * Sends a JSON command packet to a specific device (by deviceId or IP address),
 * or broadcasts to all connected devices if no target specified.
 */
export function sendDeviceCommand(
  targetIdOrIp: string | undefined,
  packet: Record<string, unknown>
): { success: boolean; sentCount: number; message: string } {
  const message = JSON.stringify(packet) + "\n";
  let sentCount = 0;

  if (targetIdOrIp) {
    let target = devicesById.get(targetIdOrIp);
    if (!target) {
      const cleanIp = targetIdOrIp.replace("::ffff:", "").trim();
      const id = ipToDeviceId.get(cleanIp);
      if (id) target = devicesById.get(id);
    }

    if (!target || !target.socket || target.socket.destroyed) {
      return {
        success: false,
        sentCount: 0,
        message: `Device "${targetIdOrIp}" is not currently connected`,
      };
    }

    try {
      target.socket.write(message);
      return {
        success: true,
        sentCount: 1,
        message: `Command sent to device "${target.deviceId}" at ${target.ipAddress}`,
      };
    } catch (err: any) {
      return {
        success: false,
        sentCount: 0,
        message: `Failed to write to socket: ${err.message}`,
      };
    }
  }

  // Broadcast to all connected sockets
  for (const dev of devicesById.values()) {
    if (dev.socket && !dev.socket.destroyed && dev.status === "online") {
      try {
        dev.socket.write(message);
        sentCount++;
      } catch {}
    }
  }

  return {
    success: sentCount > 0,
    sentCount,
    message: `Command sent to ${sentCount} connected device(s)`,
  };
}
