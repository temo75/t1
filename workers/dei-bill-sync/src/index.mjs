/**
 * TEMO DEI bill sync — Cloudflare Worker
 * Required binding: DEI_KV (KV namespace)
 * Required variables/secrets:
 *   GOOGLE_CLIENT_ID       (text variable)
 *   GOOGLE_CLIENT_SECRET   (secret)
 *   T1 bill access uses short-lived sessions issued after Google OAuth.
 * OAuth redirect URI:
 *   https://dei-bill-sync.temo75elia.workers.dev/oauth/callback
 * Optional: configure a Cron Trigger every 3 hours.
 */

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
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

function extractPaymentStatus(text) {
  const value = String(text || "").toLocaleLowerCase("el");
  const due = /(οφειλ|ανεξόφλητ|πληρωτέο|amount\s+due|outstanding|to\s+pay)/i.test(value);
  const paid = /(εξοφλήθηκ|έχει\s+εξοφληθεί|πληρώθηκε|καταβλήθηκε|paid\s+in\s+full|fully\s+paid|settled)/i.test(value);
  if (due && paid) return "unknown";
  if (paid) return "paid";
  if (due) return "due";
  return "unknown";
}
function extractDueDate(text) {
  const patterns = [
    /(?:ημερομηνία\s+λήξης|λήξη\s+πληρωμής|πληρωτέο\s+έως|due\s+date)[^\d]{0,30}(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/i,
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
async function hasT1Session(request, env) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || !env.DEI_KV) return false;
  return Boolean(await env.DEI_KV.get("t1_session:" + await sha256Hex(token)));
}
function assertConfig(env) {
  const missing = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!env.DEI_KV) missing.push("DEI_KV binding");
  return missing;
}

