const express = require('express');
const { exec } = require('child_process');

const app = express();
const port = 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware to filter requests by IP
const ipFilter = (req, res, next) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    // Check if the IP is allowed
    // Note: IPV4-mapped IPV6 addresses (::ffff:192.168.x.x) might appear
    const isAllowed = 
        clientIp.includes('127.0.0.1') || 
        clientIp.includes('chat.example.com') ||
        clientIp.includes('127.0.0.1') || 
        clientIp.includes('::1') ||
        clientIp.startsWith('::ffff:172.') || // Docker bridge usually 172.x.x.x
        clientIp.startsWith('172.');
        
    if (!isAllowed) {
        console.warn(`Blocked request from unauthorized IP: ${clientIp}`);
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    next();
};

// Use the IP filter
app.use(ipFilter);

app.post('/webhook', (req, res) => {
    const providedToken = req.body.token;
    const expectedToken = process.env.ROCKETCHAT_TOKEN;

    // Security: Validate the token
    if (!providedToken || providedToken !== expectedToken) {
        console.warn('Unauthorized request received (invalid token).');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Extract the user's message
    let messageText = req.body.text || '';
    
    // Strip out bot mentions, assuming bot might be @agy-bot or similar
    // This regex removes any @mentions at the beginning of the text
    messageText = messageText.replace(/^@\w+\s+/, '').trim();

    if (!messageText) {
        return res.json({ text: "Please provide a prompt." });
    }

    console.log(`Received prompt: ${messageText}`);

    // Escape double quotes in the prompt
    const safePrompt = messageText.replace(/"/g, '\\"');

    // Execute the Antigravity CLI
    // --dangerously-skip-permissions bypasses interactive prompts
    const command = `agy "${safePrompt}" --dangerously-skip-permissions`;
    
    console.log(`Executing: ${command}`);

    exec(command, { cwd: '/workspace' }, (error, stdout, stderr) => {
        let output = '';

        if (error) {
            console.error(`Execution error: ${error.message}`);
            output += `Error: ${error.message}\n`;
        }

        if (stderr) {
            console.error(`stderr: ${stderr}`);
            // Sometimes CLI tools output warnings/progress to stderr, we can include it or not.
            output += `\nStderr: ${stderr}\n`;
        }

        output += stdout;

        // Truncate if extremely long to avoid Rocket.Chat message limits (usually ~4000 chars)
        if (output.length > 3900) {
            output = output.substring(0, 3900) + '\n...[output truncated]';
        }

        res.json({ text: '```\n' + (output || 'Command finished with no output.') + '\n```' });
    });
});

app.listen(port, () => {
    console.log(`Rocket.Chat AGY Bridge listening on port ${port}`);
});
