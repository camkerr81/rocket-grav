const BaseAdapter = require('./BaseAdapter');

class SlackAdapter extends BaseAdapter {
    constructor() {
        super('slack');
        this.botToken = process.env.SLACK_BOT_TOKEN;
        this.verificationToken = process.env.SLACK_VERIFICATION_TOKEN || process.env.SLACK_TOKEN;
    }

    verifyRequest(req) {
        // Handle Slack URL verification challenge
        if (req.body && req.body.type === 'url_verification') {
            return true;
        }

        const token = (req.body && req.body.token) || (req.headers && req.headers['x-slack-signature']);
        if (!this.verificationToken) {
            // Allow if no token is configured for development/internal networks
            return true;
        }
        return (req.body && req.body.token === this.verificationToken);
    }

    extractPayload(req) {
        // Handle Slack Events API
        if (req.body && req.body.event) {
            const ev = req.body.event;
            return {
                text: ev.text || '',
                roomId: ev.channel,
                tmid: ev.thread_ts || null,
                userId: ev.user
            };
        }

        // Handle Slash Commands (form encoded)
        return {
            text: (req.body && req.body.text) || '',
            roomId: req.body && req.body.channel_id,
            tmid: null,
            userId: req.body && req.body.user_id
        };
    }

    async postMessage(roomId, tmid, text) {
        if (!this.botToken) {
            console.warn('[SlackAdapter] Missing SLACK_BOT_TOKEN.');
            return null;
        }

        const payload = {
            channel: roomId,
            text: text
        };
        if (tmid) payload.thread_ts = tmid;

        try {
            const response = await fetch('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.botToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            return data.ok ? data.ts : null;
        } catch (e) {
            console.error('[SlackAdapter] Error posting message:', e.message);
            return null;
        }
    }

    async updateMessage(roomId, msgId, text) {
        if (!this.botToken || !msgId) return;

        try {
            await fetch('https://slack.com/api/chat.update', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.botToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    channel: roomId,
                    ts: msgId,
                    text: text
                })
            });
        } catch (e) {
            console.error('[SlackAdapter] Error updating message:', e.message);
        }
    }
}

module.exports = SlackAdapter;
