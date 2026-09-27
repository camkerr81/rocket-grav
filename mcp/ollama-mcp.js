#!/usr/bin/env node

/**
 * Ollama MCP Server
 * Model Context Protocol (MCP) server for local Ollama instances.
 * Provides tools for Antigravity (AGY) and other MCP clients to query local models.
 */

const readline = require('readline');

// Parse CLI arguments & environment variables
const argv = process.argv.slice(2);
let endpoint = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://192.168.8.194:11434';
let defaultModel = process.env.OLLAMA_MODEL || 'qwen3:8b';

for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--endpoint' || argv[i] === '-e' || argv[i] === '--host') && argv[i + 1]) {
        endpoint = argv[++i];
    } else if ((argv[i] === '--model' || argv[i] === '-m') && argv[i + 1]) {
        defaultModel = argv[++i];
    }
}

// Normalize endpoint URL (remove trailing slash)
endpoint = endpoint.replace(/\/+$/, '');

const TOOLS = [
    {
        name: 'ask_ollama',
        description: 'Ask the local Ollama instance a prompt or question to offload lightweight tasks, summarization, quick code explanations, or fast reasoning without API costs.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'The prompt or question to ask Ollama'
                },
                model: {
                    type: 'string',
                    description: `Model to use (defaults to "${defaultModel}")`
                },
                system: {
                    type: 'string',
                    description: 'Optional system instructions'
                },
                think: {
                    type: 'boolean',
                    description: 'Whether to include model thinking/reasoning if supported'
                }
            },
            required: ['prompt']
        }
    },
    {
        name: 'run',
        description: 'Execute a completion on a specific Ollama model with a prompt.',
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: `The Ollama model name (e.g. "${defaultModel}")`
                },
                prompt: {
                    type: 'string',
                    description: 'Prompt text to process'
                },
                think: {
                    type: 'boolean',
                    description: 'Whether to include thinking tokens'
                },
                temperature: {
                    type: 'number',
                    description: 'Sampling temperature (0.0 to 1.0)'
                }
            },
            required: ['name', 'prompt']
        }
    },
    {
        name: 'chat_completion',
        description: 'Multi-turn chat completion using local Ollama model.',
        inputSchema: {
            type: 'object',
            properties: {
                model: {
                    type: 'string',
                    description: `Model name to use (defaults to "${defaultModel}")`
                },
                messages: {
                    type: 'array',
                    description: 'Array of chat messages [{ role, content }]',
                    items: {
                        type: 'object',
                        properties: {
                            role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                            content: { type: 'string' }
                        },
                        required: ['role', 'content']
                    }
                },
                think: {
                    type: 'boolean',
                    description: 'Whether to include thinking output'
                }
            },
            required: ['messages']
        }
    },
    {
        name: 'list_models',
        description: 'List all models currently installed and available in the local Ollama instance.',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    }
];

function sendJsonRpc(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleToolCall(name, args = {}) {
    switch (name) {
        case 'ask_ollama': {
            const model = args.model || defaultModel;
            const prompt = args.prompt;
            const body = {
                model,
                prompt,
                stream: false
            };
            if (args.system) body.system = args.system;
            if (args.think !== undefined) body.think = args.think;

            const res = await fetch(`${endpoint}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Ollama API error (${res.status}): ${errText}`);
            }

            const data = await res.json();
            let text = '';
            if (data.thinking && args.think !== false) {
                text += `<think>\n${data.thinking}\n</think>\n\n`;
            }
            text += data.response || '';
            return {
                content: [{ type: 'text', text }]
            };
        }

        case 'run': {
            const model = args.name || defaultModel;
            const prompt = args.prompt;
            const body = {
                model,
                prompt,
                stream: false
            };
            if (args.temperature !== undefined) body.options = { temperature: args.temperature };
            if (args.think !== undefined) body.think = args.think;

            const res = await fetch(`${endpoint}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Ollama API error (${res.status}): ${errText}`);
            }

            const data = await res.json();
            let text = '';
            if (data.thinking && args.think !== false) {
                text += `<think>\n${data.thinking}\n</think>\n\n`;
            }
            text += data.response || '';
            return {
                content: [{ type: 'text', text }]
            };
        }

        case 'chat_completion': {
            const model = args.model || defaultModel;
            const messages = args.messages || [];
            const body = {
                model,
                messages,
                stream: false
            };
            if (args.think !== undefined) body.think = args.think;

            const res = await fetch(`${endpoint}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Ollama API error (${res.status}): ${errText}`);
            }

            const data = await res.json();
            const message = data.message || { role: 'assistant', content: '' };
            let text = message.content || '';
            if (data.thinking && args.think !== false) {
                text = `<think>\n${data.thinking}\n</think>\n\n` + text;
            }
            return {
                content: [{ type: 'text', text }]
            };
        }

        case 'list_models': {
            const res = await fetch(`${endpoint}/api/tags`);
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Ollama API error (${res.status}): ${errText}`);
            }
            const data = await res.json();
            const models = (data.models || []).map(m => ({
                name: m.name,
                parameter_size: m.details?.parameter_size,
                quantization: m.details?.quantization_level,
                family: m.details?.family,
                modified_at: m.modified_at
            }));
            return {
                content: [{ type: 'text', text: JSON.stringify(models, null, 2) }]
            };
        }

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const { id, method, params } = msg;

    try {
        switch (method) {
            case 'initialize': {
                sendJsonRpc({
                    jsonrpc: '2.0',
                    id,
                    result: {
                        protocolVersion: '2024-11-05',
                        capabilities: {
                            tools: { listChanged: true }
                        },
                        serverInfo: {
                            name: 'ollama-mcp',
                            version: '1.0.0',
                            description: `Ollama MCP Bridge connected to ${endpoint} (default: ${defaultModel})`
                        }
                    }
                });
                break;
            }

            case 'notifications/initialized': {
                // Client confirmed initialization; no response needed
                break;
            }

            case 'ping': {
                sendJsonRpc({ jsonrpc: '2.0', id, result: {} });
                break;
            }

            case 'tools/list': {
                sendJsonRpc({
                    jsonrpc: '2.0',
                    id,
                    result: { tools: TOOLS }
                });
                break;
            }

            case 'tools/call': {
                const toolName = params?.name;
                const toolArgs = params?.arguments || {};
                try {
                    const result = await handleToolCall(toolName, toolArgs);
                    sendJsonRpc({
                        jsonrpc: '2.0',
                        id,
                        result
                    });
                } catch (err) {
                    sendJsonRpc({
                        jsonrpc: '2.0',
                        id,
                        result: {
                            content: [{ type: 'text', text: `Error calling tool ${toolName}: ${err.message}` }],
                            isError: true
                        }
                    });
                }
                break;
            }

            default: {
                if (id !== undefined) {
                    sendJsonRpc({
                        jsonrpc: '2.0',
                        id,
                        error: {
                            code: -32601,
                            message: `Method not found: ${method}`
                        }
                    });
                }
                break;
            }
        }
    } catch (e) {
        if (id !== undefined) {
            sendJsonRpc({
                jsonrpc: '2.0',
                id,
                error: {
                    code: -32603,
                    message: `Internal error: ${e.message}`
                }
            });
        }
    }
}

const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
});

rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
        const msg = JSON.parse(trimmed);
        handleMessage(msg);
    } catch (e) {
        process.stderr.write(`[ollama-mcp] Failed to parse input JSON: ${e.message}\n`);
    }
});

process.stderr.write(`[ollama-mcp] Server started. Endpoint: ${endpoint}, Default Model: ${defaultModel}\n`);
