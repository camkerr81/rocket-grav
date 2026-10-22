const assert = require('assert');
const {
    checkContextDivergence,
    formatContextDivergencePrompt,
    extractThreadSlug
} = require('../context_check');

const {
    ensureBrailleInCommitMessage
} = require('../git_sync');

async function runTests() {
    console.log('[Test] ⡞⣗ Running Context Divergence & Braille Enforcement Tests...');

    // 1. Slug extraction tests
    assert.strictEqual(extractThreadSlug('build a new rust CLI tool for system metrics'), 'system-metrics');
    assert.strictEqual(extractThreadSlug('create a new project called mangoamp'), 'mangoamp');
    assert.strictEqual(extractThreadSlug('start a fresh app named audio-player'), 'audio-player');
    assert.strictEqual(extractThreadSlug('create a new app', 'my-fallback'), 'my-fallback');
    assert.strictEqual(extractThreadSlug('', 'my-fallback'), 'my-fallback');
    console.log('[Test] ⢄⠎ Thread slug extraction tests passed');

    // 2. Foreign thread detection
    const contextWithThreads = {
        activeThread: 'mangoamp',
        repoSlug: 'camkerr81/mangoamp',
        conversationId: 'conv-1234',
        knownThreads: ['default', 'mangoamp', 'dockhand', 'omarchy-launcher']
    };

    const foreignPrompt = 'can you fix the container deployment in dockhand?';
    const foreignRes = await checkContextDivergence(foreignPrompt, contextWithThreads, { disableOllama: true });
    assert.strictEqual(foreignRes.isDivergent, true);
    assert.strictEqual(foreignRes.type, 'foreign_thread');
    assert.strictEqual(foreignRes.suggestedThread, 'dockhand');
    console.log('[Test] ⢄⠎ Foreign thread mention detection passed');

    // 3. New project scaffolding heuristic
    const newProjectPrompt = 'build a new rust CLI tool for system metrics';
    const newProjectRes = await checkContextDivergence(newProjectPrompt, contextWithThreads, { disableOllama: true });
    assert.strictEqual(newProjectRes.isDivergent, true);
    assert.strictEqual(newProjectRes.type, 'new_project');
    assert(newProjectRes.suggestedThread.includes('system') || newProjectRes.suggestedThread.includes('metrics'));
    console.log('[Test] ⢄⠎ New project scaffolding heuristic detection passed');

    // 4. In-domain prompt should NOT trigger divergence
    const inDomainPrompt = 'refactor the audio stream buffer handler in mangoamp';
    const inDomainRes = await checkContextDivergence(inDomainPrompt, contextWithThreads, { disableOllama: true });
    assert.strictEqual(inDomainRes.isDivergent, false);
    console.log('[Test] ⢄⠎ In-domain prompt non-divergence verified');

    // 5. Clean slate default thread without repo or conv should NOT diverge
    const cleanDefaultContext = {
        activeThread: 'default',
        repoSlug: null,
        conversationId: null,
        knownThreads: ['default']
    };
    const cleanRes = await checkContextDivergence('build a new react web app', cleanDefaultContext, { disableOllama: true });
    assert.strictEqual(cleanRes.isDivergent, false);
    console.log('[Test] ⢄⠎ Clean slate default thread bypass verified');

    // 6. Force bypass option
    const forcedRes = await checkContextDivergence('build a new app', contextWithThreads, { force: true, disableOllama: true });
    assert.strictEqual(forcedRes.isDivergent, false);
    console.log('[Test] ⢄⠎ Explicit force bypass verified');

    // 7. Context divergence prompt formatting
    const formattedPrompt = formatContextDivergencePrompt(newProjectRes, newProjectPrompt);
    assert(formattedPrompt.includes('[⢘⡃] **Context Divergence Detected**'));
    assert(formattedPrompt.includes('mangoamp'));
    assert(formattedPrompt.includes('!agy thread new'));
    assert(formattedPrompt.includes('!agy proceed'));
    assert(formattedPrompt.includes('!agy cancel'));
    // Zero emoji check
    assert(!/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(formattedPrompt));
    console.log('[Test] ⢄⠎ Divergence prompt formatting & zero-emoji verification passed');

    // 8. Braille Commit Message Enforcement
    const msgFeat = ensureBrailleInCommitMessage('feat(api): add authentication middleware', 'mangoamp');
    assert.strictEqual(msgFeat, 'feat(api): ⡴⢧ add authentication middleware');

    const msgFix = ensureBrailleInCommitMessage('fix: prevent null pointer exception on missing user', 'mangoamp');
    assert.strictEqual(msgFix, 'fix: ⠙⢦ prevent null pointer exception on missing user');

    const msgChore = ensureBrailleInCommitMessage('chore: update dependencies and config', 'mangoamp');
    assert.strictEqual(msgChore, 'chore: ⣎⣱ update dependencies and config');

    const msgDocs = ensureBrailleInCommitMessage('docs: update installation instructions in readme', 'mangoamp');
    assert.strictEqual(msgDocs, 'docs: ⣏⣿ update installation instructions in readme');

    const msgTest = ensureBrailleInCommitMessage('test: add unit tests for tokenizer', 'mangoamp');
    assert.strictEqual(msgTest, 'test: ⣠⣇ add unit tests for tokenizer');

    // If message already has a Braille icon, do not duplicate
    const msgAlreadyBraille = ensureBrailleInCommitMessage('feat(ui): ⡴⢧ add player control buttons', 'mangoamp');
    assert.strictEqual(msgAlreadyBraille, 'feat(ui): ⡴⢧ add player control buttons');

    // Fallback commit message with empty input
    const msgEmpty = ensureBrailleInCommitMessage('', 'mangoamp');
    assert.strictEqual(msgEmpty, 'chore(agy): ⣎⣱ autonomous updates from Rocket.Chat [mangoamp]');

    // Strip legacy emoji and inject Braille icon
    const msgEmoji = ensureBrailleInCommitMessage('feat: \u{1F680} add rocket launch feature', 'mangoamp');
    assert.strictEqual(msgEmoji, 'feat: ⡴⢧ add rocket launch feature');
    assert(!/[\u{1F300}-\u{1F9FF}]/u.test(msgEmoji));

    console.log('[Test] ⢄⠎ Braille commit message enforcement tests passed');

    console.log('\n[Pass] ⢄⠎ All context check & Braille enforcement tests passed successfully!');
}

runTests().catch(err => {
    console.error('[Fail] ⡱⢎ Test error:', err);
    process.exit(1);
});
