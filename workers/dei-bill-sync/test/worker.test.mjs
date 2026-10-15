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
const emailKey = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('temo@example.com')))].map(x => x.toString(16).padStart(2, '0')).join('');
const env = { GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret', DEI_KV: kv };
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
  'payment-confirmation': {
    subject: 'DEI update', body: 'Payment received. Total amount 9.00 EUR',
    internalDate: Date.parse('2026-10-13T09:00:00Z'), from: 'billing@dei.gr'
  },
  'bill-2025': {
    subject: 'DEI electricity bill', body: 'Συνολικό ποσό: 12,00 €',
    internalDate: Date.parse('2025-12-31T23:30:00Z'), from: 'billing@dei.gr',
    date: 'Thu, 15 Oct 2026 09:00:00 +0000'
  },
  'dei-notice': {
    subject: 'Ειδοποίηση έκδοσης λογαριασμού Ηλεκτρικής Ενέργειας ΔΕΗ',
    body: '<strong>Τελικό Ποσό Πληρωμής</strong><br><br><strong>77,00€</strong><br><br><strong>Ημερομηνία Λήξης</strong><br>26/10/2026<br><br><strong>Payable Amount</strong><br>77,00€<br><br><strong>Expiration Date</strong><br>26/10/2026',
    internalDate: Date.parse('2026-10-06T05:02:02Z'), from: 'noreply@dei.gr', mimeType: 'text/html'
  },
  'bill-paid-2024': {
    subject: 'DEI electricity bill 2024', body: 'Ο λογαριασμός εξοφλήθηκε. Total amount: 15.50 €',
    internalDate: Date.parse('2024-06-01T10:00:00Z'), from: 'billing@dei.gr'
  }
};
const fullMessage = id => {
  const m = samples[id];
  return { internalDate: String(m.internalDate), snippet: m.body,
    payload: { mimeType: m.mimeType || 'text/plain', headers: [
      { name: 'Subject', value: m.subject }, { name: 'From', value: m.from },
      { name: 'Date', value: m.date || dateHeader }
    ], body: { data: Buffer.from(m.body, 'utf8').toString('base64url') } } };
};
let failGmail = false;
const requestedPages = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') return new Response(JSON.stringify({ email: 'temo@example.com', verified_email: true }), { status: 200 });
  if (url === 'https://oauth2.googleapis.com/token') {
    const form = new URLSearchParams(init.body);
    if (form.get('grant_type') === 'authorization_code') return new Response(JSON.stringify({ access_token: 'test-access', refresh_token: 'test-refresh' }), { status: 200 });
    if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'test-refresh') return new Response(JSON.stringify({ access_token: 'test-access' }), { status: 200 });
  }
  if (url.includes('/messages?q=')) {
    if (failGmail) return new Response(JSON.stringify({ error: { message: 'sanitized fixture error' } }), { status: 403 });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('maxResults'), '20');
    assert.equal(parsed.searchParams.get('q'), 'in:anywhere from:(dei.gr)');
    requestedPages.push(parsed.searchParams.get('pageToken') || '');
    const page = parsed.searchParams.get('pageToken') || '';
    if (!page) return new Response(JSON.stringify({ messages: [{ id: 'security-code' }], nextPageToken: 'page-2' }));
    if (page === 'page-2') return new Response(JSON.stringify({ messages: [{ id: 'bill-2026' }, { id: 'bill-2026' }], nextPageToken: 'page-3' }));
    if (page === 'page-3') return new Response(JSON.stringify({ messages: [{ id: 'payment-confirmation' }, { id: 'bill-2025' }], nextPageToken: 'page-4' }));
    if (page === 'page-4') return new Response(JSON.stringify({ messages: [{ id: 'bill-paid-2024' }, { id: 'dei-notice' }] }));
  }
  const match = url.match(/\/messages\/([^?]+)\?format=full$/);
  if (match && samples[decodeURIComponent(match[1])]) return new Response(JSON.stringify(fullMessage(decodeURIComponent(match[1]))));
  throw new Error('Unexpected fixture request');
};

const req = (path, opts = {}) => new Request('https://dei-bill-sync.temo75elia.workers.dev' + path, opts);
let r = await worker.fetch(req('/health'), env);
assert.equal(r.status, 200);
assert.equal((await r.json()).configurationComplete, true);

r = await worker.fetch(req('/oauth/start?return_to=' + encodeURIComponent('https://temo75.github.io/t1/dei-bill.html')), env);
assert.equal(r.status, 302);
const auth = new URL(r.headers.get('location'));
const state = auth.searchParams.get('state');
assert.ok(state);
assert.equal(auth.searchParams.get('redirect_uri'), 'https://dei-bill-sync.temo75elia.workers.dev/oauth/callback');
r = await worker.fetch(req('/oauth/callback?code=test-code&state=' + state), env);
assert.equal(r.status, 302);
const returnUrl = new URL(r.headers.get('location'));
const grant = new URLSearchParams(returnUrl.hash.slice(1)).get('dei_code');
assert.ok(grant);
r = await worker.fetch(req('/api/session/exchange', { method: 'POST', headers: { origin: 'https://temo75.github.io', 'content-type': 'application/json' }, body: JSON.stringify({ code: grant }) }), env);
assert.equal(r.status, 200);
const session = await r.json();
assert.ok(session.sessionToken);
const authHeaders = { origin: 'https://temo75.github.io', authorization: 'Bearer ' + session.sessionToken };

