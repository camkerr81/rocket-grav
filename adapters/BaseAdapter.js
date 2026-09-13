/**
 * BaseAdapter - Abstract interface for chat platform integrations.
 */
class BaseAdapter {
    constructor(name = 'base') {
        this.name = name;
    }

    /**
     * Verifies the incoming webhook request authenticity.
     * @param {import('express').Request} req
     * @returns {boolean}
     */
    verifyRequest(req) {
        throw new Error(`verifyRequest() not implemented for ${this.name} adapter.`);
    }

    /**
     * Extracts normalized payload from request.
     * @param {import('express').Request} req
     * @returns {{ text: string, roomId: string, tmid: string|null, userId?: string }}
     */
    extractPayload(req) {
        throw new Error(`extractPayload() not implemented for ${this.name} adapter.`);
    }

    /**
     * Posts a new message or placeholder to the channel/thread.
     * @param {string} roomId - Channel or conversation ID
     * @param {string|null} tmid - Thread ID (if replying in a thread)
     * @param {string} text - Message text
     * @returns {Promise<string|null>} Created message ID
     */
    async postMessage(roomId, tmid, text) {
        throw new Error(`postMessage() not implemented for ${this.name} adapter.`);
    }

    /**
     * Updates an existing message in-place (used for live Braille spinner and final result).
     * @param {string} roomId - Channel or conversation ID
     * @param {string} msgId - Message ID to update
     * @param {string} text - New message text
     * @returns {Promise<void>}
     */
    async updateMessage(roomId, msgId, text) {
        throw new Error(`updateMessage() not implemented for ${this.name} adapter.`);
    }
}

module.exports = BaseAdapter;
