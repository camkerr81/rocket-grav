const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

let DatabaseSync = null;
try {
    const sqlite = require('node:sqlite');
    DatabaseSync = sqlite.DatabaseSync;
} catch (e) {
    // node:sqlite not available on older Node runtimes; will use python3 fallback
}

const DEFAULT_THREADS_FILE = process.env.THREADS_FILE || '/workspace/threads.json';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PREFIX_REGEX = /^[0-9a-f]{6,36}$/i;
const INDEX_REGEX = /^#?(\d+)$/;

function getThreadsFilePath(customPath = null) {
    return customPath || process.env.THREADS_FILE || DEFAULT_THREADS_FILE;
}

function getConversationDbPath() {
    const candidatePaths = [
        process.env.AGY_CONVERSATION_DB,
        path.join(process.env.HOME || '', '.gemini/antigravity-cli/conversation_summaries.db'),
        '/root/.gemini/antigravity-cli/conversation_summaries.db',
        path.join(os.homedir(), '.gemini/antigravity-cli/conversation_summaries.db')
    ].filter(Boolean);

    for (const p of candidatePaths) {
        try {
            if (fs.existsSync(p)) return p;
        } catch (_) {}
    }
    return null;
}

function getThreads(customPath = null) {
    const targetFile = getThreadsFilePath(customPath);
    try {
        if (fs.existsSync(targetFile)) {
            const raw = fs.readFileSync(targetFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed.threads || typeof parsed.threads !== 'object') {
                parsed.threads = {};
            }
            if (!parsed.active_thread || typeof parsed.active_thread !== 'string') {
                parsed.active_thread = 'default';
            }
            return parsed;
        }
    } catch (e) {
        console.error(`[Threads] Warning: Failed to read threads from ${targetFile}: ${e.message}`);
    }
    return { active_thread: 'default', threads: {} };
}

