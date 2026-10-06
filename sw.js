/* الجمعية الصغيرة — Service Worker
   يجعل التطبيق قابلاً للتثبيت ويعمل واجهته دون اتصال. غيّر رقم الإصدار عند كل تحديث للملفات. */
const VERSION = 'jamiya-v4.3';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './favicon-32.png', './logo-full.jpg'];
// مصادر ثابتة من CDN نخزنها للتشغيل السريع ودون اتصال
const CDN_HOSTS = ['cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'www.gstatic.com', 'cdn.jsdelivr.net', 'www.svgrepo.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // الصفحات: الشبكة أولاً ثم النسخة المخزنة عند انقطاع الاتصال
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); return res;
    }).catch(() => caches.match('./index.html').then(r => r || caches.match('./'))));
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin || CDN_HOSTS.includes(url.hostname)) {
    // مخزن أولاً مع تحديث في الخلفية
    e.respondWith(caches.open(VERSION).then(cache => cache.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })));
  }
  // طلبات Firebase وغيرها تمر مباشرة للشبكة دون تخزين
});

// الضغط على إشعار النظام: يفتح التطبيق (وصفحة الجمعية إن وُجدت)
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const jid = e.notification.data && e.notification.data.jid;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list[0];
    if (c) { c.focus(); if (jid) c.postMessage({ type: 'open-jamiya', jid }); return; }
    return self.clients.openWindow('./');
  }));
});

// إشعارات الدفع من الخادم (FCM) تصل حتى والتطبيق مغلق
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (_) { d = { data: { body: e.data ? e.data.text() : '' } }; }
  const n = d.notification || {}, x = d.data || {};
  e.waitUntil(self.registration.showNotification(n.title || x.title || 'الجمعية الذكية', { body: n.body || x.body || '', icon: 'icon-192.png', badge: 'icon-192.png', lang: 'ar', dir: 'rtl', tag: x.tag || undefined, data: { jid: x.jid || '' } }));
});
