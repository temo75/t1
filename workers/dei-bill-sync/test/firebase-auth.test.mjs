import assert from "node:assert/strict";
import test from "node:test";
import { verifyFirebaseIdToken } from "../src/firebase-auth.mjs";

const projectId = "temo-75";
const pair = await crypto.subtle.generateKey({
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
}, true, ["sign", "verify"]);
const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
publicJwk.kid = "test-key";
publicJwk.alg = "RS256";
publicJwk.use = "sig";
const fetchImpl = async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
  status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" }
});
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
async function makeToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", typ: "JWT", kid: "test-key" });
  const payload = encode({
    aud: projectId,
    iss: "https://securetoken.google.com/" + projectId,
    sub: "firebase-user-A",
    iat: now,
    exp: now + 3600,
    auth_time: now - 10,
    email_verified: true,
    ...overrides,
  });
  const unsigned = header + "." + payload;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(unsigned));
  return unsigned + "." + Buffer.from(signature).toString("base64url");
}

test("accepts a correctly signed Firebase ID token and returns its UID", async () => {
  const claims = await verifyFirebaseIdToken(await makeToken(), projectId, { fetchImpl });
  assert.equal(claims?.sub, "firebase-user-A");
  assert.equal(claims?.email_verified, true);
});

test("rejects tokens with an invalid signature", async () => {
  const token = await makeToken();
  const parts = token.split(".");
  parts[2] = Buffer.alloc(256, 0).toString("base64url");
  assert.equal(await verifyFirebaseIdToken(parts.join("."), projectId, { fetchImpl }), null);
});

test("rejects wrong audience, issuer, expired, future-issued, and empty-subject tokens", async () => {
  for (const claims of [
    { aud: "other-project" },
    { iss: "https://securetoken.google.com/other-project" },
    { exp: Math.floor(Date.now() / 1000) - 1 },
    { iat: Math.floor(Date.now() / 1000) + 120 },
    { sub: "" },
  ]) {
    assert.equal(await verifyFirebaseIdToken(await makeToken(claims), projectId, { fetchImpl }), null);
  }
});

test("rejects malformed bearer values without fetching keys", async () => {
  assert.equal(await verifyFirebaseIdToken("not-a-jwt", projectId, { fetchImpl }), null);
  assert.equal(await verifyFirebaseIdToken("", projectId, { fetchImpl }), null);
});
