import assert from 'node:assert/strict';
import worker from '../src/index.mjs';

class MemoryKV {
  data = new Map();
  async get(k, type) { const v = this.data.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; }
  async put(k, v) { this.data.set(k, String(v)); }
  async delete(k) { this.data.delete(k); }
  async list({ prefix = '', limit = 1000, cursor } = {}) {
    const keys = [...this.data.keys()].filter(k => k.startsWith(prefix)).sort();
    const offset = cursor ? Number(cursor) : 0;
    const page = keys.slice(offset, offset + limit).map(name => ({ name }));
    const next = offset + page.length;
    return { keys: page, list_complete: next >= keys.length, cursor: next >= keys.length ? undefined : String(next) };
  }
}

const kv = new MemoryKV();
const env = { GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret', DEI_KV: kv, TEST_MODE: true };
const dateHeader = 'Wed, 14 Oct 2026 09:00:00 +0000';
const samples = {
  'security-code': {
    subject: 'Notification', body: 'Your security code is 123456',
    internalDate: Date.parse('2026-10-15T08:00:00Z'), from: 'noreply@dei.gr'
  },
  'bill-2026': {
    subject: 'DEI bill October', body: 'Πληρωτέο ποσό: 77,00 € Προθεσμία πληρωμής έως 31/10/2026 Οφειλή',
    internalDate: Date.parse('2026-10-14T09:00:00Z'), from: 'billing@dei.gr', date: dateHeader
  },
  'bill-2026-duplicate': {
    subject: 'DEI bill October',
    body: 'Πληρωτέο ποσό: 77,00 € Προθεσμία πληρωμής έως 31/10/2026 Οφειλή',
    internalDate: Date.parse('2026-10-14T09:01:37Z'), from: 'billing@dei.gr', date: dateHeader
  },
  'forwarded-dei-bill': {
    subject: 'Fwd: Ειδοποίηση έκδοσης λογαριασμού Ηλεκτρικής Ενέργειας ΔΕΗ',
    body: '---------- Forwarded message ----------\nFrom: DEI <noreply@dei.gr>\nDate: Tue, 6 Oct 2026 08:02:00 +0000\nSubject: Ειδοποίηση έκδοσης λογαριασμού Ηλεκτρικής Ενέργειας ΔΕΗ\nTo: temo75elia@gmail.com\nΠληρωτέο ποσό: 45,20 € Προθεσμία πληρωμής έως 30/10/2026 Οφειλή',
    internalDate: Date.parse('2026-10-10T08:00:00Z'), from: 'temo75elia@gmail.com', date: dateHeader
  },
  'payment-confirmation': {
    subject: 'DEI payment confirmation', body: 'Payment received. Total amount 77.00 EUR',
    internalDate: Date.parse('2026-10-13T09:00:00Z'), from: 'billing@dei.gr'
  },
  'bill-2025': {
    subject: 'DEI electricity bill', body: 'Συνολικό ποσό: 12,00 €',
    internalDate: Date.parse('2025-12-31T23:30:00Z'), from: 'billing@dei.gr',
    date: 'Thu, 15 Oct 2026 09:00:00 +0000'
  },
  'bill-paid-2024': {
    subject: 'DEI electricity bill 2024', body: 'Ο λογαριασμός εξοφλήθηκε. Πληρωτέο ποσό: 15.50 € Total amount: 15.50 €',
    internalDate: Date.parse('2024-06-01T10:00:00Z'), from: 'billing@dei.gr'
  }
};
const fullMessage = id => {
  const m = samples[id];
  return { internalDate: String(m.internalDate), snippet: m.body,
    payload: { mimeType: 'text/plain', headers: [
      { name: 'Subject', value: m.subject }, { name: 'From', value: m.from },
      { name: 'Date', value: m.date || dateHeader }
    ], body: { data: Buffer.from(m.body, 'utf8').toString('base64url') } } };
};
let failGmail = false;
let googleIdentity = { sub: 'google-user-1', email: 'temo75elia@gmail.com', email_verified: true };
const requestedPages = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return new Response(JSON.stringify(googleIdentity));
  if (url === 'https://oauth2.googleapis.com/token') {
    const form = new URLSearchParams(init.body);
    if (form.get('grant_type') === 'authorization_code') return new Response(JSON.stringify({ access_token: 'test-access', refresh_token: 'test-refresh' }), { status: 200 });
    if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'test-refresh') return new Response(JSON.stringify({ access_token: 'test-access' }), { status: 200 });
  }
  if (url.includes('/messages?q=')) {
    if (failGmail) return new Response(JSON.stringify({ error: { message: 'sanitized fixture error' } }), { status: 403 });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('maxResults'), '20');
    assert.equal(parsed.searchParams.get('q'), 'in:anywhere {from:(dei.gr) subject:(Fwd) subject:(FW) subject:(Forward) subject:(Προώθηση) subject:(λογαριασμού) subject:(ΔΕΗ) subject:(Ηλεκτρικής)}');
    requestedPages.push(parsed.searchParams.get('pageToken') || '');
    const page = parsed.searchParams.get('pageToken') || '';
    if (!page) return new Response(JSON.stringify({ messages: [{ id: 'security-code' }], nextPageToken: 'page-2' }));
    if (page === 'page-2') return new Response(JSON.stringify({ messages: [{ id: 'bill-2026' }, { id: 'bill-2026' }, { id: 'bill-2026-duplicate' }, { id: 'forwarded-dei-bill' }], nextPageToken: 'page-3' }));
    if (page === 'page-3') return new Response(JSON.stringify({ messages: [{ id: 'payment-confirmation' }, { id: 'bill-2025' }], nextPageToken: 'page-4' }));
    if (page === 'page-4') return new Response(JSON.stringify({ messages: [{ id: 'bill-paid-2024' }] }));
  }
  const match = url.match(/\/messages\/([^?]+)\?format=full$/);
  if (match && samples[decodeURIComponent(match[1])]) return new Response(JSON.stringify(fullMessage(decodeURIComponent(match[1]))));
  throw new Error('Unexpected fixture request');
};

