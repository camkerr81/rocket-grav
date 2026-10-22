const { queryOllama } = require('./ollama');

/**
 * Extracts a suggested thread slug from text.
 * e.g. "build a new rust CLI tool for system metrics" -> "system-metrics"
 */
function extractThreadSlug(text, defaultSlug = 'new-project') {
    if (!text) return defaultSlug;
    
    // Explicit naming: "called <name>", "named <name>"
    const nameMatch = text.match(/\b(?:called|named)\s+([a-zA-Z0-9_\-]+)/i);
    if (nameMatch && nameMatch[1] && nameMatch[1].length >= 2) {
        return nameMatch[1].toLowerCase();
    }

    const stopwords = new Set([
        'build', 'create', 'start', 'scaffold', 'make', 'init', 'setup', 'write',
        'a', 'an', 'the', 'new', 'fresh', 'another', 'separate', 'brand',
        'project', 'repo', 'repository', 'app', 'application', 'tool', 'cli',
        'service', 'bot', 'website',
        'in', 'for', 'with', 'from', 'of', 'to', 'and', 'or', 'on', 'at', 'by',
        'can', 'you', 'please', 'we', 'i', 'need', 'want', 'this', 'that'
    ]);

    // Check if there is "for <something>" specifically, e.g. "for system metrics"
    const forMatch = text.match(/\bfor\s+([a-zA-Z0-9_\-\s]+)$/i);
    const targetText = forMatch ? forMatch[1] : text;

    const parts = targetText
        .toLowerCase()
        .replace(/[^a-z0-9\s\-]/g, ' ')
        .split(/[\s\-]+/)
        .filter(w => w.length >= 2 && !stopwords.has(w));

    if (parts.length >= 2) {
        return parts.slice(0, 3).join('-');
    }
    if (parts.length === 1) {
        return parts[0];
    }

    // Fallback to checking the whole string if targetText didn't yield enough
    if (targetText !== text) {
        const allParts = text
            .toLowerCase()
            .replace(/[^a-z0-9\s\-]/g, ' ')
            .split(/[\s\-]+/)
            .filter(w => w.length >= 2 && !stopwords.has(w));
        if (allParts.length >= 2) return allParts.slice(0, 3).join('-');
        if (allParts.length === 1) return allParts[0];
    }

    return defaultSlug;
}

// Scaffolding & new project intent patterns
const NEW_PROJECT_PATTERNS = [
    /\b(?:build|create|start|scaffold|make|init|setup|write)\s+(?:a\s+)?(?:new|fresh|another|separate|brand\s+new)\s+(?:[a-zA-Z0-9_\-]+\s+){0,3}(?:project|repo|repository|app|application|cli|service|website|game|tool|bot|package|module|crate|api|backend|frontend|microservice)\b/i,
    /\b(?:start|create|build)\s+(?:from\s+scratch|a\s+brand\s+new)\b/i,
    /\b(?:new\s+project|new\s+repo|new\s+repository|new\s+app)\b/i
];

/**
 * Inspects an incoming prompt against the active thread and bound repository context.
 * Detects whether the prompt appears to start a new project or work on a foreign project.
 */
