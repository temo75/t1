import assert from "node:assert/strict";
import worker from "../src/index.mjs";

class MemoryKV {
  data = new Map();
  async get(key, type) {
    const value = this.data.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) { this.data.set(key, String(value)); }
  async delete(key) { this.data.delete(key); }
  async list({ prefix = "", limit = 1000, cursor } = {}) {
    const keys = [...this.data.keys()].filter(key => key.startsWith(prefix)).sort();
    const offset = cursor ? Number(cursor) : 0;
    const page = keys.slice(offset, offset + limit).map(name => ({ name }));
    const next = offset + page.length;
    return { keys: page, list_complete: next >= keys.length, cursor: next >= keys.length ? undefined : String(next) };
  }
}

const projectId = "temo-75";
const keyPair = await crypto.subtle.generateKey({
  name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"
}, true, ["sign", "verify"]);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
Object.assign(publicJwk, { kid: "worker-test-key", alg: "RS256", use: "sig" });
const base64url = value => Buffer.from(JSON.stringify(value)).toString("base64url");
async function makeIdToken(uid, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "RS256", typ: "JWT", kid: publicJwk.kid });
  const payload = base64url({
    aud: projectId, iss: "https://securetoken.google.com/" + projectId,
    sub: uid, iat: now, exp: now + 3600, auth_time: now - 20, email_verified: true, ...overrides
  });
  const signingInput = header + "." + payload;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(signingInput));
  return signingInput + "." + Buffer.from(signature).toString("base64url");
}
const kv = new MemoryKV();
const env = {
  GOOGLE_CLIENT_ID: "fixture-client",
  GOOGLE_CLIENT_SECRET: "fixture-secret",
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_API_KEY: "public-fixture-api-key",
  FIREBASE_AUTH_DOMAIN: "temo-75.firebaseapp.com",
  FIREBASE_APP_ID: "1:fixture:web:fixture",
  DEI_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
  LEGACY_LINK_ADMIN_KEY: "admin-fixture-key",
  DEI_KV: kv
};
const requestedPages = [];
let failOAuthExchange = false;
await kv.put("gmail_refresh_token", "legacy-global-token-fixture");
await kv.put("latest_bill", JSON.stringify({ totalEUR: "999.00", paymentStatus: "due" }));
await kv.put("bill_history", JSON.stringify([{ gmailMessageId: "legacy-shared", totalEUR: "999.00", paymentStatus: "due" }]));
const gmailBodies = {
  "a-current": "Πληρωτέο ποσό: 77,00 € Προθεσμία πληρωμής έως 26/10/2026 Οφειλή",
  "a-paid": "Ο λογαριασμός εξοφλήθηκε. Total amount: 20,00 €",
  "b-current": "Payable Amount: 10,00 € Expiration Date: 30/11/2026 due"
};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.href.startsWith("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")) {
    return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "cache-control": "public, max-age=3600" } });
  }
  if (url.href === "https://oauth2.googleapis.com/token") {
    const form = new URLSearchParams(init.body);
    if (form.get("grant_type") === "authorization_code") {
      if (failOAuthExchange) return new Response(JSON.stringify({ error: "fixture denial" }), { status: 400 });
      const identity = form.get("code").replace("code-", "");
      return new Response(JSON.stringify({ access_token: "access-" + identity, refresh_token: "refresh-" + identity }), { status: 200 });
    }
    if (form.get("grant_type") === "refresh_token") {
      const identity = form.get("refresh_token").replace("refresh-", "");
      return new Response(JSON.stringify({ access_token: "access-" + identity }), { status: 200 });
    }
  }
  if (url.hostname === "gmail.googleapis.com" && url.pathname.endsWith("/messages")) {
    const identity = (init.headers?.authorization || "").replace("Bearer access-", "");
    requestedPages.push({ identity, page: url.searchParams.get("pageToken") || "" });
    assert.equal(url.searchParams.get("q"), "in:anywhere from:(dei.gr)");
    if (identity === "A" && !url.searchParams.has("pageToken")) {
      return new Response(JSON.stringify({ messages: [{ id: "a-current" }, { id: "a-current" }], nextPageToken: "A-page-2" }));
    }
    if (identity === "A" && url.searchParams.get("pageToken") === "A-page-2") {
      return new Response(JSON.stringify({ messages: [{ id: "a-paid" }] }));
    }
    if (identity === "B" && !url.searchParams.has("pageToken")) {
      return new Response(JSON.stringify({ messages: [{ id: "b-current" }] }));
    }
    return new Response(JSON.stringify({ messages: [] }));
  }
  const match = url.pathname.match(/\/messages\/([^/]+)$/);
  if (url.hostname === "gmail.googleapis.com" && match) {
    const identity = (init.headers?.authorization || "").replace("Bearer access-", "");
    const id = decodeURIComponent(match[1]);
    const amounts = { "a-current": "77", "a-paid": "20", "b-current": "10" };
    const dates = { "a-current": "26/10/2026", "a-paid": "31/12/2025", "b-current": "30/11/2026" };
    const owner = id.startsWith("a-") ? "A" : "B";
    assert.equal(identity, owner, "a Gmail token can only fetch that user's fixture");
    const body = gmailBodies[id];
    const full = {
      id, internalDate: String(Date.parse(id === "a-paid" ? "2025-12-31T12:00:00Z" : "2026-10-01T12:00:00Z")),
      snippet: body,
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "Subject", value: "DEI electricity bill" }, { name: "From", value: "billing@dei.gr" }],
        body: { data: Buffer.from(body).toString("base64url") }
      }
    };
    assert.ok(amounts[id] && dates[id]);
    return new Response(JSON.stringify(full));
  }
  throw new Error("Unexpected fixture request: " + url.origin + url.pathname);
};