const req = (path, opts = {}) => new Request('https://dei-bill-sync.temo75elia.workers.dev' + path, opts);
let r = await worker.fetch(req('/health'), env);
assert.equal(r.status, 200);
assert.equal((await r.json()).configurationComplete, true);

r = await worker.fetch(req('/oauth/start?return_to=' + encodeURIComponent('https://temo1.gr/dei-bill.html')), env);
assert.equal(r.status, 302, 'new temo1.gr DEI page is an allowed OAuth return URL');
const auth = new URL(r.headers.get('location'));
const state = auth.searchParams.get('state');
assert.ok(state);
assert.equal(auth.searchParams.get('redirect_uri'), 'https://dei-bill-sync.temo75elia.workers.dev/oauth/callback');

r = await worker.fetch(req('/oauth/start?return_to=' + encodeURIComponent('https://temo1.gr/t1/dei-bill.html')), env);
assert.equal(r.status, 302, 'new domain /t1 path is also allowed for OAuth return');
r = await worker.fetch(req('/oauth/start?return_to=' + encodeURIComponent('https://www.temo1.gr/dei-bill.html')), env);
assert.equal(r.status, 302, 'www new domain is also allowed for OAuth return');
r = await worker.fetch(req('/oauth/start?return_to=' + encodeURIComponent('https://temo1.gr/')), env);
assert.equal(r.status, 302, 'new domain homepage is an allowed OAuth return URL');
r = await worker.fetch(req('/oauth/start?return_to=' + encodeURIComponent('https://temo1.gr/index.html')), env);
assert.equal(r.status, 302, 'new domain main page is an allowed OAuth return URL');
r = await worker.fetch(req('/oauth/start?return_to=' + encodeURIComponent('https://evil.example/dei-bill.html')), env);
assert.equal(r.status, 400, 'untrusted external return URL is rejected');

r = await worker.fetch(req('/oauth/callback?code=test-code&state=' + state), env);
assert.equal(r.status, 302);
const returnUrl = new URL(r.headers.get('location'));
const grant = new URLSearchParams(returnUrl.hash.slice(1)).get('dei_code');
assert.ok(grant);
r = await worker.fetch(req('/api/session/exchange', { method: 'POST', headers: { origin: 'https://temo1.gr', 'content-type': 'application/json' }, body: JSON.stringify({ code: grant }) }), env);
assert.equal(r.status, 200, 'new domain is allowed to exchange OAuth grants');
const session = await r.json();
assert.ok(session.sessionToken);
const authHeaders = { origin: 'https://temo75.github.io', authorization: 'Bearer ' + session.sessionToken };

for (const continuation of [false, true, true, true]) {
  r = await worker.fetch(req('/api/sync', { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ continue: continuation }) }), env);
  assert.equal(r.status, 200, await r.clone().text());
  const result = await r.json();
  assert.equal(result.ok, true);
  assert.equal(result.complete, continuation && requestedPages.length === 4);
}
assert.equal(JSON.stringify(requestedPages), JSON.stringify(['', 'page-2', 'page-3', 'page-4']));
const ownerKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('google-user-1')).then(d => [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''));
const historyKeys = [...kv.data.keys()].filter(k => k.startsWith('bill_history:' + ownerKey + ':'));
assert.equal(historyKeys.length, 4, 'Gmail IDs deduplicate, security messages are excluded, payment receipts update matching invoices, and forwarded DEI bills are recognized');
const storedLatest = await kv.get('latest_bill:' + ownerKey, 'json');
assert.equal(storedLatest.totalEUR, '77.00');
assert.equal(storedLatest.dueDate, '2026-10-31');
assert.equal(storedLatest.paymentStatus, 'paid');
assert.equal(storedLatest.emailDate, new Date(samples['bill-2026'].internalDate).toISOString(), 'internalDate overrides Date header');

