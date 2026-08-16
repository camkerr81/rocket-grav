const express = require('express');
const { spawn } = require('child_process');

const app = express();
const port = 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware to filter requests by IP
const ipFilter = (req, res, next) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const isAllowed = 
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

    // Acknowledge the webhook immediately so Rocket.Chat doesn't time out
    // Note: Rocket.Chat expects a JSON response. If we return 200 OK immediately,
    // we cannot return the output in the same HTTP response. We'll return a placeholder.
    // However, if we just want to see the logs, we can still wait for it, but let's 
    // at least use spawn to stream to console so we don't get blind-sided by hangs.
    
    // For now, let's keep the wait but stream to console so the user can debug.
    
    const commandArgs = ['-p', messageText, '--output-format', 'json', '--dangerously-skip-permissions'];
    console.log(`Executing: agy ${commandArgs.join(' ')}`);

    const child = spawn('agy', commandArgs, { cwd: '/workspace', shell: false });
    
    let output = '';

    child.stdout.on('data', (data) => {
        const text = data.toString();
        process.stdout.write(text); // Stream to docker logs
        output += text;
    });

    child.stderr.on('data', (data) => {
        const text = data.toString();
        process.stderr.write(text); // Stream to docker logs
        // We do NOT add stderr to output when expecting JSON, as it will break JSON parsing
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
            finalOutput = parsed.output || parsed.response || parsed.text || JSON.stringify(parsed, null, 2);
        } catch (e) {
            // If it's not valid JSON (or mixed with other logs), we wrap it in a code block
            finalOutput = '```\n' + finalOutput + '\n```';
        }

        if (finalOutput.length > 3900) {
            finalOutput = finalOutput.substring(0, 3900) + '\n...[output truncated]';
        }

        // Reply to the HTTP request (if it hasn't timed out yet)
        if (!res.headersSent) {
            res.json({ text: finalOutput || 'Command finished with no output.' });
        }
    });
});

app.listen(port, () => {
    console.log(`Rocket.Chat AGY Bridge listening on port ${port}`);
});
