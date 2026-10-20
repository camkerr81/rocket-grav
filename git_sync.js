const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');
const { getThreads, saveThreads } = require('./threads');

const DEFAULT_GITEA_BASE = process.env.GITEA_URL || 'http://192.168.8.177:3000';
const DEFAULT_GITEA_USER = process.env.GITEA_USER || 'camkerr81';

/**
 * Resolves the primary workspace root directory.
 */
function getWorkspaceRoot(customRoot = null) {
    if (customRoot) return customRoot;
    if (process.env.WORKSPACE_DIR) return process.env.WORKSPACE_DIR;
    if (fs.existsSync('/workspace')) return '/workspace';
    return process.cwd();
}

/**
 * Ensures Git user and credentials are set up globally.
 */
function ensureGitConfig() {
    try {
        // Set user name and email if not set
        try {
            execSync('git config --global user.name', { stdio: 'pipe' });
        } catch (_) {
            execSync('git config --global user.name "MangoBot (Rocket-Grav)"', { stdio: 'pipe' });
        }

        try {
            execSync('git config --global user.email', { stdio: 'pipe' });
        } catch (_) {
            execSync('git config --global user.email "camkerr81@gmail.com"', { stdio: 'pipe' });
        }

        // Configure credential helper store
        execSync('git config --global credential.helper store', { stdio: 'pipe' });

        // If GITEA_PAT is available, ensure credentials file is populated
        const token = process.env.GITEA_PAT || process.env.GITEA_TOKEN;
        if (token) {
            const credPath = path.join(os.homedir(), '.git-credentials');
            const urlObj = new URL(DEFAULT_GITEA_BASE);
            const hostWithPort = urlObj.host; // e.g. 192.168.8.177:3000
            const credLine = `http://${DEFAULT_GITEA_USER}:${token}@${hostWithPort}`;

            let existing = '';
            if (fs.existsSync(credPath)) {
                existing = fs.readFileSync(credPath, 'utf8');
            }

            if (!existing.includes(hostWithPort)) {
                fs.appendFileSync(credPath, `\n${credLine}\n`, { encoding: 'utf8', mode: 0o600 });
                console.log(`[GitSync] Configured git credentials for ${hostWithPort}`);
            }
        }
    } catch (e) {
        console.warn(`[GitSync] Warning during git config setup: ${e.message}`);
    }
}

/**
 * Returns the bound repository slug or URL for a thread.
 */
function getThreadRepoMapping(threadName) {
    const data = getThreads();
    const repos = data.thread_repos || {};
    return repos[threadName] || null;
}

/**
 * Sets the repository binding for a thread in threads.json.
 */
function setThreadRepoMapping(threadName, repoSlugOrUrl) {
    const data = getThreads();
    if (!data.thread_repos || typeof data.thread_repos !== 'object') {
        data.thread_repos = {};
    }
    data.thread_repos[threadName] = repoSlugOrUrl;
    saveThreads(data);
    console.log(`[GitSync] Bound thread "${threadName}" -> repo "${repoSlugOrUrl}"`);
    return data;
}

/**
 * Resolves the directory where the thread's git repository resides.
 */
function getThreadRepoDir(threadName, customRoot = null) {
    const wsRoot = getWorkspaceRoot(customRoot);
    const mapping = getThreadRepoMapping(threadName);

    // Case 1: Thread explicitly mapped to a repo slug
    if (mapping) {
        // e.g. "camkerr81/omarchy-launcher" -> directory "omarchy-launcher"
        const repoName = mapping.replace(/\.git$/, '').split('/').pop();
        const candidateDir = path.join(wsRoot, repoName);
        if (fs.existsSync(candidateDir)) {
            return candidateDir;
        }
        // Also check if mapped by thread name directly
        const threadDir = path.join(wsRoot, threadName);
        if (fs.existsSync(threadDir)) {
            return threadDir;
        }
        return candidateDir; // Return expected path even if pending clone
    }

    // Case 2: Subdirectory matching threadName exists and is a git repo
    const candidateSub = path.join(wsRoot, threadName);
    if (fs.existsSync(path.join(candidateSub, '.git'))) {
        return candidateSub;
    }

    // Case 3: Workspace root itself is a git repo
    if (fs.existsSync(path.join(wsRoot, '.git'))) {
        return wsRoot;
    }

    return wsRoot;
}

/**
 * Clones a repository into the workspace if it does not exist yet.
 */
