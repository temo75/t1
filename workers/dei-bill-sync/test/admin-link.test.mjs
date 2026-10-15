import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

class FakeElement {
  children = [];
  listeners = new Map();
  hidden = false;
  disabled = false;
  value = "";
  textContent = "";
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  add(option) { this.children.push(option); }
}
class FakeOption {
  constructor(text, value) { this.text = text; this.value = value; }
}
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");
const source = await readFile(path.join(rootDir, "dei-admin-link.js"), "utf8");
const page = await readFile(path.join(rootDir, "bills.html"), "utf8");
assert.match(page, /DEI მომხმარებლის დაკავშირება/);
assert.match(page, /dei-admin-link\.js/);
assert.doesNotMatch(source, /LEGACY_LINK_ADMIN_KEY|SYNC_API_KEY/);

const ids = ["deiAdminLink", "deiAdminSignIn", "deiAdminSignOut", "deiAdminControls", "deiPendingRequest",
  "deiLegacyUser", "deiOwnershipVerified", "deiVerificationReference", "deiAdminMessage", "deiClaimCode",
  "deiRefreshRequests", "deiIssueClaim"];
const elements = Object.fromEntries(ids.map(id => [id, new FakeElement()]));
let authStateCallback;
let prompt;
const calls = [];
const user = { uid: "allowed-admin-uid", async getIdToken() { return "signed-admin-token"; } };
const auth = {
  currentUser: null,
  async setPersistence(value) { assert.equal(value, "session"); },
  onAuthStateChanged(callback) { authStateCallback = callback; callback(this.currentUser); return () => {}; },
  async signInWithPopup(provider) { prompt = provider.parameters.prompt; this.currentUser = user; authStateCallback(user); return { user }; },
  async signOut() { this.currentUser = null; authStateCallback(null); }
};
const firebase = {
  apps: [],
  auth: { Auth: { Persistence: { SESSION: "session" } }, GoogleAuthProvider: class { setCustomParameters(value) { this.parameters = value; } } },
  initializeApp(config, name) { assert.equal(config.projectId, "temo-75"); const app = { name, auth: () => auth }; this.apps.push(app); return app; }
};
const localStorage = {
  getItem(key) {
    if (key !== "temoWorkTrackerUsers") return null;
    return JSON.stringify([
      { id: "legacy-user-7", name: "Existing user", email: "same@example.test", password: "must-not-leave-browser" },
      { id: "legacy-admin", name: "TEMO", admin: true, password: "admin-fixture" }
    ]);
  }
};
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, async json() { return data; } });
const fetchMock = async (url, options = {}) => {
  const parsed = new URL(url);
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ path: parsed.pathname, method: options.method || "GET", headers: options.headers, body });
  if (parsed.pathname === "/api/config") return response(200, { firebaseConfig: { apiKey: "public", authDomain: "temo-75.firebaseapp.com", projectId: "temo-75", appId: "web" } });
  if (parsed.pathname === "/api/admin/link-requests") return response(200, { ok: true, requests: [
    { firebaseUid: "requesting-uid", email: "verified-user@example.test", requestedAt: "2026-10-15T10:00:00.000Z" }
  ] });
  if (parsed.pathname === "/api/admin/link-claim" && options.method === "POST") return response(200, { ok: true, claimCode: "one-time-claim-fixture" });
  throw new Error("Unexpected request " + parsed.pathname);
};
const sandbox = {
  window: { firebase, localStorage },
  document: { getElementById(id) { return elements[id] || null; } },
  localStorage, Option: FakeOption, fetch: fetchMock, URL, Date, console, Promise
};
new vm.Script(source, { filename: "dei-admin-link.js" }).runInNewContext(sandbox);
await new Promise(resolve => setTimeout(resolve, 0));
await elements.deiAdminSignIn.listeners.get("click")();
assert.equal(prompt, "select_account");
assert.equal(elements.deiAdminControls.hidden, false);
assert.deepEqual(elements.deiLegacyUser.children.map(option => option.value), ["", "legacy-user-7"], "only an existing regular T1 account is selectable");
elements.deiPendingRequest.value = "requesting-uid";
elements.deiLegacyUser.value = "legacy-user-7";
elements.deiOwnershipVerified.checked = true;
elements.deiVerificationReference.value = "confirmed through existing trusted channel";
await elements.deiIssueClaim.listeners.get("click")({ currentTarget: elements.deiIssueClaim });
const issue = calls.find(call => call.path === "/api/admin/link-claim");
assert.equal(issue.headers.Authorization, "Bearer signed-admin-token");
assert.deepEqual(issue.body, {
  firebaseUid: "requesting-uid", legacyAccountId: "legacy-user-7", ownershipVerified: true,
  verificationMethod: "owner_review", verificationReference: "confirmed through existing trusted channel"
});
assert.match(elements.deiClaimCode.textContent, /one-time-claim-fixture/);
assert.ok(!JSON.stringify(issue).includes("must-not-leave-browser"), "passwords are not sent to the Worker");
assert.ok(!JSON.stringify(calls).includes("admin-fixture"), "legacy credentials are not sent to the Worker");
console.log("PASS: Firebase-admin-only claim issuance UI; T1 user selection; no email-based auto-link; no secrets/passwords sent; one-time code shown.");
