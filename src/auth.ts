// Auth: OTP via SMS (Zambia), JWT sessions, role guards.
import { signToken, verifyToken, TokenPayload, sha256Hex, randomCode, randomHex } from "./jwt";
import { sendSms } from "./sms";
import type { SmsEnv } from "./sms";

export interface AuthEnv extends SmsEnv {
  JWT_SECRET: string;
  OTP_TTL_MINUTES?: string;
  SUPERADMIN_PHONES?: string;
}

const SUPERADMIN_ROLES = new Set(["superadmin", "admin"]);

/** True if the phone is a platform superadmin (from SUPERADMIN_PHONES secret). */
export function isSuperadminPhone(env: AuthEnv, phone: string): boolean {
  const phones = (env.SUPERADMIN_PHONES ?? "")
    .split(",")
    .map((p) => p.trim().replace(/^\+/, ""))
    .filter(Boolean);
  return phones.includes(phone.replace(/^\+/, ""));
}

export async function requestOtp(db: D1Database, env: AuthEnv, phone: string): Promise<{ ok: boolean; debugCode?: string }> {
  const code = randomCode(6);
  const codeHash = await sha256Hex(code);
  const ttlMinutes = Number(env.OTP_TTL_MINUTES ?? "5");
  const expires = new Date(Date.now() + ttlMinutes * 60_000).toISOString();

  await db
    .prepare("INSERT INTO otps (phone, code_hash, expires_at) VALUES (?, ?, ?)")
    .bind(phone, codeHash, expires)
    .run();

  // Cooldown: one valid code per phone at a time (older ones now ignored on verify).
  try {
    await sendSms(env, phone, `GRANDELEPHANTS: Your Grand Elephants verification code is ${code}. It expires in ${ttlMinutes} minutes. Do not share it.`);
  } catch (e) {
    console.error("OTP SMS failed:", e);
  }
  return { ok: true, ...(env.ENV !== "production" ? { debugCode: code } : {}) };
}

export async function verifyOtp(db: D1Database, phone: string, code: string): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await db
    .prepare(
      `SELECT id, code_hash, attempts, expires_at FROM otps
       WHERE phone = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1`
    )
    .bind(phone, now)
    .first<{ id: number; code_hash: string; attempts: number; expires_at: string }>();
  if (!rows) return false;

  const hash = await sha256Hex(String(code).trim());
  if (hash !== rows.code_hash) {
    await db.prepare("UPDATE otps SET attempts = attempts + 1 WHERE id = ?").bind(rows.id).run();
    return false;
  }
  await db.prepare("UPDATE otps SET used = 1 WHERE id = ?").bind(rows.id).run();
  return true;
}

export async function issueToken(env: AuthEnv, user: { id: number; phone: string; role: string }): Promise<string> {
  return signToken({ sub: user.id, phone: user.phone, role: user.role }, env.JWT_SECRET);
}

export async function authFromRequest(db: D1Database, env: AuthEnv, req: Request): Promise<{ id: number; phone: string; role: string; user: any } | null> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  const payload: TokenPayload | null = await verifyToken(token, env.JWT_SECRET);
  if (!payload) return null;
  const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(payload.sub).first<any>();
  if (!row) return null;
  return { id: row.id, phone: row.phone, role: row.role, user: row };
}

export function hasRole(user: { role: string }, ...roles: string[]): boolean {
  return roles.includes(user.role) || (roles.includes("admin") && SUPERADMIN_ROLES.has(user.role));
}

/** Shap user DB row into the Flutter `User` JSON (uid/name/email/role/riderStatus/...). */
export function userJson(row: any): Record<string, unknown> {
  return {
    uid: String(row.id),
    name: row.name ?? "",
    email: row.email ?? "",
    phone: row.phone ?? "",
    role: row.role ?? "user",
    riderStatus: row.rider_status ?? "none",
    riderLocation: row.rider_lat != null && row.rider_lng != null
      ? { lat: row.rider_lat, lng: row.rider_lng, address: row.rider_address ?? "" }
      : null,
    profilePhoto: row.profile_photo ?? "",
    bikePhoto: row.bike_photo ?? "",
    businessId: row.business_id ?? null,
    tpin: row.tpin ?? "",
    notificationsEnabled: (row.notifications_enabled ?? 1) === 1,
    createdAt: row.created_at,
  };
}
