const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { getThreads, getThreadsFilePath, getConversationDbPath, getConversationById, getConversationTitle, formatRelativeTime } = require('./threads');
const { replaceEmojis, replaceEmojisInFile } = require('./braille');

const DEFAULT_GITEA_BASE = process.env.GITEA_URL || 'http://192.168.8.177:3000';
const DEFAULT_GITEA_USER = process.env.GITEA_USER || 'camkerr81';
const DEFAULT_VAULT_REPO = process.env.THREADS_VAULT_REPO || 'rocket-grav-threads';
const DEFAULT_VAULT_DIR_NAME = process.env.THREADS_VAULT_DIR || '.vault';

/**
 * Retrieves Gitea personal access token from env or ~/.git-credentials.
 */
function getGiteaToken() {
    for (const envVar of ['GITEA_PAT', 'GITEA_TOKEN', 'GITEA_API_TOKEN']) {
        const val = process.env[envVar];
        if (val && val.trim()) return val.trim();
    }

    const credPath = path.join(os.homedir(), '.git-credentials');
    if (fs.existsSync(credPath)) {
        try {
            const lines = fs.readFileSync(credPath, 'utf8').split('\n');
            const targetHost = new URL(DEFAULT_GITEA_BASE).hostname;
            for (const line of lines) {
                if (line.includes(targetHost)) {
                    const clean = line.trim().replace(/%3a/gi, ':');
                    const m = clean.match(/^https?:\/\/([^:]+):([^@]+)@/);
                    if (m && m[2]) {
                        return decodeURIComponent(m[2]).trim();
                    }
                }
            }
        } catch (_) {}
    }

    return null;
}

/**
 * Resolves workspace root.
 */
function getWorkspaceRoot(customRoot = null) {
    if (customRoot) return customRoot;
    if (process.env.WORKSPACE_DIR) return process.env.WORKSPACE_DIR;
    if (fs.existsSync('/workspace')) return '/workspace';
    return process.cwd();
}

/**
 * Resolves the directory where the threads vault git repository is cloned.
 */
function getVaultDir(customRoot = null) {
    const wsRoot = getWorkspaceRoot(customRoot);
    return path.join(wsRoot, DEFAULT_VAULT_DIR_NAME);
}

/**
 * Ensures global git credentials helper and config are established.
 */
function ensureGitConfig() {
    try {
        try {
            execSync('git config --global user.name', { stdio: 'pipe' });
        } catch (_) {
            execSync('git config --global user.name "MangoBot (Rocket-Grav Vault)"', { stdio: 'pipe' });
        }

        try {
            execSync('git config --global user.email', { stdio: 'pipe' });
        } catch (_) {
            execSync('git config --global user.email "camkerr81@gmail.com"', { stdio: 'pipe' });
        }

        execSync('git config --global credential.helper store', { stdio: 'pipe' });

        const token = getGiteaToken();
        if (token) {
            const credPath = path.join(os.homedir(), '.git-credentials');
            const urlObj = new URL(DEFAULT_GITEA_BASE);
            const hostWithPort = urlObj.host;
            const credLine = `http://${DEFAULT_GITEA_USER}:${token}@${hostWithPort}`;

            let existing = '';
            if (fs.existsSync(credPath)) {
                existing = fs.readFileSync(credPath, 'utf8');
            }

            if (!existing.includes(hostWithPort)) {
                fs.appendFileSync(credPath, `\n${credLine}\n`, { encoding: 'utf8', mode: 0o600 });
            }
        }
    } catch (e) {
        console.warn(`[VaultSync] Warning setting up git config: ${e.message}`);
    }
}

/**
 * Verifies or creates the private rocket-grav-threads repository on Gitea via REST API.
 */