function ensureRepoCloned(threadName, repoSlugOrUrl = null, customRoot = null) {
    ensureGitConfig();
    const wsRoot = getWorkspaceRoot(customRoot);
    const targetSlug = repoSlugOrUrl || getThreadRepoMapping(threadName) || `${DEFAULT_GITEA_USER}/${threadName}`;

    let cloneUrl = targetSlug;
    let repoName = '';

    if (targetSlug.startsWith('http://') || targetSlug.startsWith('https://') || targetSlug.startsWith('git@')) {
        cloneUrl = targetSlug;
        repoName = targetSlug.replace(/\.git$/, '').split('/').pop();
    } else {
        // Slug format: "owner/repo" or "repo"
        const fullSlug = targetSlug.includes('/') ? targetSlug : `${DEFAULT_GITEA_USER}/${targetSlug}`;
        repoName = fullSlug.split('/')[1];
        cloneUrl = `${DEFAULT_GITEA_BASE.replace(/\/+$/, '')}/${fullSlug}.git`;
    }

    const targetDir = path.join(wsRoot, repoName);

    if (fs.existsSync(path.join(targetDir, '.git'))) {
        setThreadRepoMapping(threadName, targetSlug);
        return { success: true, targetDir, alreadyExists: true, message: `Repository already cloned in \`${repoName}\`.` };
    }

    try {
        console.log(`[GitSync] Cloning ${cloneUrl} into ${targetDir}...`);
        execSync(`git clone "${cloneUrl}" "${targetDir}"`, {
            stdio: 'pipe',
            timeout: 60000
        });

        setThreadRepoMapping(threadName, targetSlug);
        return {
            success: true,
            targetDir,
            alreadyExists: false,
            message: `[✓] **Cloned repository:** \`${targetSlug}\` into \`${repoName}/\``
        };
    } catch (e) {
        const errOut = e.stderr ? e.stderr.toString() : e.message;
        console.error(`[GitSync] Clone failed for ${cloneUrl}: ${errOut}`);
        return {
            success: false,
            targetDir,
            error: errOut
        };
    }
}

/**
 * Pre-flight git synchronization prior to running a prompt.
 * Auto-stashes, fetches, pulls new commits, and pops stash.
 */
function syncPreFlight(repoDir) {
    ensureGitConfig();

    if (!repoDir || !fs.existsSync(path.join(repoDir, '.git'))) {
        return { isGit: false, synced: false, reason: 'Not a git repository' };
    }

    const execOpts = { cwd: repoDir, stdio: 'pipe', timeout: 30000 };
    let stashed = false;
    let newCommits = 0;
    let branch = 'main';

    try {
        // 1. Determine active branch
        try {
            branch = execSync('git rev-parse --abbrev-ref HEAD', execOpts).toString().trim() || 'main';
        } catch (_) {}

        // 2. Check for local modifications
        const statusOut = execSync('git status --porcelain', execOpts).toString().trim();
        const isDirty = statusOut.length > 0;

        if (isDirty) {
            console.log(`[GitSync] Working tree in ${path.basename(repoDir)} is dirty. Auto-stashing...`);
            execSync('git stash push -u -m "rocket-grav auto-stash before pre-flight pull"', execOpts);
            stashed = true;
        }

        // 3. Fetch remote updates
        try {
            execSync('git fetch origin', execOpts);
        } catch (fetchErr) {
            console.warn(`[GitSync] Warning: git fetch origin failed: ${fetchErr.message}`);
            // If fetch fails (e.g. offline/unreachable remote), restore stash if needed and proceed
            if (stashed) {
                try { execSync('git stash pop', execOpts); } catch (_) {}
            }
            return {
                isGit: true,
                synced: false,
                fetchFailed: true,
                error: fetchErr.message,
                branch
            };
        }

        // 4. Check if local is behind origin
        try {
            const countStr = execSync(`git rev-list --count HEAD..origin/${branch}`, execOpts).toString().trim();
            newCommits = parseInt(countStr, 10) || 0;
        } catch (_) {
            // Remote branch might not exist or be named differently
        }

        let pullSuccess = false;
        let commitSummary = '';

        if (newCommits > 0) {
            console.log(`[GitSync] ${path.basename(repoDir)} is ${newCommits} commit(s) behind origin/${branch}. Pulling...`);
            execSync(`git pull --rebase origin ${branch}`, execOpts);
            pullSuccess = true;

            try {
                commitSummary = execSync('git log -1 --pretty=format:"%h - %s (%cr)"', execOpts).toString().trim();
            } catch (_) {}
        }

        // 5. Restore stash if stashed
        let stashConflict = false;
        if (stashed) {
            try {
                execSync('git stash pop', execOpts);
                console.log(`[GitSync] Restored stashed local changes in ${path.basename(repoDir)}.`);
            } catch (popErr) {
                stashConflict = true;
                console.error(`[GitSync] Stash pop conflict in ${path.basename(repoDir)}: ${popErr.message}`);
            }
        }

        const headHash = execSync('git rev-parse --short HEAD', execOpts).toString().trim();

        return {
            isGit: true,
            synced: true,
            newCommits,
            pullSuccess,
            stashed,
            stashConflict,
            branch,
            headHash,
            commitSummary
        };
    } catch (err) {
        console.error(`[GitSync] Pre-flight sync error in ${repoDir}: ${err.message}`);
        // If error occurred and stashed, attempt recovery
        if (stashed) {
            try { execSync('git stash pop', execOpts); } catch (_) {}
        }
        return {
            isGit: true,
            synced: false,
            error: err.message,
            branch
        };
    }
}

