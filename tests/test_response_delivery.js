const assert = require('assert');
const RocketChatAdapter = require('../adapters/RocketChatAdapter');

// Test 1: RocketChatAdapter instantiation
const adapter = new RocketChatAdapter();
adapter.userId = 'test_user_id';
adapter.pat = 'test_pat_token';
assert.strictEqual(adapter.name, 'rocketchat');

// Test 2: Verify chunking and fallback logic in mock environment
let mockPostCalls = [];
let mockUpdateCalls = [];
let simulateUpdateFail = false;

adapter.postMessage = async (roomId, tmid, text, attachments = null) => {
    mockPostCalls.push({ roomId, tmid, text, attachments });
    return `msg_${mockPostCalls.length}`;
};

adapter._rawUpdate = async (roomId, msgId, text) => {
    if (simulateUpdateFail) return false;
    mockUpdateCalls.push({ roomId, msgId, text });
    return true;
};

async function runTests() {
    console.log('[Test] Running RocketChatAdapter tests...');

    // Short message update
    mockUpdateCalls = [];
    mockPostCalls = [];
    let ok = await adapter.updateMessage('room1', 'msg123', 'Short response');
    assert.strictEqual(ok, true);
    assert.strictEqual(mockUpdateCalls.length, 1);
    assert.strictEqual(mockUpdateCalls[0].text, 'Short response');
    assert.strictEqual(mockPostCalls.length, 0);
    console.log('[Test] ✓ Short message in-place update passed');

    // Long message chunking (>3800 chars)
    mockUpdateCalls = [];
    mockPostCalls = [];
    const longText = 'Part 1 '.repeat(400) + '\n\n' + 'Part 2 '.repeat(400); // ~5600 chars
    ok = await adapter.updateMessage('room1', 'msg123', longText, null, 'tmid_abc');
    assert.strictEqual(ok, true);
    assert.strictEqual(mockUpdateCalls.length, 1);
    assert(mockPostCalls.length >= 1, 'Should have posted follow-up chunks');
    assert.strictEqual(mockPostCalls[0].tmid, 'tmid_abc');
    console.log(`[Test] ✓ Long message chunked into 1 update + ${mockPostCalls.length} postMessage calls`);

    // In-place update failure fallback to postMessage
    mockUpdateCalls = [];
    mockPostCalls = [];
    simulateUpdateFail = true;
    ok = await adapter.updateMessage('room1', 'msg123', 'Failed update text', [{ title: 'Trace' }], 'tmid_abc');
    assert.strictEqual(ok, false);
    assert.strictEqual(mockPostCalls.length, 1);
    assert.strictEqual(mockPostCalls[0].text, 'Failed update text');
    assert.deepStrictEqual(mockPostCalls[0].attachments, [{ title: 'Trace' }]);
    console.log('[Test] ✓ Fallback to postMessage when update fails passed');

    // Update with attachments: text updated in place without extra properties, attachments posted to thread
    mockUpdateCalls = [];
    mockPostCalls = [];
    simulateUpdateFail = false;
    ok = await adapter.updateMessage('room1', 'msg123', 'Response with attachment', [{ title: 'Trace Details' }], 'tmid_abc');
    assert.strictEqual(ok, true);
    assert.strictEqual(mockUpdateCalls.length, 1);
    assert.strictEqual(mockUpdateCalls[0].text, 'Response with attachment');
    assert.strictEqual(mockPostCalls.length, 1);
    assert.deepStrictEqual(mockPostCalls[0].attachments, [{ title: 'Trace Details' }]);
    console.log('[Test] ✓ Update with attachments routes text to chat.update and attachments to postMessage');

    // Test 3: Stream line buffering logic simulation
    console.log('[Test] Testing stream chunk fragmentation simulation...');
    let stdoutRemainder = '';
    let parsedEvents = [];
    let streamedResponseText = '';

    const simulateChunk = (chunkStr) => {
        const full = stdoutRemainder + chunkStr;
        const lines = full.split('\n');
        stdoutRemainder = lines.pop();
        for (let line of lines) {
            if (!line.trim()) continue;
            try {
                const parsed = JSON.parse(line);
                parsedEvents.push(parsed.event);
                if (parsed.step_update && parsed.step_update.text_delta) {
                    streamedResponseText += parsed.step_update.text_delta;
                }
            } catch (e) {}
        }
    };

    // Split a JSON line right through the middle across two chunks
    const json1 = JSON.stringify({ event: 'step_update', step_update: { text_delta: 'Hello ' } });
    const json2 = JSON.stringify({ event: 'result', result: { response: 'Hello World!' } });

    simulateChunk(json1.substring(0, 20)); // Cut off midway
    assert.strictEqual(parsedEvents.length, 0); // Not parsed yet
    simulateChunk(json1.substring(20) + '\n' + json2.substring(0, 15)); // Complete first, cut second
    assert.strictEqual(parsedEvents.length, 1);
    assert.strictEqual(parsedEvents[0], 'step_update');
    assert.strictEqual(streamedResponseText, 'Hello ');

    simulateChunk(json2.substring(15) + '\n'); // Complete second
    assert.strictEqual(parsedEvents.length, 2);
    assert.strictEqual(parsedEvents[1], 'result');

    console.log('[Test] ✓ Stream line buffering handles fragment chunks correctly');

    console.log('\n[Pass] All response delivery tests passed successfully!');
}

runTests().catch(err => {
    console.error('[Fail] Test failed:', err);
    process.exit(1);
});