async function ensureGiteaVaultRepo() {
    const token = getGiteaToken();
    const repoSlug = `${DEFAULT_GITEA_USER}/${DEFAULT_VAULT_REPO}`;
    const checkUrl = `${DEFAULT_GITEA_BASE.replace(/\/+$/, '')}/api/v1/repos/${repoSlug}`;

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `token ${token}`;

    try {
        const checkRes = await fetch(checkUrl, { headers });
        if (checkRes.ok) {
            return { exists: true, slug: repoSlug };
        }

        if (checkRes.status === 404 && token) {
            console.log(`[VaultSync] ⣮⣵ Creating private Gitea vault repository: ${repoSlug}...`);
            const createUrl = `${DEFAULT_GITEA_BASE.replace(/\/+$/, '')}/api/v1/user/repos`;
            const createRes = await fetch(createUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    name: DEFAULT_VAULT_REPO,
                    private: true,
                    auto_init: true,
                    description: '⣮⣵ Automated Vault for Rocket-Grav Threads, Sessions, and Antigravity Transcripts'
                })
            });

            if (createRes.ok) {
                console.log(`[VaultSync] ⢄⠎ Successfully created private repository: ${repoSlug}`);
                return { exists: true, slug: repoSlug, created: true };
            } else {
                const errJson = await createRes.json().catch(() => ({}));
                console.warn(`[VaultSync] ⢘⡃ Could not create Gitea repository: ${errJson.message || createRes.statusText}`);
            }
        }
    } catch (err) {
        console.warn(`[VaultSync] Warning checking Gitea repo: ${err.message}`);
    }

    return { exists: false, slug: repoSlug };
}

/**
 * Ensures the vault repository is cloned locally and up to date.
 */
function ensureVaultCloned(customRoot = null) {
    ensureGitConfig();
    const vaultDir = getVaultDir(customRoot);
    const cloneUrl = `${DEFAULT_GITEA_BASE.replace(/\/+$/, '')}/${DEFAULT_GITEA_USER}/${DEFAULT_VAULT_REPO}.git`;

    const execOpts = {
        stdio: 'pipe',
        timeout: 45000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    };

    if (fs.existsSync(path.join(vaultDir, '.git'))) {
        try {
            // Check if dirty and auto-stash
            const status = execSync('git status --porcelain', { ...execOpts, cwd: vaultDir }).toString().trim();
            if (status) {
                try { execSync('git stash push -u -m "vault pre-pull auto-stash"', { ...execOpts, cwd: vaultDir }); } catch (_) {}
            }
            execSync('git fetch origin', { ...execOpts, cwd: vaultDir });
            try {
                execSync('git pull --rebase origin main', { ...execOpts, cwd: vaultDir });
            } catch (_) {}
            try { execSync('git stash pop', { ...execOpts, cwd: vaultDir }); } catch (_) {}
            return { success: true, vaultDir, isNew: false };
        } catch (e) {
            console.warn(`[VaultSync] Pull warning in ${vaultDir}: ${e.message}`);
            return { success: true, vaultDir, isNew: false, warning: e.message };
        }
    }

    // Clone fresh
    try {
        fs.mkdirSync(path.dirname(vaultDir), { recursive: true });
        console.log(`[VaultSync] Cloning ${cloneUrl} into ${vaultDir}...`);
        execSync(`git clone "${cloneUrl}" "${vaultDir}"`, execOpts);
        return { success: true, vaultDir, isNew: true };
    } catch (e) {
        const errStr = e.stderr ? e.stderr.toString() : e.message;
        console.error(`[VaultSync] Clone failed for ${cloneUrl}: ${errStr}`);
        return { success: false, vaultDir, error: errStr };
    }
}

/**
 * Resolves candidate file paths for a conversation database and brain directory.
 */