async function refreshAccessToken(env) {
  const refreshToken = await env.DEI_KV.get("gmail_refresh_token");
  if (!refreshToken) throw new Error("GMAIL_NOT_CONNECTED");
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

async function listStoredBills(env) {
  const bills = [];
  let cursor;
  do {
    const page = await env.DEI_KV.list({ prefix: BILL_PREFIX, limit: 1000, cursor });
    for (const key of page.keys || []) {
      const bill = await env.DEI_KV.get(key.name, "json");
      if (bill && bill.gmailMessageId) bills.push(bill);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const legacy = await env.DEI_KV.get("bill_history", "json");
  if (Array.isArray(legacy)) {
    const seen = new Set(bills.map(x => String(x.gmailMessageId)));
    for (const bill of legacy) {
      if (!bill?.gmailMessageId || seen.has(String(bill.gmailMessageId))) continue;
      bills.push(bill);
      seen.add(String(bill.gmailMessageId));
      await env.DEI_KV.put(BILL_PREFIX + encodeURIComponent(String(bill.gmailMessageId)), JSON.stringify(bill));
    }
  }
  return [...new Map(bills.map(b => [String(b.gmailMessageId), b])).values()];
}

async function getLatestBill(env, pageToken = "") {
  const accessToken = await refreshAccessToken(env);
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
    await env.DEI_KV.put(BILL_PREFIX + encodeURIComponent(bill.gmailMessageId), JSON.stringify(bill));
    if (!newest || bill.internalDate > newest.internalDate) newest = bill;
  }
  const existingLatest = await env.DEI_KV.get("latest_bill", "json");
  if (newest && (!existingLatest || newest.internalDate >= Number(existingLatest.internalDate || 0))) {
    await env.DEI_KV.put("latest_bill", JSON.stringify(newest));
  }
  const allBills = await listStoredBills(env);
  const latest = await env.DEI_KV.get("latest_bill", "json") || newest || {
    found: false, message: "No parseable DEI invoice found in scanned messages",
    emailDate: "", totalEUR: null, dueDate: null, paymentStatus: "unknown", fetchedAt: new Date().toISOString()
  };
  return { ...latest, historyCount: allBills.length, scannedInvoices: messages.length, nextPageToken: list.nextPageToken || null };
}

async function getBillHistory(env) {
  const bills = await listStoredBills(env);
  const totalPaid = bills.reduce((sum, bill) => bill.paymentStatus === "paid" && Number.isFinite(Number(bill.totalEUR)) ? sum + Number(bill.totalEUR) : sum, 0);
  const totalDue = bills.reduce((sum, bill) => bill.paymentStatus === "due" && Number.isFinite(Number(bill.totalEUR)) ? sum + Number(bill.totalEUR) : sum, 0);
  const years = new Map();
  for (const bill of bills) {
    const timestamp = Number(bill.internalDate || 0);
    const parsedDate = timestamp ? new Date(timestamp) : new Date(bill.emailDate || "");
    if (Number.isNaN(parsedDate.getTime())) continue;
    const year = String(parsedDate.getUTCFullYear());
    if (!years.has(year)) years.set(year, { year, count: 0, paidEUR: 0, dueEUR: 0 });
    const row = years.get(year);
    row.count++;
    const amount = Number(bill.totalEUR);
    if (bill.paymentStatus === "paid" && Number.isFinite(amount)) row.paidEUR += amount;
    else if (bill.paymentStatus === "due" && Number.isFinite(amount)) row.dueEUR += amount;
  }
  const annualTotals = [...years.values()].sort((a, b) => Number(b.year) - Number(a.year))
    .map(row => ({ year: row.year, count: row.count, paidEUR: row.paidEUR.toFixed(2), dueEUR: row.dueEUR.toFixed(2) }));
  bills.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0));
  return {
    bills: bills.map(bill => ({
      emailDate: String(bill.emailDate || ""), internalDate: Number(bill.internalDate || 0) || null,
      totalEUR: bill.totalEUR ?? null, dueDate: bill.dueDate ?? null,
      paymentStatus: bill.paymentStatus || "unknown", fetchedAt: bill.fetchedAt || null
    })),
    count: bills.length, totalPaidEUR: totalPaid.toFixed(2), totalDueEUR: totalDue.toFixed(2), annualTotals
  };
}
function publicBill(bill) {
  if (!bill || typeof bill !== "object") return null;
  return {
    found: Boolean(bill.found),
    subject: String(bill.subject || ""),
    from: String(bill.from || ""),
    emailDate: String(bill.emailDate || ""),
    totalEUR: bill.totalEUR ?? null,
    dueDate: bill.dueDate ?? null,
    paymentStatus: bill.paymentStatus || "unknown",
    snippet: String(bill.snippet || "").slice(0, 300),
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

    try {
      if (url.pathname === "/health") {
        const missing = assertConfig(env);
        const connected = Boolean(env.DEI_KV && await env.DEI_KV.get("gmail_refresh_token"));
        return json({ ok: true, service: "TEMO DEI bill sync", configurationComplete: missing.length === 0, missing, oauthConfigured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), kvConfigured: Boolean(env.DEI_KV), gmailConnected: connected });
      }

      if (url.pathname === "/oauth/start") {
        const missing = assertConfig(env);
        if (missing.length) return json({ ok: false, error: "Missing required Worker configuration", missing }, 500);
        const stateBytes = crypto.getRandomValues(new Uint8Array(32));
        const state = Array.from(stateBytes, byte => byte.toString(16).padStart(2, "0")).join("");
        const returnTo = safeReturnTo(url.searchParams.get("return_to"));
        if (!returnTo) return json({ ok: false, error: "Invalid T1 return URL" }, 400);
        await env.DEI_KV.put("oauth_state:" + state, JSON.stringify({ returnTo }), { expirationTtl: 600 });
        const redirectUri = `${url.origin}/oauth/callback`;
        const auth = new URL(GOOGLE_AUTH);
        auth.search = new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "https://www.googleapis.com/auth/gmail.readonly",
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "true",
          state,
        }).toString();
        return Response.redirect(auth.toString(), 302);
      }

      if (url.pathname === "/oauth/callback") {
        const missing = assertConfig(env);
        if (missing.length) return html(`<h2>Worker configuration is incomplete.</h2><p>Missing: ${escapeHtml(missing.join(", "))}</p>`, 500);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const denied = url.searchParams.get("error");
        if (denied) return html(`<h2>Google authorization was not completed.</h2><p>${escapeHtml(denied)}</p>`, 400);
        const stateValue = state ? await env.DEI_KV.get("oauth_state:" + state) : null;
        let oauthState = null;
        try { oauthState = stateValue ? JSON.parse(stateValue) : null; } catch { oauthState = null; }
        if (!code || !state || !oauthState?.returnTo) {
          return html("<h2>Authorization link is invalid or expired.</h2><p>Open T1 and connect Gmail again.</p>", 400);
        }
        await env.DEI_KV.delete("oauth_state:" + state);
        const redirectUri = `${url.origin}/oauth/callback`;
        const form = new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code" });
        const response = await fetch(GOOGLE_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.access_token) return html("<h2>Google authorization failed.</h2><p>Verify the OAuth client and exact redirect URI in Google Cloud. Do not expose secrets.</p>", 502);
        if (data.refresh_token) {
          await env.DEI_KV.put("gmail_refresh_token", data.refresh_token);
        } else if (!(await env.DEI_KV.get("gmail_refresh_token"))) {
          return html("<h2>Google did not return a refresh token.</h2><p>Revoke this app's access in Google Account security, then open /oauth/start again.</p>", 400);
        }
        await env.DEI_KV.put("gmail_connected_at", new Date().toISOString());
        const grant = randomHex(32);
        await env.DEI_KV.put("oauth_grant:" + await sha256Hex(grant), JSON.stringify({ returnTo: oauthState.returnTo }), { expirationTtl: 180 });
        const destination = new URL(oauthState.returnTo);
        destination.hash = new URLSearchParams({ dei_code: grant }).toString();
        return Response.redirect(destination.toString(), 302);
      }

      if (url.pathname === "/api/session/exchange") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "POST, OPTIONS" });
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        if (request.headers.get("origin") !== ALLOWED_ORIGIN) return json({ ok: false, error: "Forbidden" }, 403);
        const body = await request.json().catch(() => ({}));
        const grant = String(body.code || "");
        if (!/^[a-f0-9]{64}$/i.test(grant)) return json({ ok: false, error: "Invalid or expired authorization code" }, 401);
        const grantKey = "oauth_grant:" + await sha256Hex(grant);
        const grantValue = await env.DEI_KV.get(grantKey);
        if (!grantValue) return json({ ok: false, error: "Invalid or expired authorization code" }, 401);
        await env.DEI_KV.delete(grantKey);
        const sessionToken = randomHex(32);
        const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
        await env.DEI_KV.put("t1_session:" + await sha256Hex(sessionToken), "1", { expirationTtl: 8 * 60 * 60 });
        return json({ ok: true, sessionToken, expiresAt });
      }

      if (url.pathname === "/api/status") {
        const connected = Boolean(env.DEI_KV && await env.DEI_KV.get("gmail_refresh_token"));
        const latest = env.DEI_KV ? await env.DEI_KV.get("latest_bill", "json") : null;
        return json({ ok: true, gmailConnected: connected, lastFetchedAt: latest?.fetchedAt || null });
      }

      if (url.pathname === "/api/sync") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "POST, OPTIONS" });
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        const sessionToken = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        const ownerKey = await getT1SessionOwner(request, env);
        if (!sessionToken || !ownerKey) return json({ ok: false, error: "Unauthorized" }, 401);
        let body = {};
        try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
        const cursorKey = "sync_cursor:" + await sha256Hex(sessionToken);
        if (!body.continue) await env.DEI_KV.delete(cursorKey);
        const pageToken = body.continue ? await env.DEI_KV.get(cursorKey) : null;
        const result = await getLatestBill(env, pageToken || "");
        if (result.nextPageToken) await env.DEI_KV.put(cursorKey, result.nextPageToken, { expirationTtl: 3600 });
        else await env.DEI_KV.delete(cursorKey);
        return json({
          ok: true, bill: publicBill(result), cached: false, scannedCount: result.scannedInvoices,
          historyCount: result.historyCount, complete: !result.nextPageToken
        });
      }
      if (url.pathname === "/api/history") {
        if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "GET, OPTIONS" });
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        if (!(await hasT1Session(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
        return json({ ok: true, ...(await getBillHistory(env)) });
      }

      if (url.pathname === "/api/latest") {
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        if (!(await hasT1Session(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
        const cached = await env.DEI_KV.get("latest_bill", "json");
        return json({ ok: true, bill: publicBill(cached || { found: false, paymentStatus: "unknown" }), cached: true });
      }
      return json({ service: "TEMO DEI bill sync", routes: ["/health", "/oauth/start", "/oauth/callback", "/api/status", "/api/session/exchange", "/api/sync", "/api/latest"], t1Page: "https://temo75.github.io/t1/dei-bill.html" });
    } catch (error) {
      const safe = safeError(error);
      return json({ ok: false, error: safe.message }, safe.status);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const cursor = await env.DEI_KV.get("scheduled_sync_cursor");
      const result = await getLatestBill(env, cursor || "");
      if (result.nextPageToken) await env.DEI_KV.put("scheduled_sync_cursor", result.nextPageToken);
      else await env.DEI_KV.delete("scheduled_sync_cursor");
    })());
  },
};