function saveThreads(data, customPath = null) {
    const targetFile = getThreadsFilePath(customPath);
    try {
        const dir = path.dirname(targetFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(targetFile, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error(`[Threads] Error writing threads to ${targetFile}: ${e.message}`);
        return false;
    }
}

/**
 * Safely updates a single thread's conversation ID without clobbering active_thread
 * or other concurrently modified thread mappings.
 */
function updateThreadConvId(threadName, conversationId, customPath = null) {
    if (!threadName || !conversationId) return;
    const current = getThreads(customPath);
    current.threads[threadName] = conversationId;
    saveThreads(current, customPath);
    console.log(`[Threads] Updated thread "${threadName}" -> conversation ${conversationId}`);
}

/**
 * Sets the active thread, ensuring it exists in the threads object.
 */
function setActiveThread(threadName, conversationId = null, customPath = null) {
    const current = getThreads(customPath);
    const cleanName = (threadName || 'default').trim();
    current.active_thread = cleanName;
    if (conversationId) {
        current.threads[cleanName] = conversationId;
    } else if (!current.threads.hasOwnProperty(cleanName)) {
        current.threads[cleanName] = null;
    }
    saveThreads(current, customPath);
    return current;
}

/**
 * Resets a thread's conversation ID to null so that the next prompt starts a fresh session.
 */
function resetThread(threadName = null, customPath = null) {
    const current = getThreads(customPath);
    const target = (threadName || current.active_thread || 'default').trim();
    current.threads[target] = null;
    saveThreads(current, customPath);
    return target;
}

/**
 * Deletes a thread from the threads map.
 */
function deleteThread(threadName, customPath = null) {
    const current = getThreads(customPath);
    const target = (threadName || '').trim();
    if (!target) return { success: false, error: 'No thread name specified.' };
    if (target === 'default') {
        return { success: false, error: 'Cannot delete the "default" thread. Use `!agy thread reset default` instead.' };
    }
    if (!current.threads.hasOwnProperty(target)) {
        return { success: false, error: `Thread "${target}" does not exist.` };
    }

    delete current.threads[target];
    if (current.active_thread === target) {
        current.active_thread = 'default';
    }
    saveThreads(current, customPath);
    return { success: true, deleted: target, active_thread: current.active_thread };
}

/**
 * Retrieves recent conversations from AGY SQLite database.
 */
function getRecentConversations(limit = 20) {
    const dbPath = getConversationDbPath();
    if (!dbPath) return [];

    // Try Node.js 22 built-in node:sqlite
    if (DatabaseSync) {
        try {
            const db = new DatabaseSync(dbPath, { readOnly: true });
            const stmt = db.prepare(`
                SELECT conversation_id, title, preview, step_count, last_modified_time, status 
                FROM conversation_summaries 
                ORDER BY last_modified_time DESC 
                LIMIT ?
            `);
            const rows = stmt.all(limit);
            db.close();
            return rows;
        } catch (err) {
            console.warn(`[Threads] node:sqlite error (${err.message}), falling back to python...`);
        }
    }

    // Python fallback
    try {
        const pyScript = `import sqlite3, json, sys
conn = sqlite3.connect('${dbPath.replace(/'/g, "\\'")}')
c = conn.cursor()
c.execute("SELECT conversation_id, title, preview, step_count, last_modified_time, status FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT " + str(int(${limit})))
cols = [d[0] for d in c.description]
rows = [dict(zip(cols, row)) for row in c.fetchall()]
print(json.dumps(rows))`;
        const out = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, { timeout: 5000 }).toString();
        return JSON.parse(out);
    } catch (pyErr) {
        console.error(`[Threads] Could not query conversation summaries via python: ${pyErr.message}`);
        return [];
    }
}

/**
 * Look up a conversation summary by UUID or prefix.
 */
function getConversationById(convId) {
    if (!convId) return null;
    const cleanId = convId.trim().toLowerCase();
    const dbPath = getConversationDbPath();
    if (!dbPath) return null;

    if (DatabaseSync) {
        try {
            const db = new DatabaseSync(dbPath, { readOnly: true });
            let stmt = db.prepare('SELECT conversation_id, title, preview, step_count, last_modified_time, status FROM conversation_summaries WHERE conversation_id = ? LIMIT 1');
            let row = stmt.get(cleanId);
            if (!row && cleanId.length >= 6) {
                stmt = db.prepare('SELECT conversation_id, title, preview, step_count, last_modified_time, status FROM conversation_summaries WHERE conversation_id LIKE ? LIMIT 1');
                row = stmt.get(`${cleanId}%`);
            }
            db.close();
            if (row) return row;
        } catch (_) {}
    }

    // Python fallback
    try {
        const pyScript = `import sqlite3, json, sys
conn = sqlite3.connect('${dbPath.replace(/'/g, "\\'")}')
c = conn.cursor()
c.execute("SELECT conversation_id, title, preview, step_count, last_modified_time, status FROM conversation_summaries WHERE conversation_id = ? OR conversation_id LIKE ? LIMIT 1", ('${cleanId}', '${cleanId}%'))
cols = [d[0] for d in c.description]
row = c.fetchone()
print(json.dumps(dict(zip(cols, row)) if row else None))`;
        const out = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, { timeout: 5000 }).toString();
        return JSON.parse(out);
    } catch (_) {
        return null;
    }
}

function formatRelativeTime(dateStr) {
    if (!dateStr) return 'unknown';
    try {
        const dt = new Date(dateStr);
        const diffMs = Date.now() - dt.getTime();
        const diffSec = Math.floor(diffMs / 1000);
        if (diffSec < 60) return 'just now';
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHrs = Math.floor(diffMin / 60);
        if (diffHrs < 24) return `${diffHrs}h ago`;
        const diffDays = Math.floor(diffHrs / 24);
        if (diffDays < 30) return `${diffDays}d ago`;
        return dt.toLocaleDateString();
    } catch (_) {
        return dateStr;
    }
}

