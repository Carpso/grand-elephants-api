// Grand Elephants marketplace backend.
// Cloudflare Worker + D1 + Lipila (server-side payments) + Africa's Talking SMS + FCM push.
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import {
  createCollection, createCardCollection, createDisbursement,
  checkDisbursementStatus, checkWalletBalance, LipilaEnv,
} from "./lipila";
import { parseSettings, computeOrderTotals, payoutNetCents, loadFeeSettings, invalidateFeeSettings, FeeSettings } from "./fees";
import { requestOtp, verifyOtp, issueToken, authFromRequest, isSuperadminPhone, hasRole, userJson, AuthEnv } from "./auth";
import { sendSms } from "./sms";
import { pushUser, pushAdmins, pushAllUsers, FirebaseEnv } from "./firebase";
import { nextInvoiceNo, syncInvoiceToZra } from "./invoice";
import { submitInvoice, SmartInvoiceSubmission } from "./smart_invoice";
import { isValidCategory } from "./categories";
import { randomHex, sha256Hex } from "./jwt";
import * as msg from "./messages";

type Env = AuthEnv &
  LipilaEnv &
  FirebaseEnv & {
    DB: D1Database;
    APP_URL?: string;
    CORS_ORIGINS?: string;
    VAT_PCT?: string;
    PLATFORM_COMMISSION_PCT?: string;
    DELIVERY_BASE_FEE_CENTS?: string;
    DELIVERY_PER_KM_CENTS?: string;
    LIPILA_COLLECTION_FEE_PCT?: string;
    LIPILA_DISBURSEMENT_FEE_PCT?: string;
    CARD_LIPILA_COLLECTION_FEE_PCT?: string;
    ZRA_API_KEY?: string;
  };

const app = new Hono<{ Bindings: Env }>();

/** Handler context for routes extracted into named functions. */
type Ctx = Context<{ Bindings: Env }>;

app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization"] }));

const json = (c: any, data: unknown, status = 200) => c.json(data, status);
const badRequest = (c: any, message: string) => json(c, { error: message }, 400);
const unauthorized = (c: any, message = "Unauthorized") => json(c, { error: message }, 401);
const notFound = (c: any, message = "Not found") => json(c, { error: message }, 404);

async function body(c: any): Promise<any> {
  try { return await c.req.json(); } catch { return {}; }
}

// ---------- helpers ----------

function makeOrderId(): string {
  const epoch = String(Date.now()).slice(-6);
  const rand = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
  return `ORD-${epoch}-${rand}`;
}

function normPhone(p: string): string {
  return p.replace(/\D/g, "").replace(/^0/, "260").replace(/^260/, "260").replace(/^\+/, "");
}

async function getBusiness(db: D1Database, id: number) {
  return db.prepare("SELECT * FROM businesses WHERE id = ?").bind(id).first<any>();
}

async function canManageBusiness(db: D1Database, userId: number, businessId: number): Promise<boolean> {
  const u = await db.prepare("SELECT role, business_id FROM users WHERE id = ?").bind(userId).first<any>();
  if (!u) return false;
  if (hasRole(u, "admin", "superadmin")) return true;
  if (u.business_id === businessId) return true;
  const member = await db.prepare("SELECT id FROM business_members WHERE business_id = ? AND user_id = ?").bind(businessId, userId).first();
  return !!member;
}

/**
 * Platform business used when an admin acts without a business_id:
 * the seeded/"Grand Elephants" business, else any approved one, else the first
 * row, else a freshly created "Grand Elephants" business owned by the admin.
 */
async function resolveDefaultBusiness(db: D1Database, adminUserId: number): Promise<number> {
  const seeded = await db.prepare("SELECT id FROM businesses WHERE name LIKE 'Grand Elephants%' ORDER BY id LIMIT 1").first<any>();
  if (seeded) return Number(seeded.id);
  const approved = await db.prepare("SELECT id FROM businesses WHERE status = 'approved' ORDER BY id LIMIT 1").first<any>();
  if (approved) return Number(approved.id);
  const first = await db.prepare("SELECT id FROM businesses ORDER BY id LIMIT 1").first<any>();
  if (first) return Number(first.id);
  const r = await db.prepare(
    "INSERT INTO businesses (owner_user_id, name, slogan, description, address, status) VALUES (?, 'Grand Elephants', '', '', '', 'approved')"
  ).bind(adminUserId).run();
  const newId = Number(r.meta.last_row_id);
  await db.prepare("INSERT OR IGNORE INTO wallets (business_id, balance_cents, held_cents) VALUES (?, 0, 0)").bind(newId).run();
  return newId;
}

/**
 * Business scope for the `/api/businesses/me/products*` routes.
 * Returns the business id to operate on, or null when the caller may not.
 * Admins/superadmins are always allowed (own business, explicit businessId,
 * or the default platform business).
 */
async function businessScope(db: D1Database, a: { id: number; user: any }, req: any = {}): Promise<number | null> {
  const isAdmin = hasRole(a.user, "admin", "superadmin");
  if (isAdmin && req.businessId !== undefined && req.businessId !== null && req.businessId !== "") {
    const id = Number(req.businessId);
    const biz = Number.isInteger(id) && id > 0 ? await getBusiness(db, id) : null;
    return biz ? Number(biz.id) : null;
  }
  if (a.user.business_id) return Number(a.user.business_id);
  if (isAdmin) return resolveDefaultBusiness(db, a.id);
  return null;
}

/** Env vars read as fee fallbacks by `loadFeeSettings` (DB app_settings win). */
function feeEnvRaw(env: Env): Record<string, string | undefined> {
  return {
    VAT_PCT: env.VAT_PCT, PLATFORM_COMMISSION_PCT: env.PLATFORM_COMMISSION_PCT,
    DELIVERY_BASE_FEE_CENTS: env.DELIVERY_BASE_FEE_CENTS, DELIVERY_PER_KM_CENTS: env.DELIVERY_PER_KM_CENTS,
    LIPILA_COLLECTION_FEE_PCT: env.LIPILA_COLLECTION_FEE_PCT,
    LIPILA_DISBURSEMENT_FEE_PCT: env.LIPILA_DISBURSEMENT_FEE_PCT,
    CARD_LIPILA_COLLECTION_FEE_PCT: env.CARD_LIPILA_COLLECTION_FEE_PCT,
  };
}

async function feesOf(env: Env, db: D1Database, businessId?: number): Promise<{ feeSettings: FeeSettings; commissionPct: number }> {
  const feeSettings = await loadFeeSettings(db, feeEnvRaw(env));
  let commissionPct = feeSettings.commissionPct;
  if (businessId) {
    const b = await getBusiness(db, businessId);
    if (b?.commission_pct != null) commissionPct = Number(b.commission_pct);
  }
  return { feeSettings, commissionPct };
}

function productJson(row: any): Record<string, unknown> {
  return {
    id: String(row.id),
    name: row.name,
    price: row.price_cents / 100,
    priceCents: row.price_cents,
    image: row.image ?? "",
    description: row.description ?? "",
    category: row.category ?? "",
    isGhost: row.is_ghost === 1,
    stock: row.stock ?? 0,
    active: row.active === 1,
    businessId: String(row.business_id),
    businessName: row.business_name ?? "",
    createdAt: row.created_at,
  };
}

async function orderJson(db: D1Database, row: any): Promise<Record<string, unknown>> {
  const items = await db
    .prepare("SELECT id, product_id, name, price_cents, image, quantity FROM order_items WHERE order_id = ?")
    .bind(row.id)
    .all<any>();
  const biz = await db.prepare("SELECT name, address, tpin FROM businesses WHERE id = ?").bind(row.business_id).first<any>();
  const rider = row.rider_id ? await db.prepare("SELECT id, name, phone, vehicle FROM riders WHERE id = ?").bind(row.rider_id).first<any>() : null;
  const invoice = await db.prepare("SELECT invoice_no, status FROM invoices WHERE order_id = ?").bind(row.id).first<any>();
  return {
    id: row.id,
    orderNumber: row.id,
    items: (items.results ?? []).map((it) => ({
      id: String(it.product_id ?? it.id),
      name: it.name,
      price: it.price_cents / 100,
      priceCents: it.price_cents,
      image: it.image ?? "",
      quantity: it.quantity,
      lineTotalCents: it.price_cents * it.quantity,
    })),
    subtotal: row.subtotal_cents / 100,
    subtotalCents: row.subtotal_cents,
    deliveryFee: row.delivery_fee_cents / 100,
    deliveryFeeCents: row.delivery_fee_cents,
    vatCents: row.vat_cents,
    total: row.total_cents / 100,
    totalCents: row.total_cents,
    date: row.created_at,
    status: row.status,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    transactionId: row.transaction_id,
    referenceId: row.reference_id,
    deliveryAddress: row.delivery_address ?? "",
    deliveryMethod: row.delivery_method ?? "standard",
    customerPhone: row.customer_phone ?? "",
    notes: row.notes ?? "",
    businessId: String(row.business_id),
    businessName: row.business_name ?? biz?.name ?? "",
    businessAddress: biz?.address ?? "",
    businessTpin: biz?.tpin ?? "",
    buyerTpin: row.buyer_tpin ?? "",
    riderId: row.rider_id ? String(row.rider_id) : null,
    riderName: rider?.name ?? "",
    riderVehicle: rider?.vehicle ?? "",
    invoiceNo: invoice?.invoice_no ?? null,
    invoiceStatus: invoice?.status ?? null,
    proofPhoto: row.proof_photo ?? "",
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
  };
}

