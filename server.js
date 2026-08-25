const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const url = require('url');
const os = require('os');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'orders_db.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return 'localhost';
}

// Default Settings
let settings = {
    whatsappPhone: '+2348160491143',
    textMeBotApiKey: 'x1NzntWDTbyH',
    callMeBotApiKey: '',
    provider: 'textmebot',
    autoSendWhatsapp: true
};

if (fs.existsSync(SETTINGS_FILE)) {
    try {
        settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    } catch (e) {
        console.error('Error reading settings file:', e);
    }
}

function saveSettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    } catch (e) {}
}

// Order Store (In-Memory + File Fallback)
let orders = [];
if (fs.existsSync(DB_FILE)) {
    try {
        orders = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error('Error reading orders DB file:', e);
    }
}

function saveOrders() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2), 'utf8');
    } catch (e) {}
}

// Server-Sent Events (SSE) clients map: orderId -> array of res objects
const sseClients = new Map();

function broadcastOrderUpdate(order) {
    saveOrders();
    const clients = sseClients.get(order.id) || [];
    const payload = `data: ${JSON.stringify(order)}\n\n`;
    clients.forEach(res => {
        try {
            res.write(payload);
        } catch (e) {}
    });

    const adminClients = sseClients.get('ADMIN_ALL') || [];
    adminClients.forEach(res => {
        try {
            res.write(`data: ${JSON.stringify({ type: 'ORDER_UPDATE', order })}\n\n`);
        } catch (e) {}
    });
}

// Helper methods for Order Management
const orderManager = {
    getOrdersByStatus: (status) => orders.filter(o => o.status === status),
    getOrderById: (id) => orders.find(o => o.id === id),
    assignPaymentAccount: (orderId, paymentAddress) => {
        const order = orders.find(o => o.id === orderId);
        if (order) {
            order.paymentAddress = paymentAddress;
            order.status = 'AWAITING_PAYMENT';
            order.updatedAt = new Date().toISOString();
            broadcastOrderUpdate(order);
            console.log(`[Order Manager Success] Order ${orderId} assigned account: ${paymentAddress}`);
            return order;
        }
        return null;
    },
    confirmOrder: (orderId) => {
        const order = orders.find(o => o.id === orderId);
        if (order) {
            order.status = 'COMPLETED';
            order.updatedAt = new Date().toISOString();
            broadcastOrderUpdate(order);
            console.log(`[Order Manager Success] Order ${orderId} marked COMPLETED!`);
            return order;
        }
        return null;
    },
    rejectOrder: (orderId) => {
        const order = orders.find(o => o.id === orderId);
        if (order) {
            order.status = 'PAYMENT_FAILED';
            order.updatedAt = new Date().toISOString();
            broadcastOrderUpdate(order);
            console.log(`[Order Manager Success] Order ${orderId} marked PAYMENT_FAILED!`);
            return order;
        }
        return null;
    }
};

// Initialize WhatsApp Web Bot Engine (Pure QR Code Mode)
let whatsappBot = null;
try {
    const WhatsAppBot = require('./whatsapp_bot.js');
    whatsappBot = new WhatsAppBot(orderManager);
    whatsappBot.init().catch(err => console.error('[WhatsApp Bot Init Error]:', err.message));
} catch (e) {
    console.error('[WhatsApp Bot Module Error]:', e.message);
}

