const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const qrcodeTerminal = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

class WhatsAppBot {
    constructor(orderManager) {
        this.orderManager = orderManager;
        this.sock = null;
        this.qrCodeData = null;
        this.isConnected = false;
        this.authFolder = path.join(__dirname, 'baileys_auth_info');
        this.recentlySentMessages = new Set();
    }

    getPublicBaseUrl() {
        if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
        if (process.env.BASE_URL) return process.env.BASE_URL;
        return 'https://icloud-o62c.onrender.com';
    }

    registerSentMessage(text) {
        if (!text) return;
        const clean = text.trim();
        this.recentlySentMessages.add(clean);
        setTimeout(() => {
            this.recentlySentMessages.delete(clean);
        }, 120000);
    }

    async init() {
        console.log('[WhatsApp Web Bot] Initializing WhatsApp Connection via QR Code...');

        if (!fs.existsSync(this.authFolder)) {
            fs.mkdirSync(this.authFolder, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);

        if (this.sock) {
            try { this.sock.ev.removeAllListeners(); } catch (e) {}
            try { this.sock.ws?.close(); } catch (e) {}
            try { this.sock.end(); } catch (e) {}
            this.sock = null;
        }

        this.sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            browser: ['GlobalUnlockBot', 'Chrome', '120.0.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.qrCodeData = qr;
                console.log('\n=======================================================');
                console.log('📲 SCAN THIS QR CODE WITH WHATSAPP ON YOUR PHONE:');
                console.log('=======================================================');
                qrcodeTerminal.generate(qr, { small: true });
                console.log('=======================================================');
                console.log('Or view QR code on Admin Dashboard: http://localhost:3000/admin\n');
            }

            if (connection === 'close') {
                this.isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = (statusCode === DisconnectReason.loggedOut || statusCode === 401);
                console.log(`[WhatsApp Web Bot] Connection closed (code ${statusCode}). Logged out: ${isLoggedOut}`);
                
                if (this.sock) {
                    try { this.sock.ev.removeAllListeners(); } catch (e) {}
                    try { this.sock.ws?.close(); } catch (e) {}
                    try { this.sock.end(); } catch (e) {}
                    this.sock = null;
                }

                if (isLoggedOut) {
                    console.log('[WhatsApp Web Bot] Session expired or logged out. Cleaning old session to generate fresh QR...');
                    try {
                        if (fs.existsSync(this.authFolder)) {
                            fs.rmSync(this.authFolder, { recursive: true, force: true });
                        }
                    } catch (e) {}
                }

                await delay(3000);
                this.init();
            } else if (connection === 'open') {
                this.isConnected = true;
                this.qrCodeData = null;
                console.log('\n=======================================================');
                console.log('✅ WHATSAPP WEB BOT CONNECTED & READY!');
                console.log('📱 You can now receive alerts and reply with commands directly on WhatsApp!');
                console.log('=======================================================\n');
            }
        });

