const { getThreads, setActiveThread, formatRelativeTime } = require('./threads');

class QueueManager {
    constructor() {
        this.queue = [];
        this.activeJob = null;
    }

    /**
     * Checks if a prompt execution is currently in progress.
     */
    isBusy() {
        return this.activeJob !== null;
    }

    /**
     * Returns the currently running job, or null if idle.
     */
    getActiveJob() {
        return this.activeJob;
    }

    /**
     * Returns a snapshot of pending queued jobs.
     */
    getQueue() {
        return [...this.queue];
    }

    /**
     * Enqueues a new prompt request.
     * Returns the 1-based queue position.
     */
    enqueue(jobData) {
        const id = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const job = {
            id,
            roomId: jobData.roomId,
            tmid: jobData.tmid,
            messageText: jobData.messageText,
            forceAgy: Boolean(jobData.forceAgy),
            shouldRefine: Boolean(jobData.shouldRefine),
            threadName: jobData.threadName || getThreads().active_thread || 'default',
            queuedMsgId: jobData.queuedMsgId || null,
            enqueuedAt: Date.now(),
            ...jobData
        };

        this.queue.push(job);
        console.log(`[Queue] Enqueued job ${id} (Position #${this.queue.length}) for thread "${job.threadName}": "${job.messageText.substring(0, 40)}..."`);
        return this.queue.length;
    }

    /**
     * Updates the queued placeholder message ID for a pending job by index.
     */
    updateJobMsgId(index, msgId) {
        if (this.queue[index]) {
            this.queue[index].queuedMsgId = msgId;
        }
    }

    /**
     * Removes and returns the next job in line.
     */
    dequeue() {
        if (this.queue.length === 0) return null;
        return this.queue.shift();
    }

    /**
     * Sets the active running job.
     */
    setActiveJob(job) {
        this.activeJob = job ? {
            ...job,
            startedAt: Date.now(),
            childProcess: job.childProcess || null
        } : null;
        if (this.activeJob) {
            console.log(`[Queue] Active job started: ${this.activeJob.id} ("${this.activeJob.messageText.substring(0, 40)}...") in thread "${this.activeJob.threadName}"`);
        }
    }

    /**
     * Attaches the active child process handle (for abort/kill capabilities).
     */
    attachProcess(childProcess) {
        if (this.activeJob) {
            this.activeJob.childProcess = childProcess;
        }
    }

    /**
     * Clears the active job.
     */
    clearActiveJob() {
        if (this.activeJob) {
            console.log(`[Queue] Active job finished: ${this.activeJob.id}`);
        }
        this.activeJob = null;
    }

    /**
     * Cancels the active job by sending SIGTERM (or custom signal) to child process.
     */
    cancelActive(signal = 'SIGTERM') {
        if (!this.activeJob) {
            return { success: false, message: 'No active task is currently running.' };
        }

        const job = this.activeJob;
        if (job.childProcess && typeof job.childProcess.kill === 'function') {
            try {
                job.childProcess.kill(signal);
                console.log(`[Queue] Sent ${signal} to active job ${job.id}`);
                return {
                    success: true,
                    job,
                    message: `[✓] **Cancelled active task:** "${job.messageText.substring(0, 50)}..."`
                };
            } catch (e) {
                return {
                    success: false,
                    message: `Failed to terminate active process: ${e.message}`
                };
            }
        }

        return {
            success: false,
            message: 'Active task is not attached to a killable child process.'
        };
    }

    /**
     * Clears all pending queued jobs.
     */
    clearQueue() {
        const count = this.queue.length;
        const cleared = [...this.queue];
        this.queue = [];
        console.log(`[Queue] Cleared ${count} pending job(s) from queue`);
        return { count, cleared };
    }

    /**
     * Formats status of the active job and pending queue for Rocket.Chat.
     */
    formatQueueStatus() {
        let reply = `📋 **FIFO Message Queue Status**\n`;
        reply += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        if (!this.activeJob) {
            reply += `🟢 **Active Task:** *Idle (Ready for prompts)*\n\n`;
        } else {
            const elapsed = Math.round((Date.now() - this.activeJob.startedAt) / 1000);
            const promptPreview = this.activeJob.messageText.length > 60
                ? this.activeJob.messageText.substring(0, 57) + '...'
                : this.activeJob.messageText;

            reply += `🟡 **Active Task Running:**\n`;
            reply += `• **Prompt:** "${promptPreview}"\n`;
            reply += `• **Thread:** \`${this.activeJob.threadName}\`\n`;
            reply += `• **Elapsed Time:** ${elapsed}s\n`;
            reply += `• **Status:** Processing...\n\n`;
        }

        reply += `⏳ **Pending Queue (${this.queue.length}):**\n`;
        if (this.queue.length === 0) {
            reply += `*(No prompts waiting in line)*\n`;
        } else {
            this.queue.forEach((job, idx) => {
                const waitSec = Math.round((Date.now() - job.enqueuedAt) / 1000);
                const preview = job.messageText.length > 50
                    ? job.messageText.substring(0, 48) + '..'
                    : job.messageText;
                reply += `**#${idx + 1}** \`${job.threadName}\`: "${preview}" *(waiting ${waitSec}s)*\n`;
            });
        }

        reply += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        reply += `*• View queue: \`!agy queue\`*\n`;
        reply += `*• Cancel active task: \`!agy cancel\`*\n`;
        reply += `*• Clear pending queue: \`!agy clear queue\`*\n`;
        reply += `*• Cancel everything: \`!agy cancel all\`*`;

        return reply;
    }
}

const queueManager = new QueueManager();

module.exports = {
    QueueManager,
    queueManager
};