const request = (path, options = {}) => new Request("https://dei-bill-sync.temo75elia.workers.dev" + path, options);
const auth = async uid => ({ authorization: "Bearer " + await makeIdToken(uid) });
async function json(response) { return response.json(); }
async function issueLinkClaim(legacyAccountId, firebaseUid) {
  const response = await worker.fetch(request("/api/admin/link-claim", {
    method: "POST",
    headers: { authorization: "Bearer " + env.LEGACY_LINK_ADMIN_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      legacyAccountId, firebaseUid, ownershipVerified: true,
      verificationMethod: "owner_review", verificationReference: "test-case-" + legacyAccountId
    })
  }), env);
  assert.equal(response.status, 200);
  return (await json(response)).claimCode;
}

assert.equal((await worker.fetch(request("/api/status"), env)).status, 401, "status is not public");
for (const path of ["/api/history", "/api/latest"]) {
  assert.equal((await worker.fetch(request(path), env)).status, 401, path + " rejects missing identity");
}
assert.equal((await worker.fetch(request("/api/sync", { method: "POST", body: "{}" }), env)).status, 401, "sync rejects missing identity");
assert.equal((await worker.fetch(request("/oauth/start", { method: "POST", body: "{}" }), env)).status, 401, "OAuth start rejects missing identity");

const tokenA = await makeIdToken("firebase-A");
const tokenB = await makeIdToken("firebase-B");
const headersA = { authorization: "Bearer " + tokenA, "content-type": "application/json" };
const headersB = { authorization: "Bearer " + tokenB, "content-type": "application/json" };
assert.equal((await worker.fetch(request("/api/status", { headers: headersA }), env)).status, 200);
assert.equal((await json(await worker.fetch(request("/api/status", { headers: headersB }), env))).linked, false);