function slugify(text) {
    return (text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 24);
}

/**
 * Resolves a switch target string which can be:
 * 1. 1-based index (e.g. 1, #1) referencing recent conversation list
 * 2. Full 36-character UUID
 * 3. 6+ character hex UUID prefix
 * 4. Existing thread name in threads.json
 * 5. New thread name
 */
function resolveSwitchTarget(targetStr, customPath = null) {
    if (!targetStr || typeof targetStr !== 'string') {
        return { success: false, error: 'No target thread or conversation specified.' };
    }

    const trimmed = targetStr.trim();
    if (!trimmed) {
        return { success: false, error: 'Target cannot be empty.' };
    }

    const threadsData = getThreads(customPath);

    // Case 1: 1-based index (#1, 1, etc.)
    const indexMatch = trimmed.match(INDEX_REGEX);
    if (indexMatch) {
        const idx = parseInt(indexMatch[1], 10);
        const conversations = getRecentConversations(30);
        if (conversations.length === 0) {
            return {
                success: false,
                error: `Cannot switch by index: No previous conversations found in database. Try switching by thread name or raw UUID.`
            };
        }
        if (idx < 1 || idx > conversations.length) {
            return {
                success: false,
                error: `Conversation index #${idx} is out of range (1 - ${conversations.length}). Run \`!agy conversations\` to view recent sessions.`
            };
        }

        const conv = conversations[idx - 1];
        const targetConvId = conv.conversation_id;

        // Check if a thread already points to this conversation
        let boundThreadName = Object.keys(threadsData.threads).find(
            name => threadsData.threads[name] === targetConvId
        );

        if (!boundThreadName) {
            // Generate a readable thread name from title or UUID prefix
            const baseSlug = conv.title ? slugify(conv.title) : '';
            boundThreadName = (baseSlug && !threadsData.threads.hasOwnProperty(baseSlug))
                ? baseSlug
                : `conv-${targetConvId.substring(0, 8)}`;
        }

        setActiveThread(boundThreadName, targetConvId, customPath);

        return {
            success: true,
            threadName: boundThreadName,
            convId: targetConvId,
            title: conv.title || 'Untitled',
            stepCount: conv.step_count || 0,
            lastModified: conv.last_modified_time,
            type: 'index',
            message: `[✓] **Switched to conversation #${idx}:** "${conv.title || 'Untitled'}"\n*   **Thread:** \`${boundThreadName}\`\n*   **UUID:** \`${targetConvId}\`\n*   **Turns/Steps:** ${conv.step_count || 0} (${formatRelativeTime(conv.last_modified_time)})\n\n*All subsequent prompts will continue this conversation.*`
        };
    }

    // Case 2: Full 36-char UUID or 6+ char prefix
    if (UUID_REGEX.test(trimmed) || (UUID_PREFIX_REGEX.test(trimmed) && trimmed.length >= 8)) {
        const convSummary = getConversationById(trimmed);
        const targetConvId = convSummary ? convSummary.conversation_id : trimmed.toLowerCase();

        let boundThreadName = Object.keys(threadsData.threads).find(
            name => (threadsData.threads[name] || '').toLowerCase() === targetConvId
        );

        if (!boundThreadName) {
            const baseSlug = (convSummary && convSummary.title) ? slugify(convSummary.title) : '';
            boundThreadName = (baseSlug && !threadsData.threads.hasOwnProperty(baseSlug))
                ? baseSlug
                : `conv-${targetConvId.substring(0, 8)}`;
        }

        setActiveThread(boundThreadName, targetConvId, customPath);

        const titleText = (convSummary && convSummary.title) ? ` "${convSummary.title}"` : '';
        const stepsText = (convSummary && convSummary.step_count) ? ` (${convSummary.step_count} steps)` : '';

        return {
            success: true,
            threadName: boundThreadName,
            convId: targetConvId,
            title: convSummary ? convSummary.title : null,
            stepCount: convSummary ? convSummary.step_count : 0,
            type: 'uuid',
            message: `[✓] **Switched to conversation:** \`${targetConvId}\`${titleText}${stepsText}\n*   **Active Thread:** \`${boundThreadName}\`\n\n*All subsequent prompts will continue this conversation.*`
        };
    }

    // Case 3: Existing thread name (exact or case-insensitive)
    const exactName = threadsData.threads.hasOwnProperty(trimmed) ? trimmed : null;
    const matchedName = exactName || Object.keys(threadsData.threads).find(
        k => k.toLowerCase() === trimmed.toLowerCase()
    );

    if (matchedName) {
        const convId = threadsData.threads[matchedName] || null;
        setActiveThread(matchedName, convId, customPath);

        let convDetails = '';
        if (convId) {
            const conv = getConversationById(convId);
            if (conv) {
                convDetails = `\n*   **Bound Conversation:** \`${convId}\` ("${conv.title || 'Untitled'}")\n*   **History:** ${conv.step_count || 0} steps (${formatRelativeTime(conv.last_modified_time)})`;
            } else {
                convDetails = `\n*   **Bound Conversation:** \`${convId}\``;
            }
        } else {
            convDetails = `\n*(No conversation attached yet; a fresh session will start on next prompt)*`;
        }

        return {
            success: true,
            threadName: matchedName,
            convId,
            type: 'thread',
            message: `[✓] **Switched to thread:** \`${matchedName}\`${convDetails}`
        };
    }

    // Case 4: Brand new thread name
    const sanitizedName = trimmed.replace(/[^a-zA-Z0-9_\-\.]/g, '-').substring(0, 40);
    if (!sanitizedName) {
        return { success: false, error: `Invalid thread name: "${trimmed}". Please use letters, numbers, hyphens, or underscores.` };
    }

    setActiveThread(sanitizedName, null, customPath);

    return {
        success: true,
        threadName: sanitizedName,
        convId: null,
        isNew: true,
        type: 'new_thread',
        message: `[✓] **Created and switched to new thread:** \`${sanitizedName}\`\n*(A new conversation will be started on your next prompt)*`
    };
}

