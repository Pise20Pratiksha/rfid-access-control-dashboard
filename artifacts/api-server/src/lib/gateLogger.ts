import net from "net";
import os from "os";
import { eq, and } from "drizzle-orm";
import {
  db,
  accessLogsTable,
  vehiclesTable,
  espDevicesTable,
  rfidCardsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { broadcast } from "./ws";

const TCP_PORT = Number(process.env.ESP32_TCP_PORT ?? 5000);
const DEVICE_NAME = "ESP32 Gate Logger";

let esp32Socket: net.Socket | null = null;

export { getLocalIpAddress, getAllLocalIpv4Addresses, isLocalAddress } from "./networkUtils";

function parseESP32DateTime(dateStr: string, timeStr: string): Date | null {
  try {
    const [day, month, year] = dateStr.split("/").map(Number);
    const [hour, minute, second] = timeStr.split(":").map(Number);
    if ([day, month, year, hour, minute, second].some((n) => isNaN(n))) return null;
    const d = new Date(year, month - 1, day, hour, minute, second);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

async function getOrCreateESP32Device(ipAddress: string): Promise<number> {
  const [device] = await db
    .select()
    .from(espDevicesTable)
    .where(eq(espDevicesTable.name, DEVICE_NAME))
    .limit(1);

  const now = new Date();
  if (device) {
    const [updated] = await db
      .update(espDevicesTable)
      .set({ status: "online", lastSeenAt: now, ipAddress })
      .where(eq(espDevicesTable.id, device.id))
      .returning();
    broadcast("esp_device_heartbeat", updated);
    return device.id;
  } else {
    const [created] = await db
      .insert(espDevicesTable)
      .values({
        name: DEVICE_NAME,
        location: "Main Gate",
        ipAddress,
        status: "online",
        lastSeenAt: now,
      })
      .returning();
    broadcast("esp_device_created", created);
    return created.id;
  }
}

async function updateDeviceStatus(status: "online" | "offline") {
  try {
    const [device] = await db
      .select()
      .from(espDevicesTable)
      .where(eq(espDevicesTable.name, DEVICE_NAME))
      .limit(1);

    if (device) {
      const [updated] = await db
        .update(espDevicesTable)
        .set({ status, lastSeenAt: new Date() })
        .where(eq(espDevicesTable.id, device.id))
        .returning();
      broadcast("esp_device_heartbeat", updated);
    }
  } catch (err) {
    logger.error({ err }, "Failed to update ESP32 device status in database");
  }
}

async function processRecord(
  record: { epc: string; date: string; time: string; dir: string },
  deviceId: number
): Promise<boolean> {
  const { epc, date, time, dir } = record;
  const timestamp = parseESP32DateTime(date, time);
  if (!timestamp) {
    logger.warn({ record }, "Skipping record due to invalid date/time values");
    return false;
  }

  const [existing] = await db
    .select()
    .from(accessLogsTable)
    .where(
      and(
        eq(accessLogsTable.cardUid, epc),
        eq(accessLogsTable.direction, dir),
        eq(accessLogsTable.timestamp, timestamp)
      )
    )
    .limit(1);

  if (existing) return false;

  const [card] = await db
    .select()
    .from(rfidCardsTable)
    .where(eq(rfidCardsTable.cardUid, epc))
    .limit(1);

  const isRegistered = Boolean(card);
  const authorized = Boolean(card?.active);

  const [inserted] = await db
    .insert(accessLogsTable)
    .values({
      cardUid: epc,
      direction: dir,
      deviceId,
      vehicleId: card?.vehicleId ?? null,
      authorized,
      timestamp,
    })
    .returning();

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
      deviceName: espDevicesTable.name,
      timestamp: accessLogsTable.timestamp,
    })
    .from(accessLogsTable)
    .leftJoin(vehiclesTable, eq(accessLogsTable.vehicleId, vehiclesTable.id))
    .leftJoin(espDevicesTable, eq(accessLogsTable.deviceId, espDevicesTable.id))
    .where(eq(accessLogsTable.id, inserted.id))
    .limit(1);

  if (enriched) {
    const payload = {
      ...enriched,
      isRegistered,
    };
    broadcast("access_log_created", payload);
    broadcast("tag_detected", {
      cardUid: epc,
      isRegistered,
      authorized,
      direction: dir,
      deviceId,
      deviceName: enriched.deviceName || DEVICE_NAME,
      plateNumber: enriched.plateNumber,
      ownerName: enriched.ownerName,
      carDetails: enriched.carDetails,
      timestamp: timestamp.toISOString(),
    });
  }
  return true;
}

function sendToESP32(obj: Record<string, unknown>) {
  if (esp32Socket && !esp32Socket.destroyed) {
    esp32Socket.write(JSON.stringify(obj) + "\n");
  }
}

export function initESP32ConnectionService(): void {
  // Delegated to unified bidirectional TCP server
  logger.info("[ESP32 Service] Initializing unified ESP32 TCP server on port " + TCP_PORT);
}