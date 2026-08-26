// Service Worker for Global Unlock Admin Lock-Screen Push Notifications
const CACHE_NAME = 'unlock-admin-v1';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// BACKGROUND LOCK-SCREEN PUSH HANDLER
self.addEventListener('push', (event) => {
    let payload = {
        title: '🔔 Customer Order Alert',
        body: 'New customer activity detected on portal.',
        orderId: 'ALERT-' + Date.now(),
        url: '/admin'
    };

    if (event.data) {
        try {
            payload = event.data.json();
        } catch (e) {
            payload.body = event.data.text();
        }
    }

    const options = {
        body: payload.body,
        icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"%3E%3Crect width="192" height="192" rx="40" fill="%230071e3"/%3E%3Ctext x="96" y="125" font-size="90" text-anchor="middle" fill="%23ffffff"%3E🧬%3C/text%3E%3C/svg%3E',
        badge: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"%3E%3Ccircle cx="96" cy="96" r="90" fill="%230071e3"/%3E%3Ctext x="96" y="125" font-size="90" text-anchor="middle" fill="%23ffffff"%3E🧬%3C/text%3E%3C/svg%3E',
        vibrate: [300, 150, 300, 150, 400],
        tag: 'order-alert-' + (payload.orderId || Date.now()),
        renotify: true,
        requireInteraction: true,
        data: {
            url: payload.url || '/admin',
            orderId: payload.orderId
        },
        actions: [
            { action: 'open', title: '👁️ Open Dashboard' }
        ]
    };

    event.waitUntil(
        self.registration.showNotification(payload.title, options)
    );
});

// NOTIFICATION TAP HANDLER
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || '/admin';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (let client of clientList) {
                if (client.url.includes('/admin') && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});
