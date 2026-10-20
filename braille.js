/**
 * Braille Iconography Service for Rocket-Grav
 * Enforces Zero Emoji Policy by replacing Unicode emojis with tactile Braille icons.
 */

const fs = require('fs');
const path = require('path');

let brailleMap = {};
try {
    const mapPath = path.join(__dirname, 'braille_map.json');
    if (fs.existsSync(mapPath)) {
        brailleMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    }
} catch (e) {
    console.error(`[Braille] Error loading braille_map.json: ${e.message}`);
}

// Add canonical status badges and extra glyphs
const EXTRA_MAPPINGS = {
    '🟢': '⢄⠎',
    '🔴': '⡱⢎',
    '🟡': '⠕⠪',
    '⚪': '⠤⠤',
    '🍵': '⣠⡇',
    '🤖': '⢎⡱',
    '💭': '⠪⡕',
    '👤': '⡼⢧',
    '📊': '⡞⣗',
    '🏷️': '⠊⢵',
    '🏷': '⠊⢵',
    '🪟': '⣫⣝',
    '⚡': '⢴⠃',
    '🛡️': '⣮⣵',
    '🛡': '⣮⣵',
    '🚀': '⡴⢧',
    '⚠️': '⢘⡃',
    '⚠': '⢘⡃',
    '❌': '⡱⢎',
    '✅': '⢄⠎',
    '💡': '⠪⡕',
    '📦': '⣏⣹',
    '🔧': '⠙⢦',
    '⚙️': '⣱⢏',
    '⚙': '⣱⢏',
    '📜': '⣏⣛',
    '🔍': '⠪⢕',
    '📥': '⣚⣗',
    '📤': '⣲⣗',
    '📋': '⡞⣗'
};

for (const [em, br] of Object.entries(EXTRA_MAPPINGS)) {
    brailleMap[em] = br;
}

// Sort emoji keys by length descending to match composite sequences first
const SORTED_EMOJIS = Object.keys(brailleMap).sort((a, b) => b.length - a.length);

// Regex matching broad emoji range
const GENERAL_EMOJI_REGEX = /[\u{1F000}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

/**
 * Checks if a string contains any legacy emojis.
 */
function containsEmoji(text) {
    if (!text) return false;
    return GENERAL_EMOJI_REGEX.test(text);
}

/**
 * Replaces all known legacy emojis with approved Braille glyphs.
 */
function replaceEmojis(text) {
    if (!text || typeof text !== 'string') return text;
    let result = text;
    for (const em of SORTED_EMOJIS) {
        if (result.includes(em)) {
            result = result.split(em).join(brailleMap[em]);
        }
    }
    return result;
}

/**
 * Scans a file on disk, replaces legacy emojis with Braille icons, and saves it.
 * Returns { changed: boolean, originalCount: number, filePath: string }
 */
function replaceEmojisInFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return { changed: false, error: 'File not found' };
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!containsEmoji(raw)) return { changed: false, count: 0 };

        const updated = replaceEmojis(raw);
        if (updated !== raw) {
            fs.writeFileSync(filePath, updated, 'utf8');
            return { changed: true, filePath };
        }
    } catch (e) {
        return { changed: false, error: e.message };
    }
    return { changed: false };
}

module.exports = {
    containsEmoji,
    replaceEmojis,
    replaceEmojisInFile,
    brailleMap
};
