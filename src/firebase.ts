// FCM push via firebase-admin (adapted from Kingdom Sponsor, projectId from env).
import { getApps, initializeApp, cert, App } from "firebase-admin/app";
import { getMessaging, Messaging } from "firebase-admin/messaging";

let _app: App | null = null;
let _messaging: Messaging | null = null;

export interface FirebaseEnv {
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
  FIREBASE_PROJECT_ID: string;
}

export function getFirebaseAdmin(env: FirebaseEnv): App {
  if (_app) return _app;
  const privateKey = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
  _app = initializeApp({
    credential: cert({
      projectId: env.FIREBASE_PROJECT_ID || "sell-on-app",
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
  return _app;
}

function getMessagingClient(env: FirebaseEnv): Messaging {
  if (_messaging) return _messaging;
  _messaging = getMessaging(getFirebaseAdmin(env));
  return _messaging;
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendPushNotification(
  env: FirebaseEnv,
  fcmToken: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const msg = getMessagingClient(env);
      await msg.send({
        token: fcmToken,
        notification: { title, body },
        data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
        android: { priority: "high" as const, ttl: 3600000 },
        apns: { payload: { aps: { contentAvailable: true, sound: "default" } } },
      });
      return true;
    } catch (e: any) {
      const code = e?.code ?? "";
      if (code.includes("invalid-registration-token") || code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
        return false;
      }
      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS * (attempt + 1));
      } else {
        console.error("FCM send failed after retries:", e);
      }
    }
  }
  return false;
}

export async function sendMulticastPush(
  env: FirebaseEnv,
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<{ success: number; failure: number; failedTokens: string[] }> {
  if (!tokens.length) return { success: 0, failure: 0, failedTokens: [] };
  const payload = {
    tokens,
    notification: { title, body },
    data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
    android: { priority: "high" as const, ttl: 3600000 },
    apns: { payload: { aps: { contentAvailable: true, sound: "default" } } },
  };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const msg = getMessagingClient(env);
      const res = await msg.sendEachForMulticast(payload);
      const failedTokens: string[] = [];
      const nonRetryableErrors = ["invalid-registration-token", "registration-token-not-registered", "invalid-argument"];
      res.responses.forEach((r, i) => {
        if (!r.success && r.error) {
          const code = r.error.code ?? "";
          if (nonRetryableErrors.some((e) => code.includes(e)) || attempt >= MAX_RETRIES) {
            failedTokens.push(tokens[i]);
          }
        }
      });
      return { success: res.successCount, failure: res.failureCount, failedTokens };
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS * (attempt + 1));
      } else {
        console.error("FCM multicast failed after retries:", e);
        return { success: 0, failure: tokens.length, failedTokens: tokens };
      }
    }
  }
  return { success: 0, failure: tokens.length, failedTokens: tokens };
}

/** Push to all users whose fcm_token is set. */
export async function pushAllUsers(
  db: D1Database,
  env: FirebaseEnv,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<{ success: number; failure: number }> {
  const rows = await db
    .prepare("SELECT fcm_token FROM users WHERE fcm_token IS NOT NULL AND fcm_token != '' AND notifications_enabled = 1")
    .all<{ fcm_token: string }>();
  const tokens = rows.results?.map((r) => r.fcm_token) ?? [];
  const res = await sendMulticastPush(env, tokens, title, body, data);
  return { success: res.success, failure: res.failure };
}

/** Push to all admins/superadmins (platform alerts). */
export async function pushAdmins(
  db: D1Database,
  env: FirebaseEnv,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<{ success: number; failure: number }> {
  const rows = await db
    .prepare("SELECT fcm_token FROM users WHERE role IN ('admin','superadmin') AND fcm_token IS NOT NULL AND fcm_token != ''")
    .all<{ fcm_token: string }>();
  const tokens = rows.results?.map((r) => r.fcm_token) ?? [];
  const res = await sendMulticastPush(env, tokens, title, body, data);
  return { success: res.success, failure: res.failure };
}

/** Push to a single user by id. */
export async function pushUser(
  db: D1Database,
  env: FirebaseEnv,
  userId: number,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<boolean> {
  const row = await db
    .prepare("SELECT fcm_token FROM users WHERE id = ?")
    .bind(userId)
    .first<{ fcm_token: string | null }>();
  if (!row?.fcm_token) return false;
  return sendPushNotification(env, row.fcm_token, title, body, data);
}