const claimA = await issueLinkClaim("legacy-account-A", "firebase-A");
const claimB = await issueLinkClaim("legacy-account-B", "firebase-B");
assert.equal((await worker.fetch(request("/api/account/link", { method: "POST", headers: headersB, body: JSON.stringify({ claimCode: claimA }) }), env)).status, 401, "a different UID cannot redeem a claim");
assert.equal((await worker.fetch(request("/api/account/link", { method: "POST", headers: headersA, body: JSON.stringify({ claimCode: claimA }) }), env)).status, 200);
assert.equal((await worker.fetch(request("/api/account/link", { method: "POST", headers: headersB, body: JSON.stringify({ claimCode: claimB }) }), env)).status, 200);
const unverified = await makeIdToken("firebase-unverified", { email_verified: false });
assert.equal((await worker.fetch(request("/api/account/link", {
  method: "POST", headers: { authorization: "Bearer " + unverified, "content-type": "application/json" },
  body: JSON.stringify({ claimCode: claimA })
}), env)).status, 403, "unverified Firebase email cannot be linked");

async function connectGmail(uid, headers, identity) {
  const start = await worker.fetch(request("/oauth/start", {
    method: "POST", headers, body: JSON.stringify({ returnTo: "https://temo75.github.io/t1/dei-bill.html" })
  }), env);
  assert.equal(start.status, 200);
  const startData = await json(start);
  const authorizationUrl = new URL(startData.authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://dei-bill-sync.temo75elia.workers.dev/oauth/callback");
  const state = authorizationUrl.searchParams.get("state");
  const callback = await worker.fetch(request("/oauth/callback?code=code-" + identity + "&state=" + state), env);
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get("location"), /dei_gmail=connected/);
  const before = requestedPages.length;
  const replay = await worker.fetch(request("/oauth/callback?code=code-" + identity + "&state=" + state), env);
  assert.equal(replay.status, 400, "consumed OAuth state cannot be replayed");
  assert.equal(requestedPages.length, before);
}
await connectGmail("firebase-A", headersA, "A");
await connectGmail("firebase-B", headersB, "B");

const deniedStart = await worker.fetch(request("/oauth/start", {
  method: "POST", headers: headersA, body: JSON.stringify({ returnTo: "https://temo75.github.io/t1/dei-bill.html" })
}), env);
const deniedState = new URL((await json(deniedStart)).authorizationUrl).searchParams.get("state");
const deniedCallback = await worker.fetch(request("/oauth/callback?error=access_denied&state=" + deniedState), env);
assert.equal(deniedCallback.status, 302, "Google OAuth denial returns to T1");
assert.match(deniedCallback.headers.get("location"), /dei_gmail=denied/);

const failedStart = await worker.fetch(request("/oauth/start", {
  method: "POST", headers: headersA, body: JSON.stringify({ returnTo: "https://temo75.github.io/t1/dei-bill.html" })
}), env);
const failedState = new URL((await json(failedStart)).authorizationUrl).searchParams.get("state");
failOAuthExchange = true;
const failedCallback = await worker.fetch(request("/oauth/callback?code=code-A-failure&state=" + failedState), env);
failOAuthExchange = false;
assert.equal(failedCallback.status, 302, "Google token exchange errors do not expose provider data");
assert.match(failedCallback.headers.get("location"), /dei_gmail=error/);

const userHash = async uid => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uid))).toString("hex");
const userKey = async (uid, suffix) => "dei:user:" + await userHash(uid) + ":" + suffix;
const encryptedA = await kv.get(await userKey("firebase-A", "gmail_refresh_token"));
const encryptedB = await kv.get(await userKey("firebase-B", "gmail_refresh_token"));
assert.ok(encryptedA.startsWith("v1.") && !encryptedA.includes("refresh-A"), "refresh token is encrypted at rest");
assert.ok(encryptedB.startsWith("v1.") && !encryptedB.includes("refresh-B"), "each user's refresh token is separately encrypted");
assert.notEqual(encryptedA, encryptedB);