r = await worker.fetch(req('/api/history', { headers: authHeaders }), env);
assert.equal(r.status, 200);
const history = await r.json();
assert.equal(history.count, 4);
assert.equal(history.bills.every(x => x.gmailMessageId === undefined), true, 'private Gmail message IDs are not returned');
assert.equal(history.totalPaidEUR, '92.50', 'payment receipt marks the unique matching 77 EUR invoice as paid');
assert.equal(history.totalDueEUR, '45.20', 'paid invoice is removed from due totals; forwarded bill is counted once');
assert.equal(JSON.stringify(history.annualTotals), JSON.stringify([
  { year: '2026', count: 2, paidEUR: '77.00', dueEUR: '45.20' },
  { year: '2025', count: 1, paidEUR: '0.00', dueEUR: '0.00' },
  { year: '2024', count: 1, paidEUR: '15.50', dueEUR: '0.00' }
]));
assert.equal(new Date(history.bills[0].emailDate).getUTCFullYear(), 2026);
assert.equal(new Date(history.bills[1].emailDate).getUTCFullYear(), 2026);
assert.equal(new Date(history.bills[2].emailDate).getUTCFullYear(), 2025);
assert.equal(new Date(history.bills[3].emailDate).getUTCFullYear(), 2024);
r = await worker.fetch(req('/api/latest', { headers: authHeaders }), env);
assert.equal(r.status, 200);
assert.equal((await r.json()).bill.totalEUR, '77.00');
assert.equal((await worker.fetch(req('/api/history'), env)).status, 401);
r = await worker.fetch(req('/api/sync', { method: 'GET', headers: authHeaders }), env);
assert.equal(r.status, 405);

failGmail = true;
r = await worker.fetch(req('/api/sync', { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: '{}' }), env);
assert.equal(r.status, 502);
assert.match((await r.json()).error, /Gmail API request failed/);

failGmail = false;
const largeKV = new MemoryKV();
const largeEnv = { ...env, DEI_KV: largeKV };
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session.sessionToken));
const sessionHash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
await largeKV.put('t1_session:' + sessionHash, ownerKey);
for (let i = 0; i < 1001; i++) await largeKV.put('bill_history:' + ownerKey + ':bulk-' + i, JSON.stringify({ gmailMessageId: 'bulk-' + i, found: true, emailDate: '2020-01-01T00:00:00.000Z', totalEUR: '1.00', dueDate: null, paymentStatus: 'unknown' }));
r = await worker.fetch(req('/api/history', { headers: authHeaders }), largeEnv);
assert.equal(r.status, 200);
assert.equal((await r.json()).count, 1001, 'KV history uses all list pages beyond 1000 keys');

// A second Google account gets a different token/session/history namespace.
googleIdentity = { sub: 'google-user-2', email: 'iza@example.com', email_verified: true };
r = await worker.fetch(req('/oauth/start?return_to=' + encodeURIComponent('https://temo75.github.io/t1/dei-bill.html')), env);
const state2 = new URL(r.headers.get('location')).searchParams.get('state');
r = await worker.fetch(req('/oauth/callback?code=test-code-2&state=' + state2), env);
const grant2 = new URL(r.headers.get('location')).hash;
const code2 = new URLSearchParams(grant2.slice(1)).get('dei_code');
r = await worker.fetch(req('/api/session/exchange', { method: 'POST', headers: { origin: 'https://temo75.github.io', 'content-type': 'application/json' }, body: JSON.stringify({ code: code2 }) }), env);
assert.equal(r.status, 200);
const session2 = await r.json();
const digest2 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session2.sessionToken));
const sessionHash2 = [...new Uint8Array(digest2)].map(x => x.toString(16).padStart(2, '0')).join('');
const ownerKey2 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('google-user-2')).then(d => [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''));
assert.equal(await kv.get('t1_session:' + sessionHash2), ownerKey2);
assert.notEqual(ownerKey, ownerKey2);
assert.equal(await kv.get('gmail_refresh_token:' + ownerKey2), 'test-refresh');
assert.equal(await kv.get('gmail_refresh_token:' + ownerKey), 'test-refresh');
assert.equal((await worker.fetch(req('/api/history', { headers: { authorization: 'Bearer ' + session2.sessionToken } }), env)).status, 200);
const history2 = await (await worker.fetch(req('/api/history', { headers: { authorization: 'Bearer ' + session2.sessionToken } }), env)).json();
assert.equal(history2.count, 0, 'new Google account must not see the first account history');
let scheduled;
await worker.scheduled({}, env, { waitUntil(p) { scheduled = p; } });
await scheduled;
assert.ok(await kv.get('latest_bill:' + ownerKey));
console.log('PASS: OAuth identity and per-account tokens/sessions/history; forwarded DEI bill recognition from quoted noreply@dei.gr; Gmail pagination; exclusions; KV history; annual totals; scheduled handler.');
