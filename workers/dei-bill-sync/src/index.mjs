/**
 * Per-user TEMO DEI bill sync. All private state is keyed by verified Firebase UID.
 * Firebase ID tokens are verified against Google's public Secure Token keys.
 */
import { verifyFirebaseIdToken } from "./firebase-auth.mjs";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const OAUTH_REDIRECT_URI = "https://dei-bill-sync.temo75elia.workers.dev/oauth/callback";
const DEI_USER_PREFIX = "dei:user:";
const DEI_CONNECTED_PREFIX = "dei:connected:";
const ALLOWED_ORIGIN = "https://temo75.github.io";
// Search broadly across DEI mail, then identify invoice-like messages in code.
 // in:anywhere also allows older messages still present in Spam/Trash to be considered.
const GMAIL_QUERY = 'in:anywhere from:(dei.gr)';

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-max-age": "86400",
    "vary": "Origin",
    ...extra,
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    }),
  });
}

function html(message, status = 200) {
  return new Response(`<!doctype html><html lang="el"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DEI Gmail σύνδεση</title><body style="font:16px Arial,sans-serif;max-width:680px;margin:40px auto;padding:20px;line-height:1.6">${message}</body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function findBody(payload, wantedMime) {
  if (!payload) return "";
  if (payload.mimeType === wantedMime && payload.body?.data) {
    try { return base64UrlDecode(payload.body.data); } catch { /* try other parts */ }
  }
  for (const part of payload.parts || []) {
    const found = findBody(part, wantedMime);
    if (found) return found;
  }
  if (payload.body?.data && !(payload.parts || []).length) {
    try { return base64UrlDecode(payload.body.data); } catch { /* malformed body */ }
  }
  return "";
}

function headerValue(headers, name) {
  return (headers || []).find(h => String(h.name).toLowerCase() === name.toLowerCase())?.value || "";
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|tr|li|h[1-6]|br|td|th)>/gi, "\n")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&euro;|&#8364;|&#x20ac;/gi, "€")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function extractAmount(text) {
  const t = String(text || "").replace(/\u00a0/g, " ");
  const patterns = [
    /(?:συνολικ[όο]\s+ποσ[όο]|πληρωτέο\s+ποσ[όο]|ποσ[όο]\s+πληρωμ[ής]|total\s+amount|amount\s+due)[^\d€]{0,60}(?:€\s*)?(\d{1,5}(?:[.,]\d{2})?)/i,
    /(\d{1,5}[.,]\d{2})\s*€/i,
    /€\s*(\d{1,5}[.,]\d{2})/i,
  ];
  for (const re of patterns) {
    const match = t.match(re);
    if (!match) continue;
    const raw = match[1];
    const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
    const amount = Number(normalized);
    if (Number.isFinite(amount) && amount >= 0 && amount < 100000) return amount.toFixed(2);
  }
  return null;
}

function numericBillAmount(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 && value < 100000 ? value : null;
  }
  const raw = String(value ?? "").trim().replace(/[\s\u00a0€]/g, "");
  if (!raw) return null;
  let normalized;
  if (/^\d+(?:\.\d{3})*,\d{1,2}$/.test(raw)) normalized = raw.replace(/\./g, "").replace(",", ".");
  else if (/^\d+(?:,\d{3})*\.\d{1,2}$/.test(raw)) normalized = raw.replace(/,/g, "");
  else if (/^\d+(?:\.\d{1,2})?$/.test(raw)) normalized = raw;
  else return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 && amount < 100000 ? amount : null;
}

function extractPaymentStatus(text) {
  const value = String(text || "").toLocaleLowerCase("el");
  const due = /(οφειλ|ανεξόφλητ|πληρωτέο|τελικό\s+ποσό\s+πληρωμής|amount\s+due|payable\s+amount|outstanding|to\s+pay)/i.test(value);
  const paid = /(εξοφλήθηκ|έχει\s+εξοφληθεί|πληρώθηκε|καταβλήθηκε|paid\s+in\s+full|fully\s+paid|settled)/i.test(value);
  if (due && paid) return "unknown";
  if (paid) return "paid";
  if (due) return "due";
  return "unknown";
}
function extractDueDate(text) {
  const patterns = [
    /(?:ημερομηνία\s+λήξης|λήξη\s+πληρωμής|πληρωτέο\s+έως|due\s+date|expiration\s+date)[^\d]{0,30}(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/i,
    /(?:έως|μέχρι|until|by)\s+(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/i,
  ];
  for (const re of patterns) {
    const match = String(text || "").match(re);
    if (!match) continue;
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return null;
}

const T1_RETURN_PATHS = new Set(["/t1/dei-bill.html", "/t1/bills.html"]);
function safeReturnTo(value) {
  try {
    const target = new URL(value || ALLOWED_ORIGIN + "/t1/dei-bill.html");
    if (target.origin !== ALLOWED_ORIGIN || !T1_RETURN_PATHS.has(target.pathname)) return null;
    return target.origin + target.pathname;
  } catch { return null; }
}
function randomHex(size = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(size)), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function base64UrlBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function userPrefix(uid) { return DEI_USER_PREFIX + await sha256Hex(uid) + ":"; }
async function userKey(uid, key) { return await userPrefix(uid) + key; }
async function authenticatedUid(request, env) {
  const match = String(request.headers.get("authorization") || "").match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;
  const claims = await verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID);
  return claims?.sub || null;
}
async function linkedT1Account(env, uid) {
  return await env.DEI_KV.get(await userKey(uid, "legacy_account_link"), "json");
}
async function verifiedLinkAdmin(request, env) {
  const bearer = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (env.LEGACY_LINK_ADMIN_KEY && constantTimeEqual(bearer, env.LEGACY_LINK_ADMIN_KEY)) return { type: "key" };
  if (!env.LEGACY_LINK_ADMIN_UID || !bearer) return null;
  const claims = await verifyFirebaseIdToken(bearer, env.FIREBASE_PROJECT_ID);
  if (claims?.sub === env.LEGACY_LINK_ADMIN_UID && claims.email_verified === true) return { type: "firebase", uid: claims.sub };
  return null;
}
async function pendingLinkRequest(env, uid) {
  return await env.DEI_KV.get("account_link_request:" + await sha256Hex(uid), "json");
}
function t1LinkRequired() {
  return json({ ok: false, error: "A verified existing T1 account link is required", code: "T1_ACCOUNT_LINK_REQUIRED" }, 403);
}
function assertConfig(env) {
  const missing = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!env.DEI_KV) missing.push("DEI_KV binding");
  if (!env.FIREBASE_PROJECT_ID) missing.push("FIREBASE_PROJECT_ID");
  if (!env.FIREBASE_API_KEY) missing.push("FIREBASE_API_KEY");
  if (!env.FIREBASE_AUTH_DOMAIN) missing.push("FIREBASE_AUTH_DOMAIN");
  if (!env.FIREBASE_APP_ID) missing.push("FIREBASE_APP_ID");
  if (!env.LEGACY_LINK_ADMIN_UID) missing.push("LEGACY_LINK_ADMIN_UID for verified account linking");
  if (!env.DEI_TOKEN_ENCRYPTION_KEY) missing.push("DEI_TOKEN_ENCRYPTION_KEY");
  return missing;
}
function firebaseClientConfig(env) {
  return {
    apiKey: env.FIREBASE_API_KEY || "",
    authDomain: env.FIREBASE_AUTH_DOMAIN || "",
    projectId: env.FIREBASE_PROJECT_ID || "",
    appId: env.FIREBASE_APP_ID || "",
  };
}
async function encryptionKey(env) {
  let raw;
  try { raw = base64UrlBytes(env.DEI_TOKEN_ENCRYPTION_KEY || ""); } catch { raw = new Uint8Array(); }
  if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_CONFIG_INVALID");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptRefreshToken(env, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(env);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  return "v1." + base64UrlEncode(iv) + "." + base64UrlEncode(new Uint8Array(encrypted));
}
async function decryptRefreshToken(env, value) {
  const [version, ivPart, dataPart] = String(value || "").split(".");
  if (version !== "v1" || !ivPart || !dataPart) throw new Error("TOKEN_CIPHERTEXT_INVALID");
  const key = await encryptionKey(env);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlBytes(ivPart) }, key, base64UrlBytes(dataPart));
  return new TextDecoder().decode(clear);
}
function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(String(a || ""));
  const right = new TextEncoder().encode(String(b || ""));
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
async function refreshAccessToken(env, uid) {
  const encryptedToken = await env.DEI_KV.get(await userKey(uid, "gmail_refresh_token"));
  if (!encryptedToken) throw new Error("GMAIL_NOT_CONNECTED");
  const refreshToken = await decryptRefreshToken(env, encryptedToken);
  const form = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(`GOOGLE_REFRESH_FAILED_${response.status}`);
  return data.access_token;
}

async function gmailFetch(env, path, accessToken = "") {
  const token = accessToken || await refreshAccessToken(env);
  const response = await fetch(`${GMAIL_API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GMAIL_API_FAILED_${response.status}`);
  return data;
}

function isLikelyInvoice(subject, bodyText) {
  const s = String(subject || "").toLocaleLowerCase("el");
  const t = String(bodyText || "").toLocaleLowerCase("el");
  const combined = s + "\n" + t;
  if (/(verification code|security code|one[- ]time password|login code|κωδικός επιβεβαίωσης|κωδικός ασφαλείας|κωδικός μιας χρήσης)/i.test(combined)) return false;
  if (/(payment confirmation|payment received|receipt for payment|επιβεβαίωση πληρωμής|απόδειξη πληρωμής|εξόφληση λογαριασμού|η πληρωμή σας καταχωρήθηκε)/i.test(combined)) return false;
  const subjectLooksLikeBill = /(δεη|δ[εέ]η|λογαριασμ|bill|invoice|electricity|ρεύμα)/i.test(s);
  const bodyLooksLikeBill = /(πληρωτέο ποσό|συνολικό ποσό|προθεσμία πληρωμής|ημερομηνία λήξης|amount due|due date|electricity bill|λογαριασμός ηλεκτρικού)/i.test(t);
  return subjectLooksLikeBill || bodyLooksLikeBill;
}
const BILL_PREFIX = "bill_history:";
const GMAIL_PAGE_SIZE = 20;

async function listStoredBills(env, uid) {
  const bills = [];
  let cursor;
  const prefix = await userKey(uid, "bill:");
  do {
    const page = await env.DEI_KV.list({ prefix, limit: 1000, cursor });
    for (const key of page.keys || []) {
      const bill = await env.DEI_KV.get(key.name, "json");
      if (bill && bill.gmailMessageId) bills.push(bill);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return [...new Map(bills.map(b => [String(b.gmailMessageId), b])).values()];
}

async function getLatestBill(env, uid, pageToken = "") {
  const accessToken = await refreshAccessToken(env, uid);
  const tokenParam = pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "";
  const list = await gmailFetch(env, "/messages?q=" + encodeURIComponent(GMAIL_QUERY) + "&maxResults=" + GMAIL_PAGE_SIZE + tokenParam, accessToken);
  const messages = Array.isArray(list.messages) ? list.messages : [];
  let newest = null;
  for (const summary of messages) {
    if (!summary?.id) continue;
    const full = await gmailFetch(env, "/messages/" + encodeURIComponent(summary.id) + "?format=full", accessToken);
    const headers = full.payload?.headers || [];
    const subject = headerValue(headers, "subject");
    const from = headerValue(headers, "from");
    if (!/@(?:[a-z0-9-]+\.)*dei\.gr\b/i.test(from)) continue;
    const htmlBody = findBody(full.payload, "text/html");
    const plainBody = findBody(full.payload, "text/plain");
    const bodyText = stripHtml([htmlBody, plainBody, full.snippet || ""].filter(Boolean).join("\n"));
    if (!isLikelyInvoice(subject, bodyText)) continue;
    const timestamp = Number(full.internalDate || summary.internalDate || 0);
    const headerDate = headerValue(headers, "date");
    const parsedHeaderDate = Date.parse(headerDate);
    const bill = {
      found: true,
      emailDate: timestamp ? new Date(timestamp).toISOString() : (Number.isFinite(parsedHeaderDate) ? new Date(parsedHeaderDate).toISOString() : ""),
      totalEUR: extractAmount(bodyText),
      dueDate: extractDueDate(bodyText),
      paymentStatus: extractPaymentStatus(bodyText),
      fetchedAt: new Date().toISOString(),
      gmailMessageId: String(summary.id),
      internalDate: timestamp,
    };
    if (bill.totalEUR === null && bill.dueDate === null) continue;
    await env.DEI_KV.put(await userKey(uid, "bill:" + encodeURIComponent(bill.gmailMessageId)), JSON.stringify(bill));
    if (!newest || bill.internalDate > newest.internalDate) newest = bill;
  }
  const existingLatest = await env.DEI_KV.get(await userKey(uid, "latest_bill"), "json");
  if (newest && (!existingLatest || newest.internalDate >= Number(existingLatest.internalDate || 0))) {
    await env.DEI_KV.put(await userKey(uid, "latest_bill"), JSON.stringify(newest));
  }
  const allBills = await listStoredBills(env, uid);
  const latest = await env.DEI_KV.get(await userKey(uid, "latest_bill"), "json") || newest || {
    found: false, message: "No parseable DEI invoice found in scanned messages",
    emailDate: "", totalEUR: null, dueDate: null, paymentStatus: "unknown", fetchedAt: new Date().toISOString()
  };
  return { ...latest, historyCount: allBills.length, scannedInvoices: messages.length, nextPageToken: list.nextPageToken || null };
}

async function getBillHistory(env, uid) {
  const bills = await listStoredBills(env, uid);
  const totalPaid = bills.reduce((sum, bill) => {
    const amount = numericBillAmount(bill.totalEUR);
    return bill.paymentStatus === "paid" && amount !== null ? sum + amount : sum;
  }, 0);
  const totalDue = bills.reduce((sum, bill) => {
    const amount = numericBillAmount(bill.totalEUR);
    return bill.paymentStatus === "due" && amount !== null ? sum + amount : sum;
  }, 0);
  const years = new Map();
  for (const bill of bills) {
    const timestamp = Number(bill.internalDate || 0);
    const parsedDate = timestamp ? new Date(timestamp) : new Date(bill.emailDate || "");
    if (Number.isNaN(parsedDate.getTime())) continue;
    const year = String(parsedDate.getUTCFullYear());
    if (!years.has(year)) years.set(year, { year, count: 0, paidEUR: 0, dueEUR: 0 });
    const row = years.get(year);
    row.count++;
    const amount = numericBillAmount(bill.totalEUR);
    if (bill.paymentStatus === "paid" && amount !== null) row.paidEUR += amount;
    else if (bill.paymentStatus === "due" && amount !== null) row.dueEUR += amount;
  }
  const annualTotals = [...years.values()].sort((a, b) => Number(b.year) - Number(a.year))
    .map(row => ({ year: row.year, count: row.count, paidEUR: row.paidEUR.toFixed(2), dueEUR: row.dueEUR.toFixed(2) }));
  bills.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0));
  return {
    bills: bills.map(bill => ({
      emailDate: String(bill.emailDate || ""), internalDate: Number(bill.internalDate || 0) || null,
      totalEUR: numericBillAmount(bill.totalEUR)?.toFixed(2) ?? bill.totalEUR ?? null, dueDate: bill.dueDate ?? null,
      paymentStatus: bill.paymentStatus || "unknown", fetchedAt: bill.fetchedAt || null
    })),
    count: bills.length, totalPaidEUR: totalPaid.toFixed(2), totalDueEUR: totalDue.toFixed(2), annualTotals
  };
}
function publicBill(bill) {
  if (!bill || typeof bill !== "object") return null;
  return {
    found: Boolean(bill.found),
    emailDate: String(bill.emailDate || ""),
    totalEUR: bill.totalEUR ?? null,
    dueDate: bill.dueDate ?? null,
    paymentStatus: bill.paymentStatus || "unknown",
    fetchedAt: bill.fetchedAt || null,
    message: bill.message || null,
  };
}

function safeError(error) {
  const message = String(error?.message || "Worker error");
  if (message === "GMAIL_NOT_CONNECTED") return { status: 401, message: "Gmail is not connected. Open /oauth/start first." };
  if (/^GOOGLE_REFRESH_FAILED_/.test(message)) return { status: 502, message: "Google token refresh failed. Reconnect Gmail and verify OAuth credentials." };
  if (/^GMAIL_API_FAILED_/.test(message)) return { status: 502, message: "Gmail API request failed. Verify Gmail API is enabled and OAuth access is valid." };
  return { status: 500, message: "Worker request failed. Check Cloudflare Worker logs." };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method !== "GET" && request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "GET, POST, OPTIONS" });
    if (url.origin === "null") return json({ ok: false, error: "Invalid request origin" }, 400);

    try {
      if (url.pathname === "/health") {
        const missing = assertConfig(env);
        return json({ ok: true, service: "TEMO per-user DEI bill sync", configurationComplete: missing.length === 0, missing });
      }
      if (url.pathname === "/api/config") {
        const config = firebaseClientConfig(env);
        if (!config.apiKey || !config.authDomain || !config.projectId || !config.appId) {
          return json({ ok: false, error: "Firebase client configuration is incomplete" }, 503);
        }
        return json({ ok: true, firebaseConfig: config });
      }
      if (url.pathname === "/api/account/link-request") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "POST, OPTIONS" });
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        const bearer = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        const claims = await verifyFirebaseIdToken(bearer, env.FIREBASE_PROJECT_ID);
        const uid = claims?.sub || null;
        if (!uid) return json({ ok: false, error: "A valid Firebase ID token is required" }, 401);
        if (claims.email_verified !== true || !claims.email) return json({ ok: false, error: "Verify the Firebase account email before requesting a link" }, 403);
        if ((await linkedT1Account(env, uid))?.legacyAccountId) return json({ ok: false, error: "This Firebase account is already linked" }, 409);
        const requestedAt = new Date().toISOString();
        await env.DEI_KV.put("account_link_request:" + await sha256Hex(uid), JSON.stringify({
          firebaseUid: uid, email: String(claims.email).slice(0, 254), requestedAt
        }), { expirationTtl: 7 * 24 * 60 * 60 });
        return json({ ok: true, requested: true, requestedAt });
      }
      if (url.pathname === "/api/admin/link-requests") {
        if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "GET, OPTIONS" });
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        if (!(await verifiedLinkAdmin(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
        const requests = [];
        let cursor;
        do {
          const page = await env.DEI_KV.list({ prefix: "account_link_request:", limit: 1000, cursor });
          for (const key of page.keys || []) {
            const value = await env.DEI_KV.get(key.name, "json");
            if (value?.firebaseUid && value?.email && value?.requestedAt) requests.push(value);
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        requests.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
        return json({ ok: true, requests });
      }
      if (url.pathname === "/api/admin/link-claim") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "POST, OPTIONS" });
        const admin = await verifiedLinkAdmin(request, env);
        if (!admin) return json({ ok: false, error: "Unauthorized" }, 401);
        const body = await request.json().catch(() => ({}));
        const legacyAccountId = String(body.legacyAccountId || "").trim();
        const firebaseUid = String(body.firebaseUid || "").trim();
        const verificationMethod = String(body.verificationMethod || "");
        const verificationReference = String(body.verificationReference || "").trim();
        if (!legacyAccountId || legacyAccountId.length > 200 || /[\u0000-\u001f]/.test(legacyAccountId) ||
            !firebaseUid || firebaseUid.length > 128 || /[\u0000-\u001f]/.test(firebaseUid) ||
            !["in_person", "known_phone", "existing_verified_channel", "owner_review"].includes(verificationMethod) ||
            !verificationReference || verificationReference.length > 200 || body.ownershipVerified !== true) {
          return json({ ok: false, error: "A verified account mapping and audit reference are required" }, 400);
        }
        if (admin.type === "firebase") {
          const pending = await pendingLinkRequest(env, firebaseUid);
          if (!pending || pending.firebaseUid !== firebaseUid) return json({ ok: false, error: "No pending request exists for this Firebase account" }, 409);
        }
        const claimCode = randomHex(32);
        await env.DEI_KV.put("account_link_claim:" + await sha256Hex(claimCode), JSON.stringify({
          firebaseUid, legacyAccountId, verificationMethod, verificationReference, issuedAt: new Date().toISOString()
        }), { expirationTtl: 7 * 24 * 60 * 60 });
        if (admin.type === "firebase") await env.DEI_KV.delete("account_link_request:" + await sha256Hex(firebaseUid));
        return json({ ok: true, claimCode, expiresInSeconds: 7 * 24 * 60 * 60 });
      }
      if (url.pathname === "/api/account/link") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "POST, OPTIONS" });
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        const bearer = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        const claims = await verifyFirebaseIdToken(bearer, env.FIREBASE_PROJECT_ID);
        const uid = claims?.sub || null;
        if (!uid) return json({ ok: false, error: "A valid Firebase ID token is required" }, 401);
        if (claims.email_verified !== true) return json({ ok: false, error: "Verify the Firebase account email before linking" }, 403);
        const body = await request.json().catch(() => ({}));
        const claimCode = String(body.claimCode || "");
        if (!/^[a-f0-9]{64}$/i.test(claimCode)) return json({ ok: false, error: "Invalid or expired link code" }, 401);
        const claimKey = "account_link_claim:" + await sha256Hex(claimCode);
        const claim = await env.DEI_KV.get(claimKey, "json");
        if (!claim || claim.firebaseUid !== uid) return json({ ok: false, error: "Invalid or expired link code" }, 401);
        const linkKey = await userKey(uid, "legacy_account_link");
        const existing = await env.DEI_KV.get(linkKey, "json");
        if (existing && existing.legacyAccountId !== claim.legacyAccountId) {
          return json({ ok: false, error: "This Firebase account is already linked" }, 409);
        }
        await env.DEI_KV.put(linkKey, JSON.stringify({
          legacyAccountId: claim.legacyAccountId,
          verificationMethod: claim.verificationMethod,
          verificationReference: claim.verificationReference,
          linkedAt: existing?.linkedAt || new Date().toISOString()
        }));
        await env.DEI_KV.delete(claimKey);
        return json({ ok: true, linked: true });
      }
      if (url.pathname === "/oauth/start") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "POST, OPTIONS" });
        const missing = assertConfig(env);
        if (missing.length) return json({ ok: false, error: "Worker configuration is incomplete", missing }, 503);
        const uid = await authenticatedUid(request, env);
        if (!uid) return json({ ok: false, error: "A valid Firebase ID token is required" }, 401);
        if (!(await linkedT1Account(env, uid))?.legacyAccountId) return t1LinkRequired();
        const body = await request.json().catch(() => ({}));
        const returnTo = safeReturnTo(body.returnTo);
        if (!returnTo) return json({ ok: false, error: "Invalid T1 return URL" }, 400);
        const state = randomHex(32);
        await env.DEI_KV.put("oauth_state:" + await sha256Hex(state), JSON.stringify({ uid, returnTo }), { expirationTtl: 10 * 60 });
        const auth = new URL(GOOGLE_AUTH);
        auth.search = new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          redirect_uri: OAUTH_REDIRECT_URI,
          response_type: "code",
          scope: "https://www.googleapis.com/auth/gmail.readonly",
          access_type: "offline",
          prompt: "select_account",
          include_granted_scopes: "true",
          state,
        }).toString();
        return json({ ok: true, authorizationUrl: auth.toString() });
      }
      if (url.pathname === "/oauth/callback") {
        const missing = assertConfig(env);
        if (missing.length) return html("<h2>Worker configuration is incomplete.</h2>", 503);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const stateKey = state ? "oauth_state:" + await sha256Hex(state) : "";
        const stateRecord = stateKey ? await env.DEI_KV.get(stateKey, "json") : null;
        if (!stateRecord?.uid || !safeReturnTo(stateRecord.returnTo)) {
          return html("<h2>Authorization state is invalid or expired. Return to T1 and try again.</h2>", 400);
        }
        // Consume state before calling Google so a callback cannot be replayed.
        await env.DEI_KV.delete(stateKey);
        const destination = new URL(stateRecord.returnTo);
        if (!(await linkedT1Account(env, stateRecord.uid))?.legacyAccountId) {
          destination.hash = new URLSearchParams({ dei_gmail: "link_required" }).toString();
          return Response.redirect(destination.toString(), 302);
        }
        if (url.searchParams.get("error")) {
          destination.hash = new URLSearchParams({ dei_gmail: "denied" }).toString();
          return Response.redirect(destination.toString(), 302);
        }
        if (!code) return html("<h2>Google did not return an authorization code.</h2>", 400);
        const form = new URLSearchParams({
          code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: OAUTH_REDIRECT_URI, grant_type: "authorization_code"
        });
        const response = await fetch(GOOGLE_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.access_token) {
          destination.hash = new URLSearchParams({ dei_gmail: "error" }).toString();
          return Response.redirect(destination.toString(), 302);
        }
        const refreshKey = await userKey(stateRecord.uid, "gmail_refresh_token");
        if (data.refresh_token) {
          await env.DEI_KV.put(refreshKey, await encryptRefreshToken(env, data.refresh_token));
        } else if (!(await env.DEI_KV.get(refreshKey))) {
          destination.hash = new URLSearchParams({ dei_gmail: "missing_refresh" }).toString();
          return Response.redirect(destination.toString(), 302);
        }
        const stateKeyForUser = await userKey(stateRecord.uid, "sync_status");
        await env.DEI_KV.put(stateKeyForUser, JSON.stringify({ gmailConnectedAt: new Date().toISOString(), lastSyncAt: null, lastSyncStatus: "not_synced" }));
        await env.DEI_KV.put(DEI_CONNECTED_PREFIX + await sha256Hex(stateRecord.uid), stateRecord.uid);
        destination.hash = new URLSearchParams({ dei_gmail: "connected" }).toString();
        return Response.redirect(destination.toString(), 302);
      }
      if (url.pathname === "/api/status") {
        const uid = await authenticatedUid(request, env);
        if (!uid) return json({ ok: false, error: "A valid Firebase ID token is required" }, 401);
        const link = await linkedT1Account(env, uid);
        if (!link?.legacyAccountId) return json({ ok: true, linked: false, gmailConnected: false, syncStatus: "account_link_required", lastSyncAt: null });
        const refresh = await env.DEI_KV.get(await userKey(uid, "gmail_refresh_token"));
        const status = await env.DEI_KV.get(await userKey(uid, "sync_status"), "json");
        const latest = await env.DEI_KV.get(await userKey(uid, "latest_bill"), "json");
        return json({ ok: true, linked: true, t1AccountId: link.legacyAccountId, gmailConnected: Boolean(refresh), lastFetchedAt: latest?.fetchedAt || null, syncStatus: status?.lastSyncStatus || "not_synced", lastSyncAt: status?.lastSyncAt || null });
      }
      if (url.pathname === "/api/sync") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "POST, OPTIONS" });
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        const uid = await authenticatedUid(request, env);
        if (!uid) return json({ ok: false, error: "A valid Firebase ID token is required" }, 401);
        if (!(await linkedT1Account(env, uid))?.legacyAccountId) return t1LinkRequired();
        let body = {};
        try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
        const cursorKey = await userKey(uid, "sync_cursor");
        if (!body.continue) await env.DEI_KV.delete(cursorKey);
        const pageToken = body.continue ? await env.DEI_KV.get(cursorKey) : null;
        const result = await getLatestBill(env, uid, pageToken || "");
        if (result.nextPageToken) await env.DEI_KV.put(cursorKey, result.nextPageToken, { expirationTtl: 24 * 60 * 60 });
        else await env.DEI_KV.delete(cursorKey);
        await env.DEI_KV.put(await userKey(uid, "sync_status"), JSON.stringify({
          gmailConnectedAt: (await env.DEI_KV.get(await userKey(uid, "sync_status"), "json"))?.gmailConnectedAt || null,
          lastSyncAt: new Date().toISOString(), lastSyncStatus: result.nextPageToken ? "in_progress" : "complete"
        }));
        return json({ ok: true, bill: publicBill(result), cached: false, scannedCount: result.scannedInvoices, historyCount: result.historyCount, complete: !result.nextPageToken });
      }
      if (url.pathname === "/api/history") {
        if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "GET, OPTIONS" });
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        const uid = await authenticatedUid(request, env);
        if (!uid) return json({ ok: false, error: "A valid Firebase ID token is required" }, 401);
        if (!(await linkedT1Account(env, uid))?.legacyAccountId) return t1LinkRequired();
        return json({ ok: true, ...(await getBillHistory(env, uid)) });
      }
      if (url.pathname === "/api/latest") {
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        const uid = await authenticatedUid(request, env);
        if (!uid) return json({ ok: false, error: "A valid Firebase ID token is required" }, 401);
        if (!(await linkedT1Account(env, uid))?.legacyAccountId) return t1LinkRequired();
        const latest = await env.DEI_KV.get(await userKey(uid, "latest_bill"), "json");
        return json({ ok: true, bill: publicBill(latest || { found: false, paymentStatus: "unknown" }), cached: true });
      }
      return json({ service: "TEMO per-user DEI bill sync", routes: ["/health", "/api/config", "/api/account/link-request", "/api/admin/link-requests", "/api/admin/link-claim", "/api/account/link", "/oauth/start", "/oauth/callback", "/api/status", "/api/sync", "/api/latest", "/api/history"] });
    } catch (error) {
      const safe = safeError(error);
      return json({ ok: false, error: safe.message }, safe.status);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      let cursor;
      do {
        const page = await env.DEI_KV.list({ prefix: DEI_CONNECTED_PREFIX, limit: 1000, cursor });
        for (const key of page.keys || []) {
          const uid = await env.DEI_KV.get(key.name);
          if (!uid) continue;
          try {
            if (!(await linkedT1Account(env, uid))?.legacyAccountId) continue;
            let pageToken = await env.DEI_KV.get(await userKey(uid, "scheduled_sync_cursor")) || "";
            for (let count = 0; count < 5; count++) {
              const result = await getLatestBill(env, uid, pageToken);
              pageToken = result.nextPageToken || "";
              if (!pageToken) break;
            }
            if (pageToken) await env.DEI_KV.put(await userKey(uid, "scheduled_sync_cursor"), pageToken, { expirationTtl: 7 * 24 * 60 * 60 });
            else await env.DEI_KV.delete(await userKey(uid, "scheduled_sync_cursor"));
            await env.DEI_KV.put(await userKey(uid, "sync_status"), JSON.stringify({
              lastSyncAt: new Date().toISOString(), lastSyncStatus: pageToken ? "in_progress" : "complete"
            }));
          } catch {
            await env.DEI_KV.put(await userKey(uid, "sync_status"), JSON.stringify({
              lastSyncAt: new Date().toISOString(), lastSyncStatus: "error"
            }));
          }
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    })());
  },
};
