/**
 * Ollama Client & Utility Service for Rocket-Grav
 * Handles communication with local Ollama instances on LAN.
 */

let ollamaUrl = (process.env.OLLAMA_URL || 'http://192.168.8.194:11434').replace(/\/+$/, '');
let ollamaModel = process.env.OLLAMA_MODEL || 'phi4-mini:latest';

function getOllamaUrl() {
    return ollamaUrl;
}

function setOllamaUrl(url) {
    if (url) ollamaUrl = url.replace(/\/+$/, '');
    return ollamaUrl;
}

function getOllamaModel() {
    return ollamaModel;
}

function setOllamaModel(model) {
    if (model) ollamaModel = model.trim();
    return ollamaModel;
}

/**
 * Pings the local Ollama server and returns latency + available models.
 */
async function pingOllama(customUrl = null) {
    const targetUrl = customUrl ? customUrl.replace(/\/+$/, '') : ollamaUrl;
    try {
        const startTime = Date.now();
        const res = await fetch(`${targetUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
        const latency = Date.now() - startTime;
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, latency };
        const data = await res.json();
        return { ok: true, latency, models: (data.models || []).map(m => m.name) };
    } catch (e) {
        return { ok: false, error: e.message, latency: -1 };
    }
}

/**
 * Lists models available on the local Ollama server.
 */
async function listOllamaModels(customUrl = null) {
    const targetUrl = customUrl ? customUrl.replace(/\/+$/, '') : ollamaUrl;
    const res = await fetch(`${targetUrl}/api/tags`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return data.models || [];
}

/**
 * Sends a generation prompt to the local Ollama instance.
 */
async function queryOllama(prompt, options = {}) {
    const targetUrl = options.url || ollamaUrl;
    const model = options.model || ollamaModel;
    const body = {
        model,
        prompt,
        stream: false
    };
    if (options.system) body.system = options.system;
    if (options.think !== undefined) body.think = options.think;

    const res = await fetch(`${targetUrl}/api/generate`, {
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
            return { isRefusal: true, reason: 'Pattern match', matched: m[0] };
        }
    }

    return { isRefusal: false };
}

module.exports = {
    getOllamaUrl,
    setOllamaUrl,
    getOllamaModel,
    setOllamaModel,
    pingOllama,
    listOllamaModels,
    queryOllama,
    isOllamaRefusal
};
