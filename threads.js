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

function getConversationTitle(conv) {
    if (!conv) return 'Untitled';
    const title = (conv.title && typeof conv.title === 'string' && conv.title.trim()) || '';
    if (title && title.toLowerCase() !== 'untitled') return title;
    const preview = (conv.preview && typeof conv.preview === 'string' && conv.preview.trim()) || '';
    if (preview) return preview;
    return title || 'Untitled';
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

        const convTitle = getConversationTitle(conv);

        if (!boundThreadName) {
            // Generate a readable thread name from title or UUID prefix
            const baseSlug = convTitle ? slugify(convTitle) : '';
            boundThreadName = (baseSlug && !threadsData.threads.hasOwnProperty(baseSlug))
                ? baseSlug
                : `conv-${targetConvId.substring(0, 8)}`;
        }

        setActiveThread(boundThreadName, targetConvId, customPath);

        return {
            success: true,
            threadName: boundThreadName,
            convId: targetConvId,
            title: convTitle,
            stepCount: conv.step_count || 0,
            lastModified: conv.last_modified_time,
            type: 'index',
            message: `[✓] **Switched to conversation #${idx}:** "${convTitle}"\n*   **Thread:** \`${boundThreadName}\`\n*   **UUID:** \`${targetConvId}\`\n*   **Turns/Steps:** ${conv.step_count || 0} (${formatRelativeTime(conv.last_modified_time)})\n\n*All subsequent prompts will continue this conversation.*`
        };
    }

    // Case 2: Full 36-char UUID or 6+ char prefix
    if (UUID_REGEX.test(trimmed) || (UUID_PREFIX_REGEX.test(trimmed) && trimmed.length >= 8)) {
        const convSummary = getConversationById(trimmed);
        const targetConvId = convSummary ? convSummary.conversation_id : trimmed.toLowerCase();
        const convTitle = convSummary ? getConversationTitle(convSummary) : null;

        let boundThreadName = Object.keys(threadsData.threads).find(
            name => (threadsData.threads[name] || '').toLowerCase() === targetConvId
        );

        if (!boundThreadName) {
            const baseSlug = convTitle ? slugify(convTitle) : '';
            boundThreadName = (baseSlug && !threadsData.threads.hasOwnProperty(baseSlug))
                ? baseSlug
                : `conv-${targetConvId.substring(0, 8)}`;
        }

        setActiveThread(boundThreadName, targetConvId, customPath);

        const titleText = convTitle ? ` "${convTitle}"` : '';
        const stepsText = (convSummary && convSummary.step_count) ? ` (${convSummary.step_count} steps)` : '';

        return {
            success: true,
            threadName: boundThreadName,
            convId: targetConvId,
            title: convTitle,
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
                const title = getConversationTitle(conv);
                convDetails = `\n*   **Bound Conversation:** \`${convId}\` ("${title}")\n*   **History:** ${conv.step_count || 0} steps (${formatRelativeTime(conv.last_modified_time)})`;
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
 * Formats a clean, high-compatibility list of recent AGY conversations with thread cross-references.
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
        return formatThreadList(customPath);
    }

    let reply = `**Recent Antigravity Conversations (${conversations.length}):**\n\n`;

    conversations.forEach((conv, index) => {
        const num = index + 1;
        const rawTitle = getConversationTitle(conv).replace(/\|/g, '-');
        const title = rawTitle.length > 50 ? rawTitle.substring(0, 48) + '..' : rawTitle;
        const steps = conv.step_count || 0;
        const relativeTime = formatRelativeTime(conv.last_modified_time);
        const boundThread = convToThread[conv.conversation_id.toLowerCase()];
        
        let threadTag = '';
        if (boundThread) {
            const isActive = (boundThread === activeThread);
            threadTag = isActive ? ` • 🏷️ \`${boundThread}\` ★ *(Active)*` : ` • 🏷️ \`${boundThread}\``;
        }

        const shortId = conv.conversation_id.substring(0, 8) + '...';
        reply += `**#${num}** ${boundThread && boundThread === activeThread ? '★ ' : ''}**${title}**\n`;
        reply += `└─ ${steps} steps • ${relativeTime}${threadTag} • \`${shortId}\`\n\n`;
    });

    reply += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    reply += `★ = Active thread (\`${activeThread}\`)\n\n`;
    reply += `*• Switch by index: \`!agy switch <#num>\` (e.g. \`!agy switch 1\`)*\n`;
    reply += `*• Switch by name: \`!agy switch <thread-name>\`*\n`;
    reply += `*• Switch by UUID: \`!agy switch <uuid>\`*`;

    return reply;
}

