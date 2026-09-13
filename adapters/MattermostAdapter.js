const BaseAdapter = require('./BaseAdapter');

class MattermostAdapter extends BaseAdapter {
    constructor() {
        super('mattermost');
        this.url = (process.env.MATTERMOST_URL || 'http://localhost:8065').replace(/\/$/, '');
        this.token = process.env.MATTERMOST_TOKEN; // Outgoing webhook token
        this.pat = process.env.MATTERMOST_PAT || process.env.MATTERMOST_BOT_TOKEN; // Personal Access Token or Bot Token for REST API
    }

    verifyRequest(req) {
        const providedToken = req.body && req.body.token;
        if (!this.token) {
            console.warn('[MattermostAdapter] Warning: MATTERMOST_TOKEN is not set.');
            return false;
        }
        return providedToken === this.token;
    }

    extractPayload(req) {
        return {
            text: (req.body && req.body.text) || '',
            roomId: req.body && req.body.channel_id,
            tmid: (req.body && req.body.root_id) || null,
            userId: req.body && req.body.user_id
        };
    }

    async postMessage(roomId, tmid, text) {
        if (!this.pat) {
            console.warn('[MattermostAdapter] Missing API credentials (MATTERMOST_PAT or MATTERMOST_BOT_TOKEN).');
            return null;
        }

        const payload = {
            channel_id: roomId,
            message: text
        };
        if (tmid) payload.root_id = tmid;

        try {
            const response = await fetch(`${this.url}/api/v4/posts`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.pat}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            return data.id || null;
        } catch (e) {
            console.error('[MattermostAdapter] Error posting post:', e.message);
            return null;
        }
    }

    async updateMessage(roomId, msgId, text) {
        if (!this.pat || !msgId) return;

        try {
            await fetch(`${this.url}/api/v4/posts/${msgId}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.pat}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    id: msgId,
                    message: text
                })
            });
        } catch (e) {
            console.error('[MattermostAdapter] Error updating post:', e.message);
        }
    }
}

module.exports = MattermostAdapter;
