const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 8080;

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

// Wrapper calls that delegate to the active chat provider adapter
const postMessage = (roomId, tmid, text) => adapter.postMessage(roomId, tmid, text);
const updateMessage = (roomId, msgId, text) => adapter.updateMessage(roomId, msgId, text);

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
*   \`!agy <prompt>\` - Send a prompt to AGY in the current thread
*   \`!agy reply <answer>\` - Reply to an interactive question asked by AGY
*   \`!agy model\` - Show the current model
*   \`!agy model list\` (or \`models\`) - List available models
*   \`!agy model switch <name>\` - Switch model (e.g. \`claude\`, \`flash\`, \`gemini\`, \`default\`)
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

    // Post the placeholder spinner message
    const thinkingMsgId = await postMessage(roomId, tmid, "`⠋` *AGY is thinking...*");
    if (!thinkingMsgId) {
        console.warn(`[Rocket-Grav] Warning: Failed to send initial placeholder message to room ${roomId}. Check bot credentials (ROCKETCHAT_USER_ID, ROCKETCHAT_PAT) and ROCKETCHAT_URL.`);
    }
    
    // Setup animation loop
    let isFinished = false;
    let currentStatus = "Initializing...";
    if (thinkingMsgId) {
        const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        let frameIdx = 0;
        
        const animate = async () => {
            if (isFinished) return;
            
            await updateMessage(roomId, thinkingMsgId, `\`${frames[frameIdx]}\` *${currentStatus}*`);
            
            frameIdx = (frameIdx + 1) % frames.length;
            
            if (!isFinished) setTimeout(animate, 250);
        };
        setTimeout(animate, 250);
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
                                currentStatus = `Running ${parsed.step_update.tool_name}...`;
                                process.stdout.write(`\x1b[36m\n[Tool Call: ${parsed.step_update.tool_name}]\x1b[0m\n`);
                                if (parsed.step_update.tool_info && parsed.step_update.tool_info.parameters) {
                                    process.stdout.write(`\x1b[90m${JSON.stringify(parsed.step_update.tool_info.parameters)}\x1b[0m\n`);
                                }
                                // Intercept ask_question to display to user
                                if (parsed.step_update.tool_name === 'ask_question' && parsed.step_update.tool_info && parsed.step_update.tool_info.parameters) {
                                    const params = parsed.step_update.tool_info.parameters;
                                    let promptText = `**AGY has a question:**\n\n`;
                                    if (params.questions) {
                                        params.questions.forEach(q => {
                                            promptText += `*${q.question}*\n`;
                                            if (q.options) {
                                                q.options.forEach((opt, i) => promptText += `  ${i+1}. ${opt}\n`);
                                            }
                                        });
                                    }
                                    promptText += `\n*(Reply using \`!agy reply <your answer>\`)*`;
                                    postMessage(roomId, tmid, promptText);
                                }
                            } else if (parsed.step_update.state === 'DONE') {
                                if (parsed.step_update.tool_name === 'generate_image') {
                                    imageGenerationCount++;
                                }
                                currentStatus = "Thinking...";
                                process.stdout.write(`\x1b[32m[Tool Finished: ${parsed.step_update.tool_name}]\x1b[0m\n`);
                            }
                        } else if (parsed.step_update.thinking_delta) {
                            currentStatus = "Thinking...";
                            process.stdout.write(`\x1b[90m${parsed.step_update.thinking_delta}\x1b[0m`);
                        } else if (parsed.step_update.text_delta) {
                            currentStatus = "Writing response...";
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
});

app.listen(port, () => {
    console.log(`Rocket.Chat AGY Bridge listening on port ${port}`);
});