async function pushNotif(db: D1Database, env: Env, userId: number, title: string, message: string, type = "info", data?: Record<string, string>) {
  await db.prepare("INSERT INTO notifications (user_id, title, message, type, data) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, title, message, type, data ? JSON.stringify(data) : null).run();
  if (env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    await pushUser(db, env, userId, title, message, data);
  }
}

async function logAction(db: D1Database, adminUserId: number | null, action: string, entityType: string, entityId: string | null, details?: unknown) {
  await db.prepare("INSERT INTO admin_actions (admin_user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)")
    .bind(adminUserId, action, entityType, entityId, details ? JSON.stringify(details) : null).run();
}

/** Marks an order paid, credits the business wallet, creates the ZRA invoice. Idempotent. */
async function confirmOrder(db: D1Database, env: Env, orderId: string, transactionId?: string) {
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first<any>();
  if (!order) return { ok: false, error: "order not found" };
  if (order.payment_status === "successful") return { ok: true, already: true };

  const biz = await getBusiness(db, order.business_id);
  const feeSettings = await loadFeeSettings(db, feeEnvRaw(env));
  const commissionPct = biz?.commission_pct != null ? Number(biz.commission_pct) : feeSettings.commissionPct;
  const goodsShare = order.subtotal_cents - Math.round(order.subtotal_cents * (commissionPct / 100));

  await db.batch([
    db.prepare("UPDATE orders SET payment_status = 'successful', transaction_id = ?, status = 'Confirmed', updated_at = datetime('now') WHERE id = ?")
      .bind(transactionId ?? null, orderId),
    db.prepare(`INSERT INTO wallets (business_id, balance_cents, held_cents, updated_at) VALUES (?, ?, 0, datetime('now'))
                ON CONFLICT(business_id) DO UPDATE SET balance_cents = balance_cents + excluded.balance_cents, updated_at = datetime('now')`)
      .bind(order.business_id, goodsShare),
  ]);

  // Invoice (ZRA-ready)
  const invoiceNo = await nextInvoiceNo(db);
  const inv = await db.prepare(
    `INSERT INTO invoices (invoice_no, order_id, business_id, customer_id, tp_in, buyer_tpin, status, subtotal_cents, vat_cents, total_cents)
     VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?)`
  ).bind(invoiceNo, orderId, order.business_id, order.user_id, null, order.buyer_tpin ?? null,
    order.subtotal_cents, order.vat_cents, order.total_cents).run();
  const lines = await db.prepare("SELECT name, price_cents, quantity FROM order_items WHERE order_id = ?").bind(orderId).all<any>();
  for (const l of lines.results ?? []) {
    await db.prepare("INSERT INTO invoice_items (invoice_id, name, price_cents, quantity, vat_pct) VALUES (?, ?, ?, ?, ?)")
      .bind(inv.meta.last_row_id, l.name, l.price_cents, l.quantity, feeSettings.vatPct).run();
  }
  if (biz?.tpin) {
    await db.prepare("UPDATE invoices SET tp_in = ? WHERE id = ?").bind(biz.tpin, inv.meta.last_row_id).run();
    await syncInvoiceToZra(db, env, inv.meta.last_row_id);
  }

  // ZRA SmartInvoice submission seam (no-op stub until credentials exist).
  try {
    const submission: SmartInvoiceSubmission = {
      invoiceId: Number(inv.meta.last_row_id),
      invoiceNo,
      orderId,
      businessId: order.business_id,
      buyerTpin: order.buyer_tpin ?? "",
      sellerTpin: biz?.tpin ?? "",
      subtotalCents: order.subtotal_cents,
      vatCents: order.vat_cents,
      totalCents: order.total_cents,
      issuedAt: order.created_at ?? new Date().toISOString(),
    };
    await submitInvoice(env, submission);
  } catch (e) {
    console.error("smart_invoice submission failed:", e);
  }

  const bizName = biz?.name ?? "your shop";
  await pushNotif(db, env, order.user_id, "Order confirmed", `Order ${orderId} of ${msg.kwacha(order.total_cents)} is confirmed.`, "order", { orderId });
  const owner = await db.prepare("SELECT owner_user_id FROM businesses WHERE id = ?").bind(order.business_id).first<any>();
  if (owner) {
    await pushNotif(db, env, owner.owner_user_id, "New confirmed order", `Order ${orderId} of ${msg.kwacha(order.total_cents)} confirmed.`, "order", { orderId });
  }
  if (env.ENV === "production" && order.customer_phone) {
    await sendSms(env, order.customer_phone, msg.orderConfirmedSms(orderId, order.total_cents, bizName)).catch(() => {});
  }
  return { ok: true };
}

// ---------- health ----------

app.get("/health", (c) => json(c, { ok: true, service: "grand-elephants-api", time: new Date().toISOString() }));
// Alias: the Flutter app polls /api/health (system health modal).
app.get("/api/health", (c) => json(c, { ok: true, service: "grand-elephants-api", time: new Date().toISOString() }));

// ---------- auth ----------

app.post("/api/auth/request-otp", async (c) => {
  const { phone } = await body(c);
  if (!phone) return badRequest(c, "phone is required");
  const res = await requestOtp(c.env.DB, c.env, normPhone(phone));
  return json(c, { ok: res.ok, ...(res.debugCode ? { debugCode: res.debugCode } : {}) });
});

app.post("/api/auth/verify-otp", async (c) => {
  const { phone, code, name, email, role, fcmToken } = await body(c);
  const p = normPhone(phone ?? "");
  if (!p || !code) return badRequest(c, "phone and code are required");
  const ok = await verifyOtp(c.env.DB, p, String(code).trim());
  if (!ok) return unauthorized(c, "Invalid or expired code");

  let user = await c.env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(p).first<any>();
  const isSuper = isSuperadminPhone(c.env, p);
  if (!user) {
    const uid = `u_${randomHex(8)}`;
    const wantedRole = ["user", "rider", "business"].includes(role) ? role : "user";
    const r = await c.env.DB.prepare(
      "INSERT INTO users (uid, name, email, phone, role, fcm_token) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(uid, name ?? "", email ?? null, p, isSuper ? "superadmin" : wantedRole, fcmToken ?? null).run();
    user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(r.meta.last_row_id).first<any>();
  } else {
    if (name || email || fcmToken) {
      await c.env.DB.prepare("UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email), fcm_token = COALESCE(?, fcm_token), updated_at = datetime('now') WHERE id = ?")
        .bind(name ?? null, email ?? null, fcmToken ?? null, user.id).run();
      user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first<any>();
    }
  }
  const token = await issueToken(c.env, user);
  return json(c, { token, user: userJson(user) });
});

app.get("/api/me", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  let business = null;
  if (a.user.business_id) {
    const b = await getBusiness(c.env.DB, a.user.business_id);
    if (b) {
      const wallet = await c.env.DB.prepare("SELECT * FROM wallets WHERE business_id = ?").bind(b.id).first<any>();
      business = { ...b, balanceCents: wallet?.balance_cents ?? 0, heldCents: wallet?.held_cents ?? 0, status: b.status };
    }
  }
  return json(c, { user: userJson(a.user), business });
});

app.patch("/api/me", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const pick = (field: string, col: string) => {
    if (b[field] !== undefined) { sets.push(`${col} = ?`); vals.push(b[field] === "" ? null : b[field]); }
  };
  pick("name", "name"); pick("email", "email"); pick("profilePhoto", "profile_photo");
  pick("bikePhoto", "bike_photo"); pick("tpin", "tpin"); pick("fcmToken", "fcm_token");
  if (b.notificationsEnabled !== undefined) { sets.push("notifications_enabled = ?"); vals.push(b.notificationsEnabled ? 1 : 0); }
  if (b.riderLocation && typeof b.riderLocation.lat === "number") {
    sets.push("rider_lat = ?", "rider_lng = ?", "rider_address = ?");
    vals.push(b.riderLocation.lat, b.riderLocation.lng, b.riderLocation.address ?? "");
  }
  if (!sets.length) return badRequest(c, "nothing to update");
  vals.push(a.id);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).bind(...vals).run();
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(a.id).first<any>();
  return json(c, { user: userJson(user) });
});

// Employee / business dashboard stats (any authenticated user).

app.get("/api/employee/stats", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const own = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE user_id = ?").bind(a.id).first<any>();
  const ownOrders = Number(own?.n ?? 0);
  if (!a.user.business_id) {
    return json(c, { salesTodayCents: 0, salesTotalCents: 0, ordersToday: 0, ordersTotal: 0, pendingOrders: 0, ownOrders });
  }
  const agg = await c.env.DB.prepare(
    `SELECT
       COUNT(*) AS ordersTotal,
       COALESCE(SUM(CASE WHEN payment_status = 'successful' THEN total_cents ELSE 0 END), 0) AS salesTotalCents,
       COALESCE(SUM(CASE WHEN substr(created_at, 1, 10) = date('now') THEN 1 ELSE 0 END), 0) AS ordersToday,
       COALESCE(SUM(CASE WHEN substr(created_at, 1, 10) = date('now') AND payment_status = 'successful' THEN total_cents ELSE 0 END), 0) AS salesTodayCents,
       COALESCE(SUM(CASE WHEN status NOT IN ('Delivered', 'Cancelled', 'Refunded') THEN 1 ELSE 0 END), 0) AS pendingOrders
     FROM orders WHERE business_id = ?`
  ).bind(a.user.business_id).first<any>();
  return json(c, {
    salesTodayCents: Number(agg?.salesTodayCents ?? 0),
    salesTotalCents: Number(agg?.salesTotalCents ?? 0),
    ordersToday: Number(agg?.ordersToday ?? 0),
    ordersTotal: Number(agg?.ordersTotal ?? 0),
    pendingOrders: Number(agg?.pendingOrders ?? 0),
    ownOrders,
  });
});

// ---------- public catalog ----------

app.get("/api/config", async (c) => {
  const cats = await c.env.DB.prepare("SELECT id, name, icon, enabled FROM categories WHERE enabled = 1 ORDER BY id").all<any>();
  const banners = await c.env.DB.prepare("SELECT id, title, subtitle, image, link FROM banners WHERE active = 1").all<any>();
  const settings = await c.env.DB.prepare("SELECT key, value FROM app_settings").all<any>();
  const byKey = Object.fromEntries((settings.results ?? []).map((r) => [r.key, r.value]));
  const fees = await loadFeeSettings(c.env.DB, feeEnvRaw(c.env));
  return json(c, {
    appName: byKey.app_name || "Grand Elephants",
    appSlogan: byKey.app_slogan || "Move With Conviction",
    appLogo: byKey.app_logo || "",
    currency: "ZMW",
    categories: (cats.results ?? []).map((r) => ({ id: String(r.id), name: r.name, icon: r.icon, enabled: r.enabled === 1 })),
    banners: banners.results ?? [],
    zraEnabled: byKey.zra_enabled === "1",
    feeInfo: {
      vatPct: fees.vatPct,
      commissionPct: fees.commissionPct,
      deliveryBaseFeeCents: fees.deliveryBaseFeeCents,
      deliveryPerKmCents: fees.deliveryPerKmCents,
    },
  });
});

function envV(c: any, key: string, dflt: string): string {
  const v = (c.env as any)[key];
  return v === undefined || v === "" ? dflt : String(v);
}

app.get("/api/categories", async (c) => {
  const cats = await c.env.DB.prepare("SELECT id, name, icon FROM categories WHERE enabled = 1 ORDER BY id").all<any>();
  return json(c, (cats.results ?? []).map((r) => ({ id: String(r.id), name: r.name, icon: r.icon ?? "" })));
});

app.get("/api/businesses", async (c) => {  const rows = await c.env.DB.prepare("SELECT * FROM businesses WHERE status = 'approved' ORDER BY name").all<any>();
  return json(c, (rows.results ?? []).map((b) => ({
    id: String(b.id), name: b.name, slogan: b.slogan, description: b.description,
    logo: b.logo, address: b.address, verified: true,
  })));
});

app.get("/api/products", async (c) => {
  const { category, business, q, sort } = c.req.query();
  if (sort === "new" || sort === "trending" || sort === "suggested") {
    return json(c, await productFeed(c.env.DB, sort, c));
  }
  let sql = `SELECT p.*, b.name AS business_name FROM products p JOIN businesses b ON b.id = p.business_id WHERE p.active = 1 AND b.status = 'approved'`;
  const vals: unknown[] = [];
  if (category) { sql += " AND p.category = ?"; vals.push(category); }
  if (business) { sql += " AND p.business_id = ?"; vals.push(Number(business)); }
  if (q) { sql += " AND (p.name LIKE ? OR p.description LIKE ? OR b.name LIKE ?)"; vals.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += " ORDER BY p.id DESC LIMIT 200";
  const rows = await c.env.DB.prepare(sql).bind(...vals).all<any>();
  return json(c, (rows.results ?? []).map(productJson));
});

// Product discovery feeds. All three return the exact same array shape as
// GET /api/products (productJson[]); `?limit=` (1..50, default 12) applies.

const PRODUCT_FEED_BASE = "SELECT p.*, b.name AS business_name FROM products p JOIN businesses b ON b.id = p.business_id";
const PRODUCT_FEED_WHERE = " WHERE p.active = 1 AND b.status = 'approved'";
const UNITS_SOLD = "COALESCE(SUM(CASE WHEN o.payment_status = 'successful' THEN oi.quantity ELSE 0 END), 0) AS units_sold";
const SALES_JOINS = " LEFT JOIN order_items oi ON oi.product_id = p.id LEFT JOIN orders o ON o.id = oi.order_id";

function feedLimit(c: any, dflt = 12): number {
  const n = Math.floor(Number(c.req.query("limit")));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : dflt;
}

/** Newest products first (created_at DESC). */
async function newFeed(db: D1Database, limit: number) {
  const rows = await db.prepare(`${PRODUCT_FEED_BASE}${PRODUCT_FEED_WHERE} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`)
    .bind(limit).all<any>();
  return (rows.results ?? []).map(productJson);
}

/** Best sellers first (paid units sold), falling back to newest when nothing has sold. */
async function trendingFeed(db: D1Database, limit: number) {
  const rows = await db.prepare(
    `SELECT p.*, b.name AS business_name, ${UNITS_SOLD}
     FROM products p JOIN businesses b ON b.id = p.business_id${SALES_JOINS}
     WHERE p.active = 1 AND b.status = 'approved'
     GROUP BY p.id
     ORDER BY units_sold DESC, p.created_at DESC, p.id DESC
     LIMIT ?`
  ).bind(limit).all<any>();
  return (rows.results ?? []).map(productJson);
}

/** Signed-in: categories the buyer has bought before rank first, then best sellers. Anonymous: trending. */
async function suggestedFeed(db: D1Database, userId: number | null, limit: number) {
  if (userId != null) {
    const cats = await db.prepare(
      `SELECT DISTINCT p.category FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       WHERE o.user_id = ? AND p.category != ''`
    ).bind(userId).all<any>();
    const liked = (cats.results ?? []).map((r) => String(r.category)).slice(0, 10);
    if (liked.length) {
      const ph = liked.map(() => "?").join(",");
      const rows = await db.prepare(
        `SELECT p.*, b.name AS business_name,
           CASE WHEN p.category IN (${ph}) THEN 1 ELSE 0 END AS cat_rank, ${UNITS_SOLD}
         FROM products p JOIN businesses b ON b.id = p.business_id${SALES_JOINS}
         WHERE p.active = 1 AND b.status = 'approved'
         GROUP BY p.id
         ORDER BY cat_rank DESC, units_sold DESC, p.created_at DESC, p.id DESC
         LIMIT ?`
      ).bind(...liked, limit).all<any>();
      if (rows.results?.length) return (rows.results as any[]).map(productJson);
    }
  }
  return trendingFeed(db, limit);
}

async function productFeed(db: D1Database, sort: "new" | "trending" | "suggested", c: any): Promise<unknown[]> {
  const limit = feedLimit(c);
  if (sort === "new") return newFeed(db, limit);
  if (sort === "trending") return trendingFeed(db, limit);
  const a = await authFromRequest(db, c.env, c.req.raw); // token optional
  return suggestedFeed(db, a ? a.id : null, limit);
}

// Dedicated feed paths (registered BEFORE /api/products/:id so they are not
// swallowed by the :id wildcard).
app.get("/api/products/new", async (c) => json(c, await productFeed(c.env.DB, "new", c)));
app.get("/api/products/trending", async (c) => json(c, await productFeed(c.env.DB, "trending", c)));
app.get("/api/products/suggested", async (c) => json(c, await productFeed(c.env.DB, "suggested", c)));

app.get("/api/products/:id", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT p.*, b.name AS business_name FROM products p JOIN businesses b ON b.id = p.business_id WHERE p.id = ? AND p.active = 1 AND b.status = 'approved'"
  ).bind(Number(c.req.param("id"))).first<any>();
  if (!row) return notFound(c, "Product not found");
  const related = await c.env.DB.prepare(
    "SELECT p.*, b.name AS business_name FROM products p JOIN businesses b ON b.id = p.business_id WHERE p.business_id = ? AND p.id != ? AND p.active = 1 LIMIT 8"
  ).bind(row.business_id, row.id).all<any>();
  return json(c, { product: productJson(row), moreFromBusiness: (related.results ?? []).map(productJson) });
});