// Send WhatsApp Notification (Tries WhatsApp Web Bot first, falls back to TextMeBot)
async function sendWhatsappNotification(messageText) {
    if (!settings.whatsappPhone) {
        console.log('[WhatsApp Notification Skipped] No phone number.');
        return;
    }

    const cleanPhone = settings.whatsappPhone.trim();

    // 1. Try sending via WhatsApp Web Bot
    if (whatsappBot && whatsappBot.isConnected) {
        const sent = await whatsappBot.sendNotification(cleanPhone, messageText);
        if (sent) return;
    }

    // 2. Fallback to TextMeBot API (100% Reliable on Vercel)
    const encodedText = encodeURIComponent(messageText);
    const apiKey = settings.textMeBotApiKey || 'x1NzntWDTbyH';
    const formattedPhone = cleanPhone.startsWith('+') ? cleanPhone : '+' + cleanPhone.replace(/[^0-9]/g, '');
    const apiUrl = `https://api.textmebot.com/send.php?recipient=${encodeURIComponent(formattedPhone)}&apikey=${encodeURIComponent(apiKey)}&text=${encodedText}`;

    console.log(`[WhatsApp TextMeBot Dispatching] To: ${formattedPhone}...`);

    https.get(apiUrl, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
            console.log(`[WhatsApp TextMeBot Response] Code ${res.statusCode}: ${body.trim().substring(0, 150)}`);
        });
    }).on('error', (err) => {
        console.error('[WhatsApp Notification Error]:', err.message);
    });
}