for (const continuation of [false, true, true, true]) {
  r = await worker.fetch(req('/api/sync', { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ continue: continuation }) }), env);
  assert.equal(r.status, 200);
  const result = await r.json();
  assert.equal(result.ok, true);
  assert.equal(result.complete, continuation && requestedPages.length === 4);
}
assert.equal(JSON.stringify(requestedPages), JSON.stringify(['', 'page-2', 'page-3', 'page-4']));
const historyKeys = [...kv.data.keys()].filter(k => k.startsWith('bill_history:' + emailKey + ':'));
assert.equal(historyKeys.length, 4, 'Gmail IDs deduplicate and security/payment messages are excluded');
const storedLatest = await kv.get('latest_bill:' + emailKey, 'json');
assert.equal(storedLatest.totalEUR, '77.00');
assert.equal(storedLatest.dueDate, '2026-10-31');
assert.equal(storedLatest.paymentStatus, 'due');
assert.equal(storedLatest.emailDate, new Date(samples['bill-2026'].internalDate).toISOString(), 'internalDate overrides Date header');
const deiNotice = await kv.get('bill_history:' + emailKey + ':dei-notice', 'json');
assert.equal(deiNotice.totalEUR, '77.00');
assert.equal(deiNotice.dueDate, '2026-10-26');
assert.equal(deiNotice.paymentStatus, 'due');

r = await worker.fetch(req('/api/history', { headers: authHeaders }), env);
assert.equal(r.status, 200);
const history = await r.json();
assert.equal(history.count, 4);
assert.equal(history.bills.every(x => x.gmailMessageId === undefined), true, 'private Gmail message IDs are not returned');
assert.equal(history.totalPaidEUR, '15.50');
assert.equal(history.totalDueEUR, '154.00', 'unknown status must not be counted as due');
assert.equal(JSON.stringify(history.annualTotals), JSON.stringify([
  { year: '2026', count: 2, paidEUR: '0.00', dueEUR: '154.00' },
  { year: '2025', count: 1, paidEUR: '0.00', dueEUR: '0.00' },
  { year: '2024', count: 1, paidEUR: '15.50', dueEUR: '0.00' }
]));

const localizedKV = new MemoryKV();
const localizedDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session.sessionToken));
const localizedSessionHash = [...new Uint8Array(localizedDigest)].map(x => x.toString(16).padStart(2, '0')).join('');
await localizedKV.put('t1_session:' + localizedSessionHash, JSON.stringify({ emailKey }));
const localizedBills = [
  ['2025-paid', '2025-03-01', '45,00 €', 'paid'],
  ['2025-due', '2025-08-01', '12,50', 'due'],
  ['2025-unknown', '2025-11-01', '99,00 €', 'unknown'],
  ['2026-paid-a', '2026-01-01', '20,25 €', 'paid'],
  ['2026-paid-b', '2026-02-01', '1.234,50 €', 'paid'],
  ['2026-due-a', '2026-04-01', '22,25 €', 'due'],
  ['2026-due-b', '2026-05-01', '3,50', 'due'],
  ['2026-unknown-a', '2026-06-01', '80,00 €', 'unknown'],
  ['2026-unknown-b', '2026-07-01', '5,00 €', 'unknown']
];
for (const [id, day, amount, paymentStatus] of localizedBills) {
  const internalDate = Date.parse(day + 'T12:00:00Z');
  await localizedKV.put('bill_history:' + emailKey + ':' + id, JSON.stringify({
    gmailMessageId: id, internalDate, emailDate: new Date(internalDate).toISOString(),
    totalEUR: amount, paymentStatus
  }));
}
const localizedEnv = { ...env, DEI_KV: localizedKV };
r = await worker.fetch(req('/api/history', { headers: authHeaders }), localizedEnv);
assert.equal(r.status, 200);
const localizedHistory = await r.json();
assert.equal(localizedHistory.count, 9);
assert.equal(localizedHistory.totalPaidEUR, '1299.75');
assert.equal(localizedHistory.totalDueEUR, '38.25');
assert.equal(JSON.stringify(localizedHistory.annualTotals), JSON.stringify([
  { year: '2026', count: 6, paidEUR: '1254.75', dueEUR: '25.75' },
  { year: '2025', count: 3, paidEUR: '45.00', dueEUR: '12.50' }
]));
assert.ok(localizedHistory.bills.some(x => x.totalEUR === '45.00'));
assert.equal(localizedHistory.totalPaidEUR.includes('99.00'), false, 'unknown status remains excluded');
assert.equal(JSON.stringify(history.bills.map(x => new Date(x.emailDate).getUTCFullYear())), JSON.stringify([2026, 2026, 2025, 2024]), 'history sorts bills newest first');
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
await largeKV.put('t1_session:' + sessionHash, JSON.stringify({ emailKey }));
for (let i = 0; i < 1001; i++) await largeKV.put('bill_history:' + emailKey + ':bulk-' + i, JSON.stringify({ gmailMessageId: 'bulk-' + i, found: true, emailDate: '2020-01-01T00:00:00.000Z', totalEUR: '1.00', dueDate: null, paymentStatus: 'unknown' }));
r = await worker.fetch(req('/api/history', { headers: authHeaders }), largeEnv);
assert.equal(r.status, 200);
assert.equal((await r.json()).count, 1001, 'KV history uses all list pages beyond 1000 keys');
let scheduled;
await worker.scheduled({}, env, { waitUntil(p) { scheduled = p; } });
await scheduled;
assert.ok(await kv.get('latest_bill:' + emailKey));
console.log('PASS: OAuth redirect/callback; session authorization; Gmail all-page cursor flow; security/payment exclusions; unique KV history; internalDate precedence; unknown-status totals; annual totals/order; safe Gmail API error; scheduled handler.');