function findConversationFiles(convId) {
    if (!convId) return { dbFile: null, brainDir: null };
    const cleanId = convId.trim();

    const candidateDbRoots = [
        path.join(process.env.HOME || '', '.gemini/antigravity-cli/conversations'),
        '/root/.gemini/antigravity-cli/conversations',
        path.join(os.homedir(), '.gemini/antigravity-cli/conversations')
    ].filter(Boolean);

    let dbFile = null;
    for (const r of candidateDbRoots) {
        const pDb = path.join(r, `${cleanId}.db`);
        const pPb = path.join(r, `${cleanId}.pb`);
        if (fs.existsSync(pDb)) { dbFile = pDb; break; }
        if (fs.existsSync(pPb)) { dbFile = pPb; break; }
    }

    const candidateBrainRoots = [
        path.join(process.env.HOME || '', '.gemini/antigravity-cli/brain', cleanId),
        `/root/.gemini/antigravity-cli/brain/${cleanId}`,
        path.join(os.homedir(), '.gemini/antigravity-cli/brain', cleanId)
    ].filter(Boolean);

    let brainDir = null;
    for (const b of candidateBrainRoots) {
        if (fs.existsSync(b)) { brainDir = b; break; }
    }

    return { dbFile, brainDir };
}

/**
 * Copies a directory recursively.
 */
