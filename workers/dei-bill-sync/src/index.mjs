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
const ALLOWED_ORIGINS = new Set(["https://temo75.github.io", "https://temo1.gr", "https://www.temo1.gr"]);
// Search broadly across DEI mail, then identify invoice-like messages in code.
 // in:anywhere also allows older messages still present in Spam/Trash to be considered.
const GMAIL_QUERY = 'in:anywhere {from:(dei.gr) subject:(Fwd) subject:(FW) subject:(Forward) subject:(Προώθηση) subject:(λογαριασμού) subject:(ΔΕΗ) subject:(Ηλεκτρικής)}';

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
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
    .replace(/<\/?[a-z][a-z0-9:-]*(?:\s[^>]*)?>/gi, " ")
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
  const value = String(text || "").toLocaleLowerCase("el").normalize("NFC").replace(/[\u00a0\s]+/g, " ");
  // An explicit unpaid statement wins; generic invoice labels like "amount due"
  // can coexist with a payment confirmation elsewhere in the same HTML email.
  const explicitlyUnpaid = /(δεν\s+(?:έχει\s+)?εξοφληθεί|δεν\s+εξοφλήθηκε|ανεξόφλητ|not\s+paid|unpaid|payment\s+pending)/i.test(value);
  if (explicitlyUnpaid) return "due";
  const paid = /(εξοφλ[ήη]θ|εξοφλ[ηή]μέν|έχει εξοφληθεί|έχει πληρωθεί|πληρώθηκε|πληρωμένο|καταβλήθηκε|paid in full|fully paid|payment received|settled)/i.test(value);
  if (paid) return "paid";
  const due = /(οφειλ|ανεξόφλητ|πληρωτέο|ποσό προς πληρωμή|ποσό πληρωμής|προς εξόφληση|χρεωστικό υπόλοιπο|υπόλοιπο οφειλής|τελικό ποσό πληρωμής|amount due|payable amount|amount payable|total due|payment due|outstanding|to pay)/i.test(value);
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

const T1_RETURN_PATHS = new Set([
  "https://temo75.github.io/t1/dei-bill.html",
  "https://temo75.github.io/t1/bills.html",
  "https://temo1.gr/dei-bill.html",
  "https://temo1.gr/bills.html",
  "https://temo1.gr/t1/dei-bill.html",
  "https://temo1.gr/t1/bills.html",
  "https://www.temo1.gr/dei-bill.html",
  "https://www.temo1.gr/bills.html",
  "https://www.temo1.gr/t1/dei-bill.html",
  "https://www.temo1.gr/t1/bills.html",
]);
function safeReturnTo(value) {
  try {
    const target = new URL(value || "https://temo75.github.io/t1/dei-bill.html");
    if (!ALLOWED_ORIGINS.has(target.origin)) return null;
    // temo1.gr is the new full T1 site: OAuth may be launched from the home
    // page or any nested page, not only the two standalone DEI pages.
    // Keep the old GitHub Pages domain restricted to the original T1 DEI pages.
    const isNewT1Domain = target.origin === "https://temo1.gr" || target.origin === "https://www.temo1.gr";
    if (!isNewT1Domain && !T1_RETURN_PATHS.has(target.origin + target.pathname)) return null;
    if (target.username || target.password) return null;
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
async function getT1SessionOwner(request, env) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || !env.DEI_KV) return null;
  return await env.DEI_KV.get("t1_session:" + await sha256Hex(token));
}
function assertConfig(env) {
  const missing = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!env.DEI_KV) missing.push("DEI_KV binding");
  return missing;
}

