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

const root = new FakeElement();
const messageEvents = [];
const calls = [];
let linked = true;
let gmailConnected = true;
let popupSignIns = 0;
let selectedGooglePrompt = null;
let syncMode = "success";
let syncRequests = 0;
const idToken = "signed-firebase-id-token-fixture";
const firebaseUser = {
  uid: "firebase-user-fixture",
  email: "person@example.invalid",
  emailVerified: true,
  async getIdToken() { return idToken; },
  async sendEmailVerification() {},
};
const fakeAuth = {
  currentUser: firebaseUser,
  async setPersistence(value) { assert.equal(value, "session"); },
  onAuthStateChanged(callback) { callback(this.currentUser); return () => {}; },
  async signInWithEmailAndPassword() { this.currentUser = firebaseUser; return { user: firebaseUser }; },
  async createUserWithEmailAndPassword() { this.currentUser = firebaseUser; return { user: firebaseUser }; },
  async signInWithPopup(provider) { selectedGooglePrompt = provider.parameters?.prompt; popupSignIns++; this.currentUser = firebaseUser; return { user: firebaseUser }; },
  async signOut() { this.currentUser = null; },
};
const fakeFirebase = {
  apps: [],
  auth: { Auth: { Persistence: { SESSION: "session" } }, GoogleAuthProvider: class { setCustomParameters(parameters) { this.parameters = parameters; } } },
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
  calls.push({ path: parsed.pathname, method: options.method || "GET", authorization: options.headers?.Authorization || "" });
  if (parsed.pathname === "/api/config") return response(200, {
    ok: true, firebaseConfig: { apiKey: "public-key", authDomain: "temo-75.firebaseapp.com", projectId: "temo-75", appId: "web-app-id" }
  });
  if (parsed.pathname === "/api/status") return response(200, { ok: true, linked, gmailConnected, lastSyncAt: "2026-10-15T09:00:00Z" });
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
  if (parsed.pathname === "/oauth/start") return response(200, { ok: true, authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test" });
  throw new Error("Unexpected API request " + parsed.pathname);
};

const windowObject = {
  firebase: fakeFirebase,
  dispatchEvent(event) { messageEvents.push(event); },
  DEIBillSync: null
};
const locationObject = { origin: "https://temo75.github.io", pathname: "/t1/dei-bill.html", search: "", hash: "", assign(url) { this.assigned = url; } };
const sandbox = {
  window: windowObject,
  document: { createElement() { return new FakeElement(); } },
  location: locationObject,
  history: { replaceState() {} },
  CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
  fetch: fetchMock,
  Date, Intl, URL, URLSearchParams, Promise, console, setTimeout, clearTimeout
};
const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "../../../dei-bill-sync.js");
const source = await readFile(scriptPath, "utf8");
const htmlPath = path.resolve(here, "../../../dei-bill.html");
const pageHtml = await readFile(htmlPath, "utf8");
assert.match(pageHtml, /\.dei-sync-primary\{[^}]*min-height:58px;width:100%/);
new vm.Script(source, { filename: scriptPath }).runInNewContext(sandbox);
const host = new FakeElement();
windowObject.DEIBillSync.mount(host);
await new Promise(resolve => setTimeout(resolve, 30));

assert.ok(calls.some(call => call.path === "/api/config"));
assert.ok(calls.filter(call => call.path !== "/api/config").every(call => call.authorization === "Bearer " + idToken),
  "all private Worker API requests carry the Firebase ID token");
assert.ok(!source.includes("t1.deiBillSession.v1"), "the old browser-issued Worker session is removed");
assert.ok(!source.includes("SYNC_API_KEY"), "no API secret is bundled in public browser code");
assert.ok(!source.includes("/api/account/link"), "the normal user flow has no administrator claim-code step");
assert.equal(host.children[0].children[1].textContent, "შენი Gmail ანგარიში დაკავშირებულია", "connected Gmail status is visible");
const historyPanel = host.children[6];
assert.match(historyPanel.children[1].textContent, /ქვითრები: 1/);
assert.match(historyPanel.children[2].children[1].textContent, /2026/);
const actions = host.children[5];
const syncButton = actions.children[1];
const clickSync = syncButton.listeners.get("click");
assert.equal(typeof clickSync, "function");
await clickSync();
assert.equal(syncRequests, 2, "the widget keeps paging until Worker complete=true");
assert.ok(host.children[1].textHistory.some(value => value.includes("ძველ ქვითრებს ვამოწმებ")));
assert.match(host.children[1].textContent, /ყველა გვერდი შემოწმებულია|სინქრონიზაცია დასრულდა/);

syncMode = "fail";
await clickSync();
assert.match(host.children[1].textContent, /სინქრონიზაცია ვერ შესრულდა/);
assert.equal(syncButton.disabled, false);
assert.ok(messageEvents.some(event => event.type === "t1:dei-bill"));

gmailConnected = false;
fakeAuth.currentUser = null;
const connectHost = new FakeElement();
windowObject.DEIBillSync.mount(connectHost);
await new Promise(resolve => setTimeout(resolve, 30));
const connectActions = connectHost.children[5];
const connectButton = connectActions.children[0];
assert.equal(connectButton.textContent, "Google-თან ჩემი Gmail-ის დაკავშირება");
assert.equal(connectButton.hidden, false);
assert.equal(connectHost.children[3].hidden, true, "password form is hidden by default");
assert.equal(connectHost.children[2].textContent, "უკვე გაქვს Firebase ანგარიში? შესვლა");
connectHost.children[2].listeners.get("click")();
assert.equal(connectHost.children[3].hidden, false, "existing Firebase login is available on request");
connectHost.children[2].listeners.get("click")();
await connectButton.listeners.get("click")();
assert.ok(calls.some(call => call.path === "/oauth/start" && call.method === "POST" && call.authorization === "Bearer " + idToken));
assert.equal(popupSignIns, 1, "the main Gmail button signs into Firebase with Google when needed");
assert.equal(selectedGooglePrompt, "select_account");
assert.match(locationObject.assigned, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?state=test$/);
locationObject.hash = "#dei_gmail=denied";
const deniedHost = new FakeElement();
windowObject.DEIBillSync.mount(deniedHost);
await new Promise(resolve => setTimeout(resolve, 30));
assert.match(deniedHost.children[1].textContent, /თანხმობა გაუქმდა/);
assert.equal(deniedHost.children[5].children[0].hidden, false, "retry remains visible after denied consent");
syncMode = "success";
syncRequests = 0;
gmailConnected = true;
locationObject.hash = "#dei_gmail=connected";
const connectedHost = new FakeElement();
windowObject.DEIBillSync.mount(connectedHost);
await new Promise(resolve => setTimeout(resolve, 50));
assert.equal(syncRequests, 2, "successful OAuth return automatically syncs every page");
assert.match(connectedHost.children[1].textContent, /სინქრონიზაცია დასრულდა/);

console.log("PASS: Firebase ID token on private API calls; no browser Worker session/API secret; personal history display; multi-page progress; sync errors; prominent Gmail connect button and OAuth navigation.");
