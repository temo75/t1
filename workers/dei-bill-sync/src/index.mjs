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
const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo";
const ALLOWED_ORIGIN = "https://temo75.github.io";
const GMAIL_QUERY = 'from:(dei.gr) {subject:ΔΕΗ subject:λογαριασμού}';

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
  if (/(εξοφλ|πληρώθηκε|καταβλήθηκε|paid|settled|fully\s+paid)/i.test(value)) return "paid";
  if (/(οφειλ|ανεξόφλητ|πληρωτέο|πληρωμή\s+(?:έως|μέχρι)|amount\s+due|outstanding|to\s+pay)/i.test(value)) return "due";
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
async function getT1Session(request, env) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\\s+/i, "");
  if (!token || !env.DEI_KV) return null;
  const value = await env.DEI_KV.get("t1_session:" + await sha256Hex(token));
  if (!value) return null;
  try {
    const session = JSON.parse(value);
    return session && /^[a-f0-9]{64}$/.test(session.emailKey || "") ? session : null;
  } catch { return null; }
}
function assertConfig(env) {
  const missing = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!env.DEI_KV) missing.push("DEI_KV binding");
  return missing;
}

async function refreshAccessToken(env, emailKey) {
  const refreshToken = await env.DEI_KV.get("gmail_refresh_token:" + emailKey);
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

async function gmailFetch(env, emailKey, path) {
  const token = await refreshAccessToken(env, emailKey);
  const response = await fetch(`${GMAIL_API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GMAIL_API_FAILED_${response.status}`);
  return data;
}

async function getLatestBill(env, emailKey) {
  const query = encodeURIComponent(GMAIL_QUERY);
  const list = await gmailFetch(env, emailKey, `/messages?q=${query}&maxResults=10`);
  const messages = list.messages || [];
  if (!messages.length) {
    const empty = { found: false, message: "No matching DEI bill email found", emailDate: "", totalEUR: null, dueDate: null, paymentStatus: "unknown", fetchedAt: new Date().toISOString() };
    await env.DEI_KV.put("latest_bill:" + emailKey, JSON.stringify(empty));
    return empty;
  }

  const full = await gmailFetch(env, emailKey, `/messages/${encodeURIComponent(messages[0].id)}?format=full`);
  const headers = full.payload?.headers || [];
  const htmlBody = findBody(full.payload, "text/html");
  const plainBody = findBody(full.payload, "text/plain");
  const bodyText = stripHtml(htmlBody || plainBody || full.snippet || "");
  const result = {
    found: true,
    subject: headerValue(headers, "subject"),
    from: headerValue(headers, "from"),
    emailDate: headerValue(headers, "date"),
    totalEUR: extractAmount(bodyText),
    dueDate: extractDueDate(bodyText),
    paymentStatus: extractPaymentStatus(bodyText),
    snippet: String(full.snippet || "").slice(0, 300),
    fetchedAt: new Date().toISOString(),
  };
  await env.DEI_KV.put("latest_bill:" + emailKey, JSON.stringify(result));
  return result;
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
        return json({ ok: true, service: "TEMO DEI bill sync", configurationComplete: missing.length === 0, missing, oauthConfigured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), kvConfigured: Boolean(env.DEI_KV) });
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
          scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
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
        const userInfoResponse = await fetch(GOOGLE_USERINFO, { headers: { authorization: "Bearer " + data.access_token } });
        const userInfo = await userInfoResponse.json().catch(() => ({}));
        const email = String(userInfo.email || "").trim().toLowerCase();
        if (!userInfoResponse.ok || !email || userInfo.verified_email !== true) {
          return html("<h2>Google did not confirm the account email.</h2><p>Please reconnect Gmail and allow the email identity permission.</p>", 502);
        }
        const emailKey = await sha256Hex(email);
        const refreshKey = "gmail_refresh_token:" + emailKey;
        if (data.refresh_token) {
          await env.DEI_KV.put(refreshKey, data.refresh_token);
        } else if (!(await env.DEI_KV.get(refreshKey))) {
          return html("<h2>Google did not return a refresh token.</h2><p>Revoke this app's access in Google Account security, then open T1 and connect Gmail again.</p>", 400);
        }
        const knownUsers = await env.DEI_KV.get("gmail_user_keys", "json") || [];
        if (!knownUsers.includes(emailKey)) {
          knownUsers.push(emailKey);
          await env.DEI_KV.put("gmail_user_keys", JSON.stringify(knownUsers));
        }
        const grant = randomHex(32);
        await env.DEI_KV.put("oauth_grant:" + await sha256Hex(grant), JSON.stringify({ returnTo: oauthState.returnTo, emailKey }), { expirationTtl: 180 });
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
        if (!/^[a-f0-9]{64}$/.test(grantValue.emailKey || "")) return json({ ok: false, error: "Authorization grant has no account identity" }, 401);
        const sessionToken = randomHex(32);
        const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
        await env.DEI_KV.put("t1_session:" + await sha256Hex(sessionToken), JSON.stringify({ emailKey: grantValue.emailKey }), { expirationTtl: 8 * 60 * 60 });
        return json({ ok: true, sessionToken, expiresAt });
      }

      if (url.pathname === "/api/status") {
        const session = await getT1Session(request, env);
        if (!session) return json({ ok: true, gmailConnected: false, lastFetchedAt: null });
        const latest = await env.DEI_KV.get("latest_bill:" + session.emailKey, "json");
        return json({ ok: true, gmailConnected: true, lastFetchedAt: latest?.fetchedAt || null });
      }

      if (url.pathname === "/api/sync") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "POST, OPTIONS" });
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        const session = await getT1Session(request, env);
        if (!session) return json({ ok: false, error: "Unauthorized" }, 401);
        const bill = await getLatestBill(env, session.emailKey);
        return json({ ok: true, bill: publicBill(bill), cached: false });
      }

      if (url.pathname === "/api/latest") {
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        const session = await getT1Session(request, env);
        if (!session) return json({ ok: false, error: "Unauthorized" }, 401);
        const cacheKey = "latest_bill:" + session.emailKey;
        const cached = await env.DEI_KV.get(cacheKey, "json");
        if (cached?.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < 5 * 60 * 1000) return json({ ok: true, bill: publicBill(cached), cached: true });
        const bill = await getLatestBill(env, session.emailKey);
        return json({ ok: true, bill: publicBill(bill), cached: false });
      }

      return json({ service: "TEMO DEI bill sync", routes: ["/health", "/oauth/start", "/oauth/callback", "/api/status", "/api/session/exchange", "/api/sync", "/api/latest"], t1Page: "https://temo75.github.io/t1/dei-bill.html" });
    } catch (error) {
      const safe = safeError(error);
      return json({ ok: false, error: safe.message }, safe.status);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const emailKeys = await env.DEI_KV.get("gmail_user_keys", "json") || [];
      await Promise.all(emailKeys.map(async emailKey => {
        try { await getLatestBill(env, emailKey); }
        catch (error) { console.error("Scheduled DEI sync failed for account key", emailKey, error?.message || error); }
      }));
    })());
  },
};

