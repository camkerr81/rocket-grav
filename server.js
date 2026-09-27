const express = require('express');
const { spawn } = require('child_process');
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
let ollamaModel = process.env.OLLAMA_MODEL || 'qwen3:8b';

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

const threadsFile = '/workspace/threads.json';

const { getAdapter } = require('./adapters');
const adapter = getAdapter();
console.log(`[Rocket-Grav] Initialized with chat adapter: ${adapter.name.toUpperCase()}`);
if (adapter.url) console.log(`[Rocket-Grav] Target chat server URL: ${adapter.url}`);
console.log(`[Rocket-Grav] Bridge Operating Mode: ${bridgeMode.toUpperCase()}`);
console.log(`[Rocket-Grav] Local Ollama Target: ${ollamaUrl} (default model: ${ollamaModel})`);

function getThreads() {
    if (fs.existsSync(threadsFile)) {
        try {
            return JSON.parse(fs.readFileSync(threadsFile, 'utf8'));
        } catch(e) {}
    }
    return { active_thread: 'default', threads: {} };
}

function saveThreads(data) {
    fs.writeFileSync(threadsFile, JSON.stringify(data, null, 2));
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

// Wrapper calls that delegate to the active chat provider adapter
const postMessage = (roomId, tmid, text) => adapter.postMessage(roomId, tmid, text);
const updateMessage = (roomId, msgId, text) => adapter.updateMessage(roomId, msgId, text);

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

    for (const pattern of heavyPatterns) {
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

async function executeOllamaMessage(roomId, tmid, promptText, customModel = null, fallbackToAgy = null) {
    const targetModel = customModel || ollamaModel;
    const thinkingMsgId = await postMessage(roomId, tmid, `\`⠋\` *Offloading to local Ollama (${targetModel})...*`);
    const startTime = Date.now();

    try {
        const result = await queryOllama(promptText, { model: targetModel });
        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
        let reply = `[⚡ **Local Ollama** (\`${targetModel}\` • ${elapsedSec}s)]\n\n`;
        if (result.thinking) {
            reply += `> *Thought Process:*\n> ${result.thinking.trim().replace(/\n/g, '\n> ')}\n\n`;
        }
        reply += result.text;
        if (reply.length > 7000) {
            reply = reply.substring(0, 7000) + '\n...[output truncated]';
        }
        if (thinkingMsgId) {
            await updateMessage(roomId, thinkingMsgId, reply);
        } else {
            await postMessage(roomId, tmid, reply);
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

async function runAgySession(roomId, tmid, messageText, existingMsgId = null) {
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
                        if (parsed.conversation_id) activeProcesses[parsed.conversation_id] = child;
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
            if (thinkingMsgId) {
                await updateMessage(roomId, thinkingMsgId, `Error: ${error.message}`);
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
            if (finalResultObj) {
                if (finalResultObj.conversation_id && !convId) {
                    data.threads[activeThreadName] = finalResultObj.conversation_id;
                    saveThreads(data);
                }
                finalOutput = finalResultObj.response || finalResultObj.error || JSON.stringify(finalResultObj, null, 2);
                if (finalResultObj.error) {
                    finalOutput += "\n\n**Raw Trace Details:**\n```json\n" + rawOutput.substring(Math.max(0, rawOutput.length - 1500)) + "\n```";
                }
            } else {
                finalOutput = "Error: AGY exited abruptly. Check container logs.\nRaw output trace:\n```json\n" + rawOutput.substring(Math.max(0, rawOutput.length - 1500)) + "\n```";
            }

            if (finalOutput.length > 7000) {
                finalOutput = finalOutput.substring(0, 7000) + '\n...[output truncated]';
            }

            if (imageGenerationCount > 0) {
                // Text queries are covered by Antigravity subscription ($0)
                // We only bill for generated images via GCP API (~$0.03 per image)
                const imageCost = imageGenerationCount * 0.03;
                finalOutput += `\n\n*(Estimated GCP API cost for ${imageGenerationCount} image(s): $${imageCost.toFixed(4)})*`;
            }

            if (thinkingMsgId) {
                await updateMessage(roomId, thinkingMsgId, finalOutput);
            } else {
                await postMessage(roomId, tmid, finalOutput);
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
*   \`!agy mode\` - Show current bridge operating mode and Ollama connection status
*   \`!agy mode <hybrid|agy|ollama>\` - Switch bridge mode (e.g. \`!agy mode hybrid\`, \`!agy mode agy\`)
*   \`!agy ollama <prompt>\` (or \`!ollama\`, \`!ask\`) - Send prompt directly to local Ollama
*   \`!agy ollama list\` (or \`models\`) - List available models on local Ollama
*   \`!agy ollama switch <name>\` - Switch active Ollama model (e.g. \`qwen3:8b\`, \`phi4-mini:latest\`)
*   \`!agy ollama ping\` - Test connectivity and latency to local Ollama instance
*   \`!agy full <prompt>\` - Force execution through full AGY CLI (bypass Ollama offloading)
*   \`!agy reply <answer>\` - Reply to an interactive question asked by AGY
*   \`!agy model\` - Show the current AGY model
*   \`!agy model list\` (or \`models\`) - List available AGY models
*   \`!agy model switch <name>\` - Switch AGY model (e.g. \`claude\`, \`flash\`, \`gemini\`, \`default\`)
*   \`!agy thread list\` (or \`threads\`) - List all available threads and show the active one
*   \`!agy thread switch <name>\` - Switch to an existing thread or create a new one
*   \`!agy log\` - Show the last few log entries of the active thread's transcript
*   \`!agy issues\` (or \`beads\`) - List all open beads issues
*   \`!agy help\` - Show this help message`;
        await postMessage(roomId, tmid, helpText);
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
                await postMessage(roomId, tmid, 'No Beads project initialized yet.');
                return;
            }
            const bdPath = fs.existsSync('/usr/local/bin/bd') ? '/usr/local/bin/bd' : 'bd';
            const stdout = execFileSync(bdPath, ['list'], { cwd: '/workspace' }).toString();
            await postMessage(roomId, tmid, `**Current Issues:**\n\`\`\`text\n${stdout.trim() || 'No open issues.'}\n\`\`\``);
        } catch (e) {
            const errOut = e.stdout ? e.stdout.toString() : e.message;
            await postMessage(roomId, tmid, `Error retrieving beads:\n\`\`\`text\n${errOut.trim()}\n\`\`\``);
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
        
        const logPath = `/root/.gemini/antigravity-cli/brain/${convId}/.system_generated/logs/transcript.jsonl`;
        if (!fs.existsSync(logPath)) {
            await postMessage(roomId, tmid, 'Log file not found. Have you sent a prompt in this thread yet?');
            return;
        }
        
        const thinkingMsgId = await postMessage(roomId, tmid, "`⠋` *Fetching logs...*");
        const { exec } = require('child_process');
        exec(`tail -n 25 ${logPath}`, async (error, stdout) => {
            let output = stdout.substring(0, 7000);
            if (error) output = `Error: ${error.message}`;
            if (thinkingMsgId) {
                await updateMessage(roomId, thinkingMsgId, '```json\n' + output + '\n```');
            }
        });
        return;
    }

    if (messageText === 'threads' || messageText === 'thread list') {
        const data = getThreads();
        let reply = 'Available threads:\n-----------------\n';
        const threadNames = Object.keys(data.threads);
        if (threadNames.length === 0) reply += '(no active threads yet)\n';
        for (const name of threadNames) {
            reply += `${name === data.active_thread ? '*' : ' '} ${name}\n`;
        }
        reply += `\nCurrently active: ${data.active_thread}`;
        await postMessage(roomId, tmid, '```text\n' + reply + '\n```');
        return;
    }

    if (messageText.startsWith('thread switch ') || messageText.startsWith('thread checkout ')) {
        const name = messageText.split(' ')[2].trim();
        const data = getThreads();
        data.active_thread = name;
        saveThreads(data);
        await postMessage(roomId, tmid, '```text\nSwitched to thread: ' + name + '\n```');
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
            await postMessage(roomId, tmid, `[✓] Logged to Beads Issue Tracker:\n\`\`\`text\n${stdout.trim()}\n\`\`\``);
        } catch (e) {
            console.error("Beads error:", e.message);
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
            await postMessage(roomId, tmid, `Please provide a model name, e.g. \`!agy ollama switch qwen3:8b\``);
        }
        return;
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
    if (!forceAgy) {
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
    runAgySession(roomId, tmid, messageText);
});

app.listen(port, () => {
    console.log(`Rocket.Chat AGY Bridge listening on port ${port}`);
});