/**
 * Formats a clean list of all named threads in threads.json.
 */
function formatThreadList(customPath = null) {
    const data = getThreads(customPath);
    const active = data.active_thread || 'default';
    const names = Object.keys(data.threads);

    if (names.length === 0) {
        return `**Managed Threads (0):**\n\nNo saved threads yet. A fresh session will start on your next prompt.\n*Create a thread with: \`!agy thread new <name>\`*`;
    }

    // Build thread entries with conversation details
    const threadEntries = names.map(name => {
        const convId = data.threads[name];
        const isActive = (name === active);
        let conv = null;
        let title = 'Fresh (no conversation)';
        let steps = 0;
        let lastModified = null;

        if (convId) {
            conv = getConversationById(convId);
            if (conv) {
                title = getConversationTitle(conv);
                steps = conv.step_count || 0;
                lastModified = conv.last_modified_time;
            } else {
                title = 'Bound session';
            }
        }

        return {
            name,
            convId,
            isActive,
            title,
            steps,
            lastModified,
            timeSort: lastModified ? new Date(lastModified).getTime() : 0
        };
    });

    // Sort: active thread first, then by last modified descending
    threadEntries.sort((a, b) => {
        if (a.isActive) return -1;
        if (b.isActive) return 1;
        return b.timeSort - a.timeSort;
    });

    let reply = `**Managed Threads (${threadEntries.length}):**\n\n`;

    threadEntries.forEach((entry, idx) => {
        const num = idx + 1;
        const statusMark = entry.isActive ? `★ *(Active)*` : ``;
        const shortConv = entry.convId ? `\`${entry.convId.substring(0, 8)}...\`` : `*(none)*`;
        const cleanTitle = entry.title.replace(/\|/g, '-');
        const truncatedTitle = cleanTitle.length > 50 ? cleanTitle.substring(0, 48) + '..' : cleanTitle;
        const timeAgo = entry.lastModified ? formatRelativeTime(entry.lastModified) : '-';

        reply += `**#${num}** ${entry.isActive ? '★ ' : ''}\`${entry.name}\` ${statusMark}\n`;
        reply += `└─ "${truncatedTitle}" • ${entry.steps} steps • ${timeAgo} • ${shortConv}\n\n`;
    });

    reply += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    reply += `★ = Active thread (\`${active}\`)\n\n`;
    reply += `*• Switch thread: \`!agy switch <name>\` (e.g. \`!agy switch ${threadEntries[1] ? threadEntries[1].name : 'default'}\`)*\n`;
    reply += `*• Switch by index: \`!agy switch <#num>\` | List all: \`!agy conversations\`*\n`;
    reply += `*• Manage: \`!agy thread new <name>\` | \`!agy thread reset [name]\` | \`!agy thread delete <name>\`*`;

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
        `*   **Active Thread:** \`${active}\` ★\n`;

    if (convId) {
        reply += `*   **Bound Conversation ID:** \`${convId}\`\n`;
        const conv = getConversationById(convId);
        if (conv) {
            const title = getConversationTitle(conv);
            reply += `*   **Title/Topic:** "${title}"\n` +
                `*   **Steps/Turns:** ${conv.step_count || 0}\n` +
                `*   **Last Active:** ${formatRelativeTime(conv.last_modified_time)} (${conv.last_modified_time})\n`;
        } else {
            reply += `*   **Details:** Conversation ID registered, pending first summary sync.\n`;
        }
    } else {
        reply += `*   **Bound Conversation ID:** *(None - will create new on next prompt)*\n`;
    }

    const otherThreads = Object.keys(data.threads).filter(t => t !== active);
    if (otherThreads.length > 0) {
        const previewList = otherThreads.slice(0, 6).map(t => `\`${t}\``).join(', ');
        const extraCount = otherThreads.length > 6 ? ` (+${otherThreads.length - 6} more)` : '';
        reply += `\n**Other Available Threads (${otherThreads.length}):** ${previewList}${extraCount}\n`;
    }

    reply += `\n*Switch thread: \`!agy switch <name|#num>\` | View all: \`!agy thread list\` or \`!agy conversations\`*`;
    return reply;
}

/**
 * Computes and formats visual context window token usage for the active thread.
 */
