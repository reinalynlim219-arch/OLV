const CACHE_NAME = 'olv-operations-v127';
const APP_SHELL = [
    '/',
    '/login',
    '/offline.html',
    '/manifest.webmanifest',
    '/vendor/bootstrap/bootstrap.min.css',
    '/vendor/bootstrap/bootstrap.bundle.min.js',
    '/vendor/bootstrap-icons/bootstrap-icons.min.css',
    '/vendor/bootstrap-icons/fonts/bootstrap-icons.woff2',
    '/images/icon.svg',
    '/images/icon-192.png',
    '/images/icon-512.png',
    '/css/style.css',
    '/css/theme.css',
    '/css/topbar.css',
    '/css/pages.css',
    '/css/customers.css',
    '/css/deliveries.css',
    '/js/pwa.js',
    '/js/theme.js',
    '/js/mobile-nav.js',
    '/js/topbar.js',
    '/js/sidebar.js',
    '/js/nav-flyout.js',
    '/js/dashboard.js',
    '/js/customers.js',
    '/js/deliveries.js',
    '/js/delivery-plan.js',
    '/js/table-cards.js',
    '/js/orders.js',
    '/js/reports.js',
    '/js/xlsx-report.js',
    '/js/scripts.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const requestUrl = new URL(event.request.url);
    if (requestUrl.origin !== self.location.origin) return;
    if (requestUrl.pathname === '/api/customer/delivery/photo') {
        event.respondWith(fetch(event.request, { cache: 'no-store' }));
        return;
    }

    if (requestUrl.pathname.startsWith('/api/')) {
        event.respondWith(fetch(event.request, { cache: 'no-store' }));
        return;
    }

    event.respondWith(networkFirst(event.request));
});

async function networkFirst(request) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        const cached = await caches.match(request);
        return cached || caches.match('/offline.html');
    }
}
