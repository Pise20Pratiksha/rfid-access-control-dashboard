import * as client from "openid-client";
import crypto from "crypto";
import { type Request, type Response } from "express";
import { db, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { AuthUser } from "@workspace/api-zod";

export const ISSUER_URL = process.env.ISSUER_URL ?? "https://replit.com/oidc";
export const SESSION_COOKIE = "sid";
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

export interface SessionData {
  user: AuthUser;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

let oidcConfig: client.Configuration | null = null;

export async function getOidcConfig(): Promise<client.Configuration> {
  if (!oidcConfig) {
    oidcConfig = await client.discovery(
      new URL(ISSUER_URL),
      process.env.REPL_ID!,
    );
  }
  return oidcConfig;
}

export async function createSession(data: SessionData): Promise<string> {
  const sid = crypto.randomBytes(32).toString("hex");
  await db.insert(sessionsTable).values({
    sid,
    sess: data as unknown as Record<string, unknown>,
    expire: new Date(Date.now() + SESSION_TTL),
  });
  return sid;
}

export async function getSession(sid: string): Promise<SessionData | null> {
  const [row] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.sid, sid));

  if (!row || row.expire < new Date()) {
    if (row) await deleteSession(sid);
    return null;
  }

  return row.sess as unknown as SessionData;
}

export async function updateSession(
  sid: string,
  data: SessionData,
): Promise<void> {
  await db
    .update(sessionsTable)
    .set({
      sess: data as unknown as Record<string, unknown>,
      expire: new Date(Date.now() + SESSION_TTL),
    })
    .where(eq(sessionsTable.sid, sid));
}

export async function deleteSession(sid: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
}

export async function clearSession(
  res: Response,
  sid?: string,
): Promise<void> {
  if (sid) await deleteSession(sid);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function getSessionId(req: Request): string | undefined {
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return req.cookies?.[SESSION_COOKIE];
}

function safeEqual(a: string, b: string): boolean {
  // Hash first so the comparison is constant-time regardless of input length.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Refuses to boot a production server that still uses the published default login. */
export function assertProductionCredentials(): void {
  if (process.env.NODE_ENV !== "production") return;
  const user = process.env.ADMIN_USERNAME?.trim();
  const pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass || pass === "admin" || pass.length < 10) {
    throw new Error(
      "ADMIN_USERNAME and a strong ADMIN_PASSWORD (10+ chars, not the default) must be set in production",
    );
  }
}

export function validateLocalCredentials(username: string, password: string): boolean {
  const adminUser = process.env.ADMIN_USERNAME ?? "admin";
  const adminPass = process.env.ADMIN_PASSWORD ?? "admin";
  const userOk = safeEqual(username, adminUser);
  const passOk = safeEqual(password, adminPass);
  return userOk && passOk;
}

export function makeLocalUser(): AuthUser {
  const adminUser = process.env.ADMIN_USERNAME ?? "admin";
  return {
    id: "local-admin",
    email: `${adminUser}@localhost.local`,
    firstName: adminUser,
    lastName: null,
    profileImageUrl: null,
  };
}
