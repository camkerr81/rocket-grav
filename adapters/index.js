const BaseAdapter = require('./BaseAdapter');
const RocketChatAdapter = require('./RocketChatAdapter');
const MattermostAdapter = require('./MattermostAdapter');
const SlackAdapter = require('./SlackAdapter');

/**
 * Returns the configured ChatAdapter based on CHAT_PROVIDER env var.
 * Defaults to 'rocketchat'.
 * @param {string} [provider]
 * @returns {BaseAdapter}
 */
function getAdapter(provider = process.env.CHAT_PROVIDER || 'rocketchat') {
    const normalized = provider.toLowerCase().trim();
    switch (normalized) {
        case 'mattermost':
            return new MattermostAdapter();
        case 'slack':
            return new SlackAdapter();
        case 'rocketchat':
        case 'rocket.chat':
        default:
            return new RocketChatAdapter();
    }
}

module.exports = {
    getAdapter,
    BaseAdapter,
    RocketChatAdapter,
    MattermostAdapter,
    SlackAdapter
};
