const BaseAdapter = require('./BaseAdapter');

class RocketChatAdapter extends BaseAdapter {
    constructor() {
        super('rocketchat');
        this.url = process.env.ROCKETCHAT_URL || 'http://rocketchat.example.com:3000';
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

    async postMessage(roomId, tmid, text) {
        if (!this.userId || !this.pat) {
            console.warn('[RocketChatAdapter] Missing API credentials (ROCKETCHAT_USER_ID or ROCKETCHAT_PAT).');
            return null;
        }

        const payload = { roomId, text, alias: this.botAlias, emoji: ':robot:' };
        if (tmid) payload.tmid = tmid;

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
            return data.success ? data.message._id : null;
        } catch (e) {
            console.error('[RocketChatAdapter] Error posting message:', e.message);
            return null;
        }
    }

    async updateMessage(roomId, msgId, text) {
        if (!this.userId || !this.pat || !msgId) return;

        try {
            await fetch(`${this.url}/api/v1/chat.update`, {
                method: 'POST',
                headers: {
                    'X-Auth-Token': this.pat,
                    'X-User-Id': this.userId,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ roomId, msgId, text })
            });
        } catch (e) {
            console.error('[RocketChatAdapter] Error updating message:', e.message);
        }
    }
}

module.exports = RocketChatAdapter;
