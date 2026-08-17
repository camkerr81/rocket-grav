const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const threadsFile = '/workspace/threads.json';

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

app.post('/webhook', (req, res) => {
    const providedToken = req.body.token;
    const expectedToken = process.env.ROCKETCHAT_TOKEN;

    if (!providedToken || providedToken !== expectedToken) {
        console.warn('Unauthorized request received (invalid token).');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    let messageText = req.body.text || '';
    // Strip out bot mentions or trigger words (e.g., @agy or !agy)
    messageText = messageText.replace(/^(?:@\w+|!\w+)\s+/, '').trim();

    if (!messageText) {
        return res.json({ text: "Please provide a prompt." });
    }

    console.log(`\n--- NEW REQUEST ---`);
    console.log(`Received prompt: ${messageText}`);

    // Thread management interception
    if (messageText === 'threads' || messageText === 'thread list') {
        const data = getThreads();
        let reply = 'Available threads:\n-----------------\n';
        const threadNames = Object.keys(data.threads);
        if (threadNames.length === 0) reply += '(no active threads yet)\n';
        for (const name of threadNames) {
            reply += `${name === data.active_thread ? '*' : ' '} ${name}\n`;
        }
        reply += `\nCurrently active: ${data.active_thread}`;
        return res.json({ text: '```text\n' + reply + '\n```' });
    }

    if (messageText.startsWith('thread switch ') || messageText.startsWith('thread checkout ')) {
        const name = messageText.split(' ')[2].trim();
        const data = getThreads();
        data.active_thread = name;
        saveThreads(data);
        return res.json({ text: '```text\nSwitched to thread: ' + name + '\n```' });
    }

    // Standard AGY execution
    const data = getThreads();
    const activeThreadName = data.active_thread;
    const convId = data.threads[activeThreadName];

    // Build arguments
    const commandArgs = ['-p', messageText, '--output-format', 'json', '--dangerously-skip-permissions'];
    if (convId) {
        // If we know the UUID for this thread, explicitly resume it
        commandArgs.unshift(convId);
        commandArgs.unshift('--conversation');
    }

    console.log(`Executing: agy ${commandArgs.join(' ')}`);

    const child = spawn('agy', commandArgs, { cwd: '/workspace', shell: false });
    
    let output = '';

    child.stdout.on('data', (d) => {
        const text = d.toString();
        process.stdout.write(text); // Stream to docker logs
        output += text;
    });

    child.stderr.on('data', (d) => {
        const text = d.toString();
        process.stderr.write(text); // Stream to docker logs
    });

    child.on('error', (error) => {
        console.error(`Spawn error: ${error.message}`);
        output += `Error: ${error.message}\n`;
    });

    child.on('close', (code) => {
        console.log(`\nCommand exited with code ${code}`);
        
        let finalOutput = output.trim();
        
        try {
            // Attempt to parse JSON
            const parsed = JSON.parse(finalOutput);
            
            // If this was a new thread, AGY generates a new UUID. Save it!
            if (parsed.conversation_id && !convId) {
                data.threads[activeThreadName] = parsed.conversation_id;
                saveThreads(data);
            }

            finalOutput = parsed.output || parsed.response || parsed.text || JSON.stringify(parsed, null, 2);
        } catch (e) {
            // Not valid JSON, just leave as raw text
        }

        if (finalOutput.length > 3900) {
            finalOutput = finalOutput.substring(0, 3900) + '\n...[output truncated]';
        }

        // Always wrap in a terminal-style markdown block
        if (!finalOutput.startsWith('```')) {
            finalOutput = '```text\n' + finalOutput + '\n```';
        }

        if (!res.headersSent) {
            res.json({ text: finalOutput });
        }
    });
});

app.listen(port, () => {
    console.log(`Rocket.Chat AGY Bridge listening on port ${port}`);
});