function copyDirRecursiveSync(src, dest) {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursiveSync(srcPath, destPath);
        } else if (entry.isFile()) {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * Generates the README for the vault repository.
 * Enforces tactile Braille icons and zero emojis.
 */
function generateVaultReadme(threadsData) {
    const activeThread = threadsData.active_thread || 'default';
    const threads = threadsData.threads || {};
    const repos = threadsData.thread_repos || {};
    const threadNames = Object.keys(threads);

    let md = `# ⣮⣵ Rocket-Grav Threads & Sessions Vault\n\n`;
    md += `> **Automated Antigravity Session Synchronization Vault**\n`;
    md += `> This repository stores synchronized thread mappings, conversation databases, and step transcripts from **Rocket-Grav**.\n\n`;
    md += `* **Last Synchronized:** \`${new Date().toISOString()}\`\n`;
    md += `* **Active Thread:** \`${activeThread}\` ⡺\n`;
    md += `* **Total Managed Threads:** \`${threadNames.length}\`\n\n`;

    md += `---\n\n`;
    md += `## ⠊⢵ Synchronized Threads & Sessions\n\n`;

    if (threadNames.length === 0) {
        md += `*(No threads registered yet)*\n\n`;
    } else {
        md += `| Thread Name | Status | Bound Repository | Conversation UUID | Session Topic | Steps |\n`;
        md += `| :--- | :---: | :--- | :--- | :--- | :---: |\n`;

        for (const name of threadNames) {
            const isActive = (name === activeThread);
            const convId = threads[name];
            const boundRepo = repos[name] || '*(none)*';
            let title = 'Fresh (pending prompt)';
            let steps = 0;

            if (convId) {
                const conv = getConversationById(convId);
                if (conv) {
                    title = getConversationTitle(conv);
                    steps = conv.step_count || 0;
                } else {
                    title = 'Bound session';
                }
            }

            const cleanTitle = title.replace(/\|/g, '-');
            const truncatedTitle = cleanTitle.length > 40 ? cleanTitle.substring(0, 38) + '..' : cleanTitle;
            const statusMark = isActive ? `⡺ **(Active)**` : `⠤`;
            const shortId = convId ? `\`${convId.substring(0, 8)}...\`` : `*(none)*`;

            md += `| \`${name}\` | ${statusMark} | \`${boundRepo}\` | ${shortId} | ${truncatedTitle} | ${steps} |\n`;
        }
        md += `\n`;
    }

    md += `---\n\n`;
    md += `## ⠕⣀ How to Resume a Thread Locally on Your Workstation\n\n`;
    md += `To resume any conversation thread from this vault directly in your local terminal:\n\n`;
    md += `### 1. Instant Resume using the CLI Helper\n`;
    md += `\`\`\`bash\n`;
    md += `# Pull latest vault session and immediately launch local agy in the bound project:\n`;
    md += `rocket-grav-sync resume ${activeThread}\n`;
    md += `\`\`\`\n\n`;

    md += `### 2. Manual Resumption with Antigravity CLI\n`;
    md += `\`\`\`bash\n`;
    md += `# 1. Pull latest vault updates:\n`;
    md += `rocket-grav-sync pull\n\n`;
    md += `# 2. Resume the conversation ID directly with agy:\n`;
    const exampleId = threads[activeThread] || '00000000-0000-0000-0000-000000000000';
    md += `agy --conversation ${exampleId}\n`;
    md += `\`\`\`\n\n`;

    md += `---\n\n`;
    md += `*Generated automatically by Rocket-Grav Vault Synchronizer.* ⣎⣱\n`;

    return replaceEmojis(md);
}

/**
 * Synchronizes threads.json, conversation databases, and brain files into the Gitea vault.
 */
async function syncThreadsVault(options = {}) {
    ensureGitConfig();
    const customRoot = options.customRoot || null;
    const threadName = options.threadName || getThreads().active_thread || 'default';
    const conversationId = options.conversationId || getThreads().threads[threadName] || null;

    // 1. Ensure remote Gitea repository exists
    await ensureGiteaVaultRepo();

    // 2. Ensure vault clone is ready
    const cloneResult = ensureVaultCloned(customRoot);
    if (!cloneResult.success) {
        return {
            success: false,
            error: cloneResult.error || 'Failed to clone vault repository'
        };
    }

    const vaultDir = cloneResult.vaultDir;
    const threadsSource = getThreadsFilePath();
    const threadsData = getThreads();

    try {
        // 3. Copy threads.json
        if (fs.existsSync(threadsSource)) {
            fs.copyFileSync(threadsSource, path.join(vaultDir, 'threads.json'));
        }

        // 4. Create destination subdirectories
        const convDestDir = path.join(vaultDir, 'conversations');
        const brainDestDir = path.join(vaultDir, 'brain');
        fs.mkdirSync(convDestDir, { recursive: true });
        fs.mkdirSync(brainDestDir, { recursive: true });

        // 5. Copy conversation summary catalog if available
        const catalogPath = getConversationDbPath();
        if (catalogPath && fs.existsSync(catalogPath)) {
            try {
                fs.copyFileSync(catalogPath, path.join(vaultDir, 'conversation_summaries.db'));
            } catch (_) {}
        }

        // 6. Copy conversation files for known threads
        let syncedConvCount = 0;
        const convIdsToSync = new Set();
        if (conversationId) convIdsToSync.add(conversationId);
        for (const cid of Object.values(threadsData.threads || {})) {
            if (cid) convIdsToSync.add(cid);
        }

        for (const cid of convIdsToSync) {
            const { dbFile, brainDir } = findConversationFiles(cid);
            if (dbFile) {
                const targetDb = path.join(convDestDir, path.basename(dbFile));
                fs.copyFileSync(dbFile, targetDb);
                syncedConvCount++;
            }
            if (brainDir) {
                const targetBrain = path.join(brainDestDir, cid);
                copyDirRecursiveSync(brainDir, targetBrain);
            }
        }

        // 7. Generate and write README.md
        const readmeContent = generateVaultReadme(threadsData);
        const readmePath = path.join(vaultDir, 'README.md');
        fs.writeFileSync(readmePath, readmeContent, 'utf8');
        replaceEmojisInFile(readmePath);

        // 8. Check for git modifications
        const execOpts = {
            cwd: vaultDir,
            stdio: 'pipe',
            timeout: 30000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
        };

        const statusOut = execSync('git status --porcelain', execOpts).toString().trim();
        if (!statusOut) {
            return {
                success: true,
                changed: false,
                vaultDir,
                syncedConversations: syncedConvCount,
                message: 'Vault is already up to date.'
            };
        }

        // 9. Stage, commit, and push
        execSync('git add -A', execOpts);

        const shortId = conversationId ? conversationId.substring(0, 8) : 'general';
        const commitMsg = options.commitMessage || `chore(vault): ⣎⣱ sync thread sessions [${threadName}] (${shortId})`;

        execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, execOpts);

        const commitHash = execSync('git rev-parse --short HEAD', execOpts).toString().trim();
        execSync('git push origin main', execOpts);

        console.log(`[VaultSync] ⢄⠎ Pushed vault update ${commitHash} to Gitea (${syncedConvCount} conversations synced)`);

        return {
            success: true,
            changed: true,
            pushed: true,
            commitHash,
            commitMessage: commitMsg,
            threadName,
            conversationId,
            syncedConversations: syncedConvCount,
            vaultDir
        };
    } catch (err) {
        console.error(`[VaultSync] Error during vault synchronization: ${err.message}`);
        return {
            success: false,
            error: err.message
        };
    }
}

