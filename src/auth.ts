// Auth: OTP via SMS (Zambia), JWT sessions, role guards.
import { signToken, verifyToken, TokenPayload, sha256Hex, randomCode, randomHex } from "./jwt";
import { sendSms } from "./sms";
import type { SmsEnv } from "./sms";

export interface AuthEnv extends SmsEnv {
  JWT_SECRET: string;
  OTP_TTL_MINUTES?: string;
  OTP_LOCKOUT_MINUTES?: string;
  SUPERADMIN_PHONES?: string;
}

const SUPERADMIN_ROLES = new Set(["superadmin", "admin"]);

/** Failed attempts allowed per OTP code before it is burned (brute-force cap). */
const MAX_OTP_ATTEMPTS = 5;

/** Phone lockout after the code is burned (OTP_LOCKOUT_MINUTES env, default 15). */
const DEFAULT_OTP_LOCKOUT_MINUTES = 15;

function otpLockoutMinutes(env?: AuthEnv): number {
  const n = Number(env?.OTP_LOCKOUT_MINUTES ?? DEFAULT_OTP_LOCKOUT_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_OTP_LOCKOUT_MINUTES;
}

/**
 * Returns the lockout expiry (datetime string) when the phone is currently
 * locked out, else null.
 */
export async function checkOtpLock(db: D1Database, phone: string): Promise<string | null> {
  try {
    const row = await db
      .prepare("SELECT locked_until FROM otp_lockouts WHERE phone = ? AND locked_until > datetime('now')")
      .bind(phone)
      .first<{ locked_until: string }>();
    return row?.locked_until ?? null;
  } catch (e) {
    console.error("otp_lockouts read failed (migration_004 applied?):", e);
    return null;
  }
}

/** Lock the phone for `minutes` (SQL-side clock so stored values compare against datetime('now')). */
async function lockPhone(db: D1Database, phone: string, minutes: number): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO otp_lockouts (phone, locked_until) VALUES (?, datetime('now', ?))
         ON CONFLICT(phone) DO UPDATE SET locked_until = excluded.locked_until`
      )
      .bind(phone, `+${minutes} minutes`)
      .run();
  } catch (e) {
    console.error("otp_lockouts write failed (migration_004 applied?):", e);
  }
}

async function clearPhoneLock(db: D1Database, phone: string): Promise<void> {
  try {
    await db.prepare("DELETE FROM otp_lockouts WHERE phone = ?").bind(phone).run();
  } catch (e) {
    console.error("otp_lockouts delete failed (migration_004 applied?):", e);
  }
}

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

export async function verifyOtp(db: D1Database, phone: string, code: string, env?: AuthEnv): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await db
    .prepare(
      `SELECT id, code_hash, attempts, expires_at FROM otps
       WHERE phone = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1`
    )
    .bind(phone, now)
    .first<{ id: number; code_hash: string; attempts: number; expires_at: string }>();
  if (!rows) return false;

  // Brute-force cap: burn the code after 5 failed tries so it cannot be retried.
  if (rows.attempts >= MAX_OTP_ATTEMPTS) {
    await db.prepare("UPDATE otps SET used = 1 WHERE id = ?").bind(rows.id).run();
    await lockPhone(db, phone, otpLockoutMinutes(env));
    return false;
  }

  const hash = await sha256Hex(String(code).trim());
  if (hash !== rows.code_hash) {
    const attempts = rows.attempts + 1;
    await db.prepare("UPDATE otps SET attempts = ?, used = CASE WHEN ? >= ? THEN 1 ELSE used END WHERE id = ?")
      .bind(attempts, attempts, MAX_OTP_ATTEMPTS, rows.id).run();
    if (attempts >= MAX_OTP_ATTEMPTS) await lockPhone(db, phone, otpLockoutMinutes(env));
    return false;
  }
  await db.prepare("UPDATE otps SET used = 1 WHERE id = ?").bind(rows.id).run();
  await clearPhoneLock(db, phone);
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
