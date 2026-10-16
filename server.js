const express = require('express');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the assets directory via HTTP
const assetsDir = '/root/.gemini/antigravity-cli/scratch/Pixel-Paradox/backend/assets';
app.use('/assets', express.static(assetsDir));
app.get('/assets', (req, res) => {
    if (!fs.existsSync(assetsDir)) return res.send('Assets directory not found (has AGY created it yet?)');
    const files = fs.readdirSync(assetsDir);
    let html = '<h1>Generated Images</h1><ul>';
    files.forEach(f => html += `<li><a href="/assets/${f}" target="_blank">${f}</a></li>`);
    html += '</ul>';
    res.send(html);
});

const activeProcesses = {};
let currentModel = null; // null = use default subscription model

// Bridge operating mode: 'hybrid' (smart offloading), 'agy' (Antigravity CLI only), or 'ollama' (Ollama only)
let bridgeMode = (process.env.HYBRID_MODE === 'false' || process.env.HYBRID_MODE === '0') ? 'agy' : 'hybrid';
let ollamaUrl = (process.env.OLLAMA_URL || 'http://192.168.8.194:11434').replace(/\/+$/, '');
let ollamaModel = process.env.OLLAMA_MODEL || 'phi4-mini:latest';

// Shorthand aliases for quick model switching
const MODEL_ALIASES = {
    'claude':       'claude-opus-4-6-thinking',
    'claude-opus':  'claude-opus-4-6-thinking',
    'claude-sonnet':'claude-sonnet-4-6',
    'sonnet':       'claude-sonnet-4-6',
    'opus':         'claude-opus-4-6-thinking',
    'gemini':       'gemini-3.1-pro-low',
    'gemini-pro':   'gemini-3.1-pro-low',
    'gemini-pro-high': 'gemini-3.1-pro-high',
    'flash':        'gemini-3.7-flash-medium',
    'flash-high':   'gemini-3.7-flash-high',
    'flash-low':    'gemini-3.7-flash-low',
    'gpt':          'gpt-oss-120b-medium',
    'default':      null,
};

const {
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
    formatContextUsage
} = require('./threads');

const { getAdapter } = require('./adapters');
const adapter = getAdapter();
console.log(`[Rocket-Grav] Initialized with chat adapter: ${adapter.name.toUpperCase()}`);
if (adapter.url) console.log(`[Rocket-Grav] Target chat server URL: ${adapter.url}`);
console.log(`[Rocket-Grav] Bridge Operating Mode: ${bridgeMode.toUpperCase()}`);
console.log(`[Rocket-Grav] Local Ollama Target: ${ollamaUrl} (default model: ${ollamaModel})`);

// Antigravity CLI Auto-Update Configuration & Utilities
const AGY_MANIFEST_URL = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json';

const autoUpdateState = {
    enabled: process.env.AUTO_UPDATE_ENABLED !== 'false' && process.env.AUTO_UPDATE_ENABLED !== '0',
    intervalHours: parseInt(process.env.AUTO_UPDATE_INTERVAL_HOURS, 10) || 24,
    lastCheck: null,
    lastResult: 'never',
    currentVersion: null,
    latestVersion: null,
    timer: null
};

function compareSemver(v1, v2) {
    const p1 = (v1 || '').trim().replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const p2 = (v2 || '').trim().replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
        const num1 = p1[i] || 0;
        const num2 = p2[i] || 0;
        if (num1 > num2) return 1;
        if (num1 < num2) return -1;
    }
    return 0;
}

function getInstalledAgyVersion() {
    try {
        const stdout = execSync('agy --version', { timeout: 10000 }).toString().trim();
        const match = stdout.match(/(\d+\.\d+\.\d+)/);
        return match ? match[1] : stdout;
    } catch (e) {
        console.error('[Auto-Update] Error retrieving installed agy version:', e.message);
        return null;
    }
}