const syncA1 = await worker.fetch(request("/api/sync", { method: "POST", headers: headersA, body: JSON.stringify({ continue: false }) }), env);
assert.equal(syncA1.status, 200);
const pageA1 = await json(syncA1);
assert.equal(pageA1.complete, false);
assert.equal(pageA1.bill.totalEUR, "77.00");
const syncA2 = await worker.fetch(request("/api/sync", { method: "POST", headers: headersA, body: JSON.stringify({ continue: true }) }), env);
assert.equal(syncA2.status, 200);
assert.equal((await json(syncA2)).complete, true);
const syncB = await worker.fetch(request("/api/sync?uid=firebase-A", { method: "POST", headers: headersB, body: JSON.stringify({ uid: "firebase-A" }) }), env);
assert.equal(syncB.status, 200, "browser-supplied UID is ignored in favor of signed UID");
assert.equal((await json(syncB)).bill.totalEUR, "10.00");

const latestA = await json(await worker.fetch(request("/api/latest?uid=firebase-B", { headers: headersA }), env);
assert.equal(latestA.bill.totalEUR, "77.00", "latest endpoint derives user A from the signed token");
const latestB = await json(await worker.fetch(request("/api/latest?uid=firebase-A", { headers: headersB }), env);
assert.equal(latestB.bill.totalEUR, "10.00", "latest endpoint ignores a browser-supplied UID");

const historyA = await json(await worker.fetch(request("/api/history?uid=firebase-B", { headers: headersA }), env));
const historyB = await json(await worker.fetch(request("/api/history?uid=firebase-A", { headers: headersB }), env));
assert.equal(historyA.count, 2, "duplicate Gmail message IDs collapse within the user's history");
assert.deepEqual(new Set(historyA.bills.map(bill => bill.totalEUR)), new Set(["77.00", "20.00"]));
assert.equal(historyA.totalPaidEUR, "20.00");
assert.equal(historyA.totalDueEUR, "77.00");
assert.deepEqual(historyA.annualTotals, [
  { year: "2026", count: 1, paidEUR: "0.00", dueEUR: "77.00" },
  { year: "2025", count: 1, paidEUR: "20.00", dueEUR: "0.00" }
]);
assert.equal(historyB.count, 1);
assert.equal(historyB.totalDueEUR, "10.00");
assert.equal(historyB.bills[0].totalEUR, "10.00");
assert.equal(JSON.stringify(historyA).includes("10.00"), false, "user A response contains no user B bill");
assert.equal(JSON.stringify(historyB).includes("77.00"), false, "user B response contains no user A bill");

const statusA = await json(await worker.fetch(request("/api/status", { headers: headersA }), env));
assert.equal(statusA.gmailConnected, true);
assert.equal(statusA.linked, true);
const statusB = await json(await worker.fetch(request("/api/status", { headers: headersB }), env));
assert.equal(statusB.gmailConnected, true);
assert.equal(await kv.get("gmail_refresh_token"), "legacy-global-token-fixture", "legacy global Gmail token is neither overwritten nor used");
await kv.put("latest_bill", JSON.stringify({ totalEUR: "999.00", paymentStatus: "due" }));
await kv.put("bill_history:old-admin-record", JSON.stringify({ gmailMessageId: "old-admin-record", totalEUR: "999.00", paymentStatus: "due" }));
const isolatedA = await json(await worker.fetch(request("/api/history", { headers: headersA }), env));
assert.equal(isolatedA.count, 2, "legacy shared KV history is never assigned to a regular UID");
assert.equal(isolatedA.totalDueEUR, "77.00");

const badAudience = await makeIdToken("firebase-A", { aud: "wrong-project" });
assert.equal((await worker.fetch(request("/api/history", { headers: { authorization: "Bearer " + badAudience } }), env)).status, 401);
const deniedAdmin = await worker.fetch(request("/api/admin/link-claim", {
  method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" },
  body: JSON.stringify({ legacyAccountId: "legacy-X", firebaseUid: "firebase-X", ownershipVerified: true, verificationMethod: "owner_review", verificationReference: "x" })
}), env);
assert.equal(deniedAdmin.status, 401);

console.log("PASS: signed Firebase UID authorization; unauthorized requests; admin-controlled account claims; UID-bound OAuth; OAuth state replay rejection; encrypted per-user Gmail tokens; paginated Gmail sync; duplicate message IDs; history and annual totals isolation; ignored browser UID; legacy shared KV remains unassigned.");