async function checkContextDivergence(promptText, contextInfo = {}, options = {}) {
    const activeThread = (contextInfo.activeThread || 'default').trim();
    const repoSlug = contextInfo.repoSlug || null;
    const conversationId = contextInfo.conversationId || null;
    const conversationTitle = contextInfo.conversationTitle || null;
    const knownThreads = Array.isArray(contextInfo.knownThreads) ? contextInfo.knownThreads : [];

    // Bypass 1: Brand-new default thread with no prior history or repo bound
    if (activeThread === 'default' && !repoSlug && !conversationId) {
        return { isDivergent: false };
    }

    // Bypass 2: Explicit override flag passed
    if (options.force || options.bypassCheck) {
        return { isDivergent: false };
    }

    const trimmedPrompt = (promptText || '').trim();
    if (trimmedPrompt.length < 5) {
        return { isDivergent: false };
    }

    // Rule 1: Check if prompt explicitly mentions another known existing thread
    for (const thread of knownThreads) {
        if (!thread || thread.toLowerCase() === activeThread.toLowerCase() || thread.toLowerCase() === 'default') {
            continue;
        }
        // Match whole word boundary
        const escaped = thread.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const threadRegex = new RegExp(`\\b${escaped}\\b`, 'i');
        if (threadRegex.test(trimmedPrompt)) {
            return {
                isDivergent: true,
                type: 'foreign_thread',
                activeThread,
                repoSlug,
                suggestedThread: thread,
                reason: `Prompt explicitly mentions another active thread (\`${thread}\`)`
            };
        }
    }

    // Rule 2: Fast heuristic check for new project/scaffolding intent
    // If the active thread is bound to a dedicated project (e.g. mangoamp) or has an established conversation
    const isEstablishedProject = (activeThread !== 'default') || Boolean(repoSlug) || Boolean(conversationId);
    if (isEstablishedProject) {
        for (const pattern of NEW_PROJECT_PATTERNS) {
            if (pattern.test(trimmedPrompt)) {
                const suggested = extractThreadSlug(trimmedPrompt, 'new-project');
                return {
                    isDivergent: true,
                    type: 'new_project',
                    activeThread,
                    repoSlug,
                    suggestedThread: suggested,
                    reason: `Attempting to scaffold a new project while in \`${activeThread}\``
                };
            }
        }
    }

    // Rule 3: Local Ollama Semantic Divergence Check (Fast, timeout 3500ms)
    // Only check if prompt is sufficiently descriptive (> 20 chars) and Ollama check is enabled
    if (options.disableOllama !== true && trimmedPrompt.length >= 20 && isEstablishedProject) {
        try {
            const systemPrompt = "You are a software project context classifier. Determine if the user's prompt belongs to the current project/thread or if it belongs to an unrelated/new project.\n" +
                `Current Thread: "${activeThread}"\n` +
                `Bound Repository: "${repoSlug || activeThread}"\n` +
                `Recent Topic: "${conversationTitle || 'General project work'}"\n\n` +
                `User Prompt: "${trimmedPrompt.substring(0, 350)}"\n\n` +
                "Instructions:\n" +
                "- If the prompt belongs to the current project or asks general programming questions: return ONLY 'MATCH'.\n" +
                "- If the prompt is clearly for a DIFFERENT, UNRELATED project or NEW app: return ONLY 'DIVERGENT: <short-slug> | <reason under 10 words>'.\n" +
                "- NEVER use emojis.";

            const res = await queryOllama(trimmedPrompt.substring(0, 300), {
                system: systemPrompt,
                timeoutMs: 3500
            });

            const reply = (res.text || '').trim();
            if (reply.toUpperCase().startsWith('DIVERGENT:')) {
                const payload = reply.substring(10).trim();
                const [slugPart, reasonPart] = payload.split('|').map(s => s.trim());
                const cleanSlug = extractThreadSlug(slugPart || trimmedPrompt, 'new-thread');
                const cleanReason = reasonPart || 'Semantic topic mismatch with current project';

                return {
                    isDivergent: true,
                    type: 'semantic_mismatch',
                    activeThread,
                    repoSlug,
                    suggestedThread: cleanSlug,
                    reason: cleanReason
                };
            }
        } catch (ollamaErr) {
            // Fail-open on Ollama timeout/error so user is never blocked
            console.warn(`[ContextCheck] Semantic check bypassed due to error: ${ollamaErr.message}`);
        }
    }

    return { isDivergent: false };
}

/**
 * Formats a user-friendly Rocket.Chat confirmation message when divergence is detected.
 * Enforces zero emoji policy with tactile Braille iconography.
 */
function formatContextDivergencePrompt(divResult, originalPrompt) {
    const { activeThread, repoSlug, suggestedThread, reason } = divResult;
    const repoInfo = repoSlug ? ` *(bound to \`${repoSlug}\`)*` : '';
    const displayPrompt = originalPrompt.length > 120 ? originalPrompt.substring(0, 117) + '...' : originalPrompt;
    const targetSlug = suggestedThread || 'new-project';

    let msg = `[⢘⡃] **Context Divergence Detected**\n`;
    msg += `You are currently in thread **\`${activeThread}\`**${repoInfo}.\n\n`;
    msg += `Your prompt appears to be for a different or new project:\n`;
    msg += `> *"${displayPrompt}"*\n`;
    if (reason) {
        msg += `*(Reason: ${reason})*\n\n`;
    } else {
        msg += `\n`;
    }
    msg += `**How would you like to proceed?**\n`;
    msg += `• **Create a new thread for this project:**\n`;
    msg += `  \`!agy thread new ${targetSlug}\` *(creates thread & runs this prompt)*\n`;
    msg += `• **Switch to an existing thread:**\n`;
    msg += `  \`!agy thread switch <name>\`\n`;
    msg += `• **Proceed anyway in \`${activeThread}\`:**\n`;
    msg += `  \`!agy proceed\` *(or \`!agy force <prompt>\`)*\n`;
    msg += `• **Cancel:**\n`;
    msg += `  \`!agy cancel\``;

    return msg;
}

module.exports = {
    checkContextDivergence,
    formatContextDivergencePrompt,
    extractThreadSlug
};