// ---------- orders (checkout) ----------

app.post("/api/orders", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return badRequest(c, "items are required");

  // Buyer ZRA TPIN: optional, integer-only, exactly 10 digits (spaces/dashes ignored).
  const buyerTpin = b.tpin === undefined || b.tpin === null ? "" : String(b.tpin).replace(/[\s-]/g, "");
  if (buyerTpin && !/^\d{10}$/.test(buyerTpin)) return badRequest(c, "tpin must be exactly 10 digits");

  // Load products and enforce a single business per order.
  const placeholders = items.map(() => "?").join(",");
  const ids = items.map((it: any) => Number(it.productId ?? it.id));
  const rows = await c.env.DB.prepare(
    `SELECT p.*, b.name AS business_name FROM products p JOIN businesses b ON b.id = p.business_id WHERE p.id IN (${placeholders}) AND p.active = 1`
  ).bind(...ids).all<any>();
  if (!rows.results?.length) return badRequest(c, "products not found");
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  const businessIds = new Set(rows.results.map((r) => r.business_id));
  if (businessIds.size !== 1) return badRequest(c, "cart must contain products from one business only");
  const businessId = rows.results[0].business_id;
  const biz = await getBusiness(c.env.DB, businessId);
  if (!biz || biz.status !== "approved") return badRequest(c, "business is not active");

  const normalized: { productId: number; quantity: number; priceCents: number; name: string; image: string; description: string }[] = [];
  for (const it of items) {
    const q = Math.max(1, Math.floor(Number(it.quantity) || 1));
    const p = byId.get(Number(it.productId ?? it.id));
    if (!p) return badRequest(c, "product not found");
    if (p.stock > 0 && p.stock < q) return badRequest(c, `Only ${p.stock} of "${p.name}" in stock`);
    normalized.push({ productId: p.id, quantity: q, priceCents: p.price_cents, name: p.name, image: p.image ?? "", description: p.description ?? "" });
  }

  const deliveryKm = Math.min(50, Math.max(0, Number(b.deliveryKm) || 0));
  const paymentMethod = b.paymentMethod === "card" ? "card" : "mobile_money";
  const { feeSettings, commissionPct } = await feesOf(c.env, c.env.DB, businessId);
  const totals = computeOrderTotals(feeSettings, {
    items: normalized.map((n) => ({ priceCents: n.priceCents, quantity: n.quantity })),
    deliveryKm,
    paymentMethod,
    businessCommissionPct: commissionPct,
  });

  const orderId = makeOrderId();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO orders (id, user_id, business_id, subtotal_cents, delivery_fee_cents, vat_cents, total_cents, status, payment_method, payment_status,
        delivery_address, delivery_method, customer_phone, notes, reference_id, buyer_tpin)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?, 'pending', ?, ?, ?, ?, ?, ?)`
    ).bind(orderId, a.id, businessId, totals.subtotalCents, totals.deliveryFeeCents, totals.vatCents, totals.totalCents,
      paymentMethod, b.deliveryAddress ?? "", b.deliveryMethod ?? "standard", normPhone(b.customerPhone ?? a.user.phone), b.notes ?? null, orderId,
      buyerTpin || null),
    ...normalized.map((n) => c.env.DB.prepare(
      "INSERT INTO order_items (order_id, product_id, name, price_cents, image, quantity) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(orderId, n.productId, n.name, n.priceCents, n.image, n.quantity)),
  ]);

  const callbackUrl = `${envV(c, "APP_URL", "https://grand-elephants-api.godfreymoseskalambo.workers.dev")}/api/webhooks/lipila`;
  let lipila: any = null;
  try {
    if (paymentMethod === "card") {
      const res = await createCardCollection(c.env, {
        referenceId: orderId,
        amountCents: totals.totalCents,
        narration: `Payment to ${biz.name}`,
        callbackUrl,
        customerInfo: {
          firstName: (a.user.name || "Sell On").split(" ")[0],
          lastName: a.user.name?.split(" ").slice(1).join(" ") || "App",
          phoneNumber: a.user.phone,
          email: a.user.email || `${a.id}@grandelephants.app`,
        },
        backUrl: "",
      }, c.env.DB);
      lipila = { status: res.status, referenceId: res.referenceId, cardRedirectionUrl: res.cardRedirectionUrl };
    } else {
      const res = await createCollection(c.env, {
        referenceId: orderId,
        amountCents: totals.totalCents,
        accountNumber: normPhone(b.customerPhone ?? a.user.phone),
        narration: `Payment to ${biz.name}`,
        callbackUrl,
      }, c.env.DB);
      lipila = { status: res.status, referenceId: res.referenceId, message: res.status === "pending" ? "Check your phone to approve the payment." : "" };
      if (res.status?.toLowerCase().includes("success")) {
        await confirmOrder(c.env.DB, c.env, orderId, res.identifier);
      }
    }
  } catch (e: any) {
    console.error("Lipila collection failed:", e);
    await c.env.DB.prepare("UPDATE orders SET payment_status = 'failed', updated_at = datetime('now') WHERE id = ?").bind(orderId).run();
    await logAction(c.env.DB, null, "lipila_collection_failed", "order", orderId, String(e.message ?? e).slice(0, 500));
  }

  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first<any>();
  return json(c, { order: await orderJson(c.env.DB, order), lipila, feeSummary: totals, paymentMethod }, 201);
});

app.get("/api/orders", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const rows = await c.env.DB.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").bind(a.id).all<any>();
  const out = [];
  for (const r of rows.results ?? []) out.push(await orderJson(c.env.DB, r));
  return json(c, out);
});

/** Buyer, assigned rider, or anyone who manages the seller business. */
async function canViewOrder(db: D1Database, a: { id: number; user: any }, row: any): Promise<boolean> {
  if (row.user_id === a.id) return true;
  if (a.user.role === "rider" && row.rider_id) {
    const assigned = await db.prepare("SELECT id FROM riders WHERE id = ? AND user_id = ?").bind(row.rider_id, a.id).first();
    if (assigned) return true;
  }
  return canManageBusiness(db, a.id, row.business_id);
}

app.get("/api/orders/:id", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const row = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(c.req.param("id")).first<any>();
  if (!row) return notFound(c, "Order not found");
  if (!await canViewOrder(c.env.DB, a, row)) return unauthorized(c, "Not your order");
  return json(c, { order: await orderJson(c.env.DB, row) });
});

/**
 * Printable receipt for one order (same access rule as GET /api/orders/:id).
 * Response: { receipt: { orderNumber, invoiceNo, status, paymentMethod,
 * paymentStatus, transactionId, referenceId, createdAt, deliveredAt, currency,
 * business: { id, name, address, tpin },
 * buyer: { name, phone, tpin },
 * delivery: { address, method, feeCents, riderName },
 * items: [{ name, image, unitPriceCents, quantity, lineTotalCents }],
 * subtotalCents, vatPct, vatCents, deliveryFeeCents, totalCents } }
 */
app.get("/api/orders/:id/receipt", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const row = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(c.req.param("id")).first<any>();
  if (!row) return notFound(c, "Order not found");
  if (!await canViewOrder(c.env.DB, a, row)) return unauthorized(c, "Not your order");

  const [biz, buyer, invoice, items, rider, feeSettings] = await Promise.all([
    c.env.DB.prepare("SELECT id, name, address, tpin FROM businesses WHERE id = ?").bind(row.business_id).first<any>(),
    c.env.DB.prepare("SELECT name, phone FROM users WHERE id = ?").bind(row.user_id).first<any>(),
    c.env.DB.prepare("SELECT invoice_no FROM invoices WHERE order_id = ?").bind(row.id).first<any>(),
    c.env.DB.prepare("SELECT name, price_cents, image, quantity FROM order_items WHERE order_id = ?").bind(row.id).all<any>(),
    row.rider_id ? c.env.DB.prepare("SELECT name FROM riders WHERE id = ?").bind(row.rider_id).first<any>() : Promise.resolve(null),
    loadFeeSettings(c.env.DB, feeEnvRaw(c.env)),
  ]);
  const lines = (items.results ?? []).map((it: any) => ({
    name: it.name,
    image: it.image ?? "",
    unitPriceCents: it.price_cents,
    quantity: it.quantity,
    lineTotalCents: it.price_cents * it.quantity,
  }));
  return json(c, {
    receipt: {
      orderNumber: row.id,
      invoiceNo: invoice?.invoice_no ?? null,
      status: row.status,
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      transactionId: row.transaction_id ?? "",
      referenceId: row.reference_id ?? "",
      createdAt: row.created_at,
      deliveredAt: row.delivered_at ?? null,
      currency: "ZMW",
      vatPct: feeSettings.vatPct,
      business: { id: String(biz?.id ?? row.business_id), name: biz?.name ?? "", address: biz?.address ?? "", tpin: biz?.tpin ?? "" },
      buyer: { name: buyer?.name ?? "", phone: buyer?.phone ?? row.customer_phone ?? "", tpin: row.buyer_tpin ?? "" },
      delivery: {
        address: row.delivery_address ?? "",
        method: row.delivery_method ?? "standard",
        feeCents: row.delivery_fee_cents,
        riderName: rider?.name ?? "",
      },
      items: lines,
      subtotalCents: row.subtotal_cents,
      vatCents: row.vat_cents,
      deliveryFeeCents: row.delivery_fee_cents,
      totalCents: row.total_cents,
    },
  });
});

app.post("/api/orders/:id/cancel", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const row = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(c.req.param("id")).first<any>();
  if (!row || row.user_id !== a.id) return notFound(c, "Order not found");
  if (row.payment_status === "successful") return badRequest(c, "Paid orders need admin support to cancel/refund");
  if (!["Pending", "Confirmed"].includes(row.status)) return badRequest(c, "Order cannot be cancelled");
  await c.env.DB.prepare("UPDATE orders SET status = 'Cancelled', cancelled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(row.id).run();
  await logAction(c.env.DB, a.id, "order_cancelled", "order", row.id);
  return json(c, { ok: true });
});

// ---------- business endpoints ----------

app.post("/api/businesses/apply", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  if (!b.name) return badRequest(c, "business name is required");
  const existing = await c.env.DB.prepare("SELECT id FROM businesses WHERE owner_user_id = ?").bind(a.id).first<any>();
  if (existing) return badRequest(c, "You already have a business application");
  const r = await c.env.DB.prepare(
    "INSERT INTO businesses (owner_user_id, name, slogan, description, address, tpin, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')"
  ).bind(a.id, b.name, b.slogan ?? "", b.description ?? "", b.address ?? "", b.tpin ?? null).run();
  await c.env.DB.prepare("UPDATE users SET role = 'business', business_id = ?, updated_at = datetime('now') WHERE id = ?").bind(r.meta.last_row_id, a.id).run();
  await c.env.DB.prepare("INSERT OR IGNORE INTO wallets (business_id, balance_cents, held_cents) VALUES (?, 0, 0)").bind(r.meta.last_row_id).run();
  await logAction(c.env.DB, a.id, "business_applied", "business", String(r.meta.last_row_id), { name: b.name });
  await pushAdmins(c.env.DB, c.env, "New business application", `${b.name} applied to join the marketplace`, { type: "business_application", businessId: String(r.meta.last_row_id) }).catch(() => {});
  return json(c, { ok: true, businessId: String(r.meta.last_row_id) }, 201);
});

app.get("/api/businesses/me", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  if (!a.user.business_id) return notFound(c, "No business");
  const b = await getBusiness(c.env.DB, a.user.business_id);
  if (!b) return notFound(c, "No business");
  const wallet = await c.env.DB.prepare("SELECT * FROM wallets WHERE business_id = ?").bind(b.id).first<any>();
  const numbers = await c.env.DB.prepare("SELECT * FROM collection_numbers WHERE business_id = ? ORDER BY is_default DESC").bind(b.id).all<any>();
  const staff = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.phone, u.email, m.role_in_business FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = ?`
  ).bind(b.id).all<any>();
  const riders = await c.env.DB.prepare("SELECT * FROM riders WHERE business_id = ? ORDER BY status").bind(b.id).all<any>();
  return json(c, {
    business: {
      id: String(b.id), name: b.name, slogan: b.slogan, description: b.description, logo: b.logo,
      address: b.address, tpin: b.tpin, status: b.status, commissionPct: b.commission_pct,
      balanceCents: wallet?.balance_cents ?? 0, heldCents: wallet?.held_cents ?? 0,
      collectionNumbers: (numbers.results ?? []).map((n) => ({
        id: String(n.id), businessName: n.business_name, businessId: String(n.business_id),
        network: n.network, phoneNumber: n.phone_number, tillNumber: n.till_number,
        isActive: n.is_active === 1, isDefault: n.is_default === 1, addedBy: n.added_by,
      })),
      staff: staff.results ?? [],
      riders: (riders.results ?? []).map((r) => ({
        id: String(r.id), userId: String(r.user_id), name: r.name, phone: r.phone, vehicle: r.vehicle,
        status: r.status, balance: r.balance_cents / 100, balanceCents: r.balance_cents, joined: r.joined,
      })),
    },
  });
});

