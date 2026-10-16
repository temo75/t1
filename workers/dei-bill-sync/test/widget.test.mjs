import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

class FakeElement {
  children = [];
  listeners = new Map();
  classes = new Set();
  textHistory = [];
  hidden = false;
  disabled = false;
  className = "";
  value = "";
  type = "";
  href = "";
  autocomplete = "";
  maxLength = 0;
  style = {};
  classList = {
    add: (...names) => names.forEach(name => this.classes.add(name)),
    toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name)
  };
  set textContent(value) { this._text = String(value); this.textHistory.push(this._text); }
  get textContent() { return this._text || ""; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute() {}
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");
const source = await readFile(path.join(rootDir, "dei-bill-sync.js"), "utf8");
const pageHtml = await readFile(path.join(rootDir, "dei-bill.html"), "utf8");
const billPageHtml = await readFile(path.join(rootDir, "dei-bill.html"), "utf8");
assert.match(billPageHtml, /<script src="\.\/dei-bill-sync\.js"><\/script>/, "the dedicated DEI customer page loads its sync client");
assert.match(billPageHtml, /id="deiCloudBill"/, "the dedicated DEI customer page contains the bill widget mount point");
assert.match(pageHtml, /\.dei-sync-primary\{[^}]*min-height:58px;width:100%/);

const idToken = "firebase-id-token-fixture";
const firebaseUser = {
  uid: "firebase-user-fixture",
  async getIdToken() { return idToken; }
};
let linked = false;
let gmailConnected = false;
let t1AccountId = "legacy-account-A";
let t1SessionId = "legacy-account-A";
let t1Authorized = true;
let popupSignIns = 0;
let selectedGooglePrompt = null;
let syncMode = "success";
let syncRequests = 0;
let claimSubmitted = "";
const calls = [];
const events = [];
const localStorage = {
  getItem(key) {
    if (key === "temoWorkTrackerAuthorized") return t1Authorized ? "yes" : null;
    if (key === "temoWorkTrackerUser") return t1Authorized ? "Existing T1 user" : null;
    if (key === "temoWorkTrackerUserId") return t1Authorized ? t1SessionId : null;
    return null;
  }
};
const fakeAuth = {
  currentUser: null,
  async setPersistence(value) { assert.equal(value, "session"); },
  onAuthStateChanged(callback) { callback(this.currentUser); return () => {}; },
  async signInWithPopup(provider) {
    selectedGooglePrompt = provider.parameters?.prompt;
    popupSignIns++;
    this.currentUser = firebaseUser;
    return { user: firebaseUser };
  },
  async signOut() { this.currentUser = null; }
};
const fakeFirebase = {
  apps: [],
  auth: {
    Auth: { Persistence: { SESSION: "session" } },
    GoogleAuthProvider: class { setCustomParameters(parameters) { this.parameters = parameters; } }
  },
  initializeApp(config, name) {
    assert.equal(config.projectId, "temo-75");
    const app = { name, auth: () => fakeAuth };
    this.apps.push(app);
    return app;
  }
};
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, async json() { return body; } });
const fetchMock = async (url, options = {}) => {
  const parsed = new URL(url);
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ path: parsed.pathname, method: options.method || "GET", authorization: options.headers?.Authorization || "", body });
  if (parsed.pathname === "/api/config") return response(200, {
    ok: true, firebaseConfig: { apiKey: "public-key", authDomain: "temo-75.firebaseapp.com", projectId: "temo-75", appId: "web-app-id" }
  });
  if (parsed.pathname === "/api/status") return response(200, {
    ok: true, linked, t1AccountId: linked ? t1AccountId : null, gmailConnected,
    lastSyncAt: "2026-10-15T09:00:00Z"
  });
  if (parsed.pathname === "/api/account/link-request") return response(200, { ok: true, requested: true });
  if (parsed.pathname === "/api/account/link") {
    claimSubmitted = body?.claimCode || "";
    if (claimSubmitted !== "admin-claim-fixture") return response(401, { ok: false, error: "Invalid or expired link code" });
    linked = true;
    return response(200, { ok: true, linked: true });
  }
  if (parsed.pathname === "/api/latest") return response(200, {
    ok: true, cached: true, bill: { found: true, totalEUR: "77.00", dueDate: "2026-10-26", paymentStatus: "due", emailDate: "2026-10-06T05:02:02Z" }
  });
  if (parsed.pathname === "/api/sync") {
    if (syncMode === "fail") return response(502, { ok: false, error: "Gmail API request failed" });
    syncRequests++;
    return response(200, {
      ok: true, complete: syncRequests % 2 === 0,
      bill: { found: true, totalEUR: "88.00", dueDate: "2026-11-30", paymentStatus: "due", emailDate: "2026-11-01T09:00:00Z" }
    });
  }
  if (parsed.pathname === "/api/history") return response(200, {
    ok: true, count: 1, totalPaidEUR: "0.00", totalDueEUR: "77.00",
    annualTotals: [{ year: "2026", count: 1, paidEUR: "0.00", dueEUR: "77.00" }],
    bills: [{ totalEUR: "77.00", dueDate: "2026-10-26", paymentStatus: "due", emailDate: "2026-10-06T05:02:02Z" }]
  });
  if (parsed.pathname === "/oauth/start") return response(200, {
    ok: true, authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test"
  });
  throw new Error("Unexpected API request " + parsed.pathname);
};

