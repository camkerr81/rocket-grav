const BaseAdapter = require('./BaseAdapter');

/**
 * Splits long text into chunks that fit within Rocket.Chat's message size limit.
 * Rocket.Chat default limit is typically 5,000 characters. We use 3,800 for safety margin.
 */
function splitMessageText(text, maxLen = 3800) {
    if (!text || text.length <= maxLen) return [text || ''];
    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
        if (splitIdx === -1 || splitIdx < maxLen / 2) {
            splitIdx = remaining.lastIndexOf('\n', maxLen);
        }
        if (splitIdx === -1 || splitIdx < maxLen / 3) {
            splitIdx = remaining.lastIndexOf(' ', maxLen);
        }
        if (splitIdx === -1) {
            splitIdx = maxLen;
        }
        chunks.push(remaining.substring(0, splitIdx).trim());
        remaining = remaining.substring(splitIdx).trim();
    }
    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
}

class RocketChatAdapter extends BaseAdapter {
    constructor() {
        super('rocketchat');
        this.url = process.env.ROCKETCHAT_URL || 'http://192.168.8.177:3100';
        this.userId = process.env.ROCKETCHAT_USER_ID;
        this.pat = process.env.ROCKETCHAT_PAT;
        this.token = process.env.ROCKETCHAT_TOKEN;
        this.botAlias = process.env.BOT_NAME || 'MangoBot';
    }

    verifyRequest(req) {
        const providedToken = req.body && req.body.token;
        if (!this.token) {
            console.warn('[RocketChatAdapter] Warning: ROCKETCHAT_TOKEN is not set.');
            return false;
        }
        return providedToken === this.token;
    }

    extractPayload(req) {
        return {
            text: (req.body && req.body.text) || '',
            roomId: req.body && req.body.channel_id,
            tmid: (req.body && req.body.tmid) || null,
            userId: req.body && req.body.user_id
        };
    }

    async postMessage(roomId, tmid, text, attachments = null) {
        if (!this.userId || !this.pat) {
            console.warn('[RocketChatAdapter] Missing API credentials (ROCKETCHAT_USER_ID or ROCKETCHAT_PAT).');
            return null;
        }

        const chunks = splitMessageText(text, 3800);
        let firstMsgId = null;

        for (let i = 0; i < chunks.length; i++) {
            const chunkText = chunks[i];
            const isLast = (i === chunks.length - 1);
            const payload = { roomId, text: chunkText, alias: this.botAlias };
            if (tmid) payload.tmid = tmid;
            if (isLast && Array.isArray(attachments) && attachments.length > 0) {
                payload.attachments = attachments;
            }

            try {
                const response = await fetch(`${this.url}/api/v1/chat.postMessage`, {
                    method: 'POST',
                    headers: {
                        'X-Auth-Token': this.pat,
                        'X-User-Id': this.userId,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });
                const data = await response.json();
                if (!data.success) {
                    console.error(`[RocketChatAdapter] API error posting message to ${this.url}/api/v1/chat.postMessage:`, data);
                    // If failed with attachments, retry without attachments
                    if (payload.attachments) {
                        delete payload.attachments;
                        const retryResp = await fetch(`${this.url}/api/v1/chat.postMessage`, {
                            method: 'POST',
                            headers: {
                                'X-Auth-Token': this.pat,
                                'X-User-Id': this.userId,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(payload)
                        });
                        const retryData = await retryResp.json();
                        if (retryData.success && !firstMsgId && retryData.message) {
                            firstMsgId = retryData.message._id;
                        }
                    }
                } else if (!firstMsgId && data.message) {
                    firstMsgId = data.message._id;
                }
            } catch (e) {
                console.error(`[RocketChatAdapter] Connection error posting message to ${this.url}/api/v1/chat.postMessage:`, e.message);
            }
        }

        return firstMsgId;
    }

    async _rawUpdate(roomId, msgId, text, attachments = null) {
        const payload = { roomId, msgId, text };
        if (Array.isArray(attachments) && attachments.length > 0) {
            payload.attachments = attachments;
        }

        try {
            const response = await fetch(`${this.url}/api/v1/chat.update`, {
                method: 'POST',
                headers: {
                    'X-Auth-Token': this.pat,
                    'X-User-Id': this.userId,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            if (!data.success) {
                // If update failed and attachments were present, retry without attachments
                if (payload.attachments) {
                    delete payload.attachments;
                    const retryResp = await fetch(`${this.url}/api/v1/chat.update`, {
                        method: 'POST',
                        headers: {
                            'X-Auth-Token': this.pat,
                            'X-User-Id': this.userId,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(payload)
                    });
                    const retryData = await retryResp.json();
                    return retryData.success === true;
                }
                console.warn(`[RocketChatAdapter] chat.update rejected (msgId: ${msgId}):`, data);
                return false;
            }
            return true;
        } catch (e) {
            console.error(`[RocketChatAdapter] Connection error updating message ${msgId}:`, e.message);
            return false;
        }
    }

    async updateMessage(roomId, msgId, text, attachments = null, tmid = null) {
        if (!this.userId || !this.pat || !msgId) return false;

        const chunks = splitMessageText(text, 3800);
        const firstChunk = chunks[0] || '';
        const firstAttachments = (chunks.length === 1) ? attachments : null;

        const updateOk = await this._rawUpdate(roomId, msgId, firstChunk, firstAttachments);

        if (!updateOk) {
            // Placeholder update failed (e.g. invalid arguments or deleted message)
            // Fallback to posting new message so user always receives the answer!
            console.log(`[RocketChatAdapter] In-place update failed for ${msgId}. Falling back to postMessage.`);
            await this.postMessage(roomId, tmid, text, attachments);
            return false;
        }

        // If message was split across multiple chunks, post follow-up parts into room/thread
        if (chunks.length > 1) {
            for (let i = 1; i < chunks.length; i++) {
                const isLast = (i === chunks.length - 1);
                const chunkAttachments = isLast ? attachments : null;
                await this.postMessage(roomId, tmid, chunks[i], chunkAttachments);
            }
        }

        return true;
    }
}

module.exports = RocketChatAdapter;