// Registered AFTER /api/businesses/me so the static route wins (Hono matches by registration order).
app.get("/api/businesses/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return notFound(c, "Business not found");
  const b = await getBusiness(c.env.DB, id);
  if (!b || b.status !== "approved") return notFound(c, "Business not found");
  return json(c, { id: String(b.id), name: b.name, slogan: b.slogan, description: b.description, logo: b.logo, address: b.address });
});

app.put("/api/businesses/me", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !a.user.business_id) return unauthorized(c);
  const b = await body(c);
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [field, col] of [["name", "name"], ["slogan", "slogan"], ["description", "description"], ["logo", "logo"], ["address", "address"], ["tpin", "tpin"]] as const) {
    if (b[field] !== undefined) { sets.push(`${col} = ?`); vals.push(String(b[field])); }
  }
  if (!sets.length) return badRequest(c, "nothing to update");
  vals.push(a.user.business_id);
  await c.env.DB.prepare(`UPDATE businesses SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).bind(...vals).run();
  return json(c, { ok: true });
});

app.get("/api/businesses/me/collection-numbers", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const businessId = await businessScope(c.env.DB, a, { businessId: c.req.query("businessId") });
  if (businessId == null) return unauthorized(c, "No business");
  const rows = await c.env.DB.prepare("SELECT * FROM collection_numbers WHERE business_id = ? ORDER BY is_default DESC, id DESC").bind(businessId).all<any>();
  return json(c, (rows.results ?? []).map((n) => ({
    id: String(n.id), businessName: n.business_name, businessId: String(n.business_id),
    network: n.network, phoneNumber: n.phone_number, tillNumber: n.till_number,
    isActive: n.is_active === 1, isDefault: n.is_default === 1, addedBy: n.added_by,
    createdAt: n.created_at,
  })));
});

app.post("/api/businesses/me/collection-numbers", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  const businessId = await businessScope(c.env.DB, a, b);
  if (businessId == null) return unauthorized(c, "No business");
  if (!b.phoneNumber || !b.network) return badRequest(c, "phoneNumber and network are required");
  const networks = ["mtn", "airtel", "zamtel"];
  if (!networks.includes(b.network)) return badRequest(c, "network must be mtn, airtel or zamtel");
  const biz = await getBusiness(c.env.DB, businessId);
  const isSuper = isSuperadminPhone(c.env, a.user.phone) || hasRole(a.user, "admin", "superadmin");
  const r = await c.env.DB.prepare(
    `INSERT INTO collection_numbers (business_id, business_name, network, phone_number, till_number, is_active, is_default, added_by)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(businessId, b.businessName ?? biz?.name ?? "", b.network, normPhone(b.phoneNumber), b.tillNumber ?? "",
    b.isDefault ? 1 : 0, isSuper ? "superadmin" : "business").run();
  if (b.isDefault) {
    await c.env.DB.prepare("UPDATE collection_numbers SET is_default = 0 WHERE business_id = ? AND id != ?").bind(businessId, r.meta.last_row_id).run();
  }
  return json(c, { ok: true, id: String(r.meta.last_row_id) }, 201);
});

app.put("/api/businesses/me/collection-numbers/:id", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  const businessId = await businessScope(c.env.DB, a, b);
  if (businessId == null) return unauthorized(c, "No business");
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [field, col] of [["network", "network"], ["phoneNumber", "phone_number"], ["tillNumber", "till_number"], ["businessName", "business_name"]] as const) {
    if (b[field] !== undefined) { sets.push(`${col} = ?`); vals.push(String(b[field])); }
  }
  if (b.isActive !== undefined) { sets.push("is_active = ?"); vals.push(b.isActive ? 1 : 0); }
  if (b.isDefault === true) { sets.push("is_default = ?"); vals.push(1); }
  if (!sets.length) return badRequest(c, "nothing to update");
  vals.push(businessId, Number(c.req.param("id")));
  await c.env.DB.prepare(`UPDATE collection_numbers SET ${sets.join(", ")}, updated_at = datetime('now') WHERE business_id = ? AND id = ?`).bind(...vals).run();
  if (b.isDefault === true) {
    await c.env.DB.prepare("UPDATE collection_numbers SET is_default = 0 WHERE business_id = ? AND id != ?").bind(businessId, Number(c.req.param("id"))).run();
  }
  return json(c, { ok: true });
});

app.delete("/api/businesses/me/collection-numbers/:id", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const businessId = await businessScope(c.env.DB, a, { businessId: c.req.query("businessId") });
  if (businessId == null) return unauthorized(c, "No business");
  await c.env.DB.prepare("DELETE FROM collection_numbers WHERE business_id = ? AND id = ?").bind(businessId, Number(c.req.param("id"))).run();
  return json(c, { ok: true });
});

// products (business-managed)

app.get("/api/businesses/me/products", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const businessId = await businessScope(c.env.DB, a, { businessId: c.req.query("businessId") });
  if (businessId == null) return unauthorized(c, "No business");
  const rows = await c.env.DB.prepare("SELECT * FROM products WHERE business_id = ? ORDER BY id DESC").bind(businessId).all<any>();
  return json(c, (rows.results ?? []).map(productJson));
});