async function refreshAccessToken(env, ownerKey) {
  const refreshToken = await env.DEI_KV.get("gmail_refresh_token:" + ownerKey);
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

async function gmailFetch(env, ownerKey, path, accessToken = "") {
  const token = accessToken || await refreshAccessToken(env, ownerKey);
  const response = await fetch(`${GMAIL_API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GMAIL_API_FAILED_${response.status}`);
  return data;
}

function isDeiOrigin(from, subject, bodyText) {
  if (/@(?:[a-z0-9-]+\.)*dei\.gr\b/i.test(String(from || ""))) return true;
  const body = String(bodyText || "");
  const forwarded = /(?:^|\n)\s*(?:from|από|αποστολέας|αποστολεας)\s*:/im.test(body);
  const quotedDeiAddress = /<[^>\n]*@(?:[a-z0-9-]+\.)*dei\.gr\s*>|[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)*dei\.gr/i.test(body);
  const forwardSubject = /^\s*(?:fwd?|forwarded message|προώθηση|fw)\s*[:：]/i.test(String(subject || ""));
  const deiBillSubject = /(ειδοποίηση έκδοσης λογαριασμού|λογαριασμού ηλεκτρικής ενέργειας|\bδεη\b|\bdei\b)/i.test(String(subject || ""));
  // Accept a forwarded message when the quoted original DEI sender is present
  // and either forwarding metadata or the recognizable DEI bill subject survives.
  return quotedDeiAddress && (forwarded || forwardSubject || deiBillSubject);
}

function isLikelyInvoice(subject, bodyText) {
  const s = String(subject || "").toLocaleLowerCase("el");
  const t = String(bodyText || "").toLocaleLowerCase("el");
  const combined = s + "\n" + t;
  if (/(verification code|security code|one[- ]time password|login code|κωδικός επιβεβαίωσης|κωδικός ασφαλείας|κωδικός μιας χρήσης)/i.test(combined)) return false;
  const subjectLooksLikeBill = /(δεη|δ[εέ]η|λογαριασμ|bill|invoice|electricity|ρεύμα)/i.test(s);
  const bodyLooksLikeBill = /(πληρωτέο ποσό|συνολικό ποσό|προθεσμία πληρωμής|ημερομηνία λήξης|amount due|due date|electricity bill|λογαριασμός ηλεκτρικού)/i.test(t);
  return subjectLooksLikeBill || bodyLooksLikeBill;
}

function isPaymentConfirmation(subject, bodyText) {
  const combined = String(subject || "") + "\\n" + String(bodyText || "");
  return /(payment confirmation|payment received|receipt for payment|επιβεβαίωση πληρωμής|απόδειξη πληρωμής|εξόφληση λογαριασμού|η πληρωμή σας καταχωρήθηκε|πληρωμή ολοκληρώθηκε|ο λογαριασμός εξοφλήθηκε)/i.test(combined);
}

async function applyPaymentConfirmation(env, ownerKey, existingBills, existingById, amount, dueDate, fetchedAt) {
  if (amount == null) return false;
  const cents = Math.round(Number(amount) * 100);
  let candidates = existingBills.filter(bill =>
    Math.round(Number(bill.totalEUR) * 100) === cents &&
    bill.paymentStatus !== "paid"
  );
  if (dueDate) {
    const exact = candidates.filter(bill => String(bill.dueDate || "") === dueDate);
    if (exact.length === 1) candidates = exact;
  }
  // Never guess when multiple different invoices have the same amount.
  if (candidates.length !== 1) return false;
  const matched = candidates[0];
  const updated = { ...matched, paymentStatus: "paid", paymentConfirmedAt: fetchedAt };
  const key = BILL_PREFIX + ownerKey + ":" + encodeURIComponent(String(matched.gmailMessageId));
  await env.DEI_KV.put(key, JSON.stringify(updated));
  existingById.set(String(matched.gmailMessageId), updated);
  const index = existingBills.findIndex(bill => String(bill.gmailMessageId) === String(matched.gmailMessageId));
  if (index >= 0) existingBills[index] = updated;
  const latestKey = "latest_bill:" + ownerKey;
  const latest = await env.DEI_KV.get(latestKey, "json");
  if (latest && String(latest.gmailMessageId) === String(matched.gmailMessageId)) {
    await env.DEI_KV.put(latestKey, JSON.stringify(updated));
  }
  return true;
}
function canonicalBillContent(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:[-_]{3,}\s*)?(?:forwarded message|original message)\s*[-_]*\s*$/i.test(line))
    .filter(line => !/^\s*(?:from|date|subject|to|cc|bcc|από|αποστολέας|αποστολεας)\s*:/i.test(line))
    .join(" ")
    .toLocaleLowerCase("el")
    .replace(/\s+/g, " ")
    .trim();
}

