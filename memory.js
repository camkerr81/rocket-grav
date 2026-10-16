const fs = require('fs');
const path = require('path');
const os = require('os');
const { getThreads } = require('./threads');

const LESSONS_HEADER = '## Lessons Learned & Context Memory';

/**
 * Resolves the workspace directory and AGENTS.md path.
 */
function getWorkspaceAgentsMdPath(customWorkspace = null) {
    const candidateDirs = [
        customWorkspace,
        process.env.WORKSPACE_DIR,
        fs.existsSync('/workspace') ? '/workspace' : null,
        process.cwd()
    ].filter(Boolean);

    for (const dir of candidateDirs) {
        try {
            if (fs.existsSync(dir)) {
                return path.join(dir, 'AGENTS.md');
            }
        } catch (_) {}
    }
    return path.join(process.cwd(), 'AGENTS.md');
}

/**
 * Resolves the global rules directory and lessons_learned.md path.
 */
function getGlobalRulesPath(customPath = null) {
    if (customPath) return customPath;

    const candidateRuleDirs = [
        process.env.AGY_RULES_DIR,
        '/root/.gemini/antigravity-cli/rules',
        path.join(process.env.HOME || '', '.gemini/antigravity-cli/rules'),
        path.join(os.homedir(), '.gemini/antigravity-cli/rules')
    ].filter(Boolean);

    let chosenDir = null;
    for (const dir of candidateRuleDirs) {
        try {
            if (fs.existsSync(dir)) {
                chosenDir = dir;
                break;
            }
        } catch (_) {}
    }

    if (!chosenDir) {
        // Fallback to primary candidate and create if possible
        chosenDir = candidateRuleDirs[0] || path.join(os.homedir(), '.gemini/antigravity-cli/rules');
        try {
            fs.mkdirSync(chosenDir, { recursive: true });
        } catch (_) {}
    }

    return path.join(chosenDir, 'lessons_learned.md');
}

/**
 * Adds a lesson to project AGENTS.md or global rules.
 */
function addMemory(lessonText, options = {}) {
    if (!lessonText || !lessonText.trim()) {
        return { success: false, error: 'Memory content cannot be empty.' };
    }

    const cleanLesson = lessonText.trim();
    const isGlobal = Boolean(options.isGlobal);
    const threads = getThreads(options.threadsPath);
    const threadName = options.threadName || threads.active_thread || 'default';
    const dateStr = new Date().toISOString().slice(0, 10);
    const entry = `* **[${threadName}]** (${dateStr}): ${cleanLesson}`;

    if (isGlobal) {
        const targetFile = getGlobalRulesPath(options.customPath);
        try {
            const dir = path.dirname(targetFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            let content = '';
            if (fs.existsSync(targetFile)) {
                content = fs.readFileSync(targetFile, 'utf8');
            } else {
                content = `---\ndescription: "Global lessons learned, user preferences, and cross-project knowledge."\nalways_on: true\n---\n\n# Global Lessons Learned & Cross-Project Knowledge\n\nThese guidelines and lessons apply across all projects and environments:\n\n`;
            }

            if (!content.endsWith('\n')) content += '\n';
            content += `${entry}\n`;
            fs.writeFileSync(targetFile, content, 'utf8');

            return {
                success: true,
                scope: 'global',
                targetFile,
                entry,
                message: `[✓] **Saved to Global Rules:**\n└─ ${entry}\n\n*(Applies globally to all projects in \`${path.basename(targetFile)}\`)*`
            };
        } catch (e) {
            return {
                success: false,
                error: `Failed to write global memory: ${e.message}`
            };
        }
    } else {
        const targetFile = getWorkspaceAgentsMdPath(options.workspaceDir);
        try {
            const dir = path.dirname(targetFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            let content = '';
            if (fs.existsSync(targetFile)) {
                content = fs.readFileSync(targetFile, 'utf8');
            } else {
                content = `# Agent Instructions & Project Memory\n\nGuidelines and workflows for this repository.\n\n`;
            }

            if (content.includes(LESSONS_HEADER)) {
                // Insert directly after the header
                const headerIndex = content.indexOf(LESSONS_HEADER);
                const before = content.slice(0, headerIndex + LESSONS_HEADER.length);
                const after = content.slice(headerIndex + LESSONS_HEADER.length);
                content = `${before}\n${entry}${after.startsWith('\n') ? '' : '\n'}${after}`;
            } else {
                if (!content.endsWith('\n')) content += '\n';
                content += `\n${LESSONS_HEADER}\n\n${entry}\n`;
            }

            fs.writeFileSync(targetFile, content, 'utf8');

            return {
                success: true,
                scope: 'project',
                targetFile,
                entry,
                message: `[✓] **Saved to Project Memory:**\n└─ ${entry}\n\n*(Recorded in \`${path.basename(targetFile)}\` for thread \`${threadName}\`)*`
            };
        } catch (e) {
            return {
                success: false,
                error: `Failed to write project memory: ${e.message}`
            };
        }
    }
}

/**
 * Retrieves all stored project and global memories.
 */
function getMemories(options = {}) {
    const projectFile = getWorkspaceAgentsMdPath(options.workspaceDir);
    const globalFile = getGlobalRulesPath(options.customPath);

    const projectMemories = [];
    const globalMemories = [];

    // Parse project memories from AGENTS.md
    if (fs.existsSync(projectFile)) {
        try {
            const raw = fs.readFileSync(projectFile, 'utf8');
            const lines = raw.split('\n');
            let inSection = false;

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('## ') && trimmed === LESSONS_HEADER) {
                    inSection = true;
                    continue;
                } else if (trimmed.startsWith('## ') && inSection) {
                    break;
                }

                if (inSection && (trimmed.startsWith('* ') || trimmed.startsWith('- '))) {
                    projectMemories.push(trimmed.replace(/^[\*\-]\s+/, ''));
                }
            }
        } catch (_) {}
    }

    // Parse global memories from lessons_learned.md
    if (fs.existsSync(globalFile)) {
        try {
            const raw = fs.readFileSync(globalFile, 'utf8');
            const lines = raw.split('\n');
            let pastFrontmatter = false;
            let fenceCount = 0;

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed === '---') {
                    fenceCount++;
                    if (fenceCount >= 2) pastFrontmatter = true;
                    continue;
                }
                if (fenceCount === 1) continue; // inside frontmatter

                if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
                    globalMemories.push(trimmed.replace(/^[\*\-]\s+/, ''));
                }
            }
        } catch (_) {}
    }

    return {
        projectFile,
        globalFile,
        projectMemories,
        globalMemories
    };
}