app.post("/api/businesses/me/products", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  const businessId = await businessScope(c.env.DB, a, b);
  if (businessId == null) return unauthorized(c, "No business");
  if (!b.name || !b.price) return badRequest(c, "name and price are required");
  const priceCents = Math.round(Number(b.price) * 100);
  if (!Number.isFinite(priceCents) || priceCents <= 0) return badRequest(c, "invalid price");
  if (b.category && !isValidCategory(b.category)) return badRequest(c, "unknown category");
  const r = await c.env.DB.prepare(
    `INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).bind(businessId, String(b.name).slice(0, 120), priceCents, b.image ?? "", b.description ?? "",
    b.category ?? "", b.isGhost ? 1 : 0, Number(b.stock) || 0).run();
  return json(c, { ok: true, id: String(r.meta.last_row_id) }, 201);
});

app.put("/api/businesses/me/products/:id", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  const businessId = await businessScope(c.env.DB, a, b);
  if (businessId == null) return unauthorized(c, "No business");
  const sets: string[] = [];
  const vals: unknown[] = [];
  const fields: [string, string][] = [["name", "name"], ["image", "image"], ["description", "description"], ["category", "category"]];
  for (const [field, col] of fields) if (b[field] !== undefined) { sets.push(`${col} = ?`); vals.push(String(b[field])); }
  if (b.price !== undefined) { const pc = Math.round(Number(b.price) * 100); if (pc > 0) { sets.push("price_cents = ?"); vals.push(pc); } }
  if (b.stock !== undefined) { sets.push("stock = ?"); vals.push(Math.max(0, Number(b.stock) || 0)); }
  if (b.isGhost !== undefined) { sets.push("is_ghost = ?"); vals.push(b.isGhost ? 1 : 0); }
  if (b.active !== undefined) { sets.push("active = ?"); vals.push(b.active ? 1 : 0); }
  if (!sets.length) return badRequest(c, "nothing to update");
  vals.push(businessId, Number(c.req.param("id")));
  await c.env.DB.prepare(`UPDATE products SET ${sets.join(", ")}, updated_at = datetime('now') WHERE business_id = ? AND id = ?`).bind(...vals).run();
  return json(c, { ok: true });
});

app.delete("/api/businesses/me/products/:id", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const businessId = await businessScope(c.env.DB, a, { businessId: c.req.query("businessId") });
  if (businessId == null) return unauthorized(c, "No business");
  await c.env.DB.prepare("UPDATE products SET active = 0, updated_at = datetime('now') WHERE business_id = ? AND id = ?")
    .bind(businessId, Number(c.req.param("id"))).run();
  return json(c, { ok: true });
});

// business orders

app.get("/api/businesses/me/orders", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !a.user.business_id) return unauthorized(c);
  const { status } = c.req.query();
  let sql = "SELECT * FROM orders WHERE business_id = ?";
  const vals: unknown[] = [a.user.business_id];
  if (status) { sql += " AND status = ?"; vals.push(status); }
  sql += " ORDER BY created_at DESC LIMIT 200";
  const rows = await c.env.DB.prepare(sql).bind(...vals).all<any>();
  const out = [];
  for (const r of rows.results ?? []) out.push(await orderJson(c.env.DB, r));
  return json(c, out);
});

const VALID_STATUSES = ["Confirmed", "Processing", "Shipped", "Out for Delivery", "Delivered", "Cancelled"];

app.post("/api/businesses/me/orders/:id/status", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(c.req.param("id")).first<any>();
  if (!order) return notFound(c, "Order not found");
  if (!await canManageBusiness(c.env.DB, a.id, order.business_id)) return unauthorized(c, "Not your order");
  const status = b.status;
  if (!VALID_STATUSES.includes(status)) return badRequest(c, `status must be one of: ${VALID_STATUSES.join(", ")}`);

  const riderId = b.riderId ? Number(b.riderId) : order.rider_id;
  const sets = ["status = ?", "updated_at = datetime('now')"];
  const vals: unknown[] = [status];
  if (riderId && status === "Shipped" && !order.rider_id) { sets.push("rider_id = ?", "assigned_at = datetime('now')"); vals.push(riderId); }

  if (status === "Delivered") {
    sets.push("delivered_at = datetime('now')");
    // Rider earns the delivery fee; business keeps goods share (credited at payment).
    if (order.rider_id && order.delivery_fee_cents > 0) {
      await c.env.DB.prepare("UPDATE riders SET balance_cents = balance_cents + ? WHERE id = ?").bind(order.delivery_fee_cents, order.rider_id).run();
    }
  }
  vals.push(order.id);
  await c.env.DB.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  await logAction(c.env.DB, a.id, `order_${status.toLowerCase().replace(/ /g, "_")}`, "order", order.id);

  await pushNotif(c.env.DB, c.env, order.user_id, "Order update", `Order ${order.id} is now ${status}.`, "order", { orderId: order.id });
  const biz = await getBusiness(c.env.DB, order.business_id);
  if (envV(c, "ENV", "sandbox") === "production" && order.customer_phone) {
    await sendSms(c.env, order.customer_phone, msg.orderStatusSms(order.id, status, biz?.name ?? "")).catch(() => {});
  }
  const riderRow = order.rider_id ? await c.env.DB.prepare("SELECT user_id FROM riders WHERE id = ?").bind(order.rider_id).first<any>() : null;
  if (riderRow && status === "Delivered") {
    await pushNotif(c.env.DB, c.env, riderRow.user_id, "Delivery complete", `Order ${order.id} delivered. K${(order.delivery_fee_cents / 100).toFixed(2)} added to your balance.`, "rider", { orderId: order.id });
  }
  return json(c, { ok: true });
});

// business staff

app.post("/api/businesses/me/staff", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !a.user.business_id) return unauthorized(c);
  const b = await body(c);
  const phone = normPhone(b.phone ?? "");
  if (!phone) return badRequest(c, "phone is required");
  let staff = await c.env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first<any>();
  if (!staff) {
    const r = await c.env.DB.prepare("INSERT INTO users (uid, name, phone, role) VALUES (?, ?, ?, 'employee')")
      .bind(`u_${randomHex(8)}`, b.name ?? "", phone).run();
    staff = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(r.meta.last_row_id).first<any>();
  }
  await c.env.DB.prepare("INSERT OR IGNORE INTO business_members (business_id, user_id, role_in_business) VALUES (?, ?, ?)")
    .bind(a.user.business_id, staff.id, b.roleInBusiness ?? "staff").run();
  if (staff.role === "user") {
    await c.env.DB.prepare("UPDATE users SET role = 'employee', updated_at = datetime('now') WHERE id = ?").bind(staff.id).run();
  }
  const biz = await getBusiness(c.env.DB, a.user.business_id);
  await pushNotif(c.env.DB, c.env, staff.id, "Team invitation", `You have been added to ${biz?.name ?? "a shop"} as staff.`, "business").catch(() => {});
  return json(c, { ok: true, userId: String(staff.id) }, 201);
});

// riders

app.get("/api/businesses/me/riders", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !a.user.business_id) return unauthorized(c);
  const rows = await c.env.DB.prepare("SELECT * FROM riders WHERE business_id = ? ORDER BY status, joined DESC").bind(a.user.business_id).all<any>();
  return json(c, (rows.results ?? []).map((r) => ({
    id: String(r.id), userId: String(r.user_id), name: r.name, phone: r.phone, vehicle: r.vehicle,
    status: r.status, balance: r.balance_cents / 100, balanceCents: r.balance_cents, joined: r.joined,
  })));
});

app.post("/api/businesses/me/riders", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !a.user.business_id) return unauthorized(c);
  const b = await body(c);
  const phone = normPhone(b.phone ?? "");
  if (!phone) return badRequest(c, "phone is required");
  let riderUser = await c.env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first<any>();
  if (!riderUser) {
    const r = await c.env.DB.prepare("INSERT INTO users (uid, name, phone, role, rider_status) VALUES (?, ?, ?, 'rider', 'approved')")
      .bind(`u_${randomHex(8)}`, b.name ?? "", phone).run();
    riderUser = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(r.meta.last_row_id).first<any>();
  } else if (riderUser.role === "user") {
    await c.env.DB.prepare("UPDATE users SET role = 'rider', rider_status = 'approved', updated_at = datetime('now') WHERE id = ?").bind(riderUser.id).run();
  }
  await c.env.DB.prepare("INSERT OR IGNORE INTO riders (user_id, business_id, name, phone, vehicle, status) VALUES (?, ?, ?, ?, ?, 'approved')")
    .bind(riderUser.id, a.user.business_id, b.name ?? riderUser.name, phone, b.vehicle ?? "").run();
  const biz = await getBusiness(c.env.DB, a.user.business_id);
  await pushNotif(c.env.DB, c.env, riderUser.id, "You are now a rider", `You can deliver for ${biz?.name ?? "the marketplace"}.`, "rider").catch(() => {});
  return json(c, { ok: true }, 201);
});

app.post("/api/businesses/me/riders/:id/status", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !a.user.business_id) return unauthorized(c);
  const b = await body(c);
  if (!["approved", "suspended"].includes(b.status)) return badRequest(c, "status must be approved or suspended");
  await c.env.DB.prepare("UPDATE riders SET status = ?, updated_at = datetime('now') WHERE id = ? AND business_id = ?")
    .bind(b.status, Number(c.req.param("id")), a.user.business_id).run();
  return json(c, { ok: true });
});

app.get("/api/riders/me", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const rows = await c.env.DB.prepare(
    `SELECT r.*, b.name AS business_name FROM riders r JOIN businesses b ON b.id = r.business_id WHERE r.user_id = ?`
  ).bind(a.id).all<any>();
  return json(c, (rows.results ?? []).map((r) => ({
    id: String(r.id), businessId: String(r.business_id), businessName: r.business_name,
    name: r.name, phone: r.phone, vehicle: r.vehicle, status: r.status,
    balance: r.balance_cents / 100, balanceCents: r.balance_cents, joined: r.joined,
  })));
});

app.post("/api/riders/apply", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  await c.env.DB.prepare("UPDATE users SET rider_status = 'pending', bike_photo = COALESCE(?, bike_photo), updated_at = datetime('now') WHERE id = ?")
    .bind(b.bikePhoto ?? null, a.id).run();
  await pushAdmins(c.env.DB, c.env, "New rider application", `${a.user.name || a.user.phone} applied to become a rider`, { type: "rider_application" }).catch(() => {});
  return json(c, { ok: true });
});

app.get("/api/riders/me/payouts", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const riders = await c.env.DB.prepare("SELECT id FROM riders WHERE user_id = ?").bind(a.id).all<any>();
  const ids = (riders.results ?? []).map((r) => r.id);
  if (!ids.length) return json(c, []);
  const ph = ids.map(() => "?").join(",");
  const rows = await c.env.DB.prepare(`SELECT * FROM rider_payouts WHERE rider_id IN (${ph}) ORDER BY id DESC LIMIT 100`).bind(...ids).all<any>();
  return json(c, (rows.results ?? []).map((p) => ({
    id: String(p.id), amount: p.amount_cents / 100, amountCents: p.amount_cents,
    fee: p.fee_cents / 100, feeCents: p.fee_cents, net: p.net_cents / 100, netCents: p.net_cents,
    status: p.status, createdAt: p.created_at, error: p.error,
  })));
});

app.get("/api/riders/me/deliveries", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const riders = await c.env.DB.prepare("SELECT id FROM riders WHERE user_id = ?").bind(a.id).all<any>();
  const ids = (riders.results ?? []).map((r) => r.id);
  if (!ids.length) return json(c, []);
  const ph = ids.map(() => "?").join(",");
  const rows = await c.env.DB.prepare(`SELECT * FROM orders WHERE rider_id IN (${ph}) AND status NOT IN ('Delivered', 'Cancelled', 'Refunded') ORDER BY created_at DESC`).bind(...ids).all<any>();
  const out = [];
  for (const r of rows.results ?? []) out.push(await orderJson(c.env.DB, r));
  return json(c, out);
});

app.post("/api/riders/me/location", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  if (typeof b.lat !== "number" || typeof b.lng !== "number") return badRequest(c, "lat and lng required");
  await c.env.DB.prepare("UPDATE users SET rider_lat = ?, rider_lng = ?, rider_address = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(b.lat, b.lng, b.address ?? "", a.id).run();
  return json(c, { ok: true });
});

async function riderOrderStatus(c: Ctx) {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(c.req.param("id")).first<any>();
  if (!order) return notFound(c, "Order not found");
  const rider = await c.env.DB.prepare("SELECT id FROM riders WHERE id = ? AND user_id = ?").bind(order.rider_id, a.id).first<any>();
  if (!rider) return unauthorized(c, "Not assigned to you");
  if (!["Out for Delivery", "Delivered"].includes(b.status)) return badRequest(c, "status must be Out for Delivery or Delivered");
  const proofPhoto = typeof b.proofPhoto === "string" && b.proofPhoto.trim() ? String(b.proofPhoto) : null;
  const photoSet = proofPhoto ? ", proof_photo = ?" : "";
  if (b.status === "Delivered") {
    if (order.delivery_fee_cents > 0) {
      await c.env.DB.prepare("UPDATE riders SET balance_cents = balance_cents + ? WHERE id = ?").bind(order.delivery_fee_cents, order.rider_id).run();
    }
    const sets = `status = 'Delivered', delivered_at = datetime('now'), updated_at = datetime('now')${photoSet}`;
    const vals: unknown[] = proofPhoto ? [proofPhoto, order.id] : [order.id];
    await c.env.DB.prepare(`UPDATE orders SET ${sets} WHERE id = ?`).bind(...vals).run();
    await pushNotif(c.env.DB, c.env, order.user_id, "Delivered", `Order ${order.id} has been delivered. Enjoy!`, "order", { orderId: order.id });
  } else {
    const sets = `status = 'Out for Delivery', updated_at = datetime('now')${photoSet}`;
    const vals: unknown[] = proofPhoto ? [proofPhoto, order.id] : [order.id];
    await c.env.DB.prepare(`UPDATE orders SET ${sets} WHERE id = ?`).bind(...vals).run();
  }
  return json(c, { ok: true });
}

app.post("/api/orders/:id/rider-status", riderOrderStatus);
app.patch("/api/orders/:id/rider-status", riderOrderStatus);

// notifications, addresses, chat (customer-facing)

app.get("/api/notifications/mine", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100"
  ).bind(a.id).all<any>();
  return json(c, (rows.results ?? []).map((n) => ({
    id: String(n.id), title: n.title, message: n.message, type: n.type,
    read: n.read === 1, data: n.data ? JSON.parse(n.data) : null, createdAt: n.created_at,
  })));
});

app.post("/api/notifications/:id/read", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  await c.env.DB.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?")
    .bind(Number(c.req.param("id")), a.id).run();
  return json(c, { ok: true });
});

app.post("/api/notifications/read-all", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  await c.env.DB.prepare("UPDATE notifications SET read = 1 WHERE user_id = ?").bind(a.id).run();
  return json(c, { ok: true });
});

app.get("/api/addresses", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const rows = await c.env.DB.prepare("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC").bind(a.id).all<any>();
  return json(c, (rows.results ?? []).map((r) => ({
    id: String(r.id), title: r.title, details: r.details, isDefault: r.is_default === 1,
  })));
});

app.post("/api/addresses", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  if (!b.title || !b.details) return badRequest(c, "title and details are required");
  const r = await c.env.DB.prepare(
    "INSERT INTO addresses (user_id, title, details, is_default) VALUES (?, ?, ?, ?)"
  ).bind(a.id, String(b.title), String(b.details), b.isDefault ? 1 : 0).run();
  if (b.isDefault) {
    await c.env.DB.prepare("UPDATE addresses SET is_default = 0 WHERE user_id = ? AND id != ?").bind(a.id, r.meta.last_row_id).run();
  }
  return json(c, { ok: true, id: String(r.meta.last_row_id) }, 201);
});

app.put("/api/addresses/:id", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b.title !== undefined) { sets.push("title = ?"); vals.push(String(b.title)); }
  if (b.details !== undefined) { sets.push("details = ?"); vals.push(String(b.details)); }
  if (b.isDefault !== undefined) { sets.push("is_default = ?"); vals.push(b.isDefault ? 1 : 0); }
  if (!sets.length) return badRequest(c, "nothing to update");
  vals.push(a.id, Number(c.req.param("id")));
  await c.env.DB.prepare(`UPDATE addresses SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`).bind(...vals).run();
  if (b.isDefault === true) {
    await c.env.DB.prepare("UPDATE addresses SET is_default = 0 WHERE user_id = ? AND id != ?").bind(a.id, Number(c.req.param("id"))).run();
  }
  return json(c, { ok: true });
});

app.delete("/api/addresses/:id", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  await c.env.DB.prepare("DELETE FROM addresses WHERE user_id = ? AND id = ?").bind(a.id, Number(c.req.param("id"))).run();
  return json(c, { ok: true });
});

app.get("/api/chat/messages", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const rows = await c.env.DB.prepare("SELECT * FROM chat_messages WHERE user_id = ? ORDER BY id ASC LIMIT 500").bind(a.id).all<any>();
  return json(c, (rows.results ?? []).map((m) => ({
    id: String(m.id), text: m.text, isUser: m.is_user === 1, createdAt: m.created_at,
  })));
});

app.post("/api/chat/messages", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  if (!b.text) return badRequest(c, "text is required");
  const r = await c.env.DB.prepare("INSERT INTO chat_messages (user_id, text, is_user) VALUES (?, ?, 1)")
    .bind(a.id, String(b.text).slice(0, 2000)).run();
  await pushNotif(c.env.DB, c.env, a.id, "Support", "Thanks for reaching out! An agent will reply shortly.", "support").catch(() => {});
  return json(c, { ok: true, id: String(r.meta.last_row_id) }, 201);
});

// product reviews

app.get("/api/products/:id/reviews", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT r.*, u.name AS user_name FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.product_id = ? ORDER BY r.id DESC LIMIT 50`
  ).bind(Number(c.req.param("id"))).all<any>();
  const agg = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(AVG(rating),0) AS avg FROM reviews WHERE product_id = ?"
  ).bind(Number(c.req.param("id"))).first<any>();
  return json(c, {
    reviews: (rows.results ?? []).map((r) => ({
      id: String(r.id), rating: r.rating, comment: r.comment, userName: r.user_name ?? "", createdAt: r.created_at,
    })),
    rating: Number(agg?.avg ?? 0),
    count: Number(agg?.n ?? 0),
  });
});

app.post("/api/products/:id/reviews", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  const rating = Math.max(1, Math.min(5, Math.floor(Number(b.rating) || 5)));
  await c.env.DB.prepare(
    `INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?, ?, ?, ?)
     ON CONFLICT(product_id, user_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment`
  ).bind(Number(c.req.param("id")), a.id, rating, String(b.comment ?? "").slice(0, 1000)).run();
  return json(c, { ok: true }, 201);
});

// ---------- admin: rider fleet + rider payouts ----------

