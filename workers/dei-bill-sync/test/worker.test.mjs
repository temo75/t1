import assert from 'node:assert/strict';
import worker from '../src/index.mjs';
class MemoryKV {
  data = new Map();
  async get(k, type) { const v=this.data.get(k); if (v===undefined) return null; return type==='json' ? JSON.parse(v) : v; }
  async put(k,v) { this.data.set(k,String(v)); }
  async delete(k) { this.data.delete(k); }
}
const kv=new MemoryKV();
const env={GOOGLE_CLIENT_ID:'test-client-id',GOOGLE_CLIENT_SECRET:'test-client-secret',DEI_KV:kv};
const email='Πληρωτέο ποσό: 77,00 € Προθεσμία πληρωμής έως 31/10/2026 Οφειλή';
const b64=Buffer.from(email,'utf8').toString('base64url');
globalThis.fetch=async (input, init={})=>{
 const url=String(input);
 if(url==='https://oauth2.googleapis.com/token') {
   const form=new URLSearchParams(init.body);
   if(form.get('grant_type')==='authorization_code') return new Response(JSON.stringify({access_token:'test-access',refresh_token:'test-refresh'}),{status:200});
   if(form.get('grant_type')==='refresh_token' && form.get('refresh_token')==='test-refresh') return new Response(JSON.stringify({access_token:'test-access'}),{status:200});
 }
 if(url==='https://www.googleapis.com/oauth2/v2/userinfo') return new Response(JSON.stringify({email:'temo-test@example.com',verified_email:true}),{status:200});
 if(url.includes('/messages?q=')) return new Response(JSON.stringify({messages:[{id:'message-1'}]}),{status:200});
 if(url.includes('/messages/message-1?format=full')) return new Response(JSON.stringify({snippet:'test',payload:{headers:[{name:'Subject',value:'DEI bill'},{name:'From',value:'billing@dei.gr'},{name:'Date',value:'Wed, 14 Oct 2026 09:00:00 +0000'}],mimeType:'text/plain',body:{data:b64}}}),{status:200});
 throw new Error('Unexpected fetch URL');
};
const req=(path,opts={})=>new Request('https://dei-bill-sync.temo75elia.workers.dev'+path,opts);
let r=await worker.fetch(req('/health'),env); assert.equal(r.status,200); assert.equal((await r.json()).configurationComplete,true);
r=await worker.fetch(req('/oauth/start?return_to='+encodeURIComponent('https://temo75.github.io/t1/dei-bill.html')),env); assert.equal(r.status,302); const auth=new URL(r.headers.get('location')); const state=auth.searchParams.get('state'); assert.ok(state); assert.equal(auth.searchParams.get('redirect_uri'),'https://dei-bill-sync.temo75elia.workers.dev/oauth/callback');
r=await worker.fetch(req('/oauth/callback?code=test-code&state='+state),env); assert.equal(r.status,302); const returnUrl=new URL(r.headers.get('location')); const grant=new URLSearchParams(returnUrl.hash.slice(1)).get('dei_code'); assert.ok(grant);
r=await worker.fetch(req('/api/session/exchange',{method:'POST',headers:{origin:'https://temo75.github.io','content-type':'application/json'},body:JSON.stringify({code:grant})}),env); assert.equal(r.status,200); const session=await r.json(); assert.ok(session.sessionToken);
r=await worker.fetch(req('/api/latest',{headers:{origin:'https://temo75.github.io',authorization:'Bearer '+session.sessionToken}}),env); assert.equal(r.status,200); const result=await r.json(); assert.equal(result.bill.totalEUR,'77.00'); assert.equal(result.bill.dueDate,'2026-10-31'); assert.equal(result.bill.paymentStatus,'due'); assert.ok([...kv.data.keys()].some(key=>key.startsWith('latest_bill:')));
r=await worker.fetch(req('/api/latest'),env); assert.equal(r.status,401);
const badGrant='a'.repeat(64); const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(badGrant)); const hash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join(''); await kv.put('oauth_grant:'+hash,JSON.stringify({returnTo:'https://temo75.github.io/t1/dei-bill.html'}));
r=await worker.fetch(req('/api/session/exchange',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:JSON.stringify({code:badGrant})}),env); assert.equal(r.status,403);
let waited; await worker.scheduled({},env,{waitUntil(p){waited=p;}}); await waited; assert.ok([...kv.data.keys()].some(key=>key.startsWith('latest_bill:')));
console.log('PASS: health/config; OAuth state + callback; scoped browser session; Origin rejection; authenticated latest bill parse; KV persistence; scheduled handler.');
