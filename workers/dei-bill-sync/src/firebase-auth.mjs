const FIREBASE_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let jwksCache = null;
let jwksExpiresAt = 0;

function decodeBase64UrlBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64UrlBytes(value)));
}

async function firebaseKeys(fetchImpl, forceRefresh = false) {
  if (!forceRefresh && jwksCache && jwksExpiresAt > Date.now()) return jwksCache;
  const response = await fetchImpl(FIREBASE_JWKS_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("FIREBASE_KEYS_UNAVAILABLE");
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error("FIREBASE_KEYS_INVALID");
  const cacheControl = response.headers.get("cache-control") || "";
  const maxAge = Number(cacheControl.match(/max-age=(\d+)/i)?.[1] || 3600);
  jwksCache = body.keys;
  jwksExpiresAt = Date.now() + Math.max(60, Math.min(maxAge, 86400)) * 1000;
  return jwksCache;
}

export async function verifyFirebaseIdToken(token, projectId, options = {}) {
  if (typeof token !== "string" || token.length > 16384 || !projectId) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header;
  let claims;
  try {
    header = decodeJsonPart(parts[0]);
    claims = decodeJsonPart(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (claims.aud !== projectId ||
      claims.iss !== `https://securetoken.google.com/${projectId}` ||
      typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128 ||
      !Number.isFinite(claims.exp) || claims.exp <= now ||
      !Number.isFinite(claims.iat) || claims.iat > now + 60 ||
      !Number.isFinite(claims.auth_time) || claims.auth_time > now + 60) return null;
  const fetchImpl = options.fetchImpl || fetch;
  try {
    let keys = await firebaseKeys(fetchImpl);
    let jwk = keys.find(key => key.kid === header.kid);
    if (!jwk) {
      keys = await firebaseKeys(fetchImpl, true);
      jwk = keys.find(key => key.kid === header.kid);
    }
    if (!jwk || jwk.kty !== "RSA" || jwk.alg && jwk.alg !== "RS256") return null;
    const key = await crypto.subtle.importKey("jwk", jwk, {
      name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"
    }, false, ["verify"]);
    const signature = decodeBase64UrlBytes(parts[2]);
    const signed = new TextEncoder().encode(parts[0] + "." + parts[1]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed)) return null;
    return claims;
  } catch {
    return null;
  }
}