app.get("/api/admin/riders", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const rows = await c.env.DB.prepare(
    `SELECT r.*, b.name AS business_name, u.phone AS user_phone, u.rider_status AS user_rider_status
     FROM riders r JOIN businesses b ON b.id = r.business_id JOIN users u ON u.id = r.user_id
     ORDER BY r.status, r.joined DESC LIMIT 300`
  ).all<any>();
  return json(c, (rows.results ?? []).map((r) => ({
    id: String(r.id), userId: String(r.user_id), businessId: String(r.business_id), businessName: r.business_name,
    name: r.name, phone: r.phone, vehicle: r.vehicle, status: r.status,
    balance: r.balance_cents / 100, balanceCents: r.balance_cents, joined: r.joined,
  })));
});

app.get("/api/admin/rider-applications", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const rows = await c.env.DB.prepare(
    "SELECT id, uid, name, phone, bike_photo, rider_status, created_at FROM users WHERE rider_status = 'pending' ORDER BY id DESC"
  ).all<any>();
  return json(c, (rows.results ?? []).map((u) => ({
    id: String(u.id), uid: u.uid, name: u.name, phone: u.phone, bikePhoto: u.bike_photo ?? "", createdAt: u.created_at,
  })));
});

app.post("/api/admin/rider-applications/:id/approve", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const id = Number(c.req.param("id"));
  const u = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<any>();
  if (!u) return notFound(c, "User not found");
  const b = await body(c);
  // riders.business_id is NOT NULL -> always resolve a business (body, else default platform business).
  let biz: any = null;
  const askedId = Number(b.businessId);
  if (Number.isInteger(askedId) && askedId > 0) biz = await getBusiness(c.env.DB, askedId);
  if (!biz) biz = await getBusiness(c.env.DB, await resolveDefaultBusiness(c.env.DB, a.id));
  await c.env.DB.prepare("UPDATE users SET role = 'rider', rider_status = 'approved', updated_at = datetime('now') WHERE id = ?").bind(id).run();
  const hasFleetRow = await c.env.DB.prepare("SELECT id FROM riders WHERE user_id = ?").bind(id).first<any>();
  if (!hasFleetRow) {
    await c.env.DB.prepare("INSERT OR IGNORE INTO riders (user_id, business_id, name, phone, vehicle, status) VALUES (?, ?, ?, ?, ?, 'approved')")
      .bind(id, biz.id, u.name ?? "", u.phone, b.vehicle ?? "").run();
  } else if (b.vehicle !== undefined) {
    await c.env.DB.prepare("UPDATE riders SET vehicle = ?, updated_at = datetime('now') WHERE user_id = ?").bind(String(b.vehicle), id).run();
  }
  await pushNotif(c.env.DB, c.env, id, "Rider approved", `You are now a rider${biz ? ` for ${biz.name}` : ""}. Go online to start delivering.`, "rider").catch(() => {});
  await logAction(c.env.DB, a.id, "rider_approved", "user", String(id), { businessId: biz?.id ?? null });
  return json(c, { ok: true, businessId: String(biz?.id ?? "") });
});

app.post("/api/admin/riders/:id/status", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const b = await body(c);
  if (!["approved", "suspended", "rejected"].includes(b.status)) return badRequest(c, "status must be approved, suspended or rejected");
  const riderId = Number(c.req.param("id"));
  const rider = await c.env.DB.prepare("SELECT id, user_id FROM riders WHERE id = ?").bind(riderId).first<any>();
  if (!rider) return notFound(c, "Rider not found");
  await c.env.DB.prepare("UPDATE riders SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(b.status, riderId).run();
  // Keep the user's rider_status in sync (users.rider_status has no "suspended").
  if (b.status === "approved" || b.status === "rejected") {
    await c.env.DB.prepare("UPDATE users SET rider_status = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(b.status, rider.user_id).run();
  }
  await logAction(c.env.DB, a.id, `rider_${b.status}`, "rider", String(riderId));
  return json(c, { ok: true });
});

app.get("/api/admin/rider-payouts", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const rows = await c.env.DB.prepare(
    `SELECT p.*, r.name AS rider_name, r.phone AS rider_phone, b.name AS business_name
     FROM rider_payouts p JOIN riders r ON r.id = p.rider_id JOIN businesses b ON b.id = p.business_id
     ORDER BY p.id DESC LIMIT 200`
  ).all<any>();
  return json(c, (rows.results ?? []).map((p) => ({
    id: String(p.id), riderId: String(p.rider_id), riderName: p.rider_name, businessName: p.business_name,
    amount: p.amount_cents / 100, amountCents: p.amount_cents, feeCents: p.fee_cents, netCents: p.net_cents,
    phone: p.phone, network: p.network, status: p.status, lipilaReference: p.lipila_reference, error: p.error, createdAt: p.created_at,
  })));
});

app.post("/api/admin/riders/:id/payout", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const rider = await c.env.DB.prepare("SELECT * FROM riders WHERE id = ?").bind(Number(c.req.param("id"))).first<any>();
  if (!rider) return notFound(c, "Rider not found");
  if (rider.balance_cents < 2000) return badRequest(c, "Rider balance must be at least K20 to pay out");
  const feeSettings = await loadFeeSettings(c.env.DB, feeEnvRaw(c.env));
  const amountCents = rider.balance_cents;
  const netCents = payoutNetCents(feeSettings, amountCents);
  const r = await c.env.DB.prepare(
    `INSERT INTO rider_payouts (rider_id, business_id, amount_cents, fee_cents, net_cents, phone, network, status, requested_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?)`
  ).bind(rider.id, rider.business_id, amountCents, amountCents - netCents, netCents, rider.phone, "mtn", a.id).run();
  const payoutId = r.meta.last_row_id;
  await c.env.DB.prepare("UPDATE riders SET balance_cents = 0, updated_at = datetime('now') WHERE id = ?").bind(rider.id).run();
  const referenceId = `RPY-${payoutId}-${String(Date.now()).slice(-6)}`;
  const callbackUrl = `${envV(c, "APP_URL", "https://grand-elephants-api.godfreymoseskalambo.workers.dev")}/api/webhooks/lipila`;
  try {
    const res = await createDisbursement(c.env, {
      referenceId,
      amountCents: netCents,
      accountNumber: normPhone(rider.phone),
      narration: `Rider payout to ${rider.name}`,
      callbackUrl,
    }, c.env.DB);
    await c.env.DB.prepare("UPDATE rider_payouts SET lipila_reference = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(res.referenceId, res.status === "successful" ? "successful" : "processing", payoutId).run();
  } catch (e: any) {
    await c.env.DB.prepare("UPDATE rider_payouts SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(String(e.message ?? e).slice(0, 500), payoutId).run();
    await c.env.DB.prepare("UPDATE riders SET balance_cents = balance_cents + ?, updated_at = datetime('now') WHERE id = ?")
      .bind(amountCents, rider.id).run();
    return json(c, { ok: false, error: "Rider payout failed. Balance restored.", detail: String(e.message ?? e).slice(0, 200) }, 502);
  }
  if (envV(c, "ENV", "sandbox") === "production") {
    await sendSms(c.env, rider.phone, msg.payoutSentSms(netCents, "rider earnings")).catch(() => {});
  }
  return json(c, { ok: true, payoutId: String(payoutId), netCents });
});

// admin Lipila wallet access (Grand Elephants wallet)
app.get("/api/admin/lipila/balance", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  try {
    const res = await checkWalletBalance(c.env);
    const wallet = await c.env.DB.prepare("SELECT COALESCE(SUM(balance_cents),0) AS bal FROM wallets").first<any>();
    return json(c, { ok: true, lipilaBalance: res.amount ?? 0, businessWalletCents: wallet?.bal ?? 0 });
  } catch (e: any) {
    return json(c, { ok: false, error: String(e.message ?? e).slice(0, 300) }, 502);
  }
});

// payouts

const businessPayoutHandler = async (c: Ctx) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !a.user.business_id) return unauthorized(c);
  const wallet = await c.env.DB.prepare("SELECT * FROM wallets WHERE business_id = ?").bind(a.user.business_id).first<any>();
  if (!wallet || wallet.balance_cents < 5000) return badRequest(c, "Minimum payout is K50");
  const numbers = await c.env.DB.prepare("SELECT * FROM collection_numbers WHERE business_id = ? AND is_active = 1 ORDER BY is_default DESC").bind(a.user.business_id).first<any>();
  if (!numbers) return badRequest(c, "Add a collection number first");

  const amountCents = wallet.balance_cents;
  const feeSettings = await loadFeeSettings(c.env.DB, feeEnvRaw(c.env));
  const netCents = payoutNetCents(feeSettings, amountCents);
  const r = await c.env.DB.prepare(
    `INSERT INTO payouts (business_id, amount_cents, fee_cents, net_cents, phone, network, status, requested_by)
     VALUES (?, ?, ?, ?, ?, ?, 'processing', ?)`
  ).bind(a.user.business_id, amountCents, amountCents - netCents, netCents, numbers.phone_number, numbers.network, a.id).run();
  const payoutId = r.meta.last_row_id;
  await c.env.DB.prepare("UPDATE wallets SET balance_cents = 0, updated_at = datetime('now') WHERE business_id = ?").bind(a.user.business_id).run();

  const referenceId = `PAY-${payoutId}-${String(Date.now()).slice(-6)}`;
  const callbackUrl = `${envV(c, "APP_URL", "https://grand-elephants-api.godfreymoseskalambo.workers.dev")}/api/webhooks/lipila`;
  const biz = await getBusiness(c.env.DB, a.user.business_id);
  try {
    const res = await createDisbursement(c.env, {
      referenceId,
      amountCents: netCents,
      accountNumber: normPhone(numbers.phone_number),
      narration: `Payout to ${biz?.name ?? "business"}`,
      callbackUrl,
    }, c.env.DB);
    await c.env.DB.prepare("UPDATE payouts SET lipila_reference = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(res.referenceId, res.status === "successful" ? "successful" : "processing", payoutId).run();
  } catch (e: any) {
    await c.env.DB.prepare("UPDATE payouts SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(String(e.message ?? e).slice(0, 500), payoutId).run();
    await c.env.DB.prepare("UPDATE wallets SET balance_cents = balance_cents + ?, updated_at = datetime('now') WHERE business_id = ?")
      .bind(amountCents, a.user.business_id).run();
    return json(c, { ok: false, error: "Payout failed. Balance restored.", detail: String(e.message ?? e).slice(0, 200) }, 502);
  }
  if (envV(c, "ENV", "sandbox") === "production") {
    await sendSms(c.env, numbers.phone_number, msg.payoutSentSms(netCents, biz?.name ?? "")).catch(() => {});
  }
  return json(c, { ok: true, payoutId: String(payoutId), netCents });
};

// Both spellings are accepted: the Flutter client posts the singular, some screens use the plural.
app.post("/api/businesses/me/payout", businessPayoutHandler);
app.post("/api/businesses/me/payouts", businessPayoutHandler);

const businessPayoutListHandler = async (c: Ctx) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !a.user.business_id) return unauthorized(c);
  const rows = await c.env.DB.prepare("SELECT * FROM payouts WHERE business_id = ? ORDER BY created_at DESC LIMIT 50").bind(a.user.business_id).all<any>();
  return json(c, (rows.results ?? []).map((p) => ({
    id: String(p.id), amount: p.amount_cents / 100, amountCents: p.amount_cents,
    fee: p.fee_cents / 100, feeCents: p.fee_cents, net: p.net_cents / 100, netCents: p.net_cents,
    phone: p.phone, network: p.network, status: p.status, createdAt: p.created_at, error: p.error,
  })));
};

// Both spellings are accepted for GET too.
app.get("/api/businesses/me/payout", businessPayoutListHandler);
app.get("/api/businesses/me/payouts", businessPayoutListHandler);

// ---------- business VAT / tax ----------