async function fetchLatestAgyVersion() {
    try {
        const res = await fetch(AGY_MANIFEST_URL, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data.version || null;
    } catch (e) {
        console.warn(`[Auto-Update] Could not fetch manifest from ${AGY_MANIFEST_URL}: ${e.message}`);
        return null;
    }
}

async function performAgyUpdate() {
    const currentVersion = getInstalledAgyVersion();
    console.log(`[Auto-Update] Initiating Antigravity CLI update (current: ${currentVersion || 'unknown'})...`);
    let output = '';
    let success = false;

    // Try native "agy update" first
    try {
        output = execSync('agy update', { timeout: 120000 }).toString();
        success = true;
    } catch (err) {
        output = (err.stdout ? err.stdout.toString() : '') + (err.stderr ? err.stderr.toString() : '') + err.message;
        console.warn(`[Auto-Update] 'agy update' encountered an issue, trying installation script fallback: ${output}`);

        // Fallback: run official curl installer
        try {
            const installOutput = execSync('curl -fsSL https://antigravity.google/cli/install.sh | bash', { timeout: 120000 }).toString();
            output += '\n' + installOutput;
            success = true;
        } catch (installErr) {
            output += '\n' + (installErr.stdout ? installErr.stdout.toString() : '') + installErr.message;
            success = false;
        }
    }

    const newVersion = getInstalledAgyVersion();
    const updated = Boolean(currentVersion && newVersion && compareSemver(newVersion, currentVersion) > 0);

    return {
        success,
        previousVersion: currentVersion,
        newVersion: newVersion,
        updated,
        output: output.trim()
    };
}

async function checkAndApplyAgyUpdate(triggeredBy = 'scheduler') {
    autoUpdateState.lastCheck = new Date().toISOString();
    const currentVersion = getInstalledAgyVersion();
    autoUpdateState.currentVersion = currentVersion;

    console.log(`[Auto-Update] [${triggeredBy}] Checking for Antigravity CLI updates... (Current: ${currentVersion || 'unknown'})`);
    const latestVersion = await fetchLatestAgyVersion();
    autoUpdateState.latestVersion = latestVersion;

    if (!latestVersion) {
        autoUpdateState.lastResult = 'manifest-fetch-failed';
        console.warn(`[Auto-Update] [${triggeredBy}] Unable to retrieve latest version from manifest.`);
        return { updateAvailable: false, error: 'Could not fetch latest manifest', currentVersion, latestVersion };
    }

    const hasNewer = currentVersion ? (compareSemver(latestVersion, currentVersion) > 0) : false;

    if (!hasNewer) {
        autoUpdateState.lastResult = `up-to-date (v${currentVersion})`;
        console.log(`[Auto-Update] [${triggeredBy}] Antigravity CLI is up to date (v${currentVersion}).`);
        return { updateAvailable: false, currentVersion, latestVersion };
    }

    console.log(`[Auto-Update] [${triggeredBy}] Newer version available: v${latestVersion} (installed: v${currentVersion}). Updating...`);
    const result = await performAgyUpdate();
    if (result.success && result.updated) {
        autoUpdateState.lastResult = `updated from v${currentVersion} to v${result.newVersion}`;
        autoUpdateState.currentVersion = result.newVersion;
        console.log(`[Auto-Update] [${triggeredBy}] Successfully updated Antigravity CLI to v${result.newVersion}!`);
    } else if (result.success) {
        autoUpdateState.lastResult = `checked (v${result.newVersion})`;
        autoUpdateState.currentVersion = result.newVersion;
    } else {
        autoUpdateState.lastResult = `update-failed: ${result.output.substring(0, 100)}`;
        console.error(`[Auto-Update] [${triggeredBy}] Failed to update Antigravity CLI: ${result.output}`);
    }

    return { updateAvailable: true, ...result, currentVersion, latestVersion };
}

function initAutoUpdateScheduler() {
    if (!autoUpdateState.enabled) {
        console.log('[Auto-Update] Auto-update is disabled via configuration.');
        return;
    }

    const intervalMs = autoUpdateState.intervalHours * 60 * 60 * 1000;
    console.log(`[Auto-Update] Enabled: Scheduled daily checks every ${autoUpdateState.intervalHours} hours.`);

    // Perform initial check 30 seconds after server startup
    setTimeout(async () => {
        try {
            await checkAndApplyAgyUpdate('startup');
        } catch (e) {
            console.error('[Auto-Update] Startup check error:', e);
        }
    }, 30000);

    // Schedule periodic recurring checks
    autoUpdateState.timer = setInterval(async () => {
        try {
            await checkAndApplyAgyUpdate('daily-cron');
        } catch (e) {
            console.error('[Auto-Update] Periodic check error:', e);
        }
    }, intervalMs);
}

function formatToolStatus(toolName, params = {}) {
    switch (toolName) {
        case 'run_command': {
            const cmd = params.CommandLine || '';
            const trimmed = cmd.length > 280 ? cmd.substring(0, 280) + '...' : cmd;
            return `**Running command:**\n\`\`\`bash\n$ ${trimmed}\n\`\`\``;
        }
        case 'view_file': {
            const file = params.AbsolutePath ? path.basename(params.AbsolutePath) : 'file';
            const lines = params.StartLine ? ` (lines ${params.StartLine}-${params.EndLine || ''})` : '';
            return `**Viewing file:** \`${file}\`${lines}`;
        }
        case 'write_to_file': {
            const file = params.TargetFile ? path.basename(params.TargetFile) : 'file';
            return `**Writing file:** \`${file}\``;
        }
        case 'replace_file_content': {
            const file = params.TargetFile ? path.basename(params.TargetFile) : 'file';
            const desc = params.Instruction || params.Description || '';
            const descText = desc ? `\n> *${desc.length > 120 ? desc.substring(0, 120) + '...' : desc}*` : '';
            return `**Editing file:** \`${file}\`${descText}`;
        }
        case 'grep_search': {
            return `**Searching code:** \`${params.Query || ''}\``;
        }
        case 'find_by_name': {
            return `**Locating file:** \`${params.Pattern || ''}\``;
        }
        case 'generate_image': {
            const prompt = params.Prompt ? ` — *"${params.Prompt.substring(0, 80)}..."*` : '';
            return `**Generating image**${prompt}`;
        }
        default: {
            const summary = params.toolSummary || params.Description || '';
            return `**Executing tool:** \`${toolName}\`${summary ? ` — *${summary}*` : ''}`;
        }
    }
}

function formatToolSummary(toolName, params = {}) {
    switch (toolName) {
        case 'run_command': {
            const cmd = params.CommandLine || '';
            const trimmed = cmd.length > 35 ? cmd.substring(0, 35) + '...' : cmd;
            return `Run: \`$ ${trimmed}\``;
        }
        case 'view_file': {
            return `View: \`${path.basename(params.AbsolutePath || 'file')}\``;
        }
        case 'write_to_file': {
            return `Write: \`${path.basename(params.TargetFile || 'file')}\``;
        }
        case 'replace_file_content': {
            return `Edit: \`${path.basename(params.TargetFile || 'file')}\``;
        }
        case 'grep_search': {
            return `Search: \`"${params.Query || ''}"\``;
        }
        case 'find_by_name': {
            return `Find: \`"${params.Pattern || ''}"\``;
        }
        default: {
            return `Tool: \`${toolName}\``;
        }
    }
}

/**
 * Strips ANSI escape sequences and terminal control codes from a string.
 */
function stripAnsi(str) {
    if (!str || typeof str !== 'string') return str || '';
    return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\x1B\([B0-9]|\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Normalizes and prettifies markdown text for Rocket.Chat and chat clients.
 * - Strips ANSI codes
 * - Ensures markdown headers have space after # marks (e.g. "###Heading" -> "### Heading")
 * - Condenses 3+ consecutive newlines to double newlines
 * - Auto-closes unclosed code fences if output was cut off
 * - Truncates cleanly if exceeding maxLen
 */
function formatPrettyMarkdown(text, maxLen = 7000) {
    if (!text || typeof text !== 'string') return text || '';
    let clean = stripAnsi(text);

    // Normalize header markdown: ensure space after hash (e.g. "###Title" -> "### Title")
    clean = clean.replace(/^(#{1,6})([^#\s])/gm, '$1 $2');

    // Condense 3+ consecutive newlines down to 2
    clean = clean.replace(/\n{3,}/g, '\n\n');

    clean = clean.trim();

    if (clean.length > maxLen) {
        clean = clean.substring(0, maxLen) + '\n...[output truncated]';
    }

    // Fix unclosed code fences if any
    const codeFenceMatches = clean.match(/```/g);
    if (codeFenceMatches && codeFenceMatches.length % 2 !== 0) {
        clean += '\n```';
    }

    return clean;
}

/**
 * Creates a collapsible attachment for Rocket.Chat, Slack, or Mattermost.
 * In Rocket.Chat, `collapsed: true` natively renders a clickable expandable card.
 * @param {string} title - Header or title of the collapsible section
 * @param {string} content - Inner text or code
 * @param {string} [lang] - Language fence (e.g. 'json', 'text', 'bash')
 * @param {string} [color] - Left border hex color (e.g. '#ef4444', '#8b5cf6', '#64748b')
 */
function makeCollapsibleAttachment(title, content, lang = null, color = '#6366f1') {
    let clean = stripAnsi(content || '').trim();
    if (clean.length > 7000) {
        clean = clean.substring(0, 7000) + '\n...[truncated]';
    }
    let text = clean;
    if (lang) {
        text = `\`\`\`${lang}\n${clean}\n\`\`\``;
    }
    return {
        title: title || 'Details (click to expand)',
        text: text,
        collapsed: true,
        color: color
    };
}

/**
 * Formats terminal stdout from `bd list` into a clean, universally compatible bullet list.
 */
function formatBeadsList(stdout) {
    if (!stdout || !stdout.trim()) return 'ℹ️ No issues found in Beads.';
    const lines = stdout.split('\n');
    const issues = [];
    let summaryText = '';

    const statusMap = {
        '○': '⚪ Open',
        '◐': '🟡 In Progress',
        '●': '🔴 Blocked',
        '✓': '🟢 Closed',
        '❄': '❄️ Deferred'
    };

    for (const line of lines) {
        const trimmed = stripAnsi(line).trim();
        if (!trimmed || trimmed.startsWith('---') || trimmed.startsWith('Status:')) continue;
        if (trimmed.startsWith('Total:')) {
            summaryText = trimmed;
            continue;
        }

        const m = trimmed.match(/^([○◐●✓❄])\s+([a-zA-Z0-9_\-]+)\s+(?:[●○]\s+)?(P[0-9]+)\s+(.+)$/);
        if (m) {
            const [, sym, id, priority, title] = m;
            const status = statusMap[sym] || sym;
            issues.push({ status, id, priority, title });
        }
    }

    if (issues.length === 0) {
        return `**📋 Beads Issues:**\n\`\`\`text\n${stripAnsi(stdout).trim()}\n\`\`\``;
    }

    let out = `**📋 Current Beads Issues (${issues.length}):**\n\n`;
    for (const iss of issues) {
        out += `• ${iss.status} \`${iss.id}\` [${iss.priority}]\n`;
        out += `  └─ ${iss.title}\n\n`;
    }
    if (summaryText) {
        out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        out += `*${summaryText}*`;
    }
    return out;
}

/**
 * Formats raw JSONL transcript lines into a readable step timeline with summary.
 */
function formatTranscriptLog(jsonlRaw) {
    if (!jsonlRaw || !jsonlRaw.trim()) return { summary: 'No logs available for this conversation.', raw: '' };
    const lines = stripAnsi(jsonlRaw).trim().split('\n');
    const steps = [];

    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line.trim());
            const idx = entry.step_index !== undefined ? `#${entry.step_index}` : '•';
            const type = entry.type || entry.source || 'STEP';

            if (type === 'USER_INPUT' || entry.source === 'USER_EXPLICIT') {
                const text = (entry.content || '').trim();
                const preview = text.length > 80 ? text.substring(0, 77) + '...' : text;
                steps.push(`**${idx} 👤 User:** ${preview}`);
            } else if (entry.tool_calls && entry.tool_calls.length > 0) {
                for (const tc of entry.tool_calls) {
                    const name = tc.name || (tc.function && tc.function.name) || 'tool';
                    let info = '';
                    if (tc.args) {
                        if (tc.args.CommandLine) info = `: \`${tc.args.CommandLine.substring(0, 60)}\``;
                        else if (tc.args.TargetFile) info = `: \`${tc.args.TargetFile}\``;
                        else if (tc.args.AbsolutePath) info = `: \`${tc.args.AbsolutePath}\``;
                        else if (tc.args.query) info = `: "${tc.args.query}"`;
                    }
                    steps.push(`**${idx} 🔧 Tool:** \`${name}\`${info}`);
                }
            } else if (type === 'TOOL_RESPONSE') {
                const text = (entry.content || '').trim();
                const preview = text.length > 60 ? text.substring(0, 57) + '...' : text;
                steps.push(`**${idx} ⚙️ Result:** \`${preview.replace(/\n/g, ' ')}\``);
            } else if (type === 'PLANNER_RESPONSE' || entry.source === 'MODEL') {
                const text = (entry.content || '').trim();
                if (text) {
                    const preview = text.length > 90 ? text.substring(0, 87) + '...' : text;
                    steps.push(`**${idx} 🤖 AGY:** ${preview.replace(/\n/g, ' ')}`);
                }
            } else {
                steps.push(`**${idx} ℹ️ [${type}]**`);
            }
        } catch {
            // Non-JSON or incomplete line ignored in timeline
        }
    }

    let summary = `**📜 Conversation Timeline (Recent Steps):**\n\n`;
    if (steps.length === 0) {
        summary += `*(No structured steps parsed. View raw trace attachment below.)*\n`;
    } else {
        summary += steps.slice(-15).join('\n\n') + '\n';
    }

    return {
        summary,
        raw: jsonlRaw.trim()
    };
}

// Wrapper calls that delegate to the active chat provider adapter with pretty formatting and attachment support
const postMessage = (roomId, tmid, text, attachments = null) => {
    const formatted = formatPrettyMarkdown(text);
    return adapter.postMessage(roomId, tmid, formatted, attachments);
};
const updateMessage = (roomId, msgId, text, attachments = null) => {
    const formatted = formatPrettyMarkdown(text);
    return adapter.updateMessage(roomId, msgId, formatted, attachments);
};

async function pingOllama() {
    try {
        const startTime = Date.now();
        const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
        const latency = Date.now() - startTime;
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, latency };
        const data = await res.json();
        return { ok: true, latency, models: (data.models || []).map(m => m.name) };
    } catch (e) {
        return { ok: false, error: e.message, latency: -1 };
    }
}

async function listOllamaModels() {
    const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return data.models || [];
}

async function queryOllama(prompt, options = {}) {
    const model = options.model || ollamaModel;
    const body = {
        model,
        prompt,
        stream: false
    };
    if (options.system) body.system = options.system;
    if (options.think !== undefined) body.think = options.think;

    const res = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs || 60000)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Ollama HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return {
        text: data.response || '',
        thinking: data.thinking || '',
        model: data.model || model,
        totalDuration: data.total_duration
    };
}

