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
    }

    async init() {
        console.log('[WhatsApp Web Bot] Initializing WhatsApp Connection via QR Code...');

        if (!fs.existsSync(this.authFolder)) {
            fs.mkdirSync(this.authFolder, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);

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
                const shouldReconnect = (statusCode !== DisconnectReason.loggedOut && statusCode !== 401);
                console.log(`[WhatsApp Web Bot] Connection closed (code ${statusCode}). Reconnecting: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    await delay(3000);
                    this.init();
                }
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
                if (event.type !== 'notify') return;
                for (const m of event.messages) {
                    const text = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').trim();
                    if (!text) continue;

                    const senderJid = m.key.remoteJid;
                    const fromSelf = m.key.fromMe;

                    console.log(`[Baileys Inbound Message] From: ${senderJid} (Self: ${fromSelf}) -> "${text}"`);
                    await this.handleIncomingCommand(text, senderJid, fromSelf);
                }
            } catch (err) {
                console.error('[Baileys Inbound Error]:', err);
            }
        });
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
                                 (specifiedOrderId && (lowerText.includes('ok') || lowerText.includes('confirm')));

        if (isConfirmCommand) {
            let targetOrder = null;
            if (specifiedOrderId) {
                targetOrder = this.orderManager.getOrderById(specifiedOrderId);
            } else {
                const submitted = this.orderManager.getOrdersByStatus('PAYMENT_SUBMITTED');
                const awaiting = this.orderManager.getOrdersByStatus('AWAITING_PAYMENT');
                const pending = this.orderManager.getOrdersByStatus('PENDING_ACCOUNT');
                targetOrder = submitted[0] || awaiting[0] || pending[0];
            }

            if (!targetOrder) {
                console.log('[WhatsApp Command] No active order found to confirm.');
                await this.sendMessage(senderJid, 'ℹ️ No active order currently waiting for payment confirmation.');
                return;
            }

            this.orderManager.confirmOrder(targetOrder.id);
            console.log(`[WhatsApp Command Success] Order ${targetOrder.id} CONFIRMED via Baileys WhatsApp: "${text}"`);

            const replyMsg = `✅ PAYMENT CONFIRMED!\n\nOrder ID: ${targetOrder.id}\nTarget Model: ${targetOrder.model}\nAmount: ${targetOrder.totalPrice}\n\n🎉 Customer screen has been updated to the final Receipt Screen!`;
            await this.sendMessage(senderJid, replyMsg);
            return;
        }

        // 2. ASSIGN PAYMENT ADDRESS COMMAND (e.g. "pay@zelle.com", "$chimetag", "bc1q...", "UNL-123456 pay@zelle.com")
        if (text.length >= 3 && !lowerText.startsWith('http') && !lowerText.includes('someone wants')) {
            let paymentAddressText = text;
            if (specifiedOrderId) {
                paymentAddressText = text.replace(specifiedOrderId, '').trim();
            }

            let targetOrder = null;
            if (specifiedOrderId) {
                targetOrder = this.orderManager.getOrderById(specifiedOrderId);
            } else {
                const pendingAccountOrders = this.orderManager.getOrdersByStatus('PENDING_ACCOUNT');
                targetOrder = pendingAccountOrders[0];
            }

            if (targetOrder && paymentAddressText.length > 0) {
                this.orderManager.assignPaymentAccount(targetOrder.id, paymentAddressText);
                console.log(`[WhatsApp Command Success] Order ${targetOrder.id} ASSIGNED ACCOUNT via Baileys: "${paymentAddressText}"`);

                const replyMsg = `✅ PAYMENT ADDRESS ASSIGNED!\n\nOrder ID: ${targetOrder.id}\nAddress: ${paymentAddressText}\nMethod: ${targetOrder.paymentMethod}\n\n📲 Customer screen has been updated to show payment instructions!`;
                await this.sendMessage(senderJid, replyMsg);
            }
        }
    }

    async sendNotification(phone, messageText) {
        if (!this.isConnected || !this.sock) {
            console.log('[WhatsApp Web Bot] Bot not connected yet.');
            return false;
        }

        try {
            let cleanPhone = phone.replace(/[^0-9]/g, '');
            const jid = `${cleanPhone}@s.whatsapp.net`;
            console.log(`[WhatsApp Bot Dispatching] Sending alert to ${jid}...`);
            await this.sock.sendMessage(jid, { text: messageText });
            return true;
        } catch (err) {
            console.error('[WhatsApp Bot Send Error]:', err.message);
            return false;
        }
    }

    async sendMessage(jid, messageText) {
        if (this.sock && jid) {
            try {
                await this.sock.sendMessage(jid, { text: messageText });
            } catch (e) {
                console.error('[WhatsApp Send Message Error]:', e);
            }
        }
    }
}

module.exports = WhatsAppBot;