        // Listen for Inbound WhatsApp Messages (Two-Way Command Engine)
        this.sock.ev.on('messages.upsert', async (event) => {
            try {
                if (event.type !== 'notify' && event.type !== 'append') return;

                for (const m of event.messages) {
                    const text = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').trim();
                    if (!text) continue;

                    const senderJid = m.key.remoteJid;
                    const fromSelf = m.key.fromMe;
                    const participant = m.key.participant;

                    // 1. ECHO & SELF-LOOP PREVENTION FILTER (100% Guaranteed)
                    if (this.recentlySentMessages.has(text) ||
                        text.startsWith('someone wants to do a transaction') || 
                        text.startsWith('confirm payment now') || 
                        text.startsWith('⚠️') ||
                        text.startsWith('✅') || 
                        text.startsWith('❌') || 
                        text.startsWith('ℹ️') ||
                        text.startsWith('📋') ||
                        text.includes('Please use the *Admin Dashboard*') ||
                        text.includes('http://localhost:3000/admin')) {
                        console.log(`[WhatsApp Echo Filter] Skipping bot notification/response: "${text.substring(0, 40)}..."`);
                        continue;
                    }

                    // 2. AUTHORIZATION CHECK
                    const isAuthorized = this.isAuthorizedSender(senderJid, fromSelf, participant);
                    if (!isAuthorized) {
                        console.log(`[WhatsApp Security] ⛔ STRICT LOCK: Ignored message from unauthorized sender: ${senderJid} (fromMe: ${fromSelf})`);
                        continue;
                    }

                    console.log(`[WhatsApp Instruction Received] From: ${senderJid} (fromMe: ${fromSelf}) -> "${text}"`);
                    await this.handleIncomingCommand(text, senderJid, fromSelf);
                }
            } catch (err) {
                console.error('[Baileys Inbound Error]:', err);
            }
        });
    }

    isAuthorizedSender(senderJid, fromMe, participant) {
        if (senderJid === 'HTTP_WEBHOOK') return true;

        const AUTHORIZED_PHONE = '2348160491143';
        const AUTHORIZED_LID = '159880744812614'; // LID for 08160491143

        const checkSingleJid = (jid) => {
            if (!jid) return false;
            const pureNumber = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
            if (pureNumber === AUTHORIZED_PHONE || pureNumber === AUTHORIZED_LID) return true;

            // If sender is LID, check reverse LID mapping file
            if (jid.includes('@lid')) {
                const lidId = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                if (lidId === AUTHORIZED_LID) return true;

                const mappingFile = path.join(this.authFolder, `lid-mapping-${lidId}_reverse.json`);
                if (fs.existsSync(mappingFile)) {
                    try {
                        const mappedPhone = JSON.parse(fs.readFileSync(mappingFile, 'utf8')).replace(/[^0-9]/g, '');
                        if (mappedPhone === AUTHORIZED_PHONE) return true;
                    } catch (e) {}
                }
            }
            return false;
        };

        if (fromMe) {
            const myJid = this.sock?.user?.id || '';
            const myLid = this.sock?.user?.lid || '';
            const cleanMyNumber = myJid.split(':')[0].replace(/[^0-9]/g, '');
            const cleanMyLid = myLid.split(':')[0].replace(/[^0-9]/g, '');
            if (cleanMyNumber === AUTHORIZED_PHONE || cleanMyLid === AUTHORIZED_LID) {
                return true;
            }
        }

        if (checkSingleJid(senderJid)) return true;
        if (participant && checkSingleJid(participant)) return true;

        return false;
    }

    async handleIncomingCommand(text, senderJid, fromMe) {
        const lowerText = text.toLowerCase().trim();

        const orderIdMatch = text.match(/UNL-\d{6}/i);
        const specifiedOrderId = orderIdMatch ? orderIdMatch[0].toUpperCase() : null;

        // 1. CONFIRMATION COMMANDS ("ok", "confirm", "yes", "approved", "done", "paid")
        const isConfirmCommand = lowerText === 'ok' ||
                                 lowerText === 'confirm' ||
                                 lowerText === 'yes' ||
                                 lowerText === 'approved' ||
                                 lowerText === 'done' ||
                                 lowerText === 'paid' ||
                                 lowerText.includes('confirm payment') ||
                                 (specifiedOrderId && (lowerText.includes('ok') || lowerText.includes('confirm') || lowerText.includes('yes') || lowerText.includes('paid')));

        if (isConfirmCommand) {
            const submittedOrders = this.orderManager.getOrdersByStatus('PAYMENT_SUBMITTED');
            let targetOrder = null;

            if (specifiedOrderId) {
                targetOrder = this.orderManager.getOrderById(specifiedOrderId);
            } else if (submittedOrders.length === 1) {
                targetOrder = submittedOrders[0];
            } else if (submittedOrders.length > 1) {
                const list = submittedOrders.map((o, i) => `${i + 1}. ${o.id} — ${o.model} (${o.totalPrice})`).join('\n');
                const msg = `⚠️ *${submittedOrders.length} orders* are awaiting confirmation:\n\n${list}\n\n` +
                            `Please use the *Admin Dashboard* to confirm them:\n👉 ${this.getPublicBaseUrl()}/admin`;
                await this.sendMessage(senderJid, msg);
                return;
            } else {
                // Fallback to any active order if only 1 exists
                const awaiting = this.orderManager.getOrdersByStatus('AWAITING_PAYMENT');
                const pending = this.orderManager.getOrdersByStatus('PENDING_ACCOUNT');
                const all = [...awaiting, ...pending];
                if (all.length === 1) targetOrder = all[0];
            }

            if (!targetOrder) {
                await this.sendMessage(senderJid, 'ℹ️ No active order currently waiting for payment confirmation.');
                return;
            }

            this.orderManager.confirmOrder(targetOrder.id);
            console.log(`[WhatsApp Command Success] Order ${targetOrder.id} CONFIRMED via WhatsApp: "${text}"`);
            await this.sendMessage(senderJid,
                `✅ *PAYMENT CONFIRMED!*\n\nOrder ID: ${targetOrder.id}\nModel: ${targetOrder.model}\nAmount: ${targetOrder.totalPrice}\n\n🎉 Customer screen updated to Receipt!`);
            return;
        }

        // 2. REJECTION COMMANDS ("no", "reject", "declined", "failed", "cancel")
        const isRejectCommand = lowerText === 'no' ||
                                lowerText === 'reject' ||
                                lowerText === 'declined' ||
                                lowerText === 'failed' ||
                                lowerText === 'cancel' ||
                                lowerText === 'invalid' ||
                                lowerText.includes('not paid') ||
                                (specifiedOrderId && (lowerText.includes('no') || lowerText.includes('reject') || lowerText.includes('declined') || lowerText.includes('cancel') || lowerText.includes('failed')));

        if (isRejectCommand) {
            const submittedOrders = this.orderManager.getOrdersByStatus('PAYMENT_SUBMITTED');
            let targetOrder = null;

            if (specifiedOrderId) {
                targetOrder = this.orderManager.getOrderById(specifiedOrderId);
            } else if (submittedOrders.length === 1) {
                targetOrder = submittedOrders[0];
            } else if (submittedOrders.length > 1) {
                const list = submittedOrders.map((o, i) => `${i + 1}. ${o.id} — ${o.model} (${o.totalPrice})`).join('\n');
                const msg = `⚠️ *${submittedOrders.length} orders* are active:\n\n${list}\n\n` +
                            `Please use the *Admin Dashboard* to reject/manage them:\n👉 ${this.getPublicBaseUrl()}/admin`;
                await this.sendMessage(senderJid, msg);
                return;
            } else {
                const awaiting = this.orderManager.getOrdersByStatus('AWAITING_PAYMENT');
                const pending = this.orderManager.getOrdersByStatus('PENDING_ACCOUNT');
                const all = [...awaiting, ...pending];
                if (all.length === 1) targetOrder = all[0];
            }

            if (!targetOrder) {
                await this.sendMessage(senderJid, 'ℹ️ No active order to reject.');
                return;
            }

            this.orderManager.rejectOrder(targetOrder.id);
            console.log(`[WhatsApp Command Success] Order ${targetOrder.id} REJECTED via WhatsApp: "${text}"`);
            await this.sendMessage(senderJid,
                `❌ *PAYMENT REJECTED!*\n\nOrder ID: ${targetOrder.id}\nModel: ${targetOrder.model}\nAmount: ${targetOrder.totalPrice}\n\n📲 Customer shown "Payment was not successful" with Try Again button.`);
            return;
        }

        // 3. ASSIGN PAYMENT ADDRESS (any text like "pay@zelle.com", "$chimetag", "bc1q...", or random text)
        if (text.length >= 3 && !lowerText.startsWith('http')) {
            const pendingOrders = this.orderManager.getOrdersByStatus('PENDING_ACCOUNT');
            let targetOrder = null;

            if (specifiedOrderId) {
                targetOrder = this.orderManager.getOrderById(specifiedOrderId);
            } else if (pendingOrders.length === 1) {
                targetOrder = pendingOrders[0];
            } else if (pendingOrders.length > 1) {
                const list = pendingOrders.map((o, i) => `${i + 1}. ${o.id} — ${o.model} (${o.totalPrice})`).join('\n');
                const msg = `⚠️ *${pendingOrders.length} orders* are waiting for payment addresses:\n\n${list}\n\n` +
                            `Please use the *Admin Dashboard* to assign details:\n👉 ${this.getPublicBaseUrl()}/admin`;
                await this.sendMessage(senderJid, msg);
                return;
            }

            if (!targetOrder) {
                console.log(`[WhatsApp Inbound] No pending order found waiting for account address for text: "${text}"`);
                return;
            }

            const paymentAddressText = specifiedOrderId
                ? text.replace(new RegExp(specifiedOrderId, 'i'), '').trim()
                : text;

            if (paymentAddressText.length > 0) {
                this.orderManager.assignPaymentAccount(targetOrder.id, paymentAddressText);
                console.log(`[WhatsApp Command Success] Order ${targetOrder.id} ASSIGNED ACCOUNT via WhatsApp: "${paymentAddressText}"`);
                await this.sendMessage(senderJid,
                    `✅ *PAYMENT ADDRESS ASSIGNED!*\n\nOrder ID: ${targetOrder.id}\nAddress: ${paymentAddressText}\nMethod: ${targetOrder.paymentMethod}\n\n📲 Customer screen updated with payment instructions!`);
            }
        }
    }

    async sendNotification(phone, messageText) {
        if (!this.isConnected || !this.sock) {
            console.log('[WhatsApp Web Bot] Bot not connected yet.');
            return false;
        }

        // STRICT NOTIFICATION ROUTING: Send to +2349076042815
        const cleanPhone = (phone ? phone.replace(/[^0-9]/g, '') : '2349076042815') || '2349076042815';

        try {
            const jid = `${cleanPhone}@s.whatsapp.net`;
            console.log(`[WhatsApp Bot Dispatching] Sending alert strictly to authorized admin: ${jid}...`);
            this.registerSentMessage(messageText);
            await this.sock.sendMessage(jid, { text: messageText });
            return true;
        } catch (err) {
            console.error('[WhatsApp Bot Send Error]:', err.message);
            return false;
        }
    }

    async sendMessage(jid, messageText) {
        if (this.sock) {
            try {
                const targetJid = jid || `2349076042815@s.whatsapp.net`;
                this.registerSentMessage(messageText);
                await this.sock.sendMessage(targetJid, { text: messageText });
            } catch (e) {
                console.error('[WhatsApp Send Message Error]:', e);
            }
        }
    }
}

module.exports = WhatsAppBot;
