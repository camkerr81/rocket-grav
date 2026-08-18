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

const threadsFile = '/workspace/threads.json';

// Fetch env vars for API access
const ROCKETCHAT_URL = process.env.ROCKETCHAT_URL || 'http://rocketchat.example.com:3000';
const ROCKETCHAT_USER_ID = process.env.ROCKETCHAT_USER_ID;
const ROCKETCHAT_PAT = process.env.ROCKETCHAT_PAT;
const ROCKETCHAT_TOKEN = process.env.ROCKETCHAT_TOKEN;

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

async function postMessage(roomId, tmid, text) {
    if (!ROCKETCHAT_USER_ID || !ROCKETCHAT_PAT) {
        console.warn("Missing API credentials. Cannot post message.");
        return null;
    }
    const payload = { roomId, text, alias: 'AGY', emoji: ':robot:' };
    if (tmid) payload.tmid = tmid;

    try {
        const response = await fetch(`${ROCKETCHAT_URL}/api/v1/chat.postMessage`, {
            method: 'POST',
            headers: {
                'X-Auth-Token': ROCKETCHAT_PAT,
                'X-User-Id': ROCKETCHAT_USER_ID,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        return data.success ? data.message._id : null;
    } catch (e) {
        console.error("Error posting message:", e);
        return null;
    }
}

async function updateMessage(roomId, msgId, text) {
    if (!ROCKETCHAT_USER_ID || !ROCKETCHAT_PAT || !msgId) return;

    try {
        await fetch(`${ROCKETCHAT_URL}/api/v1/chat.update`, {
            method: 'POST',
            headers: {
                'X-Auth-Token': ROCKETCHAT_PAT,
                'X-User-Id': ROCKETCHAT_USER_ID,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ roomId, msgId, text })
        });
    } catch (e) {
        console.error("Error updating message:", e);
    }
}

// Middleware to filter requests by IP
const ipFilter = (req, res, next) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const isAllowed = 
        clientIp.includes('127.0.0.1') || 
        clientIp.includes('127.0.0.1') || 
        clientIp.includes('chat.example.com') ||
        clientIp.includes('127.0.0.1') || 
        clientIp.includes('::1') ||
        clientIp.startsWith('::ffff:172.') || 
        clientIp.startsWith('172.');
        
    if (!isAllowed) {
        console.warn(`Blocked request from unauthorized IP: ${clientIp}`);
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
};

app.use(ipFilter);

app.post('/webhook', async (req, res) => {
    const providedToken = req.body.token;

    if (!providedToken || providedToken !== ROCKETCHAT_TOKEN) {
        console.warn('Unauthorized request received (invalid token).');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Acknowledge the webhook immediately so Rocket.Chat doesn't time out
    // Returning empty text prevents Rocket.Chat from sending a default webhook reply.
    res.json({}); 

    const roomId = req.body.channel_id;
    // Only pass tmid if the original message was already in a thread
    const tmid = req.body.tmid;

    let messageText = req.body.text || '';
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
*   \`!agy thread list\` (or \`threads\`) - List all available threads and show the active one
*   \`!agy thread switch <name>\` - Switch to an existing thread or create a new one
*   \`!agy log\` - Show the last few log entries of the active thread's transcript
*   \`!agy help\` - Show this help message`;
        await postMessage(roomId, tmid, helpText);
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
            if (!fs.existsSync('/workspace/.beads')) {
                execSync('/usr/local/bin/bd init', { cwd: '/workspace' });
            }
            const activeThread = getThreads().active_thread;
            const title = messageText.replace(/"/g, '\\"');
            const stdout = execSync(`/usr/local/bin/bd create "[Epic: ${activeThread}] ${title}"`, { cwd: '/workspace' }).toString();
            await postMessage(roomId, tmid, `✅ Logged to Beads Issue Tracker:\n\`\`\`text\n${stdout.trim()}\n\`\`\``);
        } catch (e) {
            console.error("Beads error:", e.message);
        }
    }

    // Post the placeholder spinner message
    const thinkingMsgId = await postMessage(roomId, tmid, "`⠋` *AGY is thinking...*");
    
    // Setup animation loop
    let isFinished = false;
    if (thinkingMsgId) {
        const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        const phrases = [
            "AGY is thinking...",
            "AGY is doing something...",
            "AGY is solving the world's problems...",
            "AGY is brewing digital coffee...",
            "AGY is consulting the ancient texts...",
            "AGY is untangling spacetime...",
            "AGY is pondering existence..."
        ];
        
        let frameIdx = 0;
        let tick = 0;
        let phraseIdx = 0;

        const animate = async () => {
            if (isFinished) return;
            
            // Switch phrase every 20 ticks (roughly 5 seconds)
            if (tick > 0 && tick % 20 === 0) {
                phraseIdx = (phraseIdx + 1) % phrases.length;
            }
            
            await updateMessage(roomId, thinkingMsgId, `\`${frames[frameIdx]}\` *${phrases[phraseIdx]}*`);
            
            frameIdx = (frameIdx + 1) % frames.length;
            tick++;
            
            if (!isFinished) setTimeout(animate, 250);
        };
        setTimeout(animate, 250);
    }

    // Standard AGY execution
    const data = getThreads();
    const activeThreadName = data.active_thread;
    const convId = data.threads[activeThreadName];

    const commandArgs = ['-p', messageText, '--output-format', 'stream-json', '--dangerously-skip-permissions'];
    if (convId) {
        commandArgs.unshift(convId);
        commandArgs.unshift('--conversation');
    }

    console.log(`Executing: agy ${commandArgs.join(' ')}`);
    const child = spawn('agy', commandArgs, { cwd: '/workspace', shell: false });
    
    let finalResultObj = null;
    let rawOutput = '';

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
                            process.stdout.write(`\x1b[36m\n[Tool Call: ${parsed.step_update.tool_name}]\x1b[0m\n`);
                            if (parsed.step_update.tool_info && parsed.step_update.tool_info.parameters) {
                                process.stdout.write(`\x1b[90m${JSON.stringify(parsed.step_update.tool_info.parameters)}\x1b[0m\n`);
                            }
                        } else if (parsed.step_update.state === 'DONE') {
                            process.stdout.write(`\x1b[32m[Tool Finished: ${parsed.step_update.tool_name}]\x1b[0m\n`);
                        }
                    } else if (parsed.step_update.thinking_delta) {
                        process.stdout.write(`\x1b[90m${parsed.step_update.thinking_delta}\x1b[0m`);
                    } else if (parsed.step_update.text_delta) {
                        process.stdout.write(parsed.step_update.text_delta);
                    }
                } else if (parsed.event === 'result') {
                    finalResultObj = parsed.result;
                } else if (parsed.event === 'init') {
                    process.stdout.write(`\x1b[32m\n[AGY Initialized - Conversation UUID: ${parsed.conversation_id}]\x1b[0m\n`);
                }
            } catch(e) {
                // If it isn't valid JSON (like raw error dumps), print it as-is
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
        isFinished = true;
        console.log(`\nCommand exited with code ${code}`);
        
        let finalOutput = '';
        if (finalResultObj) {
            if (finalResultObj.conversation_id && !convId) {
                data.threads[activeThreadName] = finalResultObj.conversation_id;
                saveThreads(data);
            }
            finalOutput = finalResultObj.response || finalResultObj.error || JSON.stringify(finalResultObj, null, 2);
        } else {
            // Fallback if we never received a result event
            finalOutput = "Error: AGY exited abruptly. Check container logs.\nRaw output trace:\n" + rawOutput.substring(rawOutput.length - 1000);
        }

        if (finalOutput.length > 7000) {
            finalOutput = finalOutput.substring(0, 7000) + '\n...[output truncated]';
        }

        // Update the placeholder message with the final result!
        if (thinkingMsgId) {
            await updateMessage(roomId, thinkingMsgId, finalOutput);
        } else {
            // Fallback if we failed to post the thinking message
            await postMessage(roomId, tmid, finalOutput);
        }
    });
});

app.listen(port, () => {
    console.log(`Rocket.Chat AGY Bridge listening on port ${port}`);
});