/**
 * Formats a markdown table of recent AGY conversations with thread cross-references.
 */
function formatConversationList(limit = 15, customPath = null) {
    const conversations = getRecentConversations(limit);
    const threadsData = getThreads(customPath);
    const activeThread = threadsData.active_thread || 'default';

    // Map conversation IDs to their thread names
    const convToThread = {};
    for (const [name, id] of Object.entries(threadsData.threads)) {
        if (id) convToThread[id.toLowerCase()] = name;
    }

    if (conversations.length === 0) {
        let text = `**Available Threads (from threads.json):**\n\n`;
        text += `| Thread | Conversation ID | Status |\n|---|---|---|\n`;
        for (const [name, id] of Object.entries(threadsData.threads)) {
            const isActive = (name === activeThread) ? ' **(active)**' : '';
            text += `| \`${name}\`${isActive} | \`${id || '(none)'}\` | ${id ? 'Bound' : 'Fresh'} |\n`;
        }
        text += `\n*Switch thread with: \`!agy switch <name>\`*`;
        return text;
    }

    let reply = `**Recent Antigravity Conversations:**\n\n`;
    reply += `| # | Title | Steps | Last Active | Thread | Conversation ID |\n`;
    reply += `|---|---|---|---|---|---|\n`;

    conversations.forEach((conv, index) => {
        const num = index + 1;
        const rawTitle = (conv.title || 'Untitled').trim().replace(/\|/g, '-');
        const title = rawTitle.length > 36 ? rawTitle.substring(0, 34) + '...' : rawTitle;
        const steps = conv.step_count || 0;
        const relativeTime = formatRelativeTime(conv.last_modified_time);
        const boundThread = convToThread[conv.conversation_id.toLowerCase()];
        
        let threadTag = '-';
        if (boundThread) {
            const isActive = (boundThread === activeThread);
            threadTag = isActive ? `\`${boundThread}\` ★` : `\`${boundThread}\``;
        }

        const shortId = conv.conversation_id.substring(0, 8) + '...';
        reply += `| ${num} | ${title} | ${steps} | ${relativeTime} | ${threadTag} | \`${shortId}\` |\n`;
    });

    reply += `\n★ = Active thread (\`${activeThread}\`)`;
    reply += `\n\n*Switch by index: \`!agy switch <#num>\` (e.g. \`!agy switch 1\`)*`;
    reply += `\n*Switch by name: \`!agy switch <thread-name>\`*`;
    reply += `\n*Switch by UUID: \`!agy switch <uuid>\`*`;

    return reply;
}