const BILL_PREFIX = "bill_history:";
const GMAIL_PAGE_SIZE = 20;

function isDuplicateBill(a, b) {
  if (!a || !b) return false;
  if (a.contentFingerprint && b.contentFingerprint && a.contentFingerprint === b.contentFingerprint) return true;
  const sameAmount = a.totalEUR != null && b.totalEUR != null &&
    Math.round(Number(a.totalEUR) * 100) === Math.round(Number(b.totalEUR) * 100);
  if (!sameAmount) return false;
  const sameDueDate = Boolean(a.dueDate && b.dueDate && String(a.dueDate) === String(b.dueDate));
  if (sameDueDate) return true;
  // Gmail sometimes delivers the same invoice twice with inconsistent/missing due dates.
  // Same amount received within 14 days is treated as a duplicate only when one due date is absent.
  const ta = Number(a.internalDate || 0), tb = Number(b.internalDate || 0);
  const closeInTime = ta > 0 && tb > 0 && Math.abs(ta - tb) <= 14 * 24 * 60 * 60 * 1000;
  return closeInTime && (!a.dueDate || !b.dueDate);
}

function deduplicateBills(bills) {
  const byMessageId = [...new Map(bills.map(b => [String(b.gmailMessageId), b])).values()]
    .sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));
  const unique = [];
  for (const bill of byMessageId) {
    const duplicateIndex = unique.findIndex(existing => isDuplicateBill(existing, bill));
    if (duplicateIndex < 0) {
      unique.push(bill);
      continue;
    }
    // Prefer a record whose payment status was successfully parsed over a stale unknown one.
    const existing = unique[duplicateIndex];
    const existingKnown = existing.paymentStatus === "paid" || existing.paymentStatus === "due";
    const billKnown = bill.paymentStatus === "paid" || bill.paymentStatus === "due";
    if (!existingKnown && billKnown) unique[duplicateIndex] = bill;
  }
  return unique;
}