const windowObject = {
  firebase: fakeFirebase, localStorage,
  dispatchEvent(event) { events.push(event); }
};
const locationObject = {
  origin: "https://temo75.github.io", pathname: "/t1/dei-bill.html", search: "", hash: "",
  assign(url) { this.assigned = url; }
};
const sandbox = {
  window: windowObject,
  document: { createElement() { return new FakeElement(); } },
  location: locationObject,
  history: { replaceState() {} },
  CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
  fetch: fetchMock,
  Date, Intl, URL, URLSearchParams, Promise, console, setTimeout, clearTimeout
};
new vm.Script(source, { filename: "dei-bill-sync.js" }).runInNewContext(sandbox);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const createHost = async () => {
  const host = new FakeElement();
  windowObject.DEIBillSync.mount(host);
  await wait(30);
  return host;
};
const firstHost = await createHost();
assert.ok(calls.some(call => call.path === "/api/config"));
assert.equal(firstHost.children[4].children[0].textContent, "Google-თან ჩემი Gmail-ის დაკავშირება");
assert.equal(firstHost.children[4].children[0].hidden, false);
assert.equal(firstHost.children[1].textContent.includes("არსებული T1"), true);
assert.equal(calls.some(call => call.path === "/api/status"), false, "no private status call until Google identity is authenticated");
assert.ok(!source.includes("createUserWithEmailAndPassword"), "DEI page does not offer a separate account registration form");
assert.ok(!source.includes("SYNC_API_KEY"), "no API secret is bundled in public browser code");
assert.ok(!source.includes("t1.deiBillSession.v1"), "the browser-issued Worker session is not used");

await firstHost.children[4].children[0].listeners.get("click")();
assert.equal(popupSignIns, 1, "one-button flow starts Firebase Google Sign-In");
assert.equal(selectedGooglePrompt, "select_account");
assert.equal(firstHost.children[5].hidden, false, "unmapped UID is prompted for admin-approved account linking");
assert.match(firstHost.children[1].textContent, /მოთხოვნა გაიგზავნა/);
assert.equal(calls.some(call => call.path === "/oauth/start"), false, "Gmail OAuth is not started before T1 account binding");
assert.ok(calls.some(call => call.path === "/api/account/link-request" && call.method === "POST" && call.authorization === "Bearer " + idToken), "the current Firebase UID requests verified account binding");

const linkPanel = firstHost.children[5];
linkPanel.children[2].value = "admin-claim-fixture";
await linkPanel.children[3].listeners.get("click")();
assert.equal(claimSubmitted, "admin-claim-fixture");
assert.ok(calls.some(call => call.path === "/api/account/link" && call.method === "POST" && call.authorization === "Bearer " + idToken));
assert.ok(calls.some(call => call.path === "/oauth/start" && call.method === "POST" && call.authorization === "Bearer " + idToken));
assert.equal(locationObject.assigned, "https://accounts.google.com/o/oauth2/v2/auth?state=test");

linked = true;
t1AccountId = "legacy-account-A";
gmailConnected = true;
fakeAuth.currentUser = firebaseUser;
locationObject.hash = "#dei_gmail=connected";
syncRequests = 0;
const connectedHost = await createHost();
assert.equal(syncRequests, 2, "OAuth return automatically syncs through every Gmail page");
assert.match(connectedHost.children[1].textContent, /სინქრონიზაცია დასრულდა/);
assert.match(connectedHost.children[6].children[1].textContent, /ქვითრები: 1/);
assert.match(connectedHost.children[6].children[2].children[1].textContent, /2026/);

syncMode = "fail";
const syncButton = connectedHost.children[4].children[1];
await syncButton.listeners.get("click")();
assert.match(connectedHost.children[1].textContent, /სინქრონიზაცია ვერ შესრულდა/);
assert.equal(syncButton.disabled, false);
assert.ok(events.some(event => event.type === "t1:dei-bill"));

gmailConnected = false;
locationObject.hash = "#dei_gmail=denied";
const deniedHost = await createHost();
assert.match(deniedHost.children[1].textContent, /თანხმობა გაუქმდა/);
assert.equal(deniedHost.children[4].children[0].hidden, false, "retry button remains available after denied consent");

t1SessionId = "different-t1-account";
const historyCallsBeforeMismatch = calls.filter(call => call.path === "/api/history").length;
const latestCallsBeforeMismatch = calls.filter(call => call.path === "/api/latest").length;
const mismatchHost = await createHost();
assert.match(mismatchHost.children[1].textContent, /სხვა მომხმარებლის მონაცემების დასაცავად/);
assert.equal(mismatchHost.children[4].children[1].hidden, true, "account mismatch blocks sync");
assert.equal(calls.filter(call => call.path === "/api/history").length, historyCallsBeforeMismatch, "mismatched T1 account does not request private history");
assert.equal(calls.filter(call => call.path === "/api/latest").length, latestCallsBeforeMismatch, "mismatched T1 account does not request the latest bill");

t1Authorized = false;
const signedOutHost = await createHost();
assert.equal(signedOutHost.children[2].hidden, false);
assert.equal(signedOutHost.children[2].href, "./index.html");
assert.equal(signedOutHost.children[4].children[0].hidden, true, "existing T1 login is required before Gmail linking");

console.log("PASS: existing T1 session gate; one-button Google account selection; admin claim redemption; account mismatch isolation; Gmail OAuth retry; automatic paginated sync; private history and sync errors.");