/**
 * Classifies a prompt into 'light' (can offload to local Ollama) vs 'heavy' (needs full AGY workspace tools).
 */
function classifyTask(prompt) {
    const text = (prompt || '').trim();

    // Forced overrides
    if (/^(?:force-agy|full|agy)\s+/i.test(text)) return 'heavy';
    if (/^(?:force-ollama|ollama|ask)\s+/i.test(text)) return 'light';

    // Patterns indicating code/workspace manipulation, bash commands, tests, builds, beads, git
    const heavyPatterns = [
        /\b(?:fix|implement|refactor|debug|build|compile)\b/i,
        /\b(?:create|make|write|edit|update|delete|remove|modify)\s+(?:a\s+)?(?:file|code|component|function|class|test|script|endpoint)\b/i,
        /\b(?:run|execute)\s+(?:command|script|test|build|npm|yarn|cargo|docker|bash)\b/i,
        /\b(?:git\s+|commit|push|pull|merge|branch|checkout|stash)\b/i,
        /\b(?:docker|docker-compose|dockerfile|container)\b/i,
        /\b(?:beads|bd\s+|issue|epic)\b/i,
        /\b[a-zA-Z0-9_\-\.]+\.(?:js|ts|jsx|tsx|json|yml|yaml|md|py|go|rs|sh|css|html)\b/i,
        /`{1,3}[\s\S]*?`{1,3}/ // Inline or fenced code blocks often mean refactoring/fixing code
    ];

    // Context patterns: conversation history, previous tasks/actions, threads, workspace context
    // These must ALWAYS route to AGY so full conversation memory & workspace state are available.
    const contextHeavyPatterns = [
        /\b(?:conversation|conversations|thread|threads|session|sessions|history|transcript)\b/i,
        /\b(?:what\s+did\s+we|what\s+was\s+the|last\s+task|last\s+step|last\s+action|last\s+prompt|what\s+have\s+we\s+done)\b/i,
        /\b(?:what\s+are\s+we\s+working\s+on|current\s+task|project\s+status|workspace\s+status)\b/i,
        /\b(?:what\s+files|list\s+files|show\s+files|find\s+files|in\s+this\s+repo|in\s+this\s+workspace)\b/i,
        /\b(?:remember|recall|secret\s+word|previous|earlier)\b/i,
        /\b(?:antigravity|agy|who\s+are\s+you|what\s+tools|which\s+tools)\b/i
    ];

    for (const pattern of contextHeavyPatterns) {
        if (pattern.test(text)) {
            return 'heavy';
        }
    }

    // Patterns indicating informational questions, explanations, summaries, or conversational queries
    const lightPatterns = [
        /^(?:what|why|how|who|when|where|which|whose)\b/i,
        /^(?:can\s+you\s+explain|explain|describe|tell\s+me\s+about|what's\s+the\s+difference|compare)\b/i,
        /^(?:summarize|translate|format|suggest|draft|rephrase|proofread|calculate)\b/i,
        /^(?:hello|hi|hey|good\s+morning|good\s+evening|ping|status)\b/i,
        /\?$/ // Ends with question mark
    ];

    for (const pattern of lightPatterns) {
        if (pattern.test(text)) {
            return 'light';
        }
    }

    // If text is short (< 80 chars) and has no heavy verbs, treat as light question/chat
    if (text.length < 80 && !/\b(?:run|write|build|fix|test|git)\b/i.test(text)) {
        return 'light';
    }

    // Default to heavy (safe bet: route to AGY agent)
    return 'heavy';
}

// Configurable and default refusal keywords/patterns for local Ollama fallback to AGY
const OLLAMA_FALLBACK_KEYWORDS = (process.env.OLLAMA_FALLBACK_KEYWORDS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

const DEFAULT_REFUSAL_STRINGS = [
    "i'm sorry, but i can't help with that request",
    "i'm sorry, but i cannot help with that request",
    "i am sorry, but i cannot help with that request",
    "i apologize, but i can't help with that request",
    "i apologize, but i cannot help with that request",
    "i cannot fulfill this request",
    "i'm unable to fulfill this request",
    "i am unable to fulfill this request",
    "i cannot assist with this request",
    "i am unable to assist with this request",
    "i can't assist with this request",
    "i cannot help with this request",
    "i can't help with that request"
];

const DEFAULT_REFUSAL_PATTERNS = [
    /I(?:'m| am) sorry,?(?: but)? I (?:can't|cannot|am unable to) help with that request/i,
    /I apologize,?(?: but)? I (?:can't|cannot|am unable to) help with that request/i,
    /I (?:cannot|can't|am unable to) (?:fulfill|complete|process|assist with) this request/i,
    /I (?:cannot|can't|am unable to) help with (?:that|this) (?:request|task|question)/i,
    /I(?:'m| am) sorry,?(?: but)? I (?:cannot|can't|am unable to) (?:assist|help|fulfill|do that)/i,
    /I apologize,?(?: but)? I (?:cannot|can't|am unable to) (?:assist|help|fulfill|do that)/i,
    /As an AI(?: language model)?, I (?:cannot|can't|am unable to|do not have|don't have)/i,
    /As a language model, I (?:cannot|can't|am unable to|do not have|don't have)/i,
    /I (?:don't|do not) have access to (?:your |the )?(?:workspace|filesystem|system|tools|real-time|files)/i,
    /I (?:don't|do not) have (?:the )?(?:ability|tools|capability|permissions) to/i,
    /I (?:cannot|can't) (?:access|view|edit|modify|run) (?:files|directories|commands|scripts|tools) in (?:your|the) (?:workspace|system|environment)/i,
    /I (?:do not|don't) have (?:real-time|current|up-to-date) (?:information|access|data)/i
];

function isOllamaRefusal(text, customKeywords = []) {
    if (!text || !text.trim()) {
        return { isRefusal: true, reason: 'Empty response', matched: 'empty response' };
    }

    const clean = text.trim();
    const lower = clean.toLowerCase();

    // Check custom strings from environment or options
    const allCustom = [...OLLAMA_FALLBACK_KEYWORDS, ...customKeywords];
    for (const kw of allCustom) {
        if (kw && lower.includes(kw.toLowerCase().trim())) {
            return { isRefusal: true, reason: 'Custom keyword match', matched: kw };
        }
    }

    // Check literal refusal strings
    for (const phrase of DEFAULT_REFUSAL_STRINGS) {
        if (lower.includes(phrase)) {
            return { isRefusal: true, reason: 'Refusal phrase', matched: phrase };
        }
    }

    // Check regex patterns against first 600 chars where refusals typically manifest
    const sample = clean.substring(0, 600);
    for (const pattern of DEFAULT_REFUSAL_PATTERNS) {
        const m = sample.match(pattern);
        if (m) {
            return { isRefusal: true, reason: 'Refusal pattern match', matched: m[0] };
        }
    }

    return { isRefusal: false };
}

async function executeOllamaMessage(roomId, tmid, promptText, customModel = null, fallbackToAgy = null) {
    const targetModel = customModel || ollamaModel;
    const thinkingMsgId = await postMessage(roomId, tmid, `\`⠋\` *Offloading to local Ollama (${targetModel})...*`);
    const startTime = Date.now();

    try {
        const result = await queryOllama(promptText, { model: targetModel });

        // In Hybrid mode, detect if local model refused, declined, or was unable to answer
        if (fallbackToAgy) {
            const refusalCheck = isOllamaRefusal(result.text);
            if (refusalCheck.isRefusal) {
                const matchedSnippet = refusalCheck.matched.length > 60
                    ? refusalCheck.matched.substring(0, 57) + '...'
                    : refusalCheck.matched;
                console.log(`[Rocket-Grav] Local Ollama declined/unable to answer (${refusalCheck.reason}: "${refusalCheck.matched}"). Falling back to frontier AGY...`);
                if (thinkingMsgId) {
                    await updateMessage(roomId, thinkingMsgId, `\`⠋\` *Local Ollama declined or unable to answer ("${matchedSnippet}"). Falling back to frontier Antigravity (AGY)...*`);
                }
                return fallbackToAgy(thinkingMsgId);
            }
        }

        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
        let reply = `[⚡ **Local Ollama** (\`${targetModel}\` • ${elapsedSec}s)]\n\n${result.text}`;
        let attachments = [];
        if (result.thinking && result.thinking.trim()) {
            attachments.push(makeCollapsibleAttachment(
                `💭 Thought Process (${targetModel} • click to expand)`,
                result.thinking.trim(),
                null,
                '#8b5cf6'
            ));
        }

        if (thinkingMsgId) {
            await updateMessage(roomId, thinkingMsgId, reply, attachments.length > 0 ? attachments : null);
        } else {
            await postMessage(roomId, tmid, reply, attachments.length > 0 ? attachments : null);
        }
    } catch (err) {
        console.error(`[Rocket-Grav] Ollama error: ${err.message}`);
        if (fallbackToAgy) {
            console.log(`[Rocket-Grav] Falling back to AGY for prompt: "${promptText}"`);
            if (thinkingMsgId) {
                await updateMessage(roomId, thinkingMsgId, `\`⠋\` *Local Ollama unavailable (${err.message}). Falling back to Antigravity (AGY)...*`);
            }
            fallbackToAgy(thinkingMsgId);
        } else {
            const errReply = `**Ollama Error:** ${err.message}\nMake sure your Ollama instance at \`${ollamaUrl}\` is reachable.`;
            if (thinkingMsgId) {
                await updateMessage(roomId, thinkingMsgId, errReply);
            } else {
                await postMessage(roomId, tmid, errReply);
            }
        }
    }
}

// System instructions for Ollama prompt refinement
const PROMPT_REFINER_SYSTEM = `You are an expert prompt engineer and software architect assisting an autonomous coding agent (Antigravity CLI).
Your task is to analyze the user's prompt and refine it into a clear, precise, actionable, and technically comprehensive prompt.

Guidelines:
1. Preserve the user's original intent, requirements, and chosen technologies.
2. If the prompt is already clear, detailed, and actionable, return it unchanged.
3. If the prompt is brief, vague, or missing crucial context, expand it with specific technical requirements, edge cases, expected inputs/outputs, and implementation scope.
4. Output ONLY the refined prompt text. Do NOT include any preamble (e.g. "Here is the refined prompt:"), conversational filler, explanations, or enclosing quotes.`;

async function refinePromptWithOllama(promptText, model = null) {
    const targetModel = model || ollamaModel;
    const startTime = Date.now();
    try {
        const res = await queryOllama(promptText, {
            model: targetModel,
            system: PROMPT_REFINER_SYSTEM,
            think: false,
            timeoutMs: 30000
        });

        let refined = (res.text || '').trim();

        // Strip surrounding quotes if present
        refined = refined.replace(/^["'`]+|["'`]+$/g, '').trim();

        // Check for refusal or empty output
        const refusal = isOllamaRefusal(refined);
        if (refusal.isRefusal || !refined) {
            console.warn(`[Prompt-Refiner] Ollama returned refusal or empty output (${refusal.matched || 'empty'}). Using original prompt.`);
            return {
                success: false,
                originalPrompt: promptText,
                refinedPrompt: promptText,
                isModified: false,
                latencySec: ((Date.now() - startTime) / 1000).toFixed(1),
                reason: 'refusal_or_empty'
            };
        }

        const isModified = refined.toLowerCase() !== promptText.toLowerCase().trim();
        const latencySec = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Prompt-Refiner] Refined prompt in ${latencySec}s (${isModified ? 'modified' : 'unchanged'}): "${refined.substring(0, 80)}..."`);

        return {
            success: true,
            originalPrompt: promptText,
            refinedPrompt: isModified ? refined : promptText,
            isModified,
            latencySec
        };
    } catch (err) {
        console.warn(`[Prompt-Refiner] Failed to refine prompt with Ollama: ${err.message}. Using original prompt.`);
        return {
            success: false,
            originalPrompt: promptText,
            refinedPrompt: promptText,
            isModified: false,
            latencySec: ((Date.now() - startTime) / 1000).toFixed(1),
            error: err.message
        };
    }
}

async function runAgySession(roomId, tmid, messageText, existingMsgId = null, extraContext = null) {
    // Post the placeholder spinner message if not already existing
    let thinkingMsgId = existingMsgId;
    if (!thinkingMsgId) {
        thinkingMsgId = await postMessage(roomId, tmid, "`⠋` *AGY is thinking...*");
        if (!thinkingMsgId) {
            console.warn(`[Rocket-Grav] Warning: Failed to send initial placeholder message to room ${roomId}. Check bot credentials (ROCKETCHAT_USER_ID, ROCKETCHAT_PAT) and ROCKETCHAT_URL.`);
        }
    }
    
    // Setup animation loop
    let isFinished = false;
    let currentStatus = "*Initializing...*";
    let recentActions = [];
    let currentToolParams = {};
    let lastRenderedMessage = "";

    const buildStatusMessage = (spinnerFrame) => {
        let msg = `\`${spinnerFrame}\` ${currentStatus}`;
        if (recentActions.length > 0) {
            msg += `\n\n*Completed actions:*\n` + recentActions.map(act => `• ${act}`).join('\n');
        }
        return msg;
    };

    if (thinkingMsgId) {
        const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        let frameIdx = 0;
        
        const animate = async () => {
            if (isFinished) return;
            
            const message = buildStatusMessage(frames[frameIdx]);
            if (message !== lastRenderedMessage) {
                lastRenderedMessage = message;
                await updateMessage(roomId, thinkingMsgId, message);
            }
            
            frameIdx = (frameIdx + 1) % frames.length;
            
            if (!isFinished) setTimeout(animate, 600);
        };
        setTimeout(animate, 600);
    }

    // Standard AGY execution
    const data = getThreads();
    const activeThreadName = data.active_thread;
    const convId = data.threads[activeThreadName];

    const commandArgs = ['-p', messageText, '--output-format', 'stream-json', '--dangerously-skip-permissions'];
    if (currentModel) {
        commandArgs.push('--model', currentModel);
    }
    if (convId) {
        commandArgs.unshift(convId);
        commandArgs.unshift('--conversation');
    }

    const executeAgy = (attempt = 1) => {
        console.log(`Executing (Attempt ${attempt}/3): agy ${commandArgs.join(' ')}`);
        const child = spawn('agy', commandArgs, { cwd: '/workspace', shell: false });
        if (convId) activeProcesses[convId] = child;
        
        let finalResultObj = null;
        let rawOutput = '';
        let imageGenerationCount = 0;

        child.stdout.on('data', (d) => {
            const text = d.toString();
            rawOutput += text;
            const lines = text.split('\n');
            for (let line of lines) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.event === 'step_update' && parsed.step_update) {
                        if (parsed.step_update.step_type === 'tool') {
                            if (parsed.step_update.state === 'ACTIVE') {
                                const toolName = parsed.step_update.tool_name;
                                currentToolParams = (parsed.step_update.tool_info && parsed.step_update.tool_info.parameters) || {};
                                currentStatus = formatToolStatus(toolName, currentToolParams);
                                process.stdout.write(`\x1b[36m\n[Tool Call: ${toolName}]\x1b[0m\n`);
                                if (currentToolParams && Object.keys(currentToolParams).length > 0) {
                                    process.stdout.write(`\x1b[90m${JSON.stringify(currentToolParams)}\x1b[0m\n`);
                                }
                                // Intercept ask_question to display to user
                                if (toolName === 'ask_question' && currentToolParams.questions) {
                                    let promptText = `**AGY has a question:**\n\n`;
                                    currentToolParams.questions.forEach(q => {
                                        promptText += `*${q.question}*\n`;
                                        if (q.options) {
                                            q.options.forEach((opt, i) => promptText += `  ${i+1}. ${opt}\n`);
                                        }
                                    });
                                    promptText += `\n*(Reply using \`!agy reply <your answer>\`)*`;
                                    postMessage(roomId, tmid, promptText);
                                }
                            } else if (parsed.step_update.state === 'DONE') {
                                const toolName = parsed.step_update.tool_name;
                                if (toolName === 'generate_image') {
                                    imageGenerationCount++;
                                }
                                const summary = formatToolSummary(toolName, currentToolParams);
                                recentActions.push(summary);
                                if (recentActions.length > 3) recentActions.shift();
                                currentStatus = "*Thinking / Planning next action...*";
                                process.stdout.write(`\x1b[32m[Tool Finished: ${toolName}]\x1b[0m\n`);
                            }
                        } else if (parsed.step_update.thinking_delta) {
                            if (!currentStatus.startsWith('*Thinking')) {
                                currentStatus = "*Thinking / Planning next action...*";
                            }
                            process.stdout.write(`\x1b[90m${parsed.step_update.thinking_delta}\x1b[0m`);
                        } else if (parsed.step_update.text_delta) {
                            currentStatus = "*Writing response...*";
                            process.stdout.write(parsed.step_update.text_delta);
                        }
                    } else if (parsed.event === 'result') {
                        finalResultObj = parsed.result;
                    } else if (parsed.event === 'init') {
                        if (parsed.conversation_id) {
                            activeProcesses[parsed.conversation_id] = child;
                            updateThreadConvId(activeThreadName, parsed.conversation_id);
                        }
                        process.stdout.write(`\x1b[32m\n[AGY Initialized - Conversation UUID: ${parsed.conversation_id}]\x1b[0m\n`);
                    }
                } catch(e) {
                    process.stdout.write(line + '\n');
                }
            }
        });

        child.stderr.on('data', (d) => {
            const text = d.toString();
            process.stderr.write(text);
        });

        child.on('error', async (error) => {
            isFinished = true;
            console.error(`Spawn error: ${error.message}`);
            const attachments = [
                makeCollapsibleAttachment('🔍 Process Spawn Error Trace', error.stack || error.message, 'text', '#ef4444')
            ];
            if (thinkingMsgId) {
                await updateMessage(roomId, thinkingMsgId, `❌ **Antigravity CLI Process Spawn Error**\n${error.message}`, attachments);
            } else {
                await postMessage(roomId, tmid, `❌ **Antigravity CLI Process Spawn Error**\n${error.message}`, attachments);
            }
        });

        child.on('close', async (code) => {
            console.log(`\nCommand exited with code ${code}`);
            
            if (finalResultObj && finalResultObj.conversation_id) {
                delete activeProcesses[finalResultObj.conversation_id];
            } else if (convId) {
                delete activeProcesses[convId];
            }

            let hasError = false;
            if (code !== 0) hasError = true;
            if (finalResultObj && finalResultObj.error) hasError = true;

            if (hasError && attempt < 3) {
                currentStatus = `Command failed. Retrying (Attempt ${attempt + 1}/3)...`;
                console.log(currentStatus);
                setTimeout(() => executeAgy(attempt + 1), 2000);
                return;
            }

            isFinished = true;
            let finalOutput = '';
            let attachments = [];

            if (finalResultObj) {
                if (finalResultObj.conversation_id) {
                    updateThreadConvId(activeThreadName, finalResultObj.conversation_id);
                }
                if (finalResultObj.response) {
                    finalOutput = finalResultObj.response;
                } else if (finalResultObj.error) {
                    finalOutput = `❌ **Antigravity CLI Error**\n${finalResultObj.error}`;
                } else {
                    finalOutput = JSON.stringify(finalResultObj, null, 2);
                }

                if (finalResultObj.error || hasError) {
                    const traceSnippet = rawOutput.trim() ? rawOutput.substring(Math.max(0, rawOutput.length - 2500)) : '';
                    if (traceSnippet) {
                        attachments.push(makeCollapsibleAttachment(
                            '🔍 Raw Trace Details (click to expand)',
                            traceSnippet,
                            'json',
                            '#ef4444'
                        ));
                    }
                }
            } else {
                finalOutput = `❌ **Antigravity Exited Abruptly** (Exit code: \`${code}\`)\nCheck container logs or expand the diagnostic trace below.`;
                const traceSnippet = rawOutput.trim() ? rawOutput.substring(Math.max(0, rawOutput.length - 2500)) : '(No output captured)';
                attachments.push(makeCollapsibleAttachment(
                    '🔍 Raw Trace Details (click to expand)',
                    traceSnippet,
                    'json',
                    '#ef4444'
                ));
            }

            if (imageGenerationCount > 0) {
                // Text queries are covered by Antigravity subscription ($0)
                // We only bill for generated images via GCP API (~$0.03 per image)
                const imageCost = imageGenerationCount * 0.03;
                finalOutput += `\n\n*(Estimated GCP API cost for ${imageGenerationCount} image(s): $${imageCost.toFixed(4)})*`;
            }

            if (extraContext && extraContext.wasRefined) {
                finalOutput = `> 💡 **Refined Prompt (${extraContext.latencySec}s):** *${extraContext.refinedPrompt}*\n\n` + finalOutput;
            }

            if (thinkingMsgId) {
                await updateMessage(roomId, thinkingMsgId, finalOutput, attachments.length > 0 ? attachments : null);
            } else {
                await postMessage(roomId, tmid, finalOutput, attachments.length > 0 ? attachments : null);
            }
        });
    };

    executeAgy(1);
}

// Middleware to filter requests by IP
const ipFilter = (req, res, next) => {
    if (process.env.DISABLE_IP_FILTER === 'true') {
        return next();
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const envAllowed = process.env.ALLOWED_IPS 
        ? process.env.ALLOWED_IPS.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    
    // Allow localhost, standard private networks (RFC1918), and Docker subnets by default
    const isAllowed = 
        envAllowed.includes('*') ||
        clientIp.includes('127.0.0.1') || 
        clientIp.includes('::1') ||
        clientIp.includes('192.168.') ||
        clientIp.includes('10.') ||
        clientIp.startsWith('::ffff:172.') || 
        clientIp.startsWith('172.') ||
        envAllowed.some(allowed => clientIp.includes(allowed) || clientIp.startsWith(allowed));
        
    if (!isAllowed) {
        console.warn(`[Rocket-Grav] Blocked request from unauthorized IP: ${clientIp}`);
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
};

app.use(ipFilter);

app.post('/webhook', async (req, res) => {
    // Handle Slack URL challenge if applicable
    if (req.body && req.body.type === 'url_verification') {
        return res.json({ challenge: req.body.challenge });
    }

    if (!adapter.verifyRequest(req)) {
        console.warn(`Unauthorized request received on ${adapter.name} adapter (invalid token/signature).`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Acknowledge the webhook immediately so chat platform doesn't time out
    res.json({}); 

    const { text: rawText, roomId, tmid } = adapter.extractPayload(req);

    let messageText = rawText || '';
    messageText = messageText.replace(/^(?:@\w+|!\w+)\s+/, '').trim();

    if (!messageText) {
        await postMessage(roomId, tmid, "Please provide a prompt.");
        return;
    }

    console.log(`\n--- NEW REQUEST ---`);
    console.log(`Received prompt: ${messageText}`);

    if (messageText === 'help') {
        const helpText = `**AGY Bridge Commands**
*   \`!agy <prompt>\` - Send a prompt (auto-routed in Hybrid mode: light tasks/questions → local Ollama; complex code/tools → AGY)
*   \`!agy /refine <prompt>\` (or \`<prompt> /refine\`) - Refine & optimize prompt using local Ollama prior to AGY execution
*   \`!agy mode\` - Show current bridge operating mode and Ollama connection status
*   \`!agy mode <hybrid|agy|ollama>\` - Switch bridge mode (e.g. \`!agy mode hybrid\`, \`!agy mode agy\`)
*   \`!agy ollama <prompt>\` (or \`!ollama\`, \`!ask\`) - Send prompt directly to local Ollama
*   \`!agy ollama list\` (or \`models\`) - List available models on local Ollama
*   \`!agy ollama switch <name>\` - Switch active Ollama model (e.g. \`qwen3.5:4b\`, \`phi4-mini:latest\`)
*   \`!agy ollama ping\` - Test connectivity and latency to local Ollama instance
*   \`!agy full <prompt>\` - Force execution through full AGY CLI (bypass Ollama offloading)
*   \`!agy reply <answer>\` - Reply to an interactive question asked by AGY
*   \`!agy model\` - Show the current AGY model
*   \`!agy model list\` (or \`models\`) - List available AGY models
*   \`!agy model switch <name>\` - Switch AGY model (e.g. \`claude\`, \`flash\`, \`gemini\`, \`default\`)
*   \`!agy conversations\` (or \`convs\`) - List recent AGY conversations with numbers & titles
*   \`!agy switch <name|#num|uuid>\` - Switch active thread or resume an AGY conversation
*   \`!agy thread\` (or \`conv\`) - Show status of active thread and bound conversation
*   \`!agy thread list\` (or \`threads\`) - List all named threads
*   \`!agy thread new <name>\` - Create and switch to a new fresh thread
*   \`!agy thread reset [name]\` - Reset a thread's conversation memory
*   \`!agy thread delete <name>\` - Delete a named thread
*   \`!agy log\` - Show recent transcript logs of the active conversation
*   \`!agy context\` (or \`!context\`, \`tokens\`) - Show context window usage & token capacity progress bar
*   \`!agy issues\` (or \`beads\`) - List all open beads issues
*   \`!agy version\` - Show installed Antigravity CLI version and update status
*   \`!agy update\` (or \`upgrade\`) - Manually check and update Antigravity CLI to latest version
*   \`!agy help\` - Show this help message`;
        await postMessage(roomId, tmid, helpText);
        return;
    }

    if (messageText.toLowerCase() === 'version' || messageText.toLowerCase() === 'agy version') {
        const current = getInstalledAgyVersion() || 'Unknown';
        const latest = await fetchLatestAgyVersion();
        const hasUpdate = (current && latest) ? (compareSemver(latest, current) > 0) : false;
        
        let reply = `**Antigravity CLI Version Info:**\n` +
            `*   **Installed Version:** \`${current}\`\n` +
            `*   **Latest Available:** \`${latest || 'Unknown'}\`\n` +
            `*   **Auto-Update Status:** ${autoUpdateState.enabled ? `Enabled (daily check every ${autoUpdateState.intervalHours}h)` : 'Disabled'}\n` +
            `*   **Last Auto-Check:** ${autoUpdateState.lastCheck ? new Date(autoUpdateState.lastCheck).toLocaleString() : 'Never'}\n` +
            `*   **Last Status:** \`${autoUpdateState.lastResult}\`\n` +
            `*   **Status:** ${hasUpdate ? `⚡ **Update available!** Run \`!agy update\` to upgrade immediately.` : `✓ Antigravity CLI is up to date.`}`;
        
        await postMessage(roomId, tmid, reply);
        return;
    }

    if (messageText.toLowerCase() === 'update' || messageText.toLowerCase() === 'upgrade' || messageText.toLowerCase() === 'agy update') {
        const thinkingMsgId = await postMessage(roomId, tmid, "`⠋` *Checking for Antigravity CLI updates...*");
        try {
            const checkResult = await checkAndApplyAgyUpdate('manual-chat');
            let reply = '';
            if (checkResult.updateAvailable && checkResult.updated) {
                reply = `[✓] **Antigravity CLI updated successfully!**\n* Previous version: \`${checkResult.previousVersion}\`\n* New version: \`${checkResult.newVersion}\``;
            } else if (!checkResult.updateAvailable && checkResult.currentVersion) {
                reply = `[✓] **Antigravity CLI is already up to date:** \`${checkResult.currentVersion}\` (Latest: \`${checkResult.latestVersion || checkResult.currentVersion}\`).`;
            } else if (checkResult.error) {
                reply = `[✗] **Update check failed:** ${checkResult.error}`;
            } else {
                reply = `[✓] Antigravity CLI check completed: \`${checkResult.newVersion || checkResult.currentVersion}\``;
            }
            if (thinkingMsgId) {
                await updateMessage(roomId, thinkingMsgId, reply);
            } else {
                await postMessage(roomId, tmid, reply);
            }
        } catch (err) {
            const errReply = `[✗] **Error updating Antigravity CLI:** ${err.message}`;
            if (thinkingMsgId) {
                await updateMessage(roomId, thinkingMsgId, errReply);
            } else {
                await postMessage(roomId, tmid, errReply);
            }
        }
        return;
    }

    if (messageText.toLowerCase() === 'model') {
        await postMessage(roomId, tmid, `Current model: **${currentModel || 'default (subscription)'}**`);
        return;
    }

    if (messageText.toLowerCase() === 'models' || messageText.toLowerCase() === 'model list') {
        let reply = '**Available Models:**\n';
        reply += '| Shortcut | Full Model ID |\n|---|---|\n';
        for (const [alias, modelId] of Object.entries(MODEL_ALIASES)) {
            reply += `| \`${alias}\` | ${modelId || '*(subscription default)*'} |\n`;
        }
        reply += `\nCurrent: **${currentModel || 'default (subscription)'}**`;
        reply += `\nSwitch with: \`!agy model switch <name>\``;
        await postMessage(roomId, tmid, reply);
        return;
    }

    if (messageText.toLowerCase().startsWith('model switch ') || messageText.toLowerCase().startsWith('model use ')) {
        const requestedModel = messageText.split(' ').slice(2).join(' ').trim().toLowerCase();
        if (MODEL_ALIASES.hasOwnProperty(requestedModel)) {
            currentModel = MODEL_ALIASES[requestedModel];
            await postMessage(roomId, tmid, `[✓] Switched to: **${currentModel || 'default (subscription)'}**`);
        } else {
            // Assume they passed a full model ID directly
            currentModel = requestedModel;
            await postMessage(roomId, tmid, `[✓] Switched to: **${currentModel}**\n*(Note: using raw model ID — make sure this is valid)*`);
        }
        return;
    }

    if (messageText.toLowerCase().startsWith('reply ') || messageText.toLowerCase().startsWith('answer ')) {
        const data = getThreads();
        const convId = data.threads[data.active_thread];
        if (convId && activeProcesses[convId]) {
            const answer = messageText.split(' ').slice(1).join(' ');
            activeProcesses[convId].stdin.write(answer + '\n');
            await postMessage(roomId, tmid, `Sent reply: **${answer}**`);
        } else {
            await postMessage(roomId, tmid, 'No active process found for this thread to reply to.');
        }
        return;
    }

    if (messageText.toLowerCase() === 'issues' || messageText.toLowerCase() === 'beads') {
        try {
            const { execFileSync } = require('child_process');
            if (!fs.existsSync('/workspace/.beads')) {
                await postMessage(roomId, tmid, 'ℹ️ No Beads project initialized in `/workspace` yet.');
                return;
            }
            const bdPath = fs.existsSync('/usr/local/bin/bd') ? '/usr/local/bin/bd' : 'bd';
            const stdout = execFileSync(bdPath, ['list'], { cwd: '/workspace' }).toString();
            const prettyTable = formatBeadsList(stdout);
            await postMessage(roomId, tmid, prettyTable);
        } catch (e) {
            const errOut = e.stdout ? e.stdout.toString() : e.message;
            const attachments = [
                makeCollapsibleAttachment('🔍 Beads Error Trace', errOut, 'text', '#ef4444')
            ];
            await postMessage(roomId, tmid, `❌ **Error retrieving Beads issues**`, attachments);
        }
        return;
    }

    if (messageText === 'log' || messageText === 'logs') {
        const data = getThreads();
        const convId = data.threads[data.active_thread];
        if (!convId) {
            await postMessage(roomId, tmid, 'No active conversation found for this thread.');
            return;
        }
        
        const candidateLogPaths = [
            path.join(process.env.HOME || '', `.gemini/antigravity-cli/brain/${convId}/.system_generated/logs/transcript.jsonl`),
            `/root/.gemini/antigravity-cli/brain/${convId}/.system_generated/logs/transcript.jsonl`,
            path.join(os.homedir(), `.gemini/antigravity-cli/brain/${convId}/.system_generated/logs/transcript.jsonl`)
        ].filter(Boolean);

        const logPath = candidateLogPaths.find(p => fs.existsSync(p));
        if (!logPath) {
            await postMessage(roomId, tmid, 'Log file not found. Have you sent a prompt in this thread yet?');
            return;
        }
        
        const thinkingMsgId = await postMessage(roomId, tmid, "`⠋` *Fetching conversation logs...*");
        const { exec } = require('child_process');
        exec(`tail -n 25 "${logPath}"`, async (error, stdout) => {
            if (error) {
                if (thinkingMsgId) {
                    await updateMessage(roomId, thinkingMsgId, `❌ **Error reading logs:** ${error.message}`);
                }
                return;
            }

            const parsed = formatTranscriptLog(stdout);
            const attachments = [
                makeCollapsibleAttachment(
                    '📄 Raw JSONL Log (click to expand)',
                    parsed.raw.length > 5000 ? parsed.raw.substring(0, 5000) + '\n...[truncated]' : parsed.raw,
                    'json',
                    '#64748b'
                )
            ];

            if (thinkingMsgId) {
                await updateMessage(roomId, thinkingMsgId, parsed.summary, attachments);
            } else {
                await postMessage(roomId, tmid, parsed.summary, attachments);
            }
        });
        return;
    }

    const lowerMessage = messageText.toLowerCase().trim();

    // Context Window & Token Capacity Telemetry
    if (
        lowerMessage === 'context' ||
        lowerMessage === 'agy context' ||
        lowerMessage === 'tokens' ||
        lowerMessage === 'usage' ||
        lowerMessage === 'context usage' ||
        lowerMessage === 'token usage'
    ) {
        const usageData = formatContextUsage();
        await postMessage(roomId, tmid, usageData.reply);
        return;
    }

    // 1. List AGY Conversations
    if (
        lowerMessage === 'conversations' ||
        lowerMessage === 'conversation list' ||
        lowerMessage === 'convs' ||
        lowerMessage === 'conv list' ||
        lowerMessage === 'list conversations' ||
        lowerMessage === 'previous conversations' ||
        lowerMessage === 'show conversations' ||
        lowerMessage === 'show previous conversations'
    ) {
        const reply = formatConversationList();
        await postMessage(roomId, tmid, reply);
        return;
    }

    // 2. Active Thread & Conversation Status
    if (
        lowerMessage === 'thread' ||
        lowerMessage === 'thread status' ||
        lowerMessage === 'thread info' ||
        lowerMessage === 'conversation' ||
        lowerMessage === 'conv' ||
        lowerMessage === 'current thread' ||
        lowerMessage === 'current conversation'
    ) {
        const reply = formatThreadStatus();
        await postMessage(roomId, tmid, reply);
        return;
    }

    // 3. List Managed Threads
    if (
        lowerMessage === 'threads' ||
        lowerMessage === 'thread list' ||
        lowerMessage === 'threads list' ||
        lowerMessage === 'list threads' ||
        lowerMessage === 'show threads' ||
        lowerMessage === 'list' ||
        lowerMessage === 'ls' ||
        lowerMessage === 'list all'
    ) {
        const reply = formatThreadList();
        await postMessage(roomId, tmid, reply);
        return;
    }

    // 4. Create New Thread
    const threadNewMatch = messageText.match(/^(?:thread\s+new|new\s+thread)\s+([a-zA-Z0-9_\-\.]+)/i);
    if (threadNewMatch) {
        const newName = threadNewMatch[1].trim();
        const res = resolveSwitchTarget(newName);
        await postMessage(roomId, tmid, res.message || `[✗] ${res.error}`);
        return;
    }

    // 5. Reset Thread
    const threadResetMatch = messageText.match(/^(?:thread\s+reset|reset\s+thread)(?:\s+([a-zA-Z0-9_\-\.]+))?/i);
    if (threadResetMatch) {
        const targetName = threadResetMatch[1] ? threadResetMatch[1].trim() : null;
        const resetName = resetThread(targetName);
        await postMessage(roomId, tmid, `[✓] **Thread reset:** \`${resetName}\`\n*(Conversation unlinked; a fresh session will start on your next prompt)*`);
        return;
    }

    // 6. Delete Thread
    const threadDeleteMatch = messageText.match(/^(?:thread\s+(?:delete|remove)|(?:delete|remove)\s+thread)\s+([a-zA-Z0-9_\-\.]+)/i);
    if (threadDeleteMatch) {
        const targetName = threadDeleteMatch[1].trim();
        const res = deleteThread(targetName);
        if (res.success) {
            await postMessage(roomId, tmid, `[✓] **Deleted thread:** \`${res.deleted}\`. Active thread is now: \`${res.active_thread}\`.`);
        } else {
            await postMessage(roomId, tmid, `[✗] ${res.error}`);
        }
        return;
    }

    // 7. Unified Thread & Conversation Switching
    // Matches:
    // - switch <target>
    // - checkout <target>
    // - use <target>
    // - thread switch <target>
    // - thread checkout <target>
    // - thread use <target>
    // - conversation switch <target>
    // - conv switch <target>
    // - conversation use <target>
    // - conv use <target>
    // - conversation <#num|uuid>
    // - conv <#num|uuid>
    // - thread <target> (when not a reserved keyword)
    let switchTarget = null;
    const generalSwitchMatch = messageText.match(/^(?:thread|conv|conversation)?\s*(?:switch|checkout|use)\s+(.+)$/i);
    if (generalSwitchMatch) {
        switchTarget = generalSwitchMatch[1].trim();
    } else {
        const convIndexOrUuidMatch = messageText.match(/^(?:conversation|conv)\s+([0-9a-fA-F\-]{6,36}|#?\d+)$/i);
        if (convIndexOrUuidMatch) {
            switchTarget = convIndexOrUuidMatch[1].trim();
        } else {
            const threadBareMatch = messageText.match(/^thread\s+([a-zA-Z0-9_\-\.]+)$/i);
            if (threadBareMatch && !['list', 'status', 'info', 'new', 'reset', 'delete', 'remove'].includes(threadBareMatch[1].toLowerCase())) {
                switchTarget = threadBareMatch[1].trim();
            }
        }
    }

    if (switchTarget) {
        const res = resolveSwitchTarget(switchTarget);
        if (res.success) {
            await postMessage(roomId, tmid, res.message);
        } else {
            await postMessage(roomId, tmid, `[✗] ${res.error}`);
        }
        return;
    }

    // Beads integration: automatically log bugs/features
    const lowerText = messageText.toLowerCase();
    if (lowerText.startsWith('bug ') || lowerText.startsWith('feature ') || lowerText.startsWith('fix ') || lowerText.startsWith('add ') || lowerText.startsWith('issue ')) {
        try {
            const { execSync } = require('child_process');
            const bdPath = fs.existsSync('/usr/local/bin/bd') ? '/usr/local/bin/bd' : 'bd';
            if (!fs.existsSync('/workspace/.beads')) {
                execSync(`${bdPath} init`, { cwd: '/workspace' });
            }
            const activeThread = getThreads().active_thread;
            const title = messageText.replace(/"/g, '\\"');
            const stdout = execSync(`${bdPath} create "[Epic: ${activeThread}] ${title}"`, { cwd: '/workspace' }).toString();
            const cleanOut = stripAnsi(stdout).trim();
            await postMessage(roomId, tmid, `[✓] **Logged to Beads Issue Tracker:**\n\`${cleanOut}\``);
        } catch (e) {
            console.error("Beads error:", e.message);
            const errTrace = e.stderr ? e.stderr.toString() : (e.stdout ? e.stdout.toString() : e.message);
            const attachments = [
                makeCollapsibleAttachment('🔍 Beads Error Trace', errTrace, 'text', '#ef4444')
            ];
            await postMessage(roomId, tmid, `❌ **Error logging to Beads:** ${e.message}`, attachments);
        }
    }

    // Operating Mode status
    if (messageText.toLowerCase() === 'mode') {
        const ping = await pingOllama();
        const ollamaStatus = ping.ok 
            ? `Online ✓ (${ping.latency}ms, ${ping.models.length} model(s) available)`
            : `Offline ✗ (${ping.error})`;
        let modeDesc = '';
        if (bridgeMode === 'hybrid') {
            modeDesc = '**HYBRID** (Auto-offload lighter questions/tasks to local Ollama; complex code/workspace tasks to AGY)';
        } else if (bridgeMode === 'ollama') {
            modeDesc = '**OLLAMA** (Direct local LLM inference only)';
        } else {
            modeDesc = '**AGY** (All requests routed to Antigravity CLI)';
        }

        let reply = `**Rocket-Grav Operating Status:**\n` +
            `*   **Mode:** ${modeDesc}\n` +
            `*   **AGY Model:** \`${currentModel || 'default (subscription)'}\`\n` +
            `*   **Local Ollama Endpoint:** \`${ollamaUrl}\`\n` +
            `*   **Active Ollama Model:** \`${ollamaModel}\`\n` +
            `*   **Ollama Status:** ${ollamaStatus}\n` +
            `*   **MCP Integration:** Configured via \`ollama-mcp\` tool in AGY\n\n` +
            `*Switch mode with: \`!agy mode <hybrid|agy|ollama>\`*`;
        await postMessage(roomId, tmid, reply);
        return;
    }

    // Switch bridge operating mode
    if (messageText.toLowerCase().startsWith('mode switch ') || messageText.toLowerCase().startsWith('mode use ') || messageText.toLowerCase().startsWith('mode set ') || messageText.toLowerCase().startsWith('mode ')) {
        const parts = messageText.split(' ');
        const targetMode = parts[parts.length - 1].toLowerCase().trim();
        if (['hybrid', 'agy', 'ollama'].includes(targetMode)) {
            bridgeMode = targetMode;
            let note = '';
            if (targetMode === 'hybrid') note = 'Questions & light tasks will be offloaded to local Ollama; coding & file operations will run via AGY.';
            if (targetMode === 'agy') note = 'All prompts will run through Antigravity CLI.';
            if (targetMode === 'ollama') note = 'All prompts will be handled directly by local Ollama.';
            await postMessage(roomId, tmid, `[✓] Switched bridge mode to: **${targetMode.toUpperCase()}**\n*${note}*`);
        } else {
            await postMessage(roomId, tmid, `Invalid mode: \`${targetMode}\`. Available modes: \`hybrid\`, \`agy\`, \`ollama\`.`);
        }
        return;
    }

    // Ollama ping / connectivity test
    if (messageText.toLowerCase() === 'ollama ping' || messageText.toLowerCase() === 'ollama status') {
        const ping = await pingOllama();
        if (ping.ok) {
            await postMessage(roomId, tmid, `[✓] **Ollama Online:** Connected to \`${ollamaUrl}\` in **${ping.latency}ms**.\nActive model: \`${ollamaModel}\`\nInstalled models (${ping.models.length}): ${ping.models.map(m => `\`${m}\``).join(', ')}`);
        } else {
            await postMessage(roomId, tmid, `[✗] **Ollama Offline:** Unable to connect to \`${ollamaUrl}\`.\nError: \`${ping.error}\``);
        }
        return;
    }

    // List Ollama models
    if (messageText.toLowerCase() === 'ollama models' || messageText.toLowerCase() === 'ollama list' || messageText.toLowerCase() === 'ollama') {
        try {
            const models = await listOllamaModels();
            if (!models || models.length === 0) {
                await postMessage(roomId, tmid, `No models found on Ollama at \`${ollamaUrl}\`.`);
                return;
            }
            let reply = `**Available Local Ollama Models (${models.length}):**\n\n| Model Name | Size | Family | Active |\n|---|---|---|:---:|\n`;
            for (const m of models) {
                const isActive = m.name === ollamaModel ? '✓' : '';
                const size = m.details?.parameter_size || (m.size ? `${(m.size / (1024*1024*1024)).toFixed(1)} GB` : 'N/A');
                const family = m.details?.family || 'N/A';
                reply += `| \`${m.name}\` | ${size} | ${family} | ${isActive} |\n`;
            }
            reply += `\nActive Ollama Model: **\`${ollamaModel}\`**\nSwitch model with: \`!agy ollama switch <name>\``;
            await postMessage(roomId, tmid, reply);
        } catch (e) {
            await postMessage(roomId, tmid, `Error querying Ollama models: ${e.message}`);
        }
        return;
    }

    // Switch Ollama model
    if (messageText.toLowerCase().startsWith('ollama switch ') || messageText.toLowerCase().startsWith('ollama model ') || messageText.toLowerCase().startsWith('ollama use ')) {
        const newModel = messageText.split(' ').slice(2).join(' ').trim();
        if (newModel) {
            ollamaModel = newModel;
            await postMessage(roomId, tmid, `[✓] Switched active Ollama model to: **\`${ollamaModel}\`**`);
        } else {
            await postMessage(roomId, tmid, `Please provide a model name, e.g. \`!agy ollama switch phi4-mini:latest\``);
        }
        return;
    }

    // Prompt Refiner Check (/refine at start, end, or inline)
    let shouldRefine = false;
    let refinedContext = null;
    let refineThinkingMsgId = null;
    const refinePattern = /(?:^|\s)\/refine(?::|\b|\s|$)/i;

    if (refinePattern.test(messageText)) {
        shouldRefine = true;
        const originalInput = messageText;
        messageText = messageText.replace(/(?:^|\s)\/refine(?::|\b|\s|$)/gi, ' ')
                                 .replace(/\s+/g, ' ')
                                 .trim();
        if (!messageText) {
            await postMessage(roomId, tmid, "Please provide a prompt to refine, e.g. `!agy /refine <your task>` or `!agy <your task> /refine`");
            return;
        }

        refineThinkingMsgId = await postMessage(roomId, tmid, `\`⠋\` *Analyzing and refining prompt with local Ollama (${ollamaModel})...*`);
        const refinerResult = await refinePromptWithOllama(messageText, ollamaModel);

        if (refinerResult.isModified) {
            const displaySnippet = refinerResult.refinedPrompt.length > 160
                ? refinerResult.refinedPrompt.substring(0, 157) + '...'
                : refinerResult.refinedPrompt;
            if (refineThinkingMsgId) {
                await updateMessage(roomId, refineThinkingMsgId, `\`⠋\` *Prompt refined via local Ollama (${refinerResult.latencySec}s):*\n> *"${displaySnippet}"*\n\n*Passing to Antigravity (AGY)...*`);
            }
            refinedContext = {
                wasRefined: true,
                originalPrompt: messageText,
                refinedPrompt: refinerResult.refinedPrompt,
                latencySec: refinerResult.latencySec
            };
            messageText = refinerResult.refinedPrompt;
        } else {
            const note = refinerResult.error
                ? `(Ollama unavailable: ${refinerResult.error})`
                : `(prompt already clear & specific)`;
            if (refineThinkingMsgId) {
                await updateMessage(roomId, refineThinkingMsgId, `\`⠋\` *Prompt refinement skipped ${note}. Passing to Antigravity (AGY)...*`);
            }
        }
    }

    // Forced AGY execution (e.g. "!agy full <prompt>" or "!agy force-agy <prompt>")
    let forceAgy = false;
    if (messageText.toLowerCase().startsWith('full ') || messageText.toLowerCase().startsWith('force-agy ') || messageText.toLowerCase().startsWith('agy ')) {
        messageText = messageText.replace(/^(?:full|force-agy|agy)\s+/i, '').trim();
        forceAgy = true;
    }

    // Explicit direct Ollama prompt (e.g. "!agy ollama <prompt>" or "!agy ask <prompt>")
    if (messageText.toLowerCase().startsWith('ollama ') || messageText.toLowerCase().startsWith('ask ')) {
        const ollamaPrompt = messageText.replace(/^(?:ollama|ask)\s+/i, '').trim();
        if (!ollamaPrompt) {
            await postMessage(roomId, tmid, "Please provide a prompt for Ollama.");
            return;
        }
        await executeOllamaMessage(roomId, tmid, ollamaPrompt);
        return;
    }

    // Routing decision
    let useOllama = false;
    if (!forceAgy && !shouldRefine) {
        if (bridgeMode === 'ollama') {
            useOllama = true;
        } else if (bridgeMode === 'hybrid') {
            const taskType = classifyTask(messageText);
            console.log(`[Rocket-Grav] Task classification for "${messageText.substring(0, 50)}...": ${taskType.toUpperCase()}`);
            if (taskType === 'light') {
                useOllama = true;
            }
        }
    }

    if (useOllama) {
        console.log(`[Rocket-Grav] Offloading to local Ollama (${ollamaModel})`);
        await executeOllamaMessage(roomId, tmid, messageText, null, (existingMsgId) => {
            // Fallback to AGY if Ollama fails
            runAgySession(roomId, tmid, messageText, existingMsgId);
        });
        return;
    }

    // Route to full Antigravity CLI session
    runAgySession(roomId, tmid, messageText, refineThinkingMsgId, refinedContext);
});

app.get('/version', async (req, res) => {
    const current = getInstalledAgyVersion();
    const latest = await fetchLatestAgyVersion();
    const hasUpdate = (current && latest) ? (compareSemver(latest, current) > 0) : false;
    res.json({
        service: 'rocket-grav',
        installed_version: current,
        latest_version: latest,
        update_available: hasUpdate,
        auto_update: {
            enabled: autoUpdateState.enabled,
            interval_hours: autoUpdateState.intervalHours,
            last_check: autoUpdateState.lastCheck,
            last_result: autoUpdateState.lastResult
        },
        bridge_mode: bridgeMode,
        ollama_model: ollamaModel
    });
});

app.get('/threads', (req, res) => {
    const data = getThreads();
    const dbPath = getConversationDbPath();
    const convs = getRecentConversations(15);
    const geminiDir = '/root/.gemini/antigravity-cli';
    let geminiFiles = [];
    try {
        if (fs.existsSync(geminiDir)) {
            geminiFiles = fs.readdirSync(geminiDir);
        }
    } catch (_) {}

    res.json({
        threads_file: getThreadsFilePath(),
        threads_data: data,
        db_path: dbPath,
        db_exists: dbPath ? fs.existsSync(dbPath) : false,
        recent_conversations_count: convs.length,
        recent_conversations: convs,
        gemini_dir: geminiDir,
        gemini_files: geminiFiles,
        thread_list_rendered: formatThreadList(),
        conversation_list_rendered: formatConversationList()
    });
});

app.get('/conversations', (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 30;
    const convs = getRecentConversations(limit);
    res.json({ count: convs.length, conversations: convs });
});

app.get('/context', (req, res) => {
    res.json(formatContextUsage());
});

app.post('/update', async (req, res) => {
    try {
        const result = await checkAndApplyAgyUpdate('http-request');
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(port, () => {
    console.log(`Rocket.Chat AGY Bridge listening on port ${port}`);
    initAutoUpdateScheduler();
});
