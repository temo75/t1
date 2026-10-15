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
}

const root = new FakeElement();
const session = { token: "fixture-session", expiresAt: new Date(Date.now() + 60_000).toISOString() };
const sessionKey = "t1.deiBillSession.v1";
const storage = new Map([[sessionKey, JSON.stringify(session)]]);
const messageEvents = [];
const windowObject = {
  dispatchEvent(event) { messageEvents.push(event); },
  DEIBillSync: null
};
const locationObject = {
  origin: "https://temo75.github.io",
  pathname: "/t1/bills.html",
  search: "",
  hash: "",
  assign() {}
};
let syncMode = "success";
let syncRequests = 0;
const calls = [];
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, async json() { return body; } });
const fetchMock = async (url, options = {}) => {
  const parsed = new URL(url);
  calls.push({ path: parsed.pathname, method: options.method || "GET" });
  if (parsed.pathname === "/api/latest") return response(200, {
    ok: true, cached: true,
    bill: { found: true, totalEUR: "77.00", dueDate: "2026-10-31", paymentStatus: "due", emailDate: "2026-10-14T09:00:00Z" }
  });
  if (parsed.pathname === "/api/sync") {
    if (syncMode === "fail") return response(502, { ok: false, error: "Gmail API request failed" });
    syncRequests++;
    return response(200, {
      ok: true, cached: false, complete: syncRequests % 2 === 0,
      bill: { found: true, totalEUR: "88.00", dueDate: "2026-11-30", paymentStatus: "due", emailDate: "2026-11-01T09:00:00Z" }
    });
  }
  if (parsed.pathname === "/api/history") {
    // This is the live Worker fallback shape when /api/history is not deployed.
    return response(200, { service: "TEMO DEI bill sync", routes: ["/api/sync", "/api/latest"] });
  }
  if (parsed.pathname === "/api/status") return response(200, { ok: true, gmailConnected: true });
  throw new Error("Unexpected widget API request");
};
const sandbox = {
  window: windowObject,
  document: { createElement() { return new FakeElement(); }, getElementById() { return root; } },
  sessionStorage: {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, value); },
    removeItem(key) { storage.delete(key); }
  },
  location: locationObject,
  history: { replaceState() {} },
  CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
  fetch: fetchMock,
  Date, Intl, URL, URLSearchParams, Promise, console, setTimeout, clearTimeout
};
const here = path.dirname(fileURLToPath(import.meta.url));
const widgetPath = path.resolve(here, "../../../dei-bill-sync.js");
const widgetSource = await readFile(widgetPath, "utf8");
new vm.Script(widgetSource, { filename: widgetPath }).runInNewContext(sandbox);

const host = new FakeElement();
windowObject.DEIBillSync.mount(host);
await new Promise(resolve => setTimeout(resolve, 0));
const historyPanel = host.children[4];
assert.match(historyPanel.children[1].textContent, /ისტორია ვერ ჩაიტვირთა/);
assert.ok(historyPanel.children[1].textContent.includes("/api/history"));

const actions = host.children[3];
const syncButton = actions.children[1];
const clickSync = syncButton.listeners.get("click");
assert.equal(typeof clickSync, "function");
await clickSync();
const progressMessages = host.children[1].textHistory;
assert.ok(progressMessages.some(value => value.includes("Gmail-იდან DEI ქვითრებს ვკითხულობ")));
assert.ok(progressMessages.some(value => value.includes("ძველი ქვითრების გვერდებს ვამოწმებ")));
assert.match(host.children[1].textContent, /ყველა გვერდი შემოწმებულია/);
assert.match(historyPanel.children[1].textContent, /ისტორია ვერ ჩაიტვირთა/);
assert.equal(syncRequests, 2, "the widget continues until Worker complete=true");

syncMode = "fail";
await clickSync();
assert.match(host.children[1].textContent, /სინქრონიზაცია ვერ შესრულდა/);
assert.equal(syncButton.disabled, false);
assert.ok(calls.some(call => call.path === "/api/history"));
console.log("PASS: widget API contract, multi-page progress/final state, history unavailable message, sync failure message.");