/**
 * Formats a markdown list of all named threads in threads.json.
 */
function formatThreadList(customPath = null) {
    const data = getThreads(customPath);
    const active = data.active_thread || 'default';
    const names = Object.keys(data.threads);

    let reply = `**Managed Threads (${names.length}):**\n\n`;
    reply += `| Status | Thread Name | Bound Conversation | Details |\n`;
    reply += `|---|---|---|---|\n`;

    if (names.length === 0) {
        reply += `| ★ | \`default\` | *(none)* | Fresh session |\n`;
    } else {
        for (const name of names) {
            const isActive = (name === active);
            const statusMark = isActive ? `★ **ACTIVE**` : ``;
            const convId = data.threads[name];
            let details = 'Fresh';
            let convStr = '*(none)*';

            if (convId) {
                convStr = `\`${convId.substring(0, 8)}...\``;
                const conv = getConversationById(convId);
                if (conv) {
                    const rawTitle = (conv.title || '').replace(/\|/g, '-');
                    const title = rawTitle.length > 25 ? rawTitle.substring(0, 23) + '..' : rawTitle;
                    details = `"${title}" (${conv.step_count || 0} steps)`;
                } else {
                    details = `Bound`;
                }
            }

            reply += `| ${statusMark} | \`${name}\` | ${convStr} | ${details} |\n`;
        }
    }

    reply += `\n*Currently active thread: \`${active}\`*`;
    reply += `\n*Commands: \`!agy switch <name>\`, \`!agy thread new <name>\`, \`!agy thread reset [name]\`, \`!agy thread delete <name>\`*`;
    return reply;
}

/**
 * Returns formatted status of the current active thread and its conversation.
 */
function formatThreadStatus(customPath = null) {
    const data = getThreads(customPath);
    const active = data.active_thread || 'default';
    const convId = data.threads[active] || null;

    let reply = `**Current Thread & Conversation Status:**\n` +
        `*   **Active Thread:** \`${active}\`\n`;

    if (convId) {
        reply += `*   **Bound Conversation ID:** \`${convId}\`\n`;
        const conv = getConversationById(convId);
        if (conv) {
            reply += `*   **Title:** "${conv.title || 'Untitled'}"\n` +
                `*   **Steps/Turns:** ${conv.step_count || 0}\n` +
                `*   **Last Active:** ${formatRelativeTime(conv.last_modified_time)} (${conv.last_modified_time})\n`;
        } else {
            reply += `*   **Details:** Conversation ID registered, pending first summary sync.\n`;
        }
    } else {
        reply += `*   **Bound Conversation ID:** *(None - will create new on next prompt)*\n`;
    }

    reply += `\n*Switch with \`!agy switch <name|#num|uuid>\` or list with \`!agy conversations\`.*`;
    return reply;
}

module.exports = {
    getThreadsFilePath,
    getConversationDbPath,
    getThreads,
    saveThreads,
    updateThreadConvId,
    setActiveThread,
    resetThread,
    deleteThread,
    getRecentConversations,
    getConversationById,
    resolveSwitchTarget,
    formatConversationList,
    formatThreadList,
    formatThreadStatus,
    formatRelativeTime,
    slugify
};