/** YYYY-MM-DD check for period filters. */
const isoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** VAT summary for one business, from what orders actually stored (VAT_PCT used for legacy 0-VAT rows). */
app.get("/api/businesses/me/tax", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const businessId = await businessScope(c.env.DB, a, { businessId: c.req.query("businessId") });
  if (businessId == null) return unauthorized(c, "No business");
  const feeSettings = await loadFeeSettings(c.env.DB, feeEnvRaw(c.env));
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  let range = "";
  const rangeVals: unknown[] = [];
  if (isoDate(from)) { range += " AND substr(created_at, 1, 10) >= ?"; rangeVals.push(from); }
  if (isoDate(to)) { range += " AND substr(created_at, 1, 10) <= ?"; rangeVals.push(to); }

  const agg = await c.env.DB.prepare(
    `SELECT COUNT(*) AS salesCount,
            COALESCE(SUM(subtotal_cents), 0) AS taxableSalesCents,
            COALESCE(SUM(CASE WHEN vat_cents > 0 THEN vat_cents ELSE CAST(ROUND(subtotal_cents * ? / 100.0) AS INTEGER) END), 0) AS vatCollectedCents
       FROM orders
      WHERE business_id = ? AND payment_status = 'successful'${range}`
  ).bind(feeSettings.vatPct, businessId, ...rangeVals).first<any>();

  const sales = await c.env.DB.prepare(
    `SELECT o.id, o.created_at, o.subtotal_cents, o.vat_cents, o.total_cents, o.buyer_tpin, i.invoice_no
       FROM orders o LEFT JOIN invoices i ON i.order_id = o.id
      WHERE o.business_id = ? AND o.payment_status = 'successful'${range}
      ORDER BY o.created_at DESC LIMIT 200`
  ).bind(businessId, ...rangeVals).all<any>();

  const vatOf = (subtotalCents: number, storedVatCents: number): number =>
    storedVatCents > 0 ? storedVatCents : Math.round(subtotalCents * feeSettings.vatPct / 100);

  return json(c, {
    businessId: String(businessId),
    from: isoDate(from) ? from : null,
    to: isoDate(to) ? to : null,
    vatPct: feeSettings.vatPct,
    salesCount: Number(agg?.salesCount ?? 0),
    taxableSalesCents: Number(agg?.taxableSalesCents ?? 0),
    vatCollectedCents: Number(agg?.vatCollectedCents ?? 0),
    vatBySale: (sales.results ?? []).map((s: any) => ({
      orderId: s.id,
      invoiceNo: s.invoice_no ?? null,
      date: s.created_at,
      taxableCents: s.subtotal_cents,
      vatCents: vatOf(s.subtotal_cents, s.vat_cents),
      totalCents: s.total_cents,
      tpin: s.buyer_tpin ?? "",
    })),
  });
});

app.get("/api/businesses/me/tax/payments", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const businessId = await businessScope(c.env.DB, a, { businessId: c.req.query("businessId") });
  if (businessId == null) return unauthorized(c, "No business");
  const rows = await c.env.DB.prepare("SELECT * FROM tax_payments WHERE business_id = ? ORDER BY id DESC LIMIT 100")
    .bind(businessId).all<any>();
  return json(c, (rows.results ?? []).map((p) => ({
    id: String(p.id),
    periodStart: p.period_start,
    periodEnd: p.period_end,
    amountCents: p.amount_cents,
    amount: p.amount_cents / 100,
    reference: p.reference,
    method: p.method,
    createdAt: p.created_at,
  })));
});

app.post("/api/businesses/me/tax/payments", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const b = await body(c);
  const businessId = await businessScope(c.env.DB, a, b);
  if (businessId == null) return unauthorized(c, "No business");
  const amountCents = b.amountCents !== undefined ? Math.round(Number(b.amountCents)) : Math.round(Number(b.amount) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return badRequest(c, "amountCents must be a positive integer");
  const periodStart = b.periodStart;
  const periodEnd = b.periodEnd;
  if (!isoDate(periodStart) || !isoDate(periodEnd)) return badRequest(c, "periodStart and periodEnd must be YYYY-MM-DD");
  if (periodEnd < periodStart) return badRequest(c, "periodEnd must not be before periodStart");
  const r = await c.env.DB.prepare(
    `INSERT INTO tax_payments (business_id, period_start, period_end, amount_cents, reference, method, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(businessId, periodStart, periodEnd, amountCents, String(b.reference ?? "").slice(0, 80),
    String(b.method ?? "").slice(0, 40), a.id).run();
  await logAction(c.env.DB, a.id, "tax_payment_recorded", "tax_payment", String(r.meta.last_row_id), { amountCents, periodStart, periodEnd });
  return json(c, { ok: true, id: String(r.meta.last_row_id) }, 201);
});

// invoices (customer)

app.get("/api/invoices/mine", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a) return unauthorized(c);
  const rows = await c.env.DB.prepare(
    `SELECT i.*, b.name AS business_name, o.id AS order_id FROM invoices i
     JOIN businesses b ON b.id = i.business_id
     JOIN orders o ON o.id = i.order_id
     WHERE i.customer_id = ? ORDER BY i.issued_at DESC LIMIT 100`
  ).bind(a.id).all<any>();
  return json(c, (rows.results ?? []).map((i) => ({
    id: String(i.id), invoiceNo: i.invoice_no, orderId: i.order_id, businessName: i.business_name,
    status: i.status, afcCode: i.afc_code, acfCode: i.acf_code, zraQr: i.zra_qr,
    subtotal: i.subtotal_cents / 100, vat: i.vat_cents / 100, total: i.total_cents / 100,
    totalCents: i.total_cents, issuedAt: i.issued_at,
  })));
});

// ---------- admin ----------

// admin product management (any product, any business)

app.get("/api/admin/products", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const businessId = Number(c.req.query("businessId"));
  let sql = "SELECT p.*, b.name AS business_name FROM products p JOIN businesses b ON b.id = p.business_id";
  const vals: unknown[] = [];
  if (Number.isInteger(businessId) && businessId > 0) { sql += " WHERE p.business_id = ?"; vals.push(businessId); }
  sql += " ORDER BY p.id DESC LIMIT 500";
  const rows = await c.env.DB.prepare(sql).bind(...vals).all<any>();
  return json(c, (rows.results ?? []).map(productJson));
});

app.post("/api/admin/products", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const b = await body(c);
  if (!b.name || !b.price) return badRequest(c, "name and price are required");
  const priceCents = Math.round(Number(b.price) * 100);
  if (!Number.isFinite(priceCents) || priceCents <= 0) return badRequest(c, "invalid price");
  if (b.category && !isValidCategory(b.category)) return badRequest(c, "unknown category");
  let businessId: number | null = null;
  if (b.businessId !== undefined && b.businessId !== null && b.businessId !== "") {
    const id = Number(b.businessId);
    const biz = Number.isInteger(id) && id > 0 ? await getBusiness(c.env.DB, id) : null;
    if (!biz) return badRequest(c, "business not found");
    businessId = Number(biz.id);
  } else {
    businessId = await resolveDefaultBusiness(c.env.DB, a.id);
  }
  const r = await c.env.DB.prepare(
    `INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(businessId, String(b.name).slice(0, 120), priceCents, b.image ?? "", b.description ?? "",
    b.category ?? "", b.isGhost ? 1 : 0, Number(b.stock) || 0, b.active === false ? 0 : 1).run();
  const id = String(r.meta.last_row_id);
  await logAction(c.env.DB, a.id, "product_created", "product", id, { businessId, name: String(b.name).slice(0, 120) });
  return json(c, { ok: true, id, businessId: String(businessId) }, 201);
});

app.put("/api/admin/products/:id", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const id = Number(c.req.param("id"));
  const existing = await c.env.DB.prepare("SELECT id FROM products WHERE id = ?").bind(id).first<any>();
  if (!existing) return notFound(c, "Product not found");
  const b = await body(c);
  if (b.category !== undefined && b.category !== "" && !isValidCategory(String(b.category))) return badRequest(c, "unknown category");
  const sets: string[] = [];
  const vals: unknown[] = [];
  const fields: [string, string][] = [["name", "name"], ["image", "image"], ["description", "description"], ["category", "category"]];
  for (const [field, col] of fields) if (b[field] !== undefined) { sets.push(`${col} = ?`); vals.push(String(b[field])); }
  if (b.price !== undefined) {
    const pc = Math.round(Number(b.price) * 100);
    if (!Number.isFinite(pc) || pc <= 0) return badRequest(c, "invalid price");
    sets.push("price_cents = ?"); vals.push(pc);
  }
  if (b.stock !== undefined) { sets.push("stock = ?"); vals.push(Math.max(0, Number(b.stock) || 0)); }
  if (b.isGhost !== undefined) { sets.push("is_ghost = ?"); vals.push(b.isGhost ? 1 : 0); }
  if (b.active !== undefined) { sets.push("active = ?"); vals.push(b.active ? 1 : 0); }
  if (b.businessId !== undefined) {
    const bid = Number(b.businessId);
    const biz = Number.isInteger(bid) && bid > 0 ? await getBusiness(c.env.DB, bid) : null;
    if (!biz) return badRequest(c, "business not found");
    sets.push("business_id = ?"); vals.push(biz.id);
  }
  if (!sets.length) return badRequest(c, "nothing to update");
  vals.push(id);
  await c.env.DB.prepare(`UPDATE products SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).bind(...vals).run();
  await logAction(c.env.DB, a.id, "product_updated", "product", String(id), b);
  return json(c, { ok: true });
});

app.delete("/api/admin/products/:id", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const id = Number(c.req.param("id"));
  const existing = await c.env.DB.prepare("SELECT id FROM products WHERE id = ?").bind(id).first<any>();
  if (!existing) return notFound(c, "Product not found");
  await c.env.DB.prepare("UPDATE products SET active = 0, updated_at = datetime('now') WHERE id = ?").bind(id).run();
  await logAction(c.env.DB, a.id, "product_deleted", "product", String(id));
  return json(c, { ok: true });
});

app.get("/api/admin/stats", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const [users, businesses, orders, products, pendingBiz, pendingPay, wallet] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<any>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM businesses").first<any>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS gmv FROM orders WHERE payment_status = 'successful'").first<any>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM products").first<any>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM businesses WHERE status = 'pending'").first<any>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM payouts WHERE status IN ('pending','processing')").first<any>(),
    c.env.DB.prepare("SELECT COALESCE(SUM(balance_cents),0) AS bal FROM wallets").first<any>(),
  ]);
  const revenue = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(o.subtotal_cents * b.commission_pct / 100), 0) AS commission FROM orders o JOIN businesses b ON b.id = o.business_id WHERE o.payment_status = 'successful'`
  ).first<any>();
  return json(c, {
    users: users?.n ?? 0, businesses: businesses?.n ?? 0, orders: orders?.n ?? 0,
    gmvCents: orders?.gmv ?? 0, products: products?.n ?? 0,
    pendingBusinesses: pendingBiz?.n ?? 0, pendingPayouts: pendingPay?.n ?? 0,
    businessWalletCents: wallet?.bal ?? 0, platformCommissionCents: revenue?.commission ?? 0,
  });
});

app.get("/api/admin/users", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const q = c.req.query("q") ?? "";
  let sql = "SELECT * FROM users";
  const vals: unknown[] = [];
  if (q) { sql += " WHERE name LIKE ? OR phone LIKE ? OR email LIKE ?"; vals.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += " ORDER BY id DESC LIMIT 200";
  const rows = await c.env.DB.prepare(sql).bind(...vals).all<any>();
  return json(c, (rows.results ?? []).map(userJson));
});

app.patch("/api/admin/users/:id", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const b = await body(c);
  const id = Number(c.req.param("id"));
  const sets: string[] = [];
  const vals: unknown[] = [];
  const assignableRoles = ["user", "rider", "business", "employee", "admin"];
  if (b.role !== undefined) {
    if (id === a.id) return json(c, { error: "You cannot change your own role" }, 403);
    if (b.role === "superadmin") {
      if (a.user.role !== "superadmin") return json(c, { error: "Only a superadmin can grant superadmin" }, 403);
    } else if (!assignableRoles.includes(b.role)) {
      return badRequest(c, "invalid role");
    }
    sets.push("role = ?"); vals.push(b.role);
  }
  if (b.riderStatus !== undefined) {
    if (!["none", "pending", "approved", "rejected"].includes(b.riderStatus)) return badRequest(c, "invalid riderStatus");
    sets.push("rider_status = ?"); vals.push(b.riderStatus);
  }
  if (b.name !== undefined) { sets.push("name = ?"); vals.push(String(b.name)); }
  if (b.notificationsEnabled !== undefined) { sets.push("notifications_enabled = ?"); vals.push(b.notificationsEnabled ? 1 : 0); }
  if (!sets.length) return badRequest(c, "nothing to update");
  vals.push(id);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).bind(...vals).run();
  await logAction(c.env.DB, a.id, "user_updated", "user", String(id), b);
  return json(c, { ok: true });
});

app.get("/api/admin/businesses", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const rows = await c.env.DB.prepare(
    `SELECT b.*, u.name AS owner_name, u.phone AS owner_phone FROM businesses b JOIN users u ON u.id = b.owner_user_id ORDER BY b.created_at DESC LIMIT 200`
  ).all<any>();
  return json(c, (rows.results ?? []).map((b) => ({
    id: String(b.id), name: b.name, slogan: b.slogan, description: b.description, logo: b.logo,
    address: b.address, tpin: b.tpin, status: b.status, commissionPct: b.commission_pct,
    ownerName: b.owner_name, ownerPhone: b.owner_phone, createdAt: b.created_at,
  })));
});