/**
 * Post-turn git synchronization: auto-commits and pushes finished AGY changes.
 */
function syncPostTurn(repoDir, options = {}) {
    ensureGitConfig();

    if (!repoDir || !fs.existsSync(path.join(repoDir, '.git'))) {
        return { isGit: false, committed: false };
    }

    const execOpts = { cwd: repoDir, stdio: 'pipe', timeout: 45000 };
    const threadName = options.threadName || 'default';

    try {
        // 1. Check for modifications or new files
        const statusOut = execSync('git status --porcelain', execOpts).toString().trim();
        if (!statusOut) {
            return { isGit: true, modified: false, committed: false };
        }

        const changedFilesCount = statusOut.split('\n').filter(Boolean).length;

        // 2. Determine active branch
        let branch = 'main';
        try {
            branch = execSync('git rev-parse --abbrev-ref HEAD', execOpts).toString().trim() || 'main';
        } catch (_) {}

        // 3. Stage all changes
        execSync('git add -A', execOpts);

        // 4. Commit changes
        const commitMsg = options.commitMessage ||
            `chore(agy): autonomous updates from Rocket.Chat [${threadName}]\n\nModified ${changedFilesCount} file(s) via Antigravity session.`;

        execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, execOpts);

        const shortHash = execSync('git rev-parse --short HEAD', execOpts).toString().trim();
        console.log(`[GitSync] Committed ${shortHash} (${changedFilesCount} files) in ${path.basename(repoDir)}`);

        // 5. Push to Gitea origin
        let pushed = false;
        try {
            execSync(`git push origin ${branch}`, execOpts);
            pushed = true;
            console.log(`[GitSync] Pushed ${shortHash} to origin/${branch}`);
        } catch (pushErr) {
            console.error(`[GitSync] Auto-push failed: ${pushErr.message}`);
            return {
                isGit: true,
                modified: true,
                committed: true,
                pushed: false,
                commitHash: shortHash,
                branch,
                changedFilesCount,
                pushError: pushErr.message
            };
        }

        return {
            isGit: true,
            modified: true,
            committed: true,
            pushed: true,
            commitHash: shortHash,
            branch,
            changedFilesCount
        };
    } catch (err) {
        console.error(`[GitSync] Post-turn sync error: ${err.message}`);
        return {
            isGit: true,
            error: err.message
        };
    }
}

/**
 * Returns formatted status of all threads and their Git repositories.
 */
function formatRepoStatusList(customRoot = null) {
    const wsRoot = getWorkspaceRoot(customRoot);
    const data = getThreads();
    const threads = Object.keys(data.threads);
    const repos = data.thread_repos || {};

    let reply = `📦 **Thread Repository & Git Sync Status**\n`;
    reply += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (threads.length === 0) {
        reply += `*(No threads configured yet)*\n`;
    } else {
        threads.forEach(tName => {
            const isActive = (tName === data.active_thread);
            const mapping = repos[tName] || '(auto-detect)';
            const repoDir = getThreadRepoDir(tName, wsRoot);
            const isGit = fs.existsSync(path.join(repoDir, '.git'));
            const statusIcon = isGit ? '🟢 Git' : '⚪ Plain';
            const shortDir = path.basename(repoDir);

            reply += `**${isActive ? '★ ' : ''}\`${tName}\`** ${isActive ? '*(Active)*' : ''}\n`;
            reply += `└─ Repo: \`${mapping}\` • Dir: \`${shortDir}/\` • ${statusIcon}\n\n`;
        });
    }

    reply += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    reply += `• *Bind thread to repo: \`!agy bind <owner/repo>\` (e.g. \`!agy bind camkerr81/omarchy-launcher\`)*\n`;
    reply += `• *Pull latest: \`!agy pull\` | Push changes: \`!agy push\`*`;

    return reply;
}

module.exports = {
    getWorkspaceRoot,
    ensureGitConfig,
    getThreadRepoMapping,
    setThreadRepoMapping,
    getThreadRepoDir,
    ensureRepoCloned,
    syncPreFlight,
    syncPostTurn,
    formatRepoStatusList
};
