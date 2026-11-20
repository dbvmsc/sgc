// SGC — service worker: guarda a aplicação no telemóvel (sem rede) e mostra as notificações push.
const V = '1.7.0';                       // igual ao ?v= do index.html
const VERSAO = 'sgc-v' + V;
const BASE = ['/', '/index.html', '/app.js?v=' + V, '/app.css?v=' + V, '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/logo.png', '/icons/favicon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSAO).then(c => c.addAll(BASE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api')) return;
  // Rede primeiro (para receber actualizações); sem rede, usa a cópia guardada.
  const nav = e.request.mode === 'navigate';
  const pedido = nav ? e.request : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(fetch(pedido).then(r => {
    if (r.ok) { const copia = r.clone(); caches.open(VERSAO).then(c => c.put(nav ? '/' : e.request, copia)); }
    return r;
  }).catch(() => caches.match(nav ? '/' : e.request, { ignoreSearch: false }).then(r => r || (nav ? caches.match('/index.html') : Response.error()))));
});

/* ---- push: o aviso chega sem texto; vamos buscar as notificações novas com a sessão guardada ---- */
function lerToken() {
  return new Promise(ok => { const r = indexedDB.open('sgc', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { try { const g = r.result.transaction('kv').objectStore('kv').get('token'); g.onsuccess = () => ok(g.result || null); g.onerror = () => ok(null); } catch (e) { ok(null); } };
    r.onerror = () => ok(null); });
}
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    const opc = { icon: '/icons/icon-192.png', badge: '/icons/favicon.png', data: { aba: '' } };
    const token = await lerToken();
    if (token) {
      try {
        const r = await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ accao: 'notificacoes', p: {} }) });
        const d = await r.json();
        if (d.ok) {
          const novas = d.dados.lista.filter(n => n.nova).slice(0, 3);
          if (self.navigator.setAppBadge && d.dados.novas) self.navigator.setAppBadge(d.dados.novas).catch(() => {});
          if (novas.length) {
            for (const n of novas) await self.registration.showNotification(n.titulo, Object.assign({}, opc, { body: n.texto || '', tag: n.id, data: { aba: n.aba || '' } }));
            return;
          }
        }
      } catch (err) {}
    }
    await self.registration.showNotification('SGC Desbravadores MSC', Object.assign({}, opc, { body: 'Tem novidades no SGC.', tag: 'sgc' }));
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const alvo = '/?aba=' + encodeURIComponent((e.notification.data && e.notification.data.aba) || 'painel');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) if (c.url.startsWith(self.location.origin)) { c.navigate(alvo).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(alvo);
  }));
});