async function listStoredBillsRaw(env, ownerKey) {
  const bills = [];
  let cursor;
  do {
    const page = await env.DEI_KV.list({ prefix: BILL_PREFIX + ownerKey + ":", limit: 1000, cursor });
    for (const key of page.keys || []) {
      const bill = await env.DEI_KV.get(key.name, "json");
      if (bill && bill.gmailMessageId) bills.push(bill);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return bills;
}

async function listStoredBills(env, ownerKey) {
  return deduplicateBills(await listStoredBillsRaw(env, ownerKey));
}

async function getLatestBill(env, ownerKey, pageToken = "") {
  const accessToken = await refreshAccessToken(env, ownerKey);
  const tokenParam = pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "";
  const list = await gmailFetch(env, ownerKey, "/messages?q=" + encodeURIComponent(GMAIL_QUERY) + "&maxResults=" + GMAIL_PAGE_SIZE + tokenParam, accessToken);
  const messages = Array.isArray(list.messages) ? list.messages : [];
  let newest = null;
  // Read existing history once per Gmail page. The previous per-message read
  // repeatedly listed every stored bill and made sync progressively slower.
  const existingBills = await listStoredBillsRaw(env, ownerKey);
  const existingById = new Map(existingBills.map(bill => [String(bill.gmailMessageId), bill]));
  for (const summary of messages) {
    if (!summary?.id) continue;
    const full = await gmailFetch(env, ownerKey, "/messages/" + encodeURIComponent(summary.id) + "?format=full", accessToken);
    const headers = full.payload?.headers || [];
    const subject = headerValue(headers, "subject");
    const from = headerValue(headers, "from");
    const htmlBody = findBody(full.payload, "text/html");
    const plainBody = findBody(full.payload, "text/plain");
    const bodyText = stripHtml([plainBody, htmlBody, full.snippet].filter(Boolean).join("\n"));
    if (!isDeiOrigin(from, subject, bodyText)) continue;
    const timestamp = Number(full.internalDate || summary.internalDate || 0);
    const fetchedAt = new Date().toISOString();
    const subjectLooksLikeBill = /(δεη|δ[εέ]η|λογαριασμ|bill|invoice|electricity|ρεύμα)/i.test(subject);
    if (isPaymentConfirmation(subject, bodyText) && !subjectLooksLikeBill) {
      await applyPaymentConfirmation(env, ownerKey, existingBills, existingById,
        extractAmount(bodyText), extractDueDate(bodyText), fetchedAt);
      // A receipt updates the matching invoice; it is never a separate bill-history row.
      continue;
    }
    if (!isLikelyInvoice(subject, bodyText)) continue;
    const headerDate = headerValue(headers, "date");
    const parsedHeaderDate = Date.parse(headerDate);
    const bill = {
      found: true,
      emailDate: timestamp ? new Date(timestamp).toISOString() : (Number.isFinite(parsedHeaderDate) ? new Date(parsedHeaderDate).toISOString() : ""),
      totalEUR: extractAmount(bodyText),
      dueDate: extractDueDate(bodyText),
      paymentStatus: extractPaymentStatus(bodyText),
      fetchedAt,
      gmailMessageId: String(summary.id),
      internalDate: timestamp,
    };
    if (bill.totalEUR === null && bill.dueDate === null) continue;
    bill.contentFingerprint = await sha256Hex([
      bill.totalEUR ?? "", bill.dueDate ?? "", bill.paymentStatus, canonicalBillContent(bodyText)
    ].join("|"));
    const sameMessage = existingById.get(bill.gmailMessageId);
    const duplicateOfOtherMessage = existingBills.some(existing =>
      String(existing.gmailMessageId) !== bill.gmailMessageId && isDuplicateBill(existing, bill)
    );
    const billKey = BILL_PREFIX + ownerKey + ":" + encodeURIComponent(bill.gmailMessageId);
    if (sameMessage) {
      // Re-parse already stored messages on each manual sync so stale "unknown"
      // payment statuses and old amounts/due dates can be repaired from Gmail.
      const repaired = {
        ...sameMessage,
        ...bill,
        paymentStatus: bill.paymentStatus === "unknown" &&
          (sameMessage.paymentStatus === "paid" || sameMessage.paymentStatus === "due")
          ? sameMessage.paymentStatus : bill.paymentStatus
      };
      await env.DEI_KV.put(billKey, JSON.stringify(repaired));
      existingById.set(bill.gmailMessageId, repaired);
      const index = existingBills.findIndex(existing => String(existing.gmailMessageId) === bill.gmailMessageId);
      if (index >= 0) existingBills[index] = repaired;
      if (!duplicateOfOtherMessage && (!newest || bill.internalDate > newest.internalDate)) newest = repaired;
    } else if (!duplicateOfOtherMessage) {
      await env.DEI_KV.put(billKey, JSON.stringify(bill));
      existingBills.push(bill);
      existingById.set(bill.gmailMessageId, bill);
      if (!newest || bill.internalDate > newest.internalDate) newest = bill;
    }
    // A forwarded duplicate must not replace the original bill as "latest".
  }
  const latestKey = "latest_bill:" + ownerKey;
  // A payment receipt may have updated the stored copy of the newest invoice
  // after the local `newest` object was created. Re-read it before writing the
  // latest pointer so a stale "due" status cannot overwrite the confirmed "paid".
  if (newest?.gmailMessageId) {
    const storedNewest = existingById.get(String(newest.gmailMessageId));
    if (storedNewest) newest = storedNewest;
  }
  const existingLatest = await env.DEI_KV.get(latestKey, "json");
  if (newest && (!existingLatest || newest.internalDate >= Number(existingLatest.internalDate || 0))) {
    await env.DEI_KV.put(latestKey, JSON.stringify(newest));
  }
  const allBills = await listStoredBills(env, ownerKey);
  const latest = await env.DEI_KV.get(latestKey, "json") || newest || {
    found: false, message: "No parseable DEI invoice found in scanned messages",
    emailDate: "", totalEUR: null, dueDate: null, paymentStatus: "unknown", fetchedAt: new Date().toISOString()
  };
  return { ...latest, historyCount: allBills.length, scannedInvoices: messages.length, nextPageToken: list.nextPageToken || null };
}

async function getBillHistory(env, ownerKey) {
  const bills = await listStoredBills(env, ownerKey);
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
        return json({ ok: true, service: "TEMO DEI bill sync", configurationComplete: missing.length === 0, missing, oauthConfigured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), kvConfigured: Boolean(env.DEI_KV), gmailConnected: null, gmailConnectionIsPerGoogleAccount: true });
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
          scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
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
        const identityResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: "Bearer " + data.access_token } });
        const identity = await identityResponse.json().catch(() => ({}));
        if (!identityResponse.ok || !identity.sub || !identity.email || identity.email_verified !== true) return html("<h2>Google account identity could not be verified.</h2><p>Reconnect using a verified Google account.</p>", 502);
        const ownerKey = await sha256Hex(String(identity.sub));
        if (data.refresh_token) {
          await env.DEI_KV.put("gmail_refresh_token:" + ownerKey, data.refresh_token);
        } else if (!(await env.DEI_KV.get("gmail_refresh_token:" + ownerKey))) {
          return html("<h2>Google did not return a refresh token.</h2><p>Revoke this app's access in Google Account security, then open /oauth/start again.</p>", 400);
        }
        await env.DEI_KV.put("gmail_connected_at:" + ownerKey, new Date().toISOString());
        const grant = randomHex(32);
        await env.DEI_KV.put("oauth_grant:" + await sha256Hex(grant), JSON.stringify({ returnTo: oauthState.returnTo, ownerKey, googleEmail: identity.email }), { expirationTtl: 180 });
        const destination = new URL(oauthState.returnTo);
        destination.hash = new URLSearchParams({ dei_code: grant }).toString();
        return Response.redirect(destination.toString(), 302);
      }

      if (url.pathname === "/api/session/exchange") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "POST, OPTIONS" });
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        if (!ALLOWED_ORIGINS.has(request.headers.get("origin"))) return json({ ok: false, error: "Forbidden" }, 403);
        const body = await request.json().catch(() => ({}));
        const grant = String(body.code || "");
        if (!/^[a-f0-9]{64}$/i.test(grant)) return json({ ok: false, error: "Invalid or expired authorization code" }, 401);
        const grantKey = "oauth_grant:" + await sha256Hex(grant);
        const grantValue = await env.DEI_KV.get(grantKey);
        if (!grantValue) return json({ ok: false, error: "Invalid or expired authorization code" }, 401);
        await env.DEI_KV.delete(grantKey);
        const grantData = JSON.parse(grantValue);
        if (!grantData.ownerKey) return json({ ok: false, error: "Google account identity missing from authorization grant" }, 401);
        const sessionToken = randomHex(32);
        const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
        await env.DEI_KV.put("t1_session:" + await sha256Hex(sessionToken), grantData.ownerKey, { expirationTtl: 8 * 60 * 60 });
        return json({ ok: true, sessionToken, expiresAt });
      }

      if (url.pathname === "/api/status") {
        const ownerKey = await getT1SessionOwner(request, env);
        if (!ownerKey) return json({ ok: true, gmailConnected: false, lastFetchedAt: null });
        const connected = Boolean(await env.DEI_KV.get("gmail_refresh_token:" + ownerKey));
        const latest = await env.DEI_KV.get("latest_bill:" + ownerKey, "json");
        const lastSyncAt = await env.DEI_KV.get("last_sync_at:" + ownerKey);
        return json({ ok: true, gmailConnected: connected, lastFetchedAt: lastSyncAt || latest?.fetchedAt || null, lastSyncAt: lastSyncAt || null });
      }

      if (url.pathname === "/api/sync") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "POST, OPTIONS" });
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        const sessionToken = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        const ownerKey = await getT1SessionOwner(request, env);
        if (!sessionToken || !ownerKey) return json({ ok: false, error: "Unauthorized" }, 401);
        let body = {};
        try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
        const cursorKey = "sync_cursor:" + ownerKey + ":" + await sha256Hex(sessionToken);
        if (!body.continue) await env.DEI_KV.delete(cursorKey);
        const pageToken = body.continue ? await env.DEI_KV.get(cursorKey) : null;
        const result = await getLatestBill(env, ownerKey, pageToken || "");
        if (result.nextPageToken) await env.DEI_KV.put(cursorKey, result.nextPageToken, { expirationTtl: 3600 });
        else {
          await env.DEI_KV.delete(cursorKey);
          // This is the actual completion time of the full manual sync, not the invoice date.
          await env.DEI_KV.put("last_sync_at:" + ownerKey, new Date().toISOString());
        }
        const lastSyncAt = result.nextPageToken ? await env.DEI_KV.get("last_sync_at:" + ownerKey) : new Date().toISOString();
        return json({
          ok: true, bill: { ...publicBill(result), lastSyncAt }, cached: false, scannedCount: result.scannedInvoices,
          historyCount: result.historyCount, complete: !result.nextPageToken, lastSyncAt
        });
      }
      if (url.pathname === "/api/history") {
        if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405, { allow: "GET, OPTIONS" });
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        const ownerKey = await getT1SessionOwner(request, env);
        if (!ownerKey) return json({ ok: false, error: "Unauthorized" }, 401);
        return json({ ok: true, ...(await getBillHistory(env, ownerKey)) });
      }

      if (url.pathname === "/api/latest") {
        if (!env.DEI_KV) return json({ ok: false, error: "DEI_KV binding is not configured" }, 503);
        const ownerKey = await getT1SessionOwner(request, env);
        if (!ownerKey) return json({ ok: false, error: "Unauthorized" }, 401);
        const cached = await env.DEI_KV.get("latest_bill:" + ownerKey, "json");
        const lastSyncAt = await env.DEI_KV.get("last_sync_at:" + ownerKey);
        return json({ ok: true, bill: { ...publicBill(cached || { found: false, paymentStatus: "unknown" }), lastSyncAt: lastSyncAt || null }, cached: true, lastSyncAt: lastSyncAt || null });
      }
      return json({ service: "TEMO DEI bill sync", routes: ["/health", "/oauth/start", "/oauth/callback", "/api/status", "/api/session/exchange", "/api/sync", "/api/latest"], t1Page: "https://temo75.github.io/t1/dei-bill.html" });
    } catch (error) {
      const safe = safeError(error);
      return json({ ok: false, error: safe.message, ...(env.TEST_MODE ? { debug: String(error?.message || error) } : {}) }, safe.status);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      let cursor;
      do {
        const page = await env.DEI_KV.list({ prefix: "gmail_refresh_token:", limit: 1000, cursor });
        for (const item of page.keys || []) {
          const ownerKey = item.name.slice("gmail_refresh_token:".length);
          if (!ownerKey) continue;
          try {
            await getLatestBill(env, ownerKey, "");
            await env.DEI_KV.put("last_sync_at:" + ownerKey, new Date().toISOString());
          } catch { /* one failed account must not stop others */ }
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    })());
  },
};

