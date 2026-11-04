/**
 * Unit & Integration Tests for Rocket-Grav Gitea Threads Vault Sync
 * 
 * Tests vault directory resolution, token discovery, README generation,
 * Braille iconography enforcement, and conversation file syncing.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    getVaultDir,
    getGiteaToken,
    generateVaultReadme,
    findConversationFiles,
    getVaultStatus,
    syncThreadsVault,
    DEFAULT_VAULT_REPO
} = require('../vault_sync');
const { containsEmoji } = require('../braille');

console.log('[Test] ⡞⣗ Running Gitea Threads Vault Sync Tests...\n');

// Test 1: Vault directory resolution
{
    const defaultVault = getVaultDir();
    assert(defaultVault && typeof defaultVault === 'string', 'Vault dir should be a non-empty string');
    assert(defaultVault.endsWith('.vault'), 'Default vault dir should end with .vault');

    const customRoot = '/tmp/test-custom-workspace';
    const customVault = getVaultDir(customRoot);
    assert.strictEqual(customVault, path.join(customRoot, '.vault'), 'Custom root should resolve custom vault dir');
    console.log('[Test] ⢄⠎ Vault directory resolution passed');
}

// Test 2: Token discovery
{
    const token = getGiteaToken();
    assert(token && token.length >= 20, 'Gitea token should be retrieved from environment or credentials');
    console.log('[Test] ⢄⠎ Gitea token discovery passed');
}

// Test 3: README generation & Zero Emoji compliance
{
    const mockThreads = {
        active_thread: 'auth-refactor',
        threads: {
            'default': '00000000-0000-0000-0000-000000000001',
            'auth-refactor': '00000000-0000-0000-0000-000000000002'
        },
        thread_repos: {
            'default': 'camkerr81/omarchy-launcher',
            'auth-refactor': 'camkerr81/rocket-grav'
        }
    };

    const readme = generateVaultReadme(mockThreads);
    assert(readme.includes('# ⣮⣵ Rocket-Grav Threads & Sessions Vault'), 'README should contain Braille icon title');
    assert(readme.includes('auth-refactor'), 'README should list active thread');
    assert(readme.includes('rocket-grav-sync resume auth-refactor'), 'README should contain CLI resume instructions');
    assert(!containsEmoji(readme), 'README must NOT contain any legacy Unicode emojis');
    console.log('[Test] ⢄⠎ Vault README generation and Braille enforcement passed');
}

// Test 4: Conversation file lookup
{
    // Query known conversation or non-existent
    const dummy = findConversationFiles('non-existent-conv-id-12345');
    assert.strictEqual(dummy.dbFile, null, 'Non-existent DB should return null');
    assert.strictEqual(dummy.brainDir, null, 'Non-existent brain should return null');
    console.log('[Test] ⢄⠎ Conversation file lookup test passed');
}

// Test 5: Vault status check
{
    const status = getVaultStatus();
    assert(status.vaultRepoUrl && status.vaultRepoUrl.includes(DEFAULT_VAULT_REPO), 'Vault URL should point to rocket-grav-threads');
    assert(typeof status.isCloned === 'boolean', 'isCloned should be boolean');
    assert(typeof status.threads === 'object', 'threads should be an object');
    console.log('[Test] ⢄⠎ Vault status check passed');
}

// Test 6: CLI Tool validation
{
    const cliPath = path.join(__dirname, '..', 'bin', 'rocket-grav-sync');
    assert(fs.existsSync(cliPath), 'rocket-grav-sync executable must exist in bin/');
    const stat = fs.statSync(cliPath);
    assert(Boolean(stat.mode & 0o111), 'rocket-grav-sync must be executable');
    const cliContent = fs.readFileSync(cliPath, 'utf8');
    assert(!containsEmoji(cliContent), 'rocket-grav-sync must not contain any legacy Unicode emojis');
    assert(cliContent.includes('cmdResume'), 'rocket-grav-sync must contain resume command');
    assert(cliContent.includes('cmdPull'), 'rocket-grav-sync must contain pull command');
    console.log('[Test] ⢄⠎ Workstation CLI script verification passed');
}

console.log('\n[Pass] ⢄⠎ All Gitea Threads Vault tests passed successfully!\n');
