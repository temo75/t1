const TEMO_PUSH_WORKER_URL='https://temo-ai.temo75.workers.dev';
const TEMO_PUSH_DB='temo-push-meta';
const TEMO_PUSH_STORE='identity';
function openTEMOPushDB(){
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open(TEMO_PUSH_DB,1);
    r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(TEMO_PUSH_STORE))r.result.createObjectStore(TEMO_PUSH_STORE);};
    r.onsuccess=()=>resolve(r.result);
    r.onerror=()=>reject(r.error);
  });
}
async function saveTEMOPushIdentity(value){
  const db=await openTEMOPushDB();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(TEMO_PUSH_STORE,'readwrite');
    tx.objectStore(TEMO_PUSH_STORE).put(value,'identity');
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });
  db.close();
}
async function loadTEMOPushIdentity(){
  const db=await openTEMOPushDB();
  const value=await new Promise((resolve,reject)=>{
    const tx=db.transaction(TEMO_PUSH_STORE,'readonly');
    const r=tx.objectStore(TEMO_PUSH_STORE).get('identity');
    r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);
  });
  db.close();
  return value;
}
async function syncTEMOPushSubscription(sub){
  const identity=await loadTEMOPushIdentity();
  if(!identity?.userId||!identity?.userName||!sub)return false;
  const payload=sub.toJSON();
  if(!payload?.endpoint||!payload?.keys?.p256dh||!payload?.keys?.auth)return false;
  const r=await fetch(TEMO_PUSH_WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    action:'push-subscribe',
    userId:String(identity.userId),
    userName:String(identity.userName),
    subscription:payload
  })});
  return r.ok;
}
self.addEventListener('message',event=>{
  const d=event.data||{};
  if(d.type!=='temo-push-identity')return;
  event.waitUntil(saveTEMOPushIdentity({
    userId:String(d.userId||''),
    userName:String(d.userName||'')
  }));
});
self.addEventListener('pushsubscriptionchange',event=>{
  event.waitUntil((async()=>{
    try{
      const reg=self.registration;
      let sub=event.newSubscription;
      if(!sub){
        const identity=await loadTEMOPushIdentity();
        if(!identity?.userId) return;
        const keyResponse=await fetch(TEMO_PUSH_WORKER_URL+'?action=push-config',{cache:'no-store'});
        const keyData=await keyResponse.json();
        if(!keyData?.ok||!keyData.publicKey)return;
        const s=String(keyData.publicKey).replace(/-/g,'+').replace(/_/g,'/');
        const raw=atob(s+'='.repeat((4-s.length%4)%4));
        const key=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)key[i]=raw.charCodeAt(i);
        sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
      }
      await syncTEMOPushSubscription(sub);
    }catch(e){console.warn('TEMO push subscription change sync failed:',e);}
  })());
});

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(clients => {
      for (const client of clients) {
        if ('focus' in client) {
          return client.focus();
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow('./');
      }
    })
  );
});

self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {
      title: '📖 TEMO',
      body: event.data ? event.data.text() : 'ახალი შეხსენება'
    };
  }

  const notification = data.notification || data;
  const title = notification.title || data.title || '📖 TEMO — ჩანაწერის შეხსენება';

  const options = {
    body: notification.body || data.body || 'შეხსენების დრო მოვიდა',
    icon: notification.icon || data.icon || './icon.png',
    badge: notification.badge || data.badge || './icon.png',
    tag: notification.tag || data.tag || 'temo-note-reminder',
    silent: notification.silent === true ? true : false,
    requireInteraction: notification.requireInteraction !== false,
    renotify: notification.renotify !== false,
    data: notification.navigate || data.url || './'
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});