/**
 * Formats a clean list of memories for Rocket.Chat.
 */
function formatMemoryList(options = {}) {
    const { projectMemories, globalMemories, projectFile, globalFile } = getMemories(options);
    const threads = getThreads(options.threadsPath);
    const activeThread = options.threadName || threads.active_thread || 'default';

    let reply = `🧠 **Antigravity Context Memory & Lessons Learned**\n`;
    reply += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    reply += `📁 **Project Memory (\`${path.basename(projectFile)}\`):**\n`;
    if (projectMemories.length === 0) {
        reply += `*(No lessons recorded for this project yet. Use \`!agy remember <text>\`)*\n\n`;
    } else {
        projectMemories.forEach((mem, idx) => {
            reply += `**#${idx + 1}** ${mem}\n`;
        });
        reply += '\n';
    }

    reply += `🌐 **Global Memory (\`${path.basename(globalFile)}\`):**\n`;
    if (globalMemories.length === 0) {
        reply += `*(No global lessons recorded yet. Use \`!agy remember global <text>\`)*\n\n`;
    } else {
        globalMemories.forEach((mem, idx) => {
            reply += `**#${idx + 1}** ${mem}\n`;
        });
        reply += '\n';
    }

    reply += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    reply += `• Active Thread: \`${activeThread}\`\n\n`;
    reply += `*• Add project lesson: \`!agy remember <lesson>\`*\n`;
    reply += `*• Add global lesson: \`!agy remember global <lesson>\`*\n`;
    reply += `*• Remove lesson: \`!agy forget <keyword>\`*`;

    return reply;
}

/**
 * Removes a memory matching a search keyword or index.
 */
function removeMemory(targetKeyword, options = {}) {
    if (!targetKeyword || !targetKeyword.trim()) {
        return { success: false, error: 'Please provide a keyword or snippet of the memory to remove.' };
    }

    const keyword = targetKeyword.trim().toLowerCase();
    const isGlobal = Boolean(options.isGlobal);
    const targetFile = isGlobal
        ? getGlobalRulesPath(options.customPath)
        : getWorkspaceAgentsMdPath(options.workspaceDir);

    if (!fs.existsSync(targetFile)) {
        return { success: false, error: `File not found: ${targetFile}` };
    }

    try {
        const raw = fs.readFileSync(targetFile, 'utf8');
        const lines = raw.split('\n');
        const keptLines = [];
        const removedLines = [];

        for (const line of lines) {
            const trimmed = line.trim();
            const isBullet = trimmed.startsWith('* ') || trimmed.startsWith('- ');
            if (isBullet && trimmed.toLowerCase().includes(keyword)) {
                removedLines.push(trimmed);
            } else {
                keptLines.push(line);
            }
        }

        if (removedLines.length === 0) {
            return {
                success: false,
                error: `No memories found matching "${targetKeyword}" in ${isGlobal ? 'global rules' : 'project memory'}.`
            };
        }

        fs.writeFileSync(targetFile, keptLines.join('\n'), 'utf8');

        return {
            success: true,
            removedCount: removedLines.length,
            removedLines,
            message: `[✓] **Removed ${removedLines.length} memory item(s):**\n` +
                removedLines.map(l => `└─ ${l}`).join('\n')
        };
    } catch (e) {
        return {
            success: false,
            error: `Failed to remove memory: ${e.message}`
        };
    }
}

module.exports = {
    getWorkspaceAgentsMdPath,
    getGlobalRulesPath,
    addMemory,
    getMemories,
    formatMemoryList,
    removeMemory
};