// HTTP Server Request Handler
const requestHandler = (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const sendJSON = (data, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    };

    const parseBody = (callback) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const parsed = body ? JSON.parse(body) : {};
                callback(parsed);
            } catch (e) {
                sendJSON({ error: 'Invalid JSON body' }, 400);
            }
        });
    };

    // --- SSE Endpoint ---
    if (pathname.startsWith('/api/orders/') && pathname.endsWith('/stream')) {
        const parts = pathname.split('/');
        const orderId = parts[3];

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        res.write('\n');

        if (!sseClients.has(orderId)) {
            sseClients.set(orderId, []);
        }
        sseClients.get(orderId).push(res);

        req.on('close', () => {
            const list = sseClients.get(orderId) || [];
            sseClients.set(orderId, list.filter(r => r !== res));
        });

        if (orderId === 'ADMIN_ALL') {
            res.write(`data: ${JSON.stringify({ type: 'INIT', orders })}\n\n`);
        } else {
            const existing = orders.find(o => o.id === orderId);
            if (existing) {
                res.write(`data: ${JSON.stringify(existing)}\n\n`);
            }
        }
        return;
    }

    // --- REST API Endpoints ---
    if (pathname === '/api/orders' && method === 'GET') {
        return sendJSON(orders);
    }

    // --- PWA Web App Manifest ---
    if (pathname === '/manifest.json' && method === 'GET') {
        const manifest = {
            name: "Global Unlock Admin Command Center",
            short_name: "UnlockAdmin",
            description: "Mobile Admin Command Center for Global Device Unlock",
            start_url: "/admin",
            display: "standalone",
            orientation: "portrait",
            background_color: "#0f1117",
            theme_color: "#0f1117",
            icons: [
                {
                    src: "/api/app-icon",
                    sizes: "192x192",
                    type: "image/png",
                    purpose: "any maskable"
                },
                {
                    src: "/api/app-icon",
                    sizes: "512x512",
                    type: "image/png",
                    purpose: "any maskable"
                }
            ]
        };
        res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
        res.end(JSON.stringify(manifest, null, 2));
        return;
    }

    // --- Mobile Access Info Endpoint (LAN IP & Direct URLs) ---
    if (pathname === '/api/mobile-info' && method === 'GET') {
        const localIp = getLocalIpAddress();
        return sendJSON({
            localIp,
            port: PORT,
            mobileAdminUrl: `http://${localIp}:${PORT}/admin`,
            mobileClientUrl: `http://${localIp}:${PORT}`
        });
    }

    // --- QR Code to Open Admin on Mobile Device (Camera Scan) ---
    if (pathname === '/api/mobile-admin-qr' && method === 'GET') {
        const localIp = getLocalIpAddress();
        const mobileAdminUrl = `http://${localIp}:${PORT}/admin`;
        QRCode.toBuffer(mobileAdminUrl, { type: 'png', width: 300, margin: 2 }, (err, buffer) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Mobile QR generation failed' }));
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'image/png',
                'Cache-Control': 'no-cache, no-store'
            });
            res.end(buffer);
        });
        return;
    }

    // --- App Icon Endpoint ---
    if (pathname === '/api/app-icon' && method === 'GET') {
        const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
            <rect width="512" height="512" rx="120" fill="#0f1117"/>
            <rect x="32" y="32" width="448" height="448" rx="100" fill="#1a1d26" stroke="#2a2e3d" stroke-width="8"/>
            <circle cx="256" cy="256" r="140" fill="none" stroke="#0071e3" stroke-width="24"/>
            <path d="M256 160v192M160 256h192" stroke="#34c759" stroke-width="24" stroke-linecap="round"/>
            <circle cx="256" cy="256" r="40" fill="#0071e3"/>
        </svg>`;
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end(iconSvg);
        return;
    }

    // --- QR Code Image Endpoint (serves local PNG, no external API) ---
    if (pathname === '/api/qr-image' && method === 'GET') {
        const qrData = whatsappBot ? whatsappBot.qrCodeData : null;
        if (!qrData) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No QR code available' }));
            return;
        }
        QRCode.toBuffer(qrData, { type: 'png', width: 300, margin: 2 }, (err, buffer) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'QR generation failed' }));
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'image/png',
                'Cache-Control': 'no-cache, no-store'
            });
            res.end(buffer);
        });
        return;
    }

    if (pathname === '/api/settings' && method === 'GET') {
        return sendJSON({
            ...settings,
            botConnected: whatsappBot ? whatsappBot.isConnected : false,
            botQr: whatsappBot ? whatsappBot.qrCodeData : null
        });
    }

    if (pathname === '/api/settings' && method === 'POST') {
        return parseBody(body => {
            if (body.whatsappPhone !== undefined) settings.whatsappPhone = body.whatsappPhone;
            if (body.textMeBotApiKey !== undefined) settings.textMeBotApiKey = body.textMeBotApiKey;
            if (body.callMeBotApiKey !== undefined) settings.callMeBotApiKey = body.callMeBotApiKey;
            if (body.provider !== undefined) settings.provider = body.provider;
            if (body.autoSendWhatsapp !== undefined) settings.autoSendWhatsapp = body.autoSendWhatsapp;
            saveSettings();
            sendJSON({ success: true, settings });
        });
    }

    // --- WEBHOOK FOR WHATSAPP INBOUND COMMANDS ---
    if (pathname === '/api/webhook') {
        const textParam = parsedUrl.query.text || parsedUrl.query.message || parsedUrl.query.body;
        if (textParam && whatsappBot) {
            console.log(`[HTTP Webhook Inbound Command]: "${textParam}"`);
            whatsappBot.handleIncomingCommand(textParam, 'HTTP_WEBHOOK', false);
            return sendJSON({ success: true, message: 'Command processed via Webhook' });
        }
        return parseBody(body => {
            const text = body.text || body.message || body.body || '';
            if (text && whatsappBot) {
                console.log(`[HTTP Webhook Inbound Command]: "${text}"`);
                whatsappBot.handleIncomingCommand(text, 'HTTP_WEBHOOK', false);
                return sendJSON({ success: true, message: 'Command processed via Webhook' });
            }
            sendJSON({ error: 'No text parameter provided' }, 400);
        });
    }

    // CREATE OR RETRY ORDER (STAGE 1: TRIGGERED WHEN USER CLICKS PAYMENT METHOD BUTTON)
    if (pathname === '/api/orders' && method === 'POST') {
        return parseBody(orderData => {
            const orderId = orderData.id || ('UNL-' + Math.floor(100000 + Math.random() * 900000));
            let targetOrder = orders.find(o => o.id === orderId);

            if (targetOrder) {
                targetOrder.country = orderData.country || targetOrder.country;
                targetOrder.activeDevice = orderData.activeDevice || targetOrder.activeDevice;
                targetOrder.service = orderData.service || targetOrder.service;
                targetOrder.model = orderData.model || targetOrder.model;
                targetOrder.identifier = orderData.identifier || targetOrder.identifier;
                targetOrder.email = orderData.email || targetOrder.email;
                targetOrder.totalPrice = orderData.totalPrice || targetOrder.totalPrice;
                targetOrder.paymentMethod = orderData.paymentMethod || targetOrder.paymentMethod;
                targetOrder.paymentAddress = '';
                targetOrder.status = 'PENDING_ACCOUNT';
                targetOrder.updatedAt = new Date().toISOString();
            } else {
                targetOrder = {
                    id: orderId,
                    country: orderData.country || 'Unknown',
                    activeDevice: orderData.activeDevice || 'Unknown',
                    service: orderData.service || 'Unknown',
                    model: orderData.model || 'Unknown',
                    identifier: orderData.identifier || 'Unknown',
                    email: orderData.email || 'Unknown',
                    totalPrice: orderData.totalPrice || '$0.00',
                    paymentMethod: orderData.paymentMethod || 'Bitcoin',
                    paymentAddress: '',
                    status: 'PENDING_ACCOUNT',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                orders.unshift(targetOrder);
            }

            broadcastOrderUpdate(targetOrder);

            // First Notification: Sent when user selects payment method button
            const alertText = `someone wants to do a transaction\n\n` +
                `Order ID: ${targetOrder.id}\n` +
                `Country: ${targetOrder.country}\n` +
                `Current Device: ${targetOrder.activeDevice}\n` +
                `Target Model: ${targetOrder.model}\n` +
                `Service: ${targetOrder.service}\n` +
                `IMEI/Serial: ${targetOrder.identifier}\n` +
                `Payment Method: ${targetOrder.paymentMethod}\n` +
                `Total Amount: ${targetOrder.totalPrice}\n` +
                `Customer Email: ${targetOrder.email}\n\n` +
                `👉 REPLY ON WHATSAPP WITH PAYMENT DETAILS (e.g. pay@zelle.com or ${targetOrder.id} pay@zelle.com)`;

            if (settings.autoSendWhatsapp) {
                sendWhatsappNotification(alertText);
            }

            sendJSON({ success: true, order: targetOrder });
        });
    }

    // ADMIN ASSIGN PAYMENT ACCOUNT (STAGE 2 -> AWAITING_PAYMENT)
    if (pathname.match(/\/api\/orders\/[^\/]+\/assign-payment$/) && method === 'POST') {
        const orderId = pathname.split('/')[3];
        return parseBody(body => {
            const order = orderManager.assignPaymentAccount(orderId, body.paymentAddress);
            if (!order) return sendJSON({ error: 'Order not found' }, 404);
            sendJSON({ success: true, order });
        });
    }

    // CLIENT MARK AS PAID (STAGE 3 -> PAYMENT_SUBMITTED + SECOND NOTIFICATION)
    if (pathname.match(/\/api\/orders\/[^\/]+\/mark-paid$/) && method === 'POST') {
        const orderId = pathname.split('/')[3];
        return parseBody(body => {
            const order = orders.find(o => o.id === orderId);
            if (!order) return sendJSON({ error: 'Order not found' }, 404);

            order.status = 'PAYMENT_SUBMITTED';
            order.updatedAt = new Date().toISOString();

            broadcastOrderUpdate(order);

            // Second Notification: "confirm payment now"
            const alertText = `confirm payment now\n\n` +
                `Order ID: ${order.id}\n` +
                `Target Model: ${order.model}\n` +
                `Paid: ${order.totalPrice} via ${order.paymentMethod}\n` +
                `Account Used: ${order.paymentAddress}\n` +
                `Customer Email: ${order.email}\n\n` +
                `👉 REPLY "ok" OR "confirm" TO APPROVE, OR "no" TO REJECT!`;

            if (settings.autoSendWhatsapp) {
                sendWhatsappNotification(alertText);
            }

            sendJSON({ success: true, order });
        });
    }

    // ADMIN CONFIRM PAYMENT (STAGE 4 -> COMPLETED)
    if (pathname.match(/\/api\/orders\/[^\/]+\/confirm$/) && method === 'POST') {
        const orderId = pathname.split('/')[3];
        return parseBody(body => {
            const order = orderManager.confirmOrder(orderId);
            if (!order) return sendJSON({ error: 'Order not found' }, 404);
            sendJSON({ success: true, order });
        });
    }

    // ADMIN REJECT PAYMENT (STAGE -> PAYMENT_FAILED)
    if (pathname.match(/\/api\/orders\/[^\/]+\/reject$/) && method === 'POST') {
        const orderId = pathname.split('/')[3];
        return parseBody(body => {
            const order = orderManager.rejectOrder(orderId);
            if (!order) return sendJSON({ error: 'Order not found' }, 404);
            sendJSON({ success: true, order });
        });
    }

    // RETRY ORDER (Customer clicked "Try Again" — reset to PENDING_ACCOUNT so admin knows)
    if (pathname.match(/\/api\/orders\/[^\/]+\/retry$/) && method === 'POST') {
        const orderId = pathname.split('/')[3];
        const order = orders.find(o => o.id === orderId);
        if (!order) return sendJSON({ error: 'Order not found' }, 404);
        order.status = 'PENDING_ACCOUNT';
        order.paymentAddress = null;
        order.paymentMethod = null;
        order.updatedAt = new Date().toISOString();
        broadcastOrderUpdate(order);
        console.log(`[Order Manager] Order ${orderId} reset to PENDING_ACCOUNT (customer retrying)`);
        return sendJSON({ success: true, order });
    }
    // DELETE ORDER API
    if (pathname.match(/\/api\/orders\/[^\/]+$/) && method === 'DELETE') {
        const orderId = pathname.split('/')[3];
        orders = orders.filter(o => o.id !== orderId);
        saveOrders();
        
        const adminClients = sseClients.get('ADMIN_ALL') || [];
        adminClients.forEach(res => {
            try {
                res.write(`data: ${JSON.stringify({ type: 'ORDER_DELETED', orderId })}\n\n`);
            } catch (e) {}
        });

        return sendJSON({ success: true });
    }

    // MANUAL TEST WHATSAPP API
    if (pathname === '/api/test-whatsapp' && method === 'POST') {
        return parseBody(body => {
            const testMsg = body.message || 'someone wants to do a transaction';
            sendWhatsappNotification(testMsg);
            sendJSON({ success: true, message: 'Test notification triggered' });
        });
    }

    // --- STATIC FILE SERVING ---
    let filePath = '.';
    if (pathname === '/' || pathname === '/index.html') {
        filePath = './Untitled-2.html';
    } else if (pathname === '/admin' || pathname === '/admin.html') {
        filePath = './admin.html';
    } else {
        filePath = '.' + pathname;
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.svg': 'image/svg+xml'
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 Not Found</h1>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end('Sorry, check with the site admin for error: ' + error.code + ' ..\n');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
};

const server = http.createServer(requestHandler);

if (require.main === module) {
    server.listen(PORT, '0.0.0.0', () => {
        const localIp = getLocalIpAddress();
        console.log(`=======================================================`);
        console.log(`🚀 Global Unlock Server is live on http://localhost:${PORT}`);
        console.log(`📱 Client URL: http://localhost:${PORT}`);
        console.log(`⚙️ Admin Dashboard URL: http://localhost:${PORT}/admin`);
        console.log(`📲 Mobile Phone Access (iOS/Android): http://${localIp}:${PORT}/admin`);
        console.log(`💬 Configured WhatsApp Provider: Auto-Connecting WhatsApp Web Bot (QR Mode)`);
        console.log(`=======================================================`);
    });
}

module.exports = requestHandler;