/**
 * Returns formatted status of the vault for reporting.
 */
function getVaultStatus(customRoot = null) {
    const vaultDir = getVaultDir(customRoot);
    const threadsData = getThreads();
    const isCloned = fs.existsSync(path.join(vaultDir, '.git'));
    const vaultRepoUrl = `${DEFAULT_GITEA_BASE.replace(/\/+$/, '')}/${DEFAULT_GITEA_USER}/${DEFAULT_VAULT_REPO}`;

    let lastCommit = null;
    let syncedConvs = 0;

    if (isCloned) {
        try {
            const hash = execSync('git rev-parse --short HEAD', { cwd: vaultDir, stdio: 'pipe' }).toString().trim();
            const msg = execSync('git log -1 --pretty=format:"%s"', { cwd: vaultDir, stdio: 'pipe' }).toString().trim();
            const date = execSync('git log -1 --pretty=format:"%cr"', { cwd: vaultDir, stdio: 'pipe' }).toString().trim();
            lastCommit = { hash, message: msg, date };
        } catch (_) {}

        try {
            const convFiles = fs.readdirSync(path.join(vaultDir, 'conversations'));
            syncedConvs = convFiles.filter(f => f.endsWith('.db') || f.endsWith('.pb')).length;
        } catch (_) {}
    }

    return {
        vaultRepoUrl,
        vaultDir,
        isCloned,
        threads: threadsData,
        lastCommit,
        syncedConversationsCount: syncedConvs
    };
}

/**
 * Formats a clean chat reply for `!agy vault`.
 */
function formatVaultStatusReply(customRoot = null) {
    const status = getVaultStatus(customRoot);
    const active = status.threads.active_thread || 'default';
    const threadCount = Object.keys(status.threads.threads || {}).length;

    let reply = `[⣮⣵] **Rocket-Grav Gitea Threads Vault Status:**\n\n`;
    reply += `*   **Vault Repository:** [${DEFAULT_GITEA_USER}/${DEFAULT_VAULT_REPO}](${status.vaultRepoUrl})\n`;
    reply += `*   **Status:** ${status.isCloned ? '⢄⠎ Synchronized & Cloned' : '⠤ Pending initial clone'}\n`;
    reply += `*   **Active Thread:** \`${active}\` ⡺\n`;
    reply += `*   **Total Threads:** ${threadCount}\n`;
    reply += `*   **Synced Conversations:** ${status.syncedConversationsCount} sessions\n`;

    if (status.lastCommit) {
        reply += `*   **Latest Commit:** \`${status.lastCommit.hash}\` (${status.lastCommit.date}) — "${status.lastCommit.message}"\n`;
    }

    reply += `\n**Local Workstation Resume Command:**\n`;
    reply += `\`\`\`bash\n`;
    reply += `rocket-grav-sync resume ${active}\n`;
    reply += `\`\`\`\n`;
    reply += `*• Run \`!agy vault sync\` to trigger on-demand push to Gitea.*`;

    return reply;
}

module.exports = {
    getGiteaToken,
    getVaultDir,
    ensureGiteaVaultRepo,
    ensureVaultCloned,
    syncThreadsVault,
    getVaultStatus,
    formatVaultStatusReply,
    generateVaultReadme,
    findConversationFiles,
    DEFAULT_VAULT_REPO,
    DEFAULT_GITEA_BASE,
    DEFAULT_GITEA_USER
};