app.post("/api/admin/businesses/:id/status", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const b = await body(c);
  if (!["pending", "approved", "suspended"].includes(b.status)) return badRequest(c, "invalid status");
  const id = Number(c.req.param("id"));
  const biz = await getBusiness(c.env.DB, id);
  if (!biz) return notFound(c, "Business not found");
  await c.env.DB.prepare("UPDATE businesses SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(b.status, id).run();
  await logAction(c.env.DB, a.id, `business_${b.status}`, "business", String(id));
  const owner = await c.env.DB.prepare("SELECT id, phone FROM users WHERE id = ?").bind(biz.owner_user_id).first<any>();
  if (owner) {
    if (b.status === "approved") {
      await pushNotif(c.env.DB, c.env, owner.id, "Business approved", `${biz.name} is approved. Start selling!`, "business");
      if (envV(c, "ENV", "sandbox") === "production") await sendSms(c.env, owner.phone, msg.businessApprovedSms(biz.name)).catch(() => {});
    } else if (b.status === "suspended") {
      await pushNotif(c.env.DB, c.env, owner.id, "Business suspended", `${biz.name} has been suspended. Contact support.`, "business");
    }
  }
  return json(c, { ok: true });
});

app.get("/api/admin/orders", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const { status } = c.req.query();
  let sql = "SELECT * FROM orders";
  const vals: unknown[] = [];
  if (status) { sql += " WHERE status = ?"; vals.push(status); }
  sql += " ORDER BY created_at DESC LIMIT 300";
  const rows = await c.env.DB.prepare(sql).bind(...vals).all<any>();
  const out = [];
  for (const r of rows.results ?? []) out.push(await orderJson(c.env.DB, r));
  return json(c, out);
});

app.get("/api/admin/payouts", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const rows = await c.env.DB.prepare(
    `SELECT p.*, b.name AS business_name FROM payouts p JOIN businesses b ON b.id = p.business_id ORDER BY p.created_at DESC LIMIT 100`
  ).all<any>();
  return json(c, (rows.results ?? []).map((p) => ({
    id: String(p.id), businessId: String(p.business_id), businessName: p.business_name,
    amount: p.amount_cents / 100, amountCents: p.amount_cents, feeCents: p.fee_cents, netCents: p.net_cents,
    phone: p.phone, network: p.network, status: p.status, lipilaReference: p.lipila_reference, error: p.error, createdAt: p.created_at,
  })));
});

app.post("/api/admin/payouts/:id/process", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const payout = await c.env.DB.prepare("SELECT * FROM payouts WHERE id = ?").bind(Number(c.req.param("id"))).first<any>();
  if (!payout) return notFound(c, "Payout not found");
  if (!payout.lipila_reference) return badRequest(c, "No Lipila reference — create a new payout");
  const res = await checkDisbursementStatus(c.env, payout.lipila_reference).catch(() => null);
  const status = res && ["success", "successful", "complete"].includes(res.status.toLowerCase())
    ? "successful"
    : res && ["failed", "error"].includes(res.status.toLowerCase()) ? "failed" : payout.status;
  await c.env.DB.prepare("UPDATE payouts SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(status, res?.message ?? null, payout.id).run();
  return json(c, { ok: true, status });
});

app.get("/api/admin/lipila-logs", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const rows = await c.env.DB.prepare("SELECT * FROM lipila_logs ORDER BY id DESC LIMIT 200").all<any>();
  return json(c, rows.results ?? []);
});

app.get("/api/admin/actions", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const rows = await c.env.DB.prepare("SELECT * FROM admin_actions ORDER BY id DESC LIMIT 200").all<any>();
  return json(c, rows.results ?? []);
});

app.get("/api/admin/invoices", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const rows = await c.env.DB.prepare(
    `SELECT i.*, b.name AS business_name FROM invoices i JOIN businesses b ON b.id = i.business_id ORDER BY i.id DESC LIMIT 200`
  ).all<any>();
  return json(c, (rows.results ?? []).map((i) => ({
    id: String(i.id), invoiceNo: i.invoice_no, orderId: i.order_id, businessName: i.business_name,
    tpin: i.tp_in, status: i.status, afcCode: i.afc_code, acfCode: i.acf_code,
    totalCents: i.total_cents, vatCents: i.vat_cents, issuedAt: i.issued_at, syncedAt: i.synced_at,
  })));
});

app.post("/api/admin/invoices/:id/sync-zra", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const res = await syncInvoiceToZra(c.env.DB, c.env, Number(c.req.param("id")));
  return json(c, res);
});

app.get("/api/admin/settings", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const rows = await c.env.DB.prepare("SELECT key, value FROM app_settings").all<any>();
  return json(c, Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value])));
});

app.patch("/api/admin/settings", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const b = await body(c);
  for (const [k, v] of Object.entries(b)) {
    if (typeof v !== "string" && typeof v !== "number") continue;
    await c.env.DB.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(k, String(v)).run();
  }
  invalidateFeeSettings();
  await logAction(c.env.DB, a.id, "settings_updated", "settings", null, b);
  return json(c, { ok: true });
});

app.get("/api/admin/categories", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const rows = await c.env.DB.prepare("SELECT * FROM categories ORDER BY id").all<any>();
  return json(c, (rows.results ?? []).map((r) => ({ id: String(r.id), name: r.name, icon: r.icon, enabled: r.enabled === 1 })));
});

app.post("/api/admin/categories", async (c) => {
  const a = await authFromRequest(c.env.DB, c.env, c.req.raw);
  if (!a || !hasRole(a.user, "admin", "superadmin")) return unauthorized(c);
  const b = await body(c);
  if (!b.name) return badRequest(c, "name is required");
  const r = await c.env.DB.prepare("INSERT INTO categories (name, icon, enabled) VALUES (?, ?, 1) ON CONFLICT(name) DO NOTHING")
    .bind(String(b.name), b.icon ?? "🛍️").run();
  return json(c, { ok: true, id: String(r.meta.last_row_id) }, 201);
});

// ---------- Lipila webhook ----------

app.post("/api/webhooks/lipila", async (c) => {
  const raw = await c.req.text();
  const secret = c.env.LIPILA_WEBHOOK_SECRET;

  // Verify: HMAC-SHA256 header (hex) OR body.secret OR ?secret= query.
  const sig = c.req.header("x-lipila-signature") ?? c.req.header("x-webhook-signature") ?? "";
  let verified = false;
  if (sig && secret) {
    const expected = await sha256Hex(`${secret}:${raw}`);
    const expectedRaw = await sha256Hex(raw + secret);
    if (sig === expected || sig === expectedRaw) verified = true;
  }
  let parsed: any = {};
  try { parsed = JSON.parse(raw); } catch { /* ignore */ }
  if (!verified && secret) {
    const qSecret = new URL(c.req.url).searchParams.get("secret");
    if (parsed.secret === secret || parsed.webhookSecret === secret || qSecret === secret) verified = true;
  }
  if (!verified) return unauthorized(c, "Invalid webhook signature");

  const event = parsed.event ?? parsed.type ?? "";
  const data = parsed.data ?? parsed;
  const referenceId = data.referenceId ?? data.reference_id ?? parsed.referenceId ?? "";
  const status = String(data.status ?? parsed.status ?? "").toLowerCase();
  const transactionId = data.identifier ?? data.transactionId ?? null;

  if (referenceId.startsWith("ORD-")) {
    // Order collection confirmation
    if (["success", "successful", "complete"].includes(status)) {
      await confirmOrder(c.env.DB, c.env, referenceId, transactionId ?? undefined);
    } else if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      await c.env.DB.prepare("UPDATE orders SET payment_status = 'failed', updated_at = datetime('now') WHERE id = ? AND payment_status != 'successful'").bind(referenceId).run();
      await logAction(c.env.DB, null, "payment_failed", "order", referenceId, { status });
    }
  } else if (referenceId.startsWith("PAY-")) {
    const payoutId = Number(referenceId.split("-")[1]);
    const final = ["success", "successful", "complete"].includes(status) ? "successful"
      : ["failed", "error"].includes(status) ? "failed" : null;
    if (final) {
      await c.env.DB.prepare("UPDATE payouts SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(final, payoutId).run();
      const payout = await c.env.DB.prepare("SELECT * FROM payouts WHERE id = ?").bind(payoutId).first<any>();
      if (payout && final === "failed") {
        await c.env.DB.prepare("UPDATE wallets SET balance_cents = balance_cents + ? WHERE business_id = ?")
          .bind(payout.amount_cents, payout.business_id).run();
        await pushAdmins(c.env.DB, c.env, "Payout failed", `Payout ${referenceId} of K${(payout.amount_cents / 100).toFixed(2)} failed. Balance restored.`, { type: "payout_failed" }).catch(() => {});
      }
    }
  } else if (referenceId.startsWith("RPY-")) {
    const payoutId = Number(referenceId.split("-")[1]);
    const final = ["success", "successful", "complete"].includes(status) ? "successful"
      : ["failed", "error"].includes(status) ? "failed" : null;
    if (final) {
      await c.env.DB.prepare("UPDATE rider_payouts SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(final, payoutId).run();
      const payout = await c.env.DB.prepare("SELECT * FROM rider_payouts WHERE id = ?").bind(payoutId).first<any>();
      if (payout && final === "failed") {
        await c.env.DB.prepare("UPDATE riders SET balance_cents = balance_cents + ? WHERE id = ?")
          .bind(payout.amount_cents, payout.rider_id).run();
      }
    }
  }
  await logAction(c.env.DB, null, `lipila_webhook_${event || status || "event"}`, "payment", referenceId, { status });
  return json(c, { received: true });
});

// ---------- scheduled: finalize payouts + expire stale orders ----------

async function runCron(env: Env) {
  // 1) Finalize disbursements stuck in 'processing'
  const payouts = await env.DB.prepare("SELECT * FROM payouts WHERE status = 'processing' AND lipila_reference IS NOT NULL").all<any>();
  for (const p of payouts.results ?? []) {
    try {
      const res = await checkDisbursementStatus(env, p.lipila_reference);
      const s = res.status.toLowerCase();
      if (["success", "successful", "complete"].includes(s)) {
        await env.DB.prepare("UPDATE payouts SET status = 'successful', updated_at = datetime('now') WHERE id = ?").bind(p.id).run();
      } else if (["failed", "error"].includes(s)) {
        await env.DB.prepare("UPDATE payouts SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?").bind(res.message ?? null, p.id).run();
        await env.DB.prepare("UPDATE wallets SET balance_cents = balance_cents + ? WHERE business_id = ?").bind(p.amount_cents, p.business_id).run();
      }
    } catch (e: any) {
      console.error(`cron payout check failed for ${p.id}:`, e);
    }
  }

  // 2) Expire orders that were never paid (48h)
  const expired = await env.DB.prepare(
    `SELECT id FROM orders WHERE payment_status = 'pending' AND status = 'Pending' AND created_at < datetime('now', '-2 days')`
  ).all<any>();
  for (const o of expired.results ?? []) {
    await env.DB.prepare("UPDATE orders SET status = 'Cancelled', cancelled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(o.id).run();
  }

  // 3) Finalize rider payouts stuck in 'processing'
  const rp = await env.DB.prepare("SELECT * FROM rider_payouts WHERE status = 'processing' AND lipila_reference IS NOT NULL").all<any>();
  for (const p of rp.results ?? []) {
    try {
      const res = await checkDisbursementStatus(env, p.lipila_reference);
      const s = res.status.toLowerCase();
      if (["success", "successful", "complete"].includes(s)) {
        await env.DB.prepare("UPDATE rider_payouts SET status = 'successful', updated_at = datetime('now') WHERE id = ?").bind(p.id).run();
      } else if (["failed", "error"].includes(s)) {
        await env.DB.prepare("UPDATE rider_payouts SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?").bind(res.message ?? null, p.id).run();
        await env.DB.prepare("UPDATE riders SET balance_cents = balance_cents + ? WHERE id = ?").bind(p.amount_cents, p.rider_id).run();
      }
    } catch (e: any) {
      console.error(`cron rider payout check failed for ${p.id}:`, e);
    }
  }

  return { payoutsChecked: (payouts.results ?? []).length, ordersExpired: (expired.results ?? []).length, riderPayoutsChecked: (rp.results ?? []).length };
}

app.get("/__cron", async (c) => {
  const res = await runCron(c.env);
  return json(c, { ok: true, ...res });
});

// Serve the website (Flutter web build) for any non-API path.
app.all("*", async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith("/api/") || url.pathname === "/health" || url.pathname === "/__cron") {
    return json(c, { error: "Not found" }, 404);
  }
  const assets = (c.env as any).ASSETS;
  if (!assets) return json(c, { error: "Website not built yet. Run: flutter build web" }, 503);
  try {
    return await assets.fetch(c.req.raw);
  } catch (e: any) {
    return json(c, { error: "Website unavailable: " + String(e.message ?? e).slice(0, 200) }, 503);
  }
});

app.onError((e, c) => {
  console.error("Unhandled:", e);
  return json(c, { error: "Internal error: " + String(e.message ?? e).slice(0, 300) }, 500);
});

export default {
  fetch: app.fetch,
  scheduled: (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runCron(env));
  },
};
