import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import {
  db,
  accessLogsTable,
  vehiclesTable,
  espDevicesTable,
  rfidCardsTable,
} from "@workspace/db";
import {
  ListAccessLogsQueryParams,
  CreateAccessLogBody,
} from "@workspace/api-zod";
import { broadcast } from "../lib/ws";

const router: IRouter = Router();

function selectAccessLogRow() {
  return db
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
    .leftJoin(
      espDevicesTable,
      eq(accessLogsTable.deviceId, espDevicesTable.id),
    );
}

router.get("/access-logs", async (req, res): Promise<void> => {
  const query = ListAccessLogsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const {
    startDate,
    endDate,
    vehicleId,
    direction,
    authorized,
    search,
    sortBy,
    sortOrder,
    page,
    pageSize,
  } = query.data;

  const conditions = [];
  if (startDate) {
    conditions.push(gte(accessLogsTable.timestamp, new Date(`${startDate}T00:00:00.000Z`)));
  }
  if (endDate) {
    conditions.push(lte(accessLogsTable.timestamp, new Date(`${endDate}T23:59:59.999Z`)));
  }
  if (vehicleId) {
    conditions.push(eq(accessLogsTable.vehicleId, vehicleId));
  }
  if (direction) {
    conditions.push(eq(accessLogsTable.direction, direction));
  }
  if (authorized !== undefined) {
    conditions.push(eq(accessLogsTable.authorized, authorized));
  }
  if (search) {
    conditions.push(
      or(
        ilike(accessLogsTable.cardUid, `%${search}%`),
        ilike(vehiclesTable.plateNumber, `%${search}%`),
        ilike(vehiclesTable.ownerName, `%${search}%`),
      ),
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumn =
    sortBy === "plateNumber"
      ? vehiclesTable.plateNumber
      : sortBy === "direction"
        ? accessLogsTable.direction
        : accessLogsTable.timestamp;
  const orderFn = sortOrder === "asc" ? asc : desc;

  const [items, totalRow] = await Promise.all([
    selectAccessLogRow()
      .where(whereClause)
      .orderBy(orderFn(sortColumn))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(accessLogsTable)
      .leftJoin(vehiclesTable, eq(accessLogsTable.vehicleId, vehiclesTable.id))
      .where(whereClause),
  ]);

  res.json({
    items,
    total: totalRow[0]?.count ?? 0,
    page,
    pageSize,
  });
});

router.post("/access-logs", async (req, res): Promise<void> => {
  const parsed = CreateAccessLogBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { cardUid, direction, deviceId } = parsed.data;

  const [card] = await db
    .select()
    .from(rfidCardsTable)
    .where(eq(rfidCardsTable.cardUid, cardUid));

  const isRegistered = Boolean(card);
  const authorized = Boolean(card?.active);

  const [log] = await db
    .insert(accessLogsTable)
    .values({
      cardUid,
      direction,
      deviceId: deviceId ?? null,
      vehicleId: card?.vehicleId ?? null,
      authorized,
    })
    .returning();

  if (deviceId) {
    await db
      .update(espDevicesTable)
      .set({ status: "online", lastSeenAt: new Date() })
      .where(eq(espDevicesTable.id, deviceId));
  }

  const [enriched] = await selectAccessLogRow().where(eq(accessLogsTable.id, log!.id));

  if (enriched) {
    const payload = {
      ...enriched,
      isRegistered,
    };
    broadcast("access-log", payload);
    broadcast("access_log_created", payload);
    broadcast("tag_detected", {
      cardUid,
      isRegistered,
      authorized,
      direction,
      deviceId,
      deviceName: enriched.deviceName,
      plateNumber: enriched.plateNumber,
      ownerName: enriched.ownerName,
      carDetails: enriched.carDetails,
      timestamp: enriched.timestamp.toISOString(),
    });
    res.status(201).json(payload);
  } else {
    res.status(201).json(log);
  }
});

export default router;
