import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, espDevicesTable } from "@workspace/db";
import {
  CreateEspDeviceBody,
  UpdateEspDeviceParams,
  UpdateEspDeviceBody,
  DeleteEspDeviceParams,
  GetEspDeviceParams,
  SendEspHeartbeatParams,
  SendEspHeartbeatBody,
} from "@workspace/api-zod";
import { broadcast } from "../lib/ws";
import { getLiveDevices, sendDeviceCommand } from "../deviceRegistry";

const router: IRouter = Router();

router.get("/esp-devices", async (_req, res): Promise<void> => {
  const devices = await db
    .select()
    .from(espDevicesTable)
    .orderBy(espDevicesTable.createdAt);
  res.json(devices);
});

router.post("/esp-devices", async (req, res): Promise<void> => {
  const parsed = CreateEspDeviceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [device] = await db
    .insert(espDevicesTable)
    .values(parsed.data)
    .returning();

  broadcast("device-created", device);
  res.status(201).json(device);
});

router.get("/esp-devices/:id", async (req, res): Promise<void> => {
  const params = GetEspDeviceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [device] = await db
    .select()
    .from(espDevicesTable)
    .where(eq(espDevicesTable.id, params.data.id));

  if (!device) {
    res.status(404).json({ error: "ESP device not found" });
    return;
  }

  res.json(device);
});

router.patch("/esp-devices/:id", async (req, res): Promise<void> => {
  const params = UpdateEspDeviceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateEspDeviceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [device] = await db
    .update(espDevicesTable)
    .set(parsed.data)
    .where(eq(espDevicesTable.id, params.data.id))
    .returning();

  if (!device) {
    res.status(404).json({ error: "ESP device not found" });
    return;
  }

  broadcast("device-updated", device);
  res.json(device);
});

router.delete("/esp-devices/:id", async (req, res): Promise<void> => {
  const params = DeleteEspDeviceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [device] = await db
    .delete(espDevicesTable)
    .where(eq(espDevicesTable.id, params.data.id))
    .returning();

  if (!device) {
    res.status(404).json({ error: "ESP device not found" });
    return;
  }

  broadcast("device-deleted", { id: params.data.id });
  res.sendStatus(204);
});

router.post("/esp-devices/:id/heartbeat", async (req, res): Promise<void> => {
  const params = SendEspHeartbeatParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = SendEspHeartbeatBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [device] = await db
    .update(espDevicesTable)
    .set({
      status: "online",
      lastSeenAt: new Date(),
      ...(parsed.data.ipAddress ? { ipAddress: parsed.data.ipAddress } : {}),
    })
    .where(eq(espDevicesTable.id, params.data.id))
    .returning();

  if (!device) {
    res.status(404).json({ error: "ESP device not found" });
    return;
  }

  broadcast("device-status", device);
  res.json(device);
});

// Live Device Telemetry & Connected Devices endpoint
router.get("/devices/live", async (_req, res): Promise<void> => {
  const live = getLiveDevices();
  res.json(live);
});

// Send remote command to a connected ESP32 device
router.post("/devices/:id/command", async (req, res): Promise<void> => {
  const targetId = req.params.id;
  const payload = req.body || {};

  if (!payload.cmd && !payload.type) {
    res.status(400).json({ error: "Command payload must include 'cmd' or 'type'" });
    return;
  }

  const packet = {
    type: payload.type || "cmd",
    cmd: payload.cmd,
    ...payload,
  };

  const result = sendDeviceCommand(targetId, packet);
  if (!result.success) {
    res.status(404).json(result);
    return;
  }

  res.json(result);
});

export default router;