function formatContextUsage(customPath = null) {
    const data = getThreads(customPath);
    const activeThread = data.active_thread || 'default';
    const convId = data.threads[activeThread];

    if (!convId) {
        return {
            reply: `ℹ️ Active thread \`${activeThread}\` has no active conversation yet. Send a prompt to start one!`
        };
    }

    const candidateLogPaths = [
        path.join(process.env.HOME || '', `.gemini/antigravity-cli/brain/${convId}/.system_generated/logs/transcript.jsonl`),
        `/root/.gemini/antigravity-cli/brain/${convId}/.system_generated/logs/transcript.jsonl`,
        path.join(os.homedir(), `.gemini/antigravity-cli/brain/${convId}/.system_generated/logs/transcript.jsonl`)
    ].filter(Boolean);

    const logPath = candidateLogPaths.find(p => fs.existsSync(p));
    if (!logPath) {
        return {
            reply: `ℹ️ Log file not found for conversation \`${convId}\`. Have you sent a prompt in thread \`${activeThread}\` yet?`
        };
    }

    try {
        const raw = fs.readFileSync(logPath, 'utf8').trim().split('\n');
        let latestTokens = null;
        let stepCount = 0;

        for (let i = raw.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(raw[i]);
                if (stepCount === 0 && entry.step_index !== undefined) {
                    stepCount = entry.step_index;
                }
                if (!latestTokens && (entry.input_tokens !== undefined || (entry.usage && entry.usage.input_tokens !== undefined))) {
                    latestTokens = {
                        input_tokens: entry.input_tokens || (entry.usage && entry.usage.input_tokens) || 0,
                        cache_read_tokens: entry.cache_read_tokens || (entry.usage && entry.usage.cache_read_tokens) || 0,
                        output_tokens: entry.output_tokens || (entry.usage && entry.usage.output_tokens) || 0,
                        step_index: entry.step_index
                    };
                }
                if (stepCount > 0 && latestTokens) break;
            } catch (_) {}
        }

        if (!latestTokens) {
            return {
                reply: `ℹ️ No token usage telemetry recorded for conversation \`${convId}\` yet.`
            };
        }

        const cached = latestTokens.cache_read_tokens;
        const input = latestTokens.input_tokens;
        const output = latestTokens.output_tokens;
        const totalActive = cached + input;
        const maxLimit = 256000;
        const pctNum = Math.min(100, (totalActive / maxLimit) * 100);
        const pct = pctNum.toFixed(1);
        const filled = Math.min(20, Math.max(0, Math.round((pctNum / 100) * 20)));
        const progressBar = '█'.repeat(filled) + '░'.repeat(20 - filled);
        const remaining = Math.max(0, maxLimit - totalActive);

        let statusText = '🟢 Context Healthy (Well within limits)';
        if (pctNum >= 90) {
            statusText = '🔴 Context Critical (Approaching automatic compaction threshold)';
        } else if (pctNum >= 75) {
            statusText = '🟡 Context Elevated (Consider /compact if starting major new refactor)';
        }

        let reply = `📊 **Context Window Usage** (\`${activeThread}\`)\n`;
        reply += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        reply += `**Usage:** \`${totalActive.toLocaleString()}\` / \`${maxLimit.toLocaleString()}\` tokens (**${pct}%**)\n`;
        reply += `\`[${progressBar}] ${pct}%\`\n\n`;
        reply += `• ⚡ **Cached History & System:** \`${cached.toLocaleString()}\` tokens (${((cached / (totalActive || 1)) * 100).toFixed(1)}%)\n`;
        reply += `• 📥 **Current Turn Input:** \`${input.toLocaleString()}\` tokens (${((input / (totalActive || 1)) * 100).toFixed(1)}%)\n`;
        reply += `• 📤 **Last Turn Output:** \`${output.toLocaleString()}\` tokens\n`;
        reply += `• 🏷️ **Total Active Context:** \`${totalActive.toLocaleString()}\` tokens\n`;
        reply += `• 🪟 **Remaining to Compaction:** \`${remaining.toLocaleString()}\` tokens (${((remaining / maxLimit) * 100).toFixed(1)}%)\n\n`;
        reply += `• **Active Thread:** \`${activeThread}\` (\`${convId.substring(0, 8)}...\`)\n`;
        reply += `• **Step Count:** ${stepCount || raw.length} steps\n`;
        reply += `• **Status:** ${statusText}\n`;

        return {
            reply,
            totalActive,
            maxLimit,
            pct,
            cached,
            input,
            output
        };
    } catch (err) {
        return {
            reply: `❌ Failed to read context usage: ${err.message}`
        };
    }
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
    formatContextUsage,
    formatRelativeTime,
    getConversationTitle,
    slugify
};
