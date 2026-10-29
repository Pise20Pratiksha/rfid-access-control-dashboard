import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const vehiclesTable = pgTable("vehicles", {
  id: serial("id").primaryKey(),
  plateNumber: text("plate_number").notNull(),
  ownerName: text("owner_name").notNull(),
  carDetails: text("car_details"),
  vehicleType: text("vehicle_type").notNull().default("car"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertVehicleSchema = createInsertSchema(vehiclesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertVehicle = z.infer<typeof insertVehicleSchema>;
export type VehicleRow = typeof vehiclesTable.$inferSelect;
