const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { DebugHandler } = require('./main_scripts/debug-handler');


// Lazy load SettingsPanel to avoid blocking activation
let SettingsPanel = null;
function getSettingsPanel() {
    if (!SettingsPanel) {
        try {
            SettingsPanel = require('./settings-panel').SettingsPanel;
        } catch (e) {
            console.error('Failed to load SettingsPanel:', e);
        }
    }
    return SettingsPanel;
}

// states

const GLOBAL_STATE_KEY = 'auto-accept-enabled-global';
const PRO_STATE_KEY = 'auto-accept-isPro';
const FREQ_STATE_KEY = 'auto-accept-frequency';
const BANNED_COMMANDS_KEY = 'auto-accept-banned-commands';
const HAS_RUN_KEY = 'auto-accept-has-run';
const ENABLED_DURING_SESSION_KEY = 'auto-accept-enabled-during-session';
const ROI_STATS_KEY = 'auto-accept-roi-stats'; // For ROI notification
const SECONDS_PER_CLICK = 5; // Conservative estimate: 5 seconds saved per auto-accept
const LICENSE_API = 'https://auto-accept-backend.onrender.com/api';
// Locking
const LOCK_KEY = 'auto-accept-instance-lock';
const HEARTBEAT_KEY = 'auto-accept-instance-heartbeat';
const INSTANCE_ID = Math.random().toString(36).substring(7);

const LOG_FILE_NAME = 'auto-accept-cdp-TRAE.log';

let isEnabled = false;
let isPro = true; // Pro features always enabled
let isLockedOut = false; // Local tracking
let pollFrequency = 2000; // Default for Free
let bannedCommands = []; // List of command patterns to block

const RELEASY_PROMO_KEY = 'auto-accept-releasy-promo-shown';

let pollTimer;
let statsCollectionTimer; // For periodic stats collection
let statusBarItem;
let statusSettingsItem;
let statusQueueItem; // Queue status display
let outputChannel;
let currentIDE = 'Trae';
let globalContext;
let startupConfirmedForSession = false;
let enabledDuringLastSession = false;
let hasRunBefore = false;
let continuePolicyForNextStart = 'auto'; // 'auto' | 'ask' (ask prevents auto-resume on enable)
let lastAutoContinueSweepAt = 0;
const autoContinueLastClickByConn = new Map(); // connectionId -> ts

function isAutoContinueOnOpenOrStartEnabled() {
    try {
        return !!vscode.workspace.getConfiguration('auto-accept.continue').get('autoClickOnOpenOrStart', true);
    } catch (e) {
        return true;
    }
}

function getConfiguredCDPSettings() {
    try {
        const cfg = vscode.workspace.getConfiguration('auto-accept.cdp');
        const port = Number(cfg.get('port', 9005));
        return {
            port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 9005
        };
    } catch (e) {
        return { port: 9005 };
    }
}

function applyCDPSettingsToHandler() {
    if (!cdpHandler || typeof cdpHandler.setPortConfig !== 'function') return getConfiguredCDPSettings();
    const settings = getConfiguredCDPSettings();
    cdpHandler.setPortConfig(settings.port);
    return settings;
}

async function maybeAutoClickContinueOnOpenOrStart(source = 'unknown') {
    try {
        if (!isEnabled || !cdpHandler) return;
        if (!isAutoContinueOnOpenOrStartEnabled()) return;

        const now = Date.now();
        if (lastAutoContinueSweepAt && (now - lastAutoContinueSweepAt) < 1500) return;
        lastAutoContinueSweepAt = now;

        const hasResults = await cdpHandler.evaluateAll('Boolean(window.__autoAcceptHasContinue && window.__autoAcceptHasContinue())');
        const targets = Array.isArray(hasResults)
            ? hasResults.filter(r => r && r.ok && r.value === true).map(r => r.id)
            : [];

        if (targets.length === 0) return;

        log(`[Continue] AutoClick(${source}): detected on ${targets.length} session(s)`);

        const clicks = [];
        for (const id of targets) {
            const last = autoContinueLastClickByConn.get(id) || 0;
            if (last && (now - last) < 2500) continue;
            autoContinueLastClickByConn.set(id, now);

            const res = await cdpHandler.evaluateOn(
                id,
                'typeof window!=="undefined" && window.__autoAcceptForceClickContinueOnce ? window.__autoAcceptForceClickContinueOnce() : false',
                4000
            );
            clicks.push({ id, ...res });
        }

        if (clicks.length > 0) {
            const ok = clicks.filter(c => c.ok);
            const anyClicked = ok.some(c => c.value === true);
            log(`[Continue] AutoClick(${source}): anyClicked=${anyClicked} results=${JSON.stringify(ok.map(c => ({ id: c.id, value: c.value })))}`);
        }
    } catch (e) {
        log(`[Continue] AutoClick(${source}) error: ${e?.message || String(e)}`);
    }
}

let cdpHandler;
let relauncher;
let debugHandler; // Debug Handler instance
let lastContinueDiagLogAt = 0;
const continueDumpState = new Map();

function getLogFilePathFromContext(context) {
    try {
        const storagePath = (context && context.globalStorageUri && context.globalStorageUri.fsPath)
            ? context.globalStorageUri.fsPath
            : (context && context.globalStoragePath ? context.globalStoragePath : null);

        if (storagePath) {
            try { fs.mkdirSync(storagePath, { recursive: true }); } catch (e) { }
            return path.join(storagePath, LOG_FILE_NAME);
        }
    } catch (e) { }

    const extensionRoot = path.basename(__dirname).toLowerCase() === 'dist'
        ? path.join(__dirname, '..')
        : __dirname;
    return path.join(extensionRoot, LOG_FILE_NAME);
}

function log(message) {
    try {
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        const logLine = `[${timestamp}] ${message}`;
        console.log(logLine);

        const logPath = getLogFilePathFromContext(globalContext);
        fs.appendFileSync(logPath, logLine + '\n');
    } catch (e) {
        console.error('\u{26A1} failed:', e);
    }
}

// --- Scheduler Class ---
class Scheduler {
    constructor(context, cdpHandler, logFn, options = {}) {
        this.context = context;
        this.cdpHandler = cdpHandler;
        this.log = logFn;
        this.timer = null;
        this.silenceTimer = null;
        this.lastRunTime = Date.now();
        this.lastClickTime = 0;
        this.lastClickCount = 0;
        this.lastActivityTime = 0;
        this.lastDomActivityTime = 0;
        this.enabled = false;
        this.config = {};
        this.promptQueue = Promise.resolve();

        // Queue mode state
        this.runtimeQueue = [];
        this.queueIndex = 0;
        this.isRunningQueue = false;
        this.isStopped = false; // Flag to cancel pending prompts
        this.taskStartTime = 0;
        this.hasSentCurrentItem = false;
        this.activationTime = Date.now(); // Track when scheduler was created for activation guard
        this.ensureCdpReady = typeof options.ensureCdpReady === 'function' ? options.ensureCdpReady : null;
        this.lastCdpSyncTime = 0;

        // Multi-queue ready architecture (single conversation for now)
        this.targetConversation = '';  // '' = current active tab
        this.promptHistory = [];       // HistoryEntry[]
        this.conversationStatus = 'idle'; // 'idle'|'running'|'waiting'
        this.isPaused = false;         // User-initiated pause

        // Sending backoff / retry state (prevents spamming the composer when the chat is busy)
        this.lastSendAttemptTime = 0;
        this.lastSendFailureToastAt = 0;

        // Queue send retry state (controlled)
        this.currentItemAttempts = 0;
        this.sendInProgress = false;
    }

    async ensureCdpReadyNow(reason, force = false) {
        if (!this.ensureCdpReady) return;
        const now = Date.now();
        if (!force && this.lastCdpSyncTime && (now - this.lastCdpSyncTime) < 2000) return;
        this.lastCdpSyncTime = now;
        try {
            this.log(`Scheduler: Syncing CDP (${reason})...`);
            await this.ensureCdpReady();
        } catch (e) {
            this.log(`Scheduler: CDP sync failed: ${e?.message || String(e)}`);
        }
    }

    start() {
        this.loadConfig();
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => this.check(), 60000);

        // Silence detection timer (runs more frequently)
        if (this.silenceTimer) clearInterval(this.silenceTimer);
        this.silenceTimer = setInterval(() => this.checkSilence(), 5000);

        // Reset activation time when scheduler starts (for accurate grace period)
        this.activationTime = Date.now();
        this.log('Scheduler started.');
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.silenceTimer) {
            clearInterval(this.silenceTimer);
            this.silenceTimer = null;
        }
        this.isRunningQueue = false;
    }

    loadConfig() {
        const cfg = vscode.workspace.getConfiguration('auto-accept.schedule');
        const newEnabled = cfg.get('enabled', false);

        // Reset timer on rising edge (Disabled -> Enabled)
        if (!this.enabled && newEnabled) {
            this.lastRunTime = Date.now();
            this.log('Scheduler: Enabled via config update - Timer reset');
        }
        this.enabled = newEnabled;
        this.config = {
            mode: cfg.get('mode', 'interval'),
            value: cfg.get('value', '30'),
            prompt: cfg.get('prompt', 'Status report please'),
            prompts: cfg.get('prompts', []),
            queueMode: cfg.get('queueMode', 'consume'),
            silenceTimeout: cfg.get('silenceTimeout', 30) * 1000, // Convert to ms
            checkPromptEnabled: cfg.get('checkPrompt.enabled', false),
            checkPromptText: cfg.get('checkPrompt.text', 'Make sure that the previous task was implemented fully as per requirements, implement all gaps, fix all bugs and test everything. Make sure that you reused existing code where possible instead of duplicating code. ultrathink internally avoiding verbosity.')
        };
        this.log(`Scheduler Config: mode=${this.config.mode}, enabled=${this.enabled}, prompts=${this.config.prompts.length}`);
    }

    buildRuntimeQueue() {
        const prompts = [...this.config.prompts];
        if (prompts.length === 0) return [];

        const queue = [];
        for (let i = 0; i < prompts.length; i++) {
            queue.push({ type: 'task', text: prompts[i], index: i });
            if (this.config.checkPromptEnabled) {
                queue.push({ type: 'check', text: this.config.checkPromptText, afterIndex: i });
            }
        }
        return queue;
    }

    async check() {
        this.loadConfig();
        if (!isEnabled) return;
        if (!this.enabled || !this.cdpHandler) return;

        const now = new Date();
        const mode = this.config.mode;
        const val = this.config.value;

        if (mode === 'interval') {
            const minutes = parseInt(val) || 30;
            const ms = minutes * 60 * 1000;
            if (Date.now() - this.lastRunTime > ms) {
                this.log(`Scheduler: Interval triggered (${minutes}m)`);
                await this.trigger();
            }
        } else if (mode === 'daily') {
            const [targetH, targetM] = val.split(':').map(Number);
            if (now.getHours() === targetH && now.getMinutes() === targetM) {
                if (Date.now() - this.lastRunTime > 60000) {
                    this.log(`Scheduler: Daily triggered (${val})`);
                    await this.trigger();
                }
            }
        }
        // Queue mode is handled via startQueue() and silence detection
    }

    async checkSilence() {
        // Queue advancement only requires: running queue + CDP connection + queue mode
        // Note: this.enabled is for scheduled runs; manual "Run Queue" doesn't need it
        if (!this.cdpHandler || !this.isRunningQueue) return;
        if (this.config.mode !== 'queue') return;
        if (this.isPaused) return; // User paused - wait for resume

        // Get current click count from CDP
        try {
            const stats = await this.cdpHandler.getStats();
            const currentClicks = stats?.clicks || 0;
            const reportedActivityTime = stats?.lastActivityTime || 0;
            const reportedDomActivityTime = stats?.lastDomActivityTime || 0;

            // If clicks happened, update last click time
            if (currentClicks > this.lastClickCount) {
                this.lastClickTime = Date.now();
                this.lastActivityTime = this.lastClickTime;
                this.lastClickCount = currentClicks;
                this.log(`Scheduler: Activity detected (${currentClicks} clicks)`);
            }

            if (reportedActivityTime && (!this.lastActivityTime || reportedActivityTime > this.lastActivityTime)) {
                this.lastActivityTime = reportedActivityTime;
            }
            if (reportedDomActivityTime && (!this.lastDomActivityTime || reportedDomActivityTime > this.lastDomActivityTime)) {
                this.lastDomActivityTime = reportedDomActivityTime;
            }

            // Check if silence timeout reached (only after we've successfully sent the current queue item)
            const silenceDuration = Date.now() - (this.lastActivityTime || this.lastClickTime || Date.now());
            const taskDuration = Date.now() - this.taskStartTime;

            // In queue mode, the UI's "Value / Timeout" is treated as a max-wait per item (seconds).
            // This prevents the queue from appearing to "ignore" a smaller timeout value.
            const queueTimeoutSeconds = parseInt(String(this.config.value || '30'), 10);
            const queueTimeoutMs = (Number.isFinite(queueTimeoutSeconds) && queueTimeoutSeconds > 0 ? queueTimeoutSeconds : 30) * 1000;
            const minTaskDurationMs = 1500; // small guard to avoid instant advancement on stale timestamps

            if (this.hasSentCurrentItem && taskDuration > minTaskDurationMs) {
                const silenceHit = silenceDuration > this.config.silenceTimeout;
                const timeoutHit = taskDuration > queueTimeoutMs;
                if (silenceHit || timeoutHit) {
                    let canAdvance = true;
                    try {
                        const convStatus = await this.getConversationStatus();
                        if (convStatus === 'working') canAdvance = false;
                    } catch (e) { }

                    if (!canAdvance) return;
                    const reason = timeoutHit
                        ? `timeout (${Math.round(taskDuration / 1000)}s > ${Math.round(queueTimeoutMs / 1000)}s)`
                        : `silence (${Math.round(silenceDuration / 1000)}s > ${Math.round(this.config.silenceTimeout / 1000)}s)`;
                    this.log(`Scheduler: Advancing queue due to ${reason}`);
                    await this.advanceQueue();
                }
            }
            // Retry sending if we haven't successfully sent the current item yet.
            // Backoff is enforced in executeCurrentQueueItem().
            if (this.conversationStatus === 'waiting' && !this.hasSentCurrentItem) {
                await this.executeCurrentQueueItem();
            }
        } catch (e) {
            this.log(`Scheduler: Error checking silence: ${e.message}`);
        }
    }

    async startQueue(options) {
        // CRITICAL: Require explicit source for all startQueue calls
        const validSources = ['manual', 'debug-server', 'resume', 'test'];
        const source = options?.source;

        // DEBUG: Trace caller if no valid source
        if (!source || !validSources.includes(source)) {
            this.log(`Scheduler: BLOCKED startQueue - invalid source: "${source}". Valid: ${validSources.join(', ')}`);
            this.log('Scheduler: Stack trace: ' + new Error().stack);
            return; // Block phantom callers
        }

        this.log(`Scheduler: startQueue called with source: ${source}`);

        // Dampener: Prevent rapid restarts/loops (2 second cooldown)
        if (this.lastStartQueueTime && Date.now() - this.lastStartQueueTime < 2000) {
            this.log('Scheduler: Ignoring rapid startQueue call (< 2s)');
            return;
        }
        this.lastStartQueueTime = Date.now();

        // ACTIVATION GUARD: Block non-manual starts during activation grace period.
        // Prevents config/debug automation from triggering queue start on reload, while still allowing user clicks.
        if (this.activationTime && Date.now() - this.activationTime < 5000 && source !== 'manual' && source !== 'test') {
            this.log(`Scheduler: BLOCKED startQueue during activation grace period (${Math.round((Date.now() - this.activationTime) / 1000)}s < 5s)`);
            return;
        }

        // Load config first to get current state
        this.loadConfig();

        // Prevent auto-starting queue when scheduler is enabled but user hasn't explicitly started it
        if (this.config.mode === 'queue' && this.isRunningQueue) {
            this.log('Scheduler: Queue is already running, ignoring duplicate startQueue call');
            return;
        }

        this.log(`Scheduler: Queue start proceeding (source: ${source})`);

        if (this.config.mode !== 'queue') {
            this.log('Scheduler: Not in queue mode, ignoring startQueue');
            vscode.window.showWarningMessage('Multi Purpose Agent for TRAE: Set mode to "Queue" first.');
            return;
        }

        // Ensure we have fresh CDP connections and injected helpers (chat webviews may not exist at activation time).
        await this.ensureCdpReadyNow('startQueue', true);

        // Clear stale browser-side completion statuses that can deadlock queue sending.
        try {
            if (this.cdpHandler && typeof this.cdpHandler.evaluate === 'function') {
                await this.cdpHandler.evaluate('if(window.__autoAcceptState){ window.__autoAcceptState.completionStatus = {}; }');
            }
        } catch (e) {
            this.log(`Scheduler: Failed to clear completion status: ${e.message}`);
        }

        this.runtimeQueue = this.buildRuntimeQueue();
        this.queueIndex = 0;
        this.isRunningQueue = true;
        this.isStopped = false; // Clear stopped flag when starting
        this.lastClickCount = 0;
        this.lastClickTime = Date.now();
        this.lastActivityTime = Date.now();
        this.lastDomActivityTime = 0;
        this.taskStartTime = Date.now();
        this.hasSentCurrentItem = false;
        this.lastSendAttemptTime = 0;
        this.currentItemAttempts = 0;

        this.log(`Scheduler: Starting queue with ${this.runtimeQueue.length} items`);

        if (this.runtimeQueue.length === 0) {
            this.log('Scheduler: Queue is empty, nothing to run');
            if (options && options.source === 'manual') {
                // Warning Dampener: Prevent spamming warnings loop
                const now = Date.now();
                if (this.queueWarningDampener && (now - this.queueWarningDampener < 5000)) {
                    this.log('Scheduler: Suppressed empty queue warning (dampener active)');
                } else {
                    vscode.window.showWarningMessage('Multi Purpose Agent for TRAE: Prompt queue is empty. Add prompts first.');
                    this.queueWarningDampener = now;
                }
            } else {
                this.log('Scheduler: Suppressing empty queue warning (auto-start or no source)');
            }
            this.isRunningQueue = false;
            this.hasSentCurrentItem = false;
            return;
        }

        await this.executeCurrentQueueItem();
    }

    async advanceQueue() {
        if (!this.isRunningQueue) return;

        const completedItem = this.runtimeQueue[this.queueIndex];

        // In consume mode, remove prompts only after completing a TASK item (not after check prompts).
        if (this.config.queueMode === 'consume' && completedItem && completedItem.type === 'task') {
            await this.consumeCurrentPrompt();
        }

        this.queueIndex++;
        this.lastClickCount = 0;
        this.lastClickTime = Date.now();
        this.lastActivityTime = Date.now();
        this.lastDomActivityTime = 0;
        this.taskStartTime = Date.now();
        this.hasSentCurrentItem = false;
        this.lastSendAttemptTime = 0;
        this.currentItemAttempts = 0;

        if (this.queueIndex >= this.runtimeQueue.length) {
            if (this.config.queueMode === 'loop' && this.runtimeQueue.length > 0) {
                this.log('Scheduler: Queue completed, looping...');
                this.queueIndex = 0;
                // Rebuild queue to respect any config changes
                this.loadConfig();
                this.runtimeQueue = this.buildRuntimeQueue();
            } else {
                this.log('Scheduler: Queue completed, stopping');
                this.isRunningQueue = false;
                vscode.window.showInformationMessage('Multi Purpose Agent for TRAE: Prompt queue completed!');
                return;
            }
        }

        await this.executeCurrentQueueItem();
    }

    async sendQueueItemText(text) {
        return this.queuePrompt(text, { fatalOnFail: false });
    }

     async executeCurrentQueueItem() {
         if (this.queueIndex >= this.runtimeQueue.length) return;
 
         // Never run multiple send attempts concurrently (prevents duplicated/concatenated prompts).
         if (this.sendInProgress) return;
 
         // Backoff: avoid repeatedly trying to send while the UI is in a transient state.
         if (this.lastSendAttemptTime && (Date.now() - this.lastSendAttemptTime) < 4000) {
             return;
         }

        // Controlled retries for the current item only.
        if (this.currentItemAttempts >= 5) {
            this.conversationStatus = 'idle';
            vscode.window.showErrorMessage('Queue Error: Prompt not delivered (failed 5 times).');
            this.stopQueue();
            return;
        }

        // Check conversation status before sending
        const status = await this.getConversationStatus();
        if (status === 'working') {
            this.log('Scheduler: Conversation b\u{1F504}, will retry on next silence check...');
            this.conversationStatus = 'waiting';
            return; // Silence timer will retry
        }

        const item = this.runtimeQueue[this.queueIndex];
        const itemType = item.type === 'check' ? 'Check Prompt' : `Task ${item.index + 1}`;

        const checkTranscriptForSnippet = async (rawText) => {
            if (!this.cdpHandler || typeof this.cdpHandler.evaluateAll !== 'function') return false;
            const snippet = String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, 96).toLowerCase();
            if (!snippet) return false;
            const expr = `(function(){try{var s=${JSON.stringify(snippet)};function getAllDocs(root){var out=[];var seen=new Set();function push(d){try{if(!d||seen.has(d))return;seen.add(d);out.push(d);}catch(e){}}push(root||document);for(var i=0;i<out.length;i++){var d=out[i];try{var frames=d.querySelectorAll('iframe,frame');for(var j=0;j<frames.length;j++){try{var fd=frames[j].contentDocument||(frames[j].contentWindow&&frames[j].contentWindow.document);if(fd)push(fd);}catch(e){}}}catch(e){}}return out;}function docText(doc){try{var el=(doc&&doc.body)?doc.body:(doc&&doc.documentElement?doc.documentElement:null);if(!el)return '';var t=(el.innerText||el.textContent||'');return (t+'').toLowerCase();}catch(e){return '';}}var docs=getAllDocs(document);for(var k=0;k<docs.length;k++){var t=docText(docs[k]);if(t&&t.indexOf(s)!==-1)return true;}return false;}catch(e){return false;}})()`;
            const results = await this.cdpHandler.evaluateAll(expr);
            return Array.isArray(results) && results.some(r => r && r.ok && (r.value === true || r.value === 'true'));
        };

        // If we've already attempted to send this item, de-dupe retries by checking the transcript first.
        if (this.currentItemAttempts > 0) {
            try {
                const already = await checkTranscriptForSnippet(item.text);
                if (already) {
                    this.log(`Scheduler: Prompt already present in transcript; marking as sent for ${itemType}`);
                    this.hasSentCurrentItem = true;
                    this.lastActivityTime = Date.now();
                    this.conversationStatus = 'running';
                    return;
                }
            } catch (e) {
                // ignore transcript check errors
            }
        }

         this.log(`Scheduler: Executing ${itemType}: "${item.text.substring(0, 50)}..."`);
         this.conversationStatus = 'running';
         vscode.window.showInformationMessage(`Multi Purpose Agent for TRAE: Sending ${itemType}`);
 
         const isCheckPrompt = item.type === 'check';
         this.lastSendAttemptTime = Date.now();
         this.currentItemAttempts++;
 
         this.sendInProgress = true;
         let res;
         try {
             res = await this.sendQueueItemText(item.text);
         } finally {
             this.sendInProgress = false;
         }
         
        if (res && res.success === false && this.isRunningQueue) {
            if (!isCheckPrompt) {
                try {
                    const already = await checkTranscriptForSnippet(item.text);
                    if (already) {
                        this.log(`Scheduler: Prompt appears in transcript after reported failure; treating as sent for ${itemType}`);
                        this.hasSentCurrentItem = true;
                        this.lastActivityTime = Date.now();
                        this.conversationStatus = 'running';
                        return;
                    }
                } catch (e) { }
            }

            this.conversationStatus = 'waiting';
            const now = Date.now();
            if (!this.lastSendFailureToastAt || (now - this.lastSendFailureToastAt) > 15000) {
                vscode.window.showWarningMessage(`Multi Purpose Agent for TRAE: ${res.error || 'Prompt not delivered'} (will retry)`);
                this.lastSendFailureToastAt = now;
            }
            return;
        }
        // Note: addToHistory is called inside queuePrompt after successful send
    }

    async consumeCurrentPrompt() {
        try {
            const config = vscode.workspace.getConfiguration('auto-accept.schedule');
            const prompts = config.get('prompts', []);
            if (prompts.length > 0) {
                // Remove the first prompt (the one that was just completed)
                const remaining = prompts.slice(1);
                await config.update('prompts', remaining, vscode.ConfigurationTarget.Global);
                this.log(`Scheduler: Consumed prompt, ${remaining.length} remaining`);
            }
        } catch (e) {
            this.log(`Scheduler: Error consuming prompt: ${e.message}`);
        }
    }

    async consumeCompletedPrompts() {
        try {
            const config = vscode.workspace.getConfiguration('auto-accept.schedule');
            // Clear the prompts array after successful completion
            await config.update('prompts', [], vscode.ConfigurationTarget.Global);
            this.log('Scheduler: Consumed prompts cleared from config');
        } catch (e) {
            this.log(`Scheduler: Error clearing consumed prompts: ${e.message}`);
        }
    }

    async queuePrompt(text, options = {}) {
        const fatalOnFail = options.fatalOnFail !== false;

        this.promptQueue = this.promptQueue.then(async () => {
            // Check if queue was stopped before we could send
            if (this.isStopped) {
                this.log('Scheduler: Prompt cancelled (queue stopped)');
                return { success: false, cancelled: true };
            }

            this.lastRunTime = Date.now();
            if (!text) return { success: false, skipped: true };

            this.log(`Scheduler: Sending prompt "${text.substring(0, 50)}..."`);

            // Use CDP only - the verified working method
            if (this.cdpHandler) {
                try {
                    // Ensure CDP has scanned/injected latest chat surfaces before attempting to send.
                    await this.ensureCdpReadyNow('queuePrompt');

                    const rawSentCount = await this.cdpHandler.sendPrompt(text, this.targetConversation);
                    let sentCount = typeof rawSentCount === 'number' ? rawSentCount : (rawSentCount ? 1 : 0);

                    // CRITICAL FIX: If 0 prompts sent, we must abort, otherwise we wait for silence forever
                    if (sentCount === 0) {
                        const err = new Error('Prompt not delivered (no active chat input / send function found).');
                        if (fatalOnFail) throw err;
                        this.log(`Scheduler: Non-fatal send failure: ${err.message}`);
                        return { success: false, error: err.message, sentCount: 0 };
                    }

                    this.addToHistory(text, this.targetConversation);
                    if (this.isRunningQueue && this.config.mode === 'queue') {
                        this.hasSentCurrentItem = true;
                        this.lastActivityTime = Date.now();
                    }
                    this.log(`Scheduler: Prompt sent via CDP (${sentCount} tabs)`);
                    return { success: true, sentCount };
                } catch (err) {
                    this.log(`Scheduler: CDP failed: ${err.message}`);
                    if (fatalOnFail) {
                        vscode.window.showErrorMessage(`Queue Error: ${err.message}`);
                        // Force stop queue on critical error to prevent "Running" ghost state
                        this.stopQueue();
                        return { success: false, error: err.message };
                    }
                    vscode.window.showWarningMessage(`Multi Purpose Agent for TRAE: ${err.message}`);
                    return { success: false, error: err.message };
                }
             } else {
                 this.log('Scheduler: CDP handler not available');
                 if (this.isRunningQueue && this.config.mode === 'queue') {
                     if (fatalOnFail) {
                         vscode.window.showErrorMessage('Queue Error: CDP handler not available.');
                         this.stopQueue();
                         return { success: false, error: 'CDP handler not available.' };
                     }
                     vscode.window.showWarningMessage('Multi Purpose Agent for TRAE: CDP handler not available.');
                     return { success: false, error: 'CDP handler not available.' };
                 }
                 return { success: false, error: 'CDP handler not available.' };
             }
         }).catch(err => {
             this.log(`Scheduler Error: ${err.message}`);
             return { success: false, error: err.message };
         });
         return this.promptQueue;
     }

    async sendPrompt(text) {
        return this.queuePrompt(text);
    }

    async trigger() {
        const text = this.config.prompt;
        return this.queuePrompt(text);
    }

    getStatus() {
        return {
            enabled: this.enabled,
            mode: this.config.mode,
            isRunningQueue: this.isRunningQueue,
            queueLength: this.runtimeQueue.length,
            queueIndex: this.queueIndex,
            targetConversation: this.targetConversation,
            conversationStatus: this.conversationStatus,
            isPaused: this.isPaused,
            currentPrompt: this.getCurrentPrompt()
        };
    }

    // --- Multi-Queue Ready Methods ---

    async getConversationStatus(conversationId) {
        if (!this.cdpHandler) return 'unknown';
        try {
            // If we don't have any active CDP connections yet, treat as busy and retry later.
            if (typeof this.cdpHandler.getConnectionCount === 'function' && this.cdpHandler.getConnectionCount() === 0) {
                return 'working';
            }

            const state = await this.cdpHandler.getCompletionStatus();
            const target = conversationId || this.targetConversation || 'current';

            // If user selected a specific conversation, use it directly.
            if (target && target !== 'current') {
                return state?.[target] || 'idle';
            }

            // For "Current (Active Tab)", try to resolve which tab is active instead of blocking on ANY working tab.
            if (typeof this.cdpHandler.getActiveConversation === 'function') {
                const active = await this.cdpHandler.getActiveConversation();
                if (active) {
                    return state?.[active] || 'idle';
                }
            }

            // No reliable active tab signal - default to idle to avoid deadlocking the queue.
            return 'idle';
        } catch (e) {
            this.log(`Scheduler: Error getting conversation status: ${e.message}`);
            return 'unknown';
        }
    }

    async getConversations() {
        if (!this.cdpHandler) return [];
        try {
            return await this.cdpHandler.getConversations();
        } catch (e) {
            this.log(`Scheduler: Error getting conversations: ${e.message}`);
            return [];
        }
    }

    addToHistory(text, conversationId) {
        const entry = {
            text: text.substring(0, 100),
            fullText: text,
            timestamp: Date.now(),
            status: 'sent',
            conversationId: conversationId || this.targetConversation || 'current'
        };
        this.promptHistory.push(entry);
        // Keep last 50 entries
        if (this.promptHistory.length > 50) {
            this.promptHistory.shift();
        }
        this.log(`Scheduler: Added to history: "${entry.text.substring(0, 50)}..."`);
    }

    getHistory() {
        return this.promptHistory.map(h => ({
            text: h.text,
            timestamp: h.timestamp,
            timeAgo: this.formatTimeAgo(h.timestamp),
            status: h.status,
            conversation: h.conversationId
        }));
    }

    formatTimeAgo(ts) {
        const diff = Date.now() - ts;
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
        return Math.floor(diff / 86400000) + 'd ago';
    }

    setTargetConversation(conversationId) {
        this.targetConversation = conversationId || '';
        this.log(`Scheduler: Target conversation set to: "${this.targetConversation || 'current'}"`);
    }

    // Queue control methods
    pauseQueue() {
        if (!this.isRunningQueue || this.isPaused) return false;
        this.isPaused = true;
        this.log('Scheduler: Queue paused by user');
        vscode.window.showInformationMessage('Queue paused.');
        return true;
    }

    resumeQueue() {
        if (!this.isRunningQueue || !this.isPaused) return false;
        this.isPaused = false;
        this.log('Scheduler: Queue resumed by user');
        vscode.window.showInformationMessage('Queue resumed.');
        // Trigger next check immediately
        this.checkSilence();
        return true;
    }

    async skipPrompt() {
        if (!this.isRunningQueue) return false;
        this.log('Scheduler: Skipping current prompt');
        vscode.window.showInformationMessage('Skipping to next prompt...');

        // Advance without sending current
        this.queueIndex++;
        this.isPaused = false; // Clear pause if set
        this.lastClickCount = 0;
        this.lastClickTime = Date.now();
        this.lastActivityTime = Date.now();
        this.taskStartTime = Date.now();
        this.hasSentCurrentItem = false;
        this.currentItemAttempts = 0;

        if (this.queueIndex >= this.runtimeQueue.length) {
            this.log('Scheduler: No more prompts to skip to, queue complete');
            this.isRunningQueue = false;
            this.conversationStatus = 'idle';
            return true;
        }

        // Execute next item
        await this.executeCurrentQueueItem();
        return true;
    }

    stopQueue() {
        if (!this.isRunningQueue && this.runtimeQueue.length === 0) return false;
        this.isRunningQueue = false;
        this.isStopped = true; // Signal pending prompts to cancel
        this.runtimeQueue = [];
        this.queueIndex = 0;
        this.conversationStatus = 'idle';
        this.isPaused = false;
        this.lastClickCount = 0;
        this.lastClickTime = 0;
        this.lastActivityTime = 0;
        this.taskStartTime = 0;
        this.hasSentCurrentItem = false;
        this.currentItemAttempts = 0;
        // Reset the prompt queue to cancel pending operations
        this.promptQueue = Promise.resolve();
        this.log('Scheduler: Queue stopped by user');
        vscode.window.showInformationMessage('Queue stopped.');
        return true;
    }

    async resetQueue() {
        // Stop the queue if running
        this.isRunningQueue = false;
        this.isStopped = false; // Reset the stopped flag
        this.runtimeQueue = [];
        this.queueIndex = 0;
        this.conversationStatus = 'idle';
        this.isPaused = false;
        this.lastClickCount = 0;
        this.lastClickTime = 0;
        this.lastActivityTime = 0;
        this.taskStartTime = 0;
        this.hasSentCurrentItem = false;
        this.currentItemAttempts = 0;
        this.promptQueue = Promise.resolve(); // Clear pending prompts

        // Clear prompts from config
        try {
            const config = vscode.workspace.getConfiguration('auto-accept.schedule');
            await config.update('prompts', [], vscode.ConfigurationTarget.Global);
            this.log('Scheduler: Queue reset - all prompts cleared');
        } catch (e) {
            this.log(`Scheduler: Error resetting queue: ${e.message}`);
        }

        vscode.window.showInformationMessage('Queue reset.');
        return true;
    }

    getCurrentPrompt() {
        if (!this.isRunningQueue || this.queueIndex >= this.runtimeQueue.length) return null;
        return this.runtimeQueue[this.queueIndex];
    }
}

let scheduler;

function detectIDE() {
    const appName = vscode.env.appName || '';
    if (appName.toLowerCase().includes('trae')) return 'Trae';
    return 'Trae';
}

async function activate(context) {
    globalContext = context;
    console.log('Multi Purpose Agent for TRAE Extension: Activator called.');

    // CRITICAL: Create status bar items FIRST before anything else
    try {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'auto-accept.toggle';
        statusBarItem.text = '\u{23F3} Multi Purpose Agent for TRAE: Loading...';
        statusBarItem.tooltip = 'Multi Purpose Agent for TRAE is initializing...';
        context.subscriptions.push(statusBarItem);
        statusBarItem.show();

        statusSettingsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
        statusSettingsItem.command = 'auto-accept.openSettings';
        statusSettingsItem.text = '\u{2699}\u{FE0F}';
        statusSettingsItem.tooltip = 'Multi Purpose Agent for TRAE Settings & Pro Features';
        context.subscriptions.push(statusSettingsItem);
        statusSettingsItem.show();

        // Queue Status bar item
        statusQueueItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 96);
        statusQueueItem.command = 'auto-accept.showQueueMenu';
        statusQueueItem.text = '\u{1F4CB} Queue: Idle';
        statusQueueItem.tooltip = 'Prompt Queue - Click for controls';
        context.subscriptions.push(statusQueueItem);
        // Hidden by default, shown when queue is running

        console.log('Multi Purpose Agent for TRAE: Status bar items created and shown.');
    } catch (sbError) {
        console.error('CRITICAL: Failed to create status bar items:', sbError);
    }

    try {
        // 1. Initialize State
        isEnabled = context.globalState.get(GLOBAL_STATE_KEY, false);
        enabledDuringLastSession = context.globalState.get(ENABLED_DURING_SESSION_KEY, false);
        hasRunBefore = context.globalState.get(HAS_RUN_KEY, false);
        await context.globalState.update(HAS_RUN_KEY, true);
        await context.globalState.update(ENABLED_DURING_SESSION_KEY, false);
        isPro = true; // Pro features always enabled

        // Load frequency (Pro always gets best settings)
        pollFrequency = context.globalState.get(FREQ_STATE_KEY, 1000);

        // Load banned commands list (default: common dangerous patterns)
        const defaultBannedCommands = [
            'rm -rf /',
            'rm -rf ~',
            'rm -rf *',
            'format c:',
            'del /f /s /q',
            'rmdir /s /q',
            ':(){:|:&};:',  // fork bomb
            'dd if=',
            'mkfs.',
            '> /dev/sda',
            'chmod -R 777 /'
        ];
        bannedCommands = context.globalState.get(BANNED_COMMANDS_KEY, defaultBannedCommands);


        // 1.5 Verify License Background Check
        verifyLicense(context).then(isValid => {
            if (isPro !== isValid) {
                isPro = isValid;
                context.globalState.update(PRO_STATE_KEY, isValid);
                log(`License re-verification: Updated Pro status to ${isValid}`);

                if (cdpHandler && cdpHandler.setProStatus) {
                    cdpHandler.setProStatus(isValid);
                }

                if (!isValid) {
                    pollFrequency = 300; // Downgrade speed
                }
                updateStatusBar();
            }
        });

        currentIDE = detectIDE();

        // 2. Create Output Channel
        outputChannel = vscode.window.createOutputChannel('Multi Purpose Agent for TRAE');
        context.subscriptions.push(outputChannel);

        log(`Multi Purpose Agent for TRAE: Activating...`);
        log(`Multi Purpose Agent for TRAE: Detected environment: ${currentIDE.toUpperCase()}`);

        // Setup Focus Listener - Push state to browser (authoritative source)
        vscode.window.onDidChangeWindowState(async (e) => {
            // Always push focus state to browser - this is the authoritative source
            if (cdpHandler && cdpHandler.setFocusState) {
                await cdpHandler.setFocusState(e.focused);
            }

            // When user returns and auto-accept is running, check for away actions
            if (e.focused && isEnabled) {
                log(`[Away] Window focus detected by Trae API. Checking for away actions...`);
                // Wait a tiny bit for CDP to settle after focus state is pushed
                setTimeout(() => checkForAwayActions(context), 500);
            }
        });

        // 3. Initialize Handlers (Lazy Load) - \u{1F916}h IDEs use CDP now
        try {
            const { CDPHandler } = require('./main_scripts/cdp-handler');
            const { Relauncher } = require('./main_scripts/relauncher');

            cdpHandler = new CDPHandler(log);
            applyCDPSettingsToHandler();
            relauncher = new Relauncher(log, () => getConfiguredCDPSettings().port);
            log(`CDP handlers initialized for ${currentIDE}.`);



            // Keep CDPHandler initialized, but do not start the browser-side loop until the user explicitly enables it.

            // Initialize Scheduler
            scheduler = new Scheduler(context, cdpHandler, log, { ensureCdpReady: syncSessions });
            scheduler.start();

            debugHandler = new DebugHandler(context, {
                log,
                getScheduler: () => scheduler,
                getIsPro: () => true, // Always Pro in this build
                getLockedOut: () => isLockedOut,
                getCDPHandler: () => cdpHandler,
                getRelauncher: () => relauncher,
                syncSessions: async () => syncSessions()
            });
            // Only start debug server when debugMode is enabled.
            const debugEnabled = vscode.workspace.getConfiguration('auto-accept.debugMode').get('enabled', false);
            if (debugEnabled) {
                debugHandler.startServer();
            }
        } catch (err) {
            log(`Failed to initialize CDP handlers: ${err.message}`);
            vscode.window.showErrorMessage(`Multi Purpose Agent for TRAE Error: ${err.message}`);
        }

        // 4. Update Status Bar (already created at start)
        updateStatusBar();
        log('Status bar updated with current state.');

        // 5. Register Commands
        context.subscriptions.push(
            vscode.commands.registerCommand('auto-accept.toggle', () => handleToggle(context)),
            vscode.commands.registerCommand('auto-accept.relaunch', () => handleRelaunch()),
            vscode.commands.registerCommand('auto-accept.updateFrequency', (freq) => handleFrequencyUpdate(context, freq)),
            vscode.commands.registerCommand('auto-accept.updateBannedCommands', (commands) => handleBannedCommandsUpdate(context, commands)),
            vscode.commands.registerCommand('auto-accept.getBannedCommands', () => bannedCommands),
            vscode.commands.registerCommand('auto-accept.getROIStats', async () => {
                const stats = await loadROIStats(context);
                const timeSavedSeconds = stats.clicksThisWeek * SECONDS_PER_CLICK;
                const timeSavedMinutes = Math.round(timeSavedSeconds / 60);
                return {
                    ...stats,
                    timeSavedMinutes,
                    timeSavedFormatted: timeSavedMinutes >= 60
                        ? `${(timeSavedMinutes / 60).toFixed(1)} hours`
                        : `${timeSavedMinutes} minutes`
                };
            }),
            vscode.commands.registerCommand('auto-accept.openSettings', () => {
                const panel = getSettingsPanel();
                if (panel) {
                    panel.createOrShow(context.extensionUri, context);
                } else {
                    vscode.window.showErrorMessage('Failed to load Settings Panel.');
                }
            }),
            vscode.commands.registerCommand('auto-accept.activatePro', () => handleProActivation(context)),
            vscode.commands.registerCommand('auto-accept.startQueue', async (options) => {
                log('[Scheduler] Queue start requested via command');
                if (scheduler) {
                    // Ensure CDP scans/injects the active chat surface before starting the queue.
                    await syncSessions();
                    await scheduler.startQueue(options);
                    log('[Scheduler] Queue start handled via command');
                } else {
                    log('[Scheduler] Cannot start queue - scheduler not initialized');
                    vscode.window.showWarningMessage('Multi Purpose Agent for TRAE: Scheduler not ready. Please try again.');
                }
            }),
            vscode.commands.registerCommand('auto-accept.getQueueStatus', () => {
                if (scheduler) {
                    return scheduler.getStatus();
                }
                return { enabled: false, isRunningQueue: false, queueLength: 0, queueIndex: 0 };
            }),
            vscode.commands.registerCommand('auto-accept.getConversations', async () => {
                if (scheduler) {
                    return await scheduler.getConversations();
                }
                return [];
            }),
            vscode.commands.registerCommand('auto-accept.getPromptHistory', () => {
                if (scheduler) {
                    return scheduler.getHistory();
                }
                return [];
            }),
            vscode.commands.registerCommand('auto-accept.setTargetConversation', (conversationId) => {
                if (scheduler) {
                    scheduler.setTargetConversation(conversationId);
                }
            }),
            vscode.commands.registerCommand('auto-accept.pauseQueue', () => {
                if (scheduler) {
                    scheduler.pauseQueue();
                }
            }),
            vscode.commands.registerCommand('auto-accept.resumeQueue', () => {
                if (scheduler) {
                    scheduler.resumeQueue();
                }
            }),
            vscode.commands.registerCommand('auto-accept.skipPrompt', async () => {
                if (scheduler) {
                    await scheduler.skipPrompt();
                }
            }),
            vscode.commands.registerCommand('auto-accept.stopQueue', () => {
                if (scheduler) {
                    scheduler.stopQueue();
                }
            }),
            vscode.commands.registerCommand('auto-accept.showQueueMenu', async () => {
                if (!scheduler) return;

                const status = scheduler.getStatus();
                const items = [];

                if (status.isRunningQueue) {
                    if (status.isPaused) {
                        items.push({ label: '\u{25B6}\u{FE0F} Resume', action: 'resume' });
                    } else {
                        items.push({ label: '\u{23F8}\u{FE0F} Pause', action: 'pause' });
                    }
                    items.push({ label: '\u{23ED}\u{FE0F} Skip Current', action: 'skip' });
                    items.push({ label: '\u{23F9}\u{FE0F} Stop Queue', action: 'stop' });
                }
                items.push({ label: '\u{2699}\u{FE0F} Open Settings', action: 'settings' });

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: `Queue: ${status.queueIndex + 1}/${status.queueLength}${status.isPaused ? ' (Paused)' : ''}`
                });

                if (selected) {
                    switch (selected.action) {
                        case 'pause': scheduler.pauseQueue(); break;
                        case 'resume': scheduler.resumeQueue(); break;
                        case 'skip': await scheduler.skipPrompt(); break;
                        case 'stop': scheduler.stopQueue(); break;
                        case 'settings': vscode.commands.executeCommand('auto-accept.openSettings'); break;
                    }
                }
            }),
            vscode.commands.registerCommand('auto-accept.resetSettings', async () => {
                // Reset all extension settings
                await context.globalState.update(GLOBAL_STATE_KEY, false);
                await context.globalState.update(PRO_STATE_KEY, true);
                await context.globalState.update(FREQ_STATE_KEY, 1000);
                await context.globalState.update(BANNED_COMMANDS_KEY, undefined);
                await context.globalState.update(ROI_STATS_KEY, undefined);
                isEnabled = false;
                isPro = true;
                bannedCommands = [];
                vscode.window.showInformationMessage('Multi Purpose Agent for TRAE: All settings reset to defaults.');
                updateStatusBar();
            }),
            // Debug Mode Command - Allows AI agent programmatic control
            vscode.commands.registerCommand('auto-accept.debugCommand', async (action, params = {}) => {
                if (debugHandler) {
                    return await debugHandler.handleCommand(action, params);
                }
                return { success: false, error: 'DebugHandler not ready' };
            })
        );

        // Monitor configuration changes for Debug Mode
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('auto-accept.debugMode.enabled') && debugHandler) {
                const enabled = vscode.workspace.getConfiguration('auto-accept.debugMode').get('enabled', false);
                if (enabled) {
                    debugHandler.startServer();
                } else {
                    debugHandler.stopServer();
                }
            }
        }));




        // 6. Register URI Handler for deep links (e.g., from Stripe success page)
        const uriHandler = {
            handleUri(uri) {
                log(`URI Handler received: ${uri.toString()}`);
                if (uri.path === '/activate' || uri.path === 'activate') {
                    log('Activation URI detected - verifying pro status...');
                    handleProActivation(context);
                }
            }
        };
        context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
        log('URI Handler registered for activation deep links.');

        // 7. Check environment and start if enabled
        try {
            await checkEnvironmentAndStart();
        } catch (err) {
            log(`Error in environment check: ${err.message}`);
        }

        // 8. Show Releasy AI Cross-Promo (Once, after first session)
        showReleasyCrossPromo(context);

        log('Multi Purpose Agent for TRAE: Activation complete');
    } catch (error) {
        console.error('ACTIVATION CRITICAL FAILURE:', error);
        log(`ACTIVATION CRITICAL FAILURE: ${error.message}`);
        vscode.window.showErrorMessage(`Multi Purpose Agent for TRAE Extension failed to activate: ${error.message}`);
    }
}

async function ensureCDPOrPrompt(showPrompt = false) {
    if (!cdpHandler) return false;

    const cdpSettings = applyCDPSettingsToHandler();

    log('Checking for active CDP session...');
    const cdpAvailable = await cdpHandler.isCDPAvailable();
    log(`Environment check: CDP Available = ${cdpAvailable}`);

    if (cdpAvailable) {
        log('CDP is active and available.');
        return true;
    } else {
        log(`CDP not found on target ports (${cdpSettings.port} +/- ${cdpSettings.range}).`);
        if (showPrompt && relauncher) {
            log('Initiating CDP setup and relaunch flow...');
            await relauncher.ensureCDPAndRelaunch();
        }
        return false;
    }
}

async function checkEnvironmentAndStart() {
    if (!isEnabled) {
        if (hasRunBefore && enabledDuringLastSession && !startupConfirmedForSession) {
            const choice = await vscode.window.showInformationMessage(
                'Multi Purpose Agent for TRAE was enabled last session. Start now?',
                { modal: true },
                'Start',
                'Keep Off'
            );

            if (choice === 'Start') {
                isEnabled = true;
                await globalContext.globalState.update(GLOBAL_STATE_KEY, true);
                await globalContext.globalState.update(ENABLED_DURING_SESSION_KEY, true);
                startupConfirmedForSession = true;
            } else {
                updateStatusBar();
                return;
            }
        } else {
            updateStatusBar();
            return;
        }
    }

    if (isEnabled) {
        await globalContext.globalState.update(ENABLED_DURING_SESSION_KEY, true);
        log('Initializing Multi Purpose Agent for TRAE environment...');
        const cdpReady = await ensureCDPOrPrompt(false);

        if (!cdpReady) {
            // CDP not available - reset to OFF state so user can trigger setup via toggle
            log('Multi Purpose Agent for TRAE was enabled but CDP is not available. Resetting to OFF state.');
            isEnabled = false;
            await globalContext.globalState.update(GLOBAL_STATE_KEY, false);
        } else {
            // Prevent auto-resuming a pending "Continue" on startup; we will ask the user first.
            continuePolicyForNextStart = 'ask';
            await startPolling();
            await maybeAskToContinueLastPrompt();
            // Start stats collection if already enabled on startup
            startStatsCollection(globalContext);
        }
    }
    updateStatusBar();
}

async function maybeAskToContinueLastPrompt() {
    if (!cdpHandler) return;

    try {
        log('[Continue] Checking for pending Continue action...');

        // If user enabled automatic Continue on open/start, do it without prompting.
        if (isAutoContinueOnOpenOrStartEnabled()) {
            await maybeAutoClickContinueOnOpenOrStart('startup');
            await cdpHandler.evaluateAll(`if(window.__autoAcceptSetContinuePolicy) window.__autoAcceptSetContinuePolicy('auto')`);
            continuePolicyForNextStart = 'auto';
            return;
        }

        const hasResults = await cdpHandler.evaluateAll('Boolean(window.__autoAcceptHasContinue && window.__autoAcceptHasContinue())');
        const anyHasContinue = Array.isArray(hasResults) && hasResults.some(r => r && r.ok && r.value === true);
        log(`[Continue] hasContinue=${!!anyHasContinue}`);

        // If diagnostics are available, log a compact snapshot for troubleshooting.
        try {
            const diagRaw = await cdpHandler.evaluate(`(function(){try{
                var d=(typeof window!=='undefined'&&window.__autoAcceptGetContinueDiagnostics)?window.__autoAcceptGetContinueDiagnostics():null;
                return JSON.stringify(d);
            }catch(e){return JSON.stringify({ts:Date.now(),error:(e&&e.message)?e.message:String(e)});}})()`);
            if (typeof diagRaw === 'string' && diagRaw) {
                const d = JSON.parse(diagRaw);
                if (d && typeof d === 'object') {
                    log(`[Continue] diag banner=${!!d.banner?.detected} candidates=${d.continue?.totalCandidates ?? null} visible=${d.continue?.visibleCandidates ?? null} issues=${Array.isArray(d.continue?.issues) ? d.continue.issues.join(',') : ''}`);
                }
            }
        } catch (e) { }

        if (!anyHasContinue) {
            await cdpHandler.evaluateAll(`if(window.__autoAcceptSetContinuePolicy) window.__autoAcceptSetContinuePolicy('auto')`);
            continuePolicyForNextStart = 'auto';
            return;
        }

        const choice = await vscode.window.showInformationMessage(
            'A "Continue" action is available in the agent chat. Continue the last response now?',
            { modal: true },
            'Continue',
            'Skip'
        );
        log(`[Continue] userChoice=${choice || 'dismissed'}`);

        if (choice === 'Continue') {
            const results = await cdpHandler.evaluateAll('typeof window!=="undefined" && window.__autoAcceptForceClickContinueOnce ? window.__autoAcceptForceClickContinueOnce() : false');
            const ok = Array.isArray(results) ? results.filter(r => r && r.ok) : [];
            const anyClicked = ok.some(r => r.value === true);
            log(`[Continue] forceClickContinueOnce anyClicked=${anyClicked} results=${JSON.stringify(ok.map(r => ({ id: r.id, value: r.value })))}`);

            // Fallback: if the UI element isn't discoverable/clickable, send the literal "Continue" prompt.
            if (!anyClicked) {
                log('[Continue] Fallback to sending "Continue" prompt');
                await cdpHandler.evaluateAll('if(typeof window!=="undefined" && window.__autoAcceptSendPrompt) window.__autoAcceptSendPrompt("Continue")');
            }
            await cdpHandler.evaluateAll('if(window.__autoAcceptSetContinueBlockUntilGone) window.__autoAcceptSetContinueBlockUntilGone(false)');
        } else {
            // Block the currently visible Continue until it disappears; future Continue actions can still be auto-clicked.
            await cdpHandler.evaluateAll('if(window.__autoAcceptSetContinueBlockUntilGone) window.__autoAcceptSetContinueBlockUntilGone(true)');
        }

        await cdpHandler.evaluateAll(`if(window.__autoAcceptSetContinuePolicy) window.__autoAcceptSetContinuePolicy('auto')`);
        continuePolicyForNextStart = 'auto';
    } catch (e) {
        log(`[Continue] Error: ${e?.message || String(e)}`);
        // Failing this prompt should never prevent the extension from running.
        try { await cdpHandler.evaluateAll(`if(window.__autoAcceptSetContinuePolicy) window.__autoAcceptSetContinuePolicy('auto')`); } catch (e2) { }
        continuePolicyForNextStart = 'auto';
    }
}

async function handleToggle(context) {
    log('=== handleToggle CALLED ===');
    log(`  Previous isEnabled: ${isEnabled}`);

    try {
        const now = Date.now();
        if (handleToggle._lastAt && (now - handleToggle._lastAt) < 750) {
            return;
        }
        handleToggle._lastAt = now;

        // Check CDP availability first
        const cdpAvailable = cdpHandler ? await cdpHandler.isCDPAvailable() : false;

        // If trying to enable but CDP not available, prompt for relaunch (don't change state)
        if (!isEnabled && !cdpAvailable && relauncher) {
            log('Multi Purpose Agent for TRAE: CDP not available. Prompting for setup/relaunch.');
            await relauncher.ensureCDPAndRelaunch();
            return; // Don't change state - toggle stays OFF
        }

        if (!isEnabled) {
            const choice = await vscode.window.showInformationMessage(
                'Start Multi Purpose Agent for TRAE now?',
                { modal: true },
                'Start',
                'Cancel'
            );
            if (choice !== 'Start') return;
        }

        isEnabled = !isEnabled;
        log(`  New isEnabled: ${isEnabled}`);

        // Update state and UI IMMEDIATELY (non-blocking)
        await context.globalState.update(GLOBAL_STATE_KEY, isEnabled);
        log(`  GlobalState updated`);

        log('  Calling updateStatusBar...');
        updateStatusBar();

        // Do CDP operations in background (don't block toggle)
        if (isEnabled) {
            log('Multi Purpose Agent for TRAE: Enabled');
            await context.globalState.update(ENABLED_DURING_SESSION_KEY, true);
            // Prevent auto-resuming a pending "Continue" on enable; we will ask the user first.
            continuePolicyForNextStart = 'ask';
            await startPolling();
            await maybeAskToContinueLastPrompt();
            startStatsCollection(context);
            incrementSessionCount(context);
        } else {
            log('Multi Purpose Agent for TRAE: Disabled');

            // Fire-and-forget: Show session summary notification (non-blocking)
            if (cdpHandler) {
                cdpHandler.getSessionSummary()
                    .then(summary => showSessionSummaryNotification(context, summary))
                    .catch(() => { });
            }

            // Fire-and-forget: collect stats and stop in background
            collectAndSaveStats(context).catch(() => { });
            stopPolling().catch(() => { });
        }

        log('=== handleToggle COMPLETE ===');
    } catch (e) {
        log(`Error toggling: ${e.message}`);
        log(`Error stack: ${e.stack}`);
    }
}

async function handleRelaunch() {
    if (!relauncher) {
        vscode.window.showErrorMessage('Relauncher not initialized.');
        return;
    }

    log('Initiating Relaunch sequence...');
    await relauncher.ensureCDPAndRelaunch();
}

async function handleFrequencyUpdate(context, freq) {
    pollFrequency = freq;
    await context.globalState.update(FREQ_STATE_KEY, freq);
    log(`Poll frequency updated to: ${freq}ms`);
    if (isEnabled) {
        await syncSessions();
    }
}

async function handleBannedCommandsUpdate(context, commands) {
    bannedCommands = Array.isArray(commands) ? commands : [];
    await context.globalState.update(BANNED_COMMANDS_KEY, bannedCommands);
    log(`Banned commands updated: ${bannedCommands.length} patterns`);
    if (bannedCommands.length > 0) {
        log(`Banned patterns: ${bannedCommands.slice(0, 5).join(', ')}${bannedCommands.length > 5 ? '...' : ''}`);
    }
    if (isEnabled) {
        await syncSessions();
    }
}

async function syncSessions() {
    if (cdpHandler && !isLockedOut) {
        log(`CDP: Syncing sessions...`);
        try {
            const cdpSettings = applyCDPSettingsToHandler();
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const detectedWorkspace = workspaceFolders && workspaceFolders.length > 0
                ? workspaceFolders[0].name
                : null;
            const autoContinueOnOpenOrStart = vscode.workspace
                .getConfiguration('auto-accept.continue')
                .get('autoClickOnOpenOrStart', true);

            await cdpHandler.start({
                enabled: isEnabled,
                isPro,
                pollInterval: pollFrequency,
                ide: currentIDE,
                bannedCommands: bannedCommands,
                continuePolicy: continuePolicyForNextStart,
                continueBlockUntilGone: continuePolicyForNextStart === 'ask',
                autoClickContinueOnOpenOrStart: !!autoContinueOnOpenOrStart,
                cdpPort: cdpSettings.port,
                workspaceName: detectedWorkspace
            });

            // Extension-side safety net: when enabled, auto-click Continue on sync when user opted in.
            await maybeAutoClickContinueOnOpenOrStart('sync');
        } catch (err) {
            log(`CDP: Sync error: ${err.message}`);
        }
    }
}

function getLogDirectoryFromContext(context) {
    const logPath = getLogFilePathFromContext(context);
    try {
        const dir = path.dirname(logPath);
        if (dir) {
            try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
            return dir;
        }
    } catch (e) { }
    return __dirname;
}

function safeFileToken(input) {
    return String(input || '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 80);
}

function writeContinueCandidatesDumpFile({ connectionId, diag, dump }) {
    const dir = getLogDirectoryFromContext(globalContext);
    const ts = new Date();
    const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}-${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;
    const idToken = safeFileToken(connectionId);
    const fileName = `auto-accept-continue-components-TRAE-${stamp}-${idToken}.json`;
    const filePath = path.join(dir, fileName);
    const payload = {
        ts: Date.now(),
        connectionId,
        diag: diag || null,
        dump: dump || null
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return filePath;
}

async function ensureCdpControlLock() {
    if (!globalContext) return true;

    const lockKey = `${currentIDE.toLowerCase()}-instance-lock`;
    const activeInstance = globalContext.globalState.get(lockKey);
    const myId = globalContext.extension.id;

    if (activeInstance && activeInstance !== myId) {
        const lastPing = globalContext.globalState.get(`${lockKey}-ping`);
        if (lastPing && (Date.now() - lastPing) < 15000) {
            if (!isLockedOut) {
                log(`CDP Control: Locked by another instance (${activeInstance}). Standby mode.`);
                isLockedOut = true;
                updateStatusBar();
            }
            return false;
        }
    }

    await globalContext.globalState.update(lockKey, myId);
    await globalContext.globalState.update(`${lockKey}-ping`, Date.now());

    if (isLockedOut) {
        log('CDP Control: Lock acquired. Resuming control.');
        isLockedOut = false;
        updateStatusBar();
    }

    return true;
}

async function emitContinueDiagnostics(force = false) {
    try {
        if (!isEnabled) return;
        if (!cdpHandler || typeof cdpHandler.evaluateAll !== 'function') return;
        if (isLockedOut) return;
        const debugEnabled = vscode.workspace.getConfiguration('auto-accept.debugMode').get('enabled', false);
        if (!debugEnabled) return;

        const now = Date.now();
        const minIntervalMs = force ? 0 : 15000;
        if (!force && (now - lastContinueDiagLogAt) < minIntervalMs) return;

        const expr = `(function(){try{var d=(typeof window!=='undefined'&&window.__autoAcceptGetContinueDiagnostics)?window.__autoAcceptGetContinueDiagnostics():null;return JSON.stringify(d);}catch(e){return JSON.stringify({ts:Date.now(),error:(e&&e.message)?e.message:String(e)});}})()`;
        const results = await cdpHandler.evaluateAll(expr);

        let logged = false;
        for (const r of results) {
            if (!r || !r.ok) {
                log(`[DIAG_CONTINUE] ${JSON.stringify({ ts: now, id: r?.id || null, ok: false, error: r?.error || 'unknown_error' })}`);
                logged = true;
                continue;
            }

            let diag = null;
            try { diag = typeof r.value === 'string' ? JSON.parse(r.value) : r.value; } catch (e) { diag = { ts: now, parseError: e?.message || String(e), raw: String(r.value || '').substring(0, 400) }; }

            const hasBanner = !!diag?.banner?.detected;
            const hasVisibleContinue = (diag?.continue?.visibleCandidates || 0) > 0;
            const hasIssues = Array.isArray(diag?.continue?.issues) && diag.continue.issues.length > 0;
            const isTraeDiag = !!(diag && typeof diag === 'object' && diag?.state?.currentMode === 'trae');

            if (!force && !hasBanner && !hasVisibleContinue && !hasIssues) continue;

            let dumpFile = null;
            let dumpMeta = null;
            try {
                if (cdpHandler && typeof cdpHandler.evaluateOn === 'function') {
                    const sig = JSON.stringify({
                        banner: diag?.banner?.matches || [],
                        total: diag?.continue?.totalCandidates || 0,
                        visible: diag?.continue?.visibleCandidates || 0,
                        issues: diag?.continue?.issues || [],
                        last: diag?.continue?.last?.lastResult || ''
                    });

                    const prev = continueDumpState.get(r.id) || { lastSig: '', lastDumpAt: 0 };
                    const dumpMinIntervalMs = 60000;
                    const shouldDump = force || (sig !== prev.lastSig) || ((now - prev.lastDumpAt) > dumpMinIntervalMs);

                    if (shouldDump && isTraeDiag && (force || hasBanner || hasVisibleContinue || hasIssues)) {
                        const exprAll = `(function(){try{return JSON.stringify((typeof window!=='undefined'&&window.__autoAcceptGetContinueCandidatesAll)?window.__autoAcceptGetContinueCandidatesAll():null);}catch(e){return JSON.stringify({ts:Date.now(),error:(e&&e.message)?e.message:String(e)});}})()`;
                        const dumpRes = await cdpHandler.evaluateOn(r.id, exprAll, 6000);
                        let dump = null;
                        if (dumpRes && dumpRes.ok) {
                            try { dump = typeof dumpRes.value === 'string' ? JSON.parse(dumpRes.value) : dumpRes.value; } catch (e) { dump = { ts: now, parseError: e?.message || String(e), raw: String(dumpRes.value || '').substring(0, 800) }; }
                        } else {
                            dump = { ts: now, error: dumpRes?.error || 'evaluateOn_failed' };
                        }

                        dumpFile = writeContinueCandidatesDumpFile({ connectionId: r.id, diag, dump });
                        dumpMeta = {
                            totalCandidates: dump?.totalCandidates ?? null,
                            truncated: dump?.truncated ?? null
                        };

                        continueDumpState.set(r.id, { lastSig: sig, lastDumpAt: now });
                    }
                }
            } catch (e) {
                dumpMeta = { error: e?.message || String(e) };
            }

            log(`[DIAG_CONTINUE] ${JSON.stringify({ ts: now, id: r.id, ok: true, diag, dumpFile, dumpMeta })}`);
            logged = true;
        }

        if (logged || force) {
            lastContinueDiagLogAt = now;
        }
    } catch (e) {
        log(`[DIAG_CONTINUE] ${JSON.stringify({ ts: Date.now(), ok: false, error: e?.message || String(e) })}`);
        lastContinueDiagLogAt = Date.now();
    }
}

// Update Queue Status Bar
function updateQueueStatusBar() {
    if (!statusQueueItem || !scheduler) return;

    const status = scheduler.getStatus();

    if (status.isRunningQueue) {
        statusQueueItem.show();
        const pauseIndicator = status.isPaused ? ' \u{23F3}' : '';
        statusQueueItem.text = `\u{1F4CB} Queue ${status.queueIndex + 1}/${status.queueLength}${pauseIndicator}`;
        statusQueueItem.tooltip = status.isPaused
            ? 'Queue is paused - Click to resume'
            : `Running prompt ${status.queueIndex + 1} of ${status.queueLength} - Click for controls`;
    } else {
        statusQueueItem.hide();
    }
}

async function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    log('Multi Purpose Agent for TRAE: Monitoring session...');

    const hasControl = await ensureCdpControlLock();
    if (hasControl) {
        await syncSessions();
        await emitContinueDiagnostics(true);
    }

    // Polling now primarily handles the Instance Lock and ensures CDP is active
    pollTimer = setInterval(async () => {
        if (!isEnabled) return;
        const hasControl = await ensureCdpControlLock();
        if (!hasControl) return;
        await syncSessions();
        await emitContinueDiagnostics(false);
    }, 5000);
}

async function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    if (statsCollectionTimer) {
        clearInterval(statsCollectionTimer);
        statsCollectionTimer = null;
    }
    if (scheduler) scheduler.stop();
    // Don't keep debug server open unless explicitly enabled
    try {
        const debugEnabled = vscode.workspace.getConfiguration('auto-accept.debugMode').get('enabled', false);
        if (!debugEnabled && debugHandler) debugHandler.stopServer();
    } catch (e) { }
    if (cdpHandler) await cdpHandler.stop();
    log('Multi Purpose Agent for TRAE: Polling stopped');
}

// --- ROI Stats Collection ---

function getWeekStart() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const diff = now.getDate() - dayOfWeek;
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);
    return weekStart.getTime();
}

async function loadROIStats(context) {
    const defaultStats = {
        weekStart: getWeekStart(),
        clicksThisWeek: 0,
        blockedThisWeek: 0,
        sessionsThisWeek: 0
    };

    let stats = context.globalState.get(ROI_STATS_KEY, defaultStats);

    // Check if we need to reset for a new week
    const currentWeekStart = getWeekStart();
    if (stats.weekStart !== currentWeekStart) {
        log(`ROI Stats: New week detected. Showing summary and resetting.`);

        // Show weekly summary notification if there were meaningful stats
        if (stats.clicksThisWeek > 0) {
            await showWeeklySummaryNotification(context, stats);
        }

        // Reset for new week
        stats = { ...defaultStats, weekStart: currentWeekStart };
        await context.globalState.update(ROI_STATS_KEY, stats);
    }

    // Calculate formatted time for UI
    const timeSavedSeconds = (stats.clicksThisWeek || 0) * SECONDS_PER_CLICK;
    const timeSavedMinutes = Math.round(timeSavedSeconds / 60);
    let timeStr;
    if (timeSavedMinutes >= 60) {
        timeStr = `${(timeSavedMinutes / 60).toFixed(1)}h`;
    } else {
        timeStr = `${timeSavedMinutes}m`;
    }
    stats.timeSavedFormatted = timeStr;

    return stats;
}

async function showWeeklySummaryNotification(context, lastWeekStats) {
    const timeSavedSeconds = lastWeekStats.clicksThisWeek * SECONDS_PER_CLICK;
    const timeSavedMinutes = Math.round(timeSavedSeconds / 60);

    let timeStr;
    if (timeSavedMinutes >= 60) {
        timeStr = `${(timeSavedMinutes / 60).toFixed(1)} hours`;
    } else {
        timeStr = `${timeSavedMinutes} minutes`;
    }

    const message = `\u{1F4CA} Last week, Multi Purpose Agent for TRAE saved you ${timeStr} by auto-clicking ${lastWeekStats.clicksThisWeek} buttons!`;

    let detail = '';
    if (lastWeekStats.sessionsThisWeek > 0) {
        detail += `Recovered ${lastWeekStats.sessionsThisWeek} stuck sessions. `;
    }
    if (lastWeekStats.blockedThisWeek > 0) {
        detail += `Blocked ${lastWeekStats.blockedThisWeek} dangerous commands.`;
    }

    const choice = await vscode.window.showInformationMessage(
        message,
        { detail: detail.trim() || undefined },
        'View Details'
    );

    if (choice === 'View Details') {
        const panel = getSettingsPanel();
        if (panel) {
            panel.createOrShow(context.extensionUri, context);
        }
    }
}

// --- SESSION SUMMARY NOTIFICATION ---
// Called when user finishes a session (e.g., leaves conversation view)
async function showSessionSummaryNotification(context, summary) {
    log(`[Notification] showSessionSummaryNotification called with: ${JSON.stringify(summary)}`);
    if (!summary || summary.clicks === 0) {
        log(`[Notification] Session summary skipped: no clicks`);
        return;
    }
    log(`[Notification] Showing session summary for ${summary.clicks} clicks`);

    const lines = [
        `\u{1F7E2} This session:`,
        `- ${summary.clicks} actions auto-accepted`,
        `- ${summary.terminalCommands} terminal commands`,
        `- ${summary.fileEdits} file edits`,
        `- ${summary.blocked} interruptions blocked`
    ];

    if (summary.estimatedTimeSaved) {
        lines.push(`\n\u{23F3} Estimated time saved: ~${summary.estimatedTimeSaved} minutes`);
    }

    const message = lines.join('\n');

    vscode.window.showInformationMessage(
        `\u{1F916} Multi Purpose Agent for TRAE: ${summary.clicks} actions handled this session`,
        { detail: message },
        'View Stats'
    ).then(choice => {
        if (choice === 'View Stats') {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
    });
}

// --- "AWAY" ACTIONS NOTIFICATION ---
// Called when user returns after window was minimized/unfocused
async function showAwayActionsNotification(context, actionsCount) {
    log(`[Notification] showAwayActionsNotification called with: ${actionsCount}`);
    if (!actionsCount || actionsCount === 0) {
        log(`[Notification] Away actions skipped: count is 0 or undefined`);
        return;
    }
    log(`[Notification] Showing away actions notification for ${actionsCount} actions`);

    const message = `\u{1F680} Multi Purpose Agent for TRAE handled ${actionsCount} action${actionsCount > 1 ? 's' : ''} while you were away.`;
    const detail = `Agents stayed autonomous while you focused elsewhere.`;

    vscode.window.showInformationMessage(
        message,
        { detail },
        'View Dashboard'
    ).then(choice => {
        if (choice === 'View Dashboard') {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
    });
}

// --- AWAY MODE POLLING ---
// Check for "away actions" when user returns (called periodically)
let lastAwayCheck = Date.now();
async function checkForAwayActions(context) {
    log(`[Away] checkForAwayActions called. cdpHandler=${!!cdpHandler}, isEnabled=${isEnabled}`);
    if (!cdpHandler || !isEnabled) {
        log(`[Away] Skipping check: cdpHandler=${!!cdpHandler}, isEnabled=${isEnabled}`);
        return;
    }

    try {
        log(`[Away] Calling cdpHandler.getAwayActions()...`);
        const awayActions = await cdpHandler.getAwayActions();
        log(`[Away] Got awayActions: ${awayActions}`);
        if (awayActions > 0) {
            log(`[Away] Detected ${awayActions} actions while user was away. Showing notification...`);
            await showAwayActionsNotification(context, awayActions);
        } else {
            log(`[Away] No away actions to report`);
        }
    } catch (e) {
        log(`[Away] Error checking away actions: ${e.message}`);
    }
}

async function collectAndSaveStats(context) {
    if (!cdpHandler) return;

    try {
        // Get stats from browser and reset them
        const browserStats = await cdpHandler.resetStats();

        if (browserStats.clicks > 0 || browserStats.blocked > 0) {
            const currentStats = await loadROIStats(context);
            currentStats.clicksThisWeek += browserStats.clicks;
            currentStats.blockedThisWeek += browserStats.blocked;

            await context.globalState.update(ROI_STATS_KEY, currentStats);
            log(`ROI Stats collected: +${browserStats.clicks} clicks, +${browserStats.blocked} blocked (Total: ${currentStats.clicksThisWeek} clicks, ${currentStats.blockedThisWeek} blocked)`);

            // Broadcast update to real-time dashboard
            const panel = getSettingsPanel();
            if (panel) {
                panel.sendROIStats();
            }
        }
    } catch (e) {
        // Silently fail - stats collection should not interrupt normal operation
    }
}

async function incrementSessionCount(context) {
    const stats = await loadROIStats(context);
    stats.sessionsThisWeek++;
    await context.globalState.update(ROI_STATS_KEY, stats);
    log(`ROI Stats: Session count incremented to ${stats.sessionsThisWeek}`);
}

function startStatsCollection(context) {
    if (statsCollectionTimer) clearInterval(statsCollectionTimer);

    // Collect stats every 30 seconds and check for away actions
    statsCollectionTimer = setInterval(() => {
        if (isEnabled) {
            collectAndSaveStats(context);
            checkForAwayActions(context); // Check if user returned from away
        }
    }, 30000);

    log('ROI Stats: Collection started (every 30s)');
}


function updateStatusBar() {
    if (!statusBarItem) return;

    if (isEnabled) {
        let statusText = 'ON';
        let tooltip = `Multi Purpose Agent for TRAE is running.`;
        let bgColor = undefined;
        let icon = '\u{2705}';

        const cdpConnected = cdpHandler && cdpHandler.getConnectionCount() > 0;

        if (cdpConnected) {
            tooltip += ' (CDP Connected)';
        }

        if (isLockedOut) {
            statusText = 'PAUSED (Multi-window)';
            bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            icon = '\u{1F504}';
        }

        statusBarItem.text = `${icon} Multi Purpose Agent for TRAE: ${statusText}`;
        statusBarItem.tooltip = tooltip;
        statusBarItem.backgroundColor = bgColor;

    } else {
        statusBarItem.text = '\u{2B55} Multi Purpose Agent for TRAE: OFF';
        statusBarItem.tooltip = 'Click to enable Multi Purpose Agent for TRAE.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

// Re-implement checkInstanceLock correctly with context
async function checkInstanceLock() {
    if (isPro) return true;
    if (!globalContext) return true; // Should not happen

    const lockId = globalContext.globalState.get(LOCK_KEY);
    const lastHeartbeat = globalContext.globalState.get(HEARTBEAT_KEY, 0);
    const now = Date.now();

    // 1. If no lock or lock is stale (>10s), claim it
    if (!lockId || (now - lastHeartbeat > 10000)) {
        await globalContext.globalState.update(LOCK_KEY, INSTANCE_ID);
        await globalContext.globalState.update(HEARTBEAT_KEY, now);
        return true;
    }

    // 2. If we own the lock, update heartbeat
    if (lockId === INSTANCE_ID) {
        await globalContext.globalState.update(HEARTBEAT_KEY, now);
        return true;
    }

    // 3. Someone else owns the lock and it's fresh
    return false;
}

async function verifyLicense(context) {
    const userId = context.globalState.get('auto-accept-userId');
    if (!userId) return false;

    return new Promise((resolve) => {
        const https = require('https');
        https.get(`${LICENSE_API}/check-license?userId=${userId}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.isPro === true);
                } catch (e) {
                    resolve(false);
                }
            });
        }).on('error', () => resolve(false));
    });
}

// Handle Pro activation (called from URI handler or command)
async function handleProActivation(context) {
    log('Pro Activation: Starting verification process...');

    // Show progress notification
    vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Multi Purpose Agent for TRAE: Verifying Pro status...',
            cancellable: false
        },
        async (progress) => {
            progress.report({ increment: 30 });

            // Give webhook a moment to process (Stripe webhooks can have slight delay)
            await new Promise(resolve => setTimeout(resolve, 1500));
            progress.report({ increment: 30 });

            // Verify license
            const isProNow = await verifyLicense(context);
            progress.report({ increment: 40 });

            if (isProNow) {
                // Update state
                isPro = true;
                await context.globalState.update(PRO_STATE_KEY, true);

                // Update CDP handler if running
                if (cdpHandler && cdpHandler.setProStatus) {
                    cdpHandler.setProStatus(true);
                }

                // Update poll frequency to pro default
                pollFrequency = context.globalState.get(FREQ_STATE_KEY, 1000);

                // Sync sessions with new pro status
                if (isEnabled) {
                    await syncSessions();
                }

                // Update UI
                updateStatusBar();

                log('Pro Activation: SUCCESS - User is now Pro!');
                vscode.window.showInformationMessage(
                    '\u{1F389} Pro Activated! Thank you for your support. All Pro features are now unlocked.',
                    'Open Dashboard'
                ).then(choice => {
                    if (choice === 'Open Dashboard') {
                        const panel = getSettingsPanel();
                        if (panel) panel.createOrShow(context.extensionUri, context);
                    }
                });
            } else {
                log('Pro Activation: License not found yet. Starting background polling...');
                // Start background polling in case webhook is delayed
                startProPolling(context);
            }
        }
    );
}

// Background polling for delayed webhook scenarios
let proPollingTimer = null;
let proPollingAttempts = 0;
const MAX_PRO_POLLING_ATTEMPTS = 24; // 2 minutes (5s intervals)

function startProPolling(context) {
    if (proPollingTimer) {
        clearInterval(proPollingTimer);
    }

    proPollingAttempts = 0;
    log('Pro Polling: Starting background verification (checking every 5s for up to 2 minutes)...');

    vscode.window.showInformationMessage(
        'Payment received! Verifying your Pro status... This may take a moment.'
    );

    proPollingTimer = setInterval(async () => {
        proPollingAttempts++;
        log(`Pro Polling: Attempt ${proPollingAttempts}/${MAX_PRO_POLLING_ATTEMPTS}`);

        if (proPollingAttempts > MAX_PRO_POLLING_ATTEMPTS) {
            clearInterval(proPollingTimer);
            proPollingTimer = null;
            log('Pro Polling: Max attempts reached. User should check manually.');
            vscode.window.showWarningMessage(
                'Pro verification is taking longer than expected. Please click "Check Pro Status" in settings, or contact support if the issue persists.',
                'Open Settings'
            ).then(choice => {
                if (choice === 'Open Settings') {
                    const panel = getSettingsPanel();
                    if (panel) panel.createOrShow(context.extensionUri, context);
                }
            });
            return;
        }

        const isProNow = await verifyLicense(context);
        if (isProNow) {
            clearInterval(proPollingTimer);
            proPollingTimer = null;

            // Update state
            isPro = true;
            await context.globalState.update(PRO_STATE_KEY, true);

            if (cdpHandler && cdpHandler.setProStatus) {
                cdpHandler.setProStatus(true);
            }

            pollFrequency = context.globalState.get(FREQ_STATE_KEY, 1000);

            if (isEnabled) {
                await syncSessions();
            }

            updateStatusBar();

            log('Pro Polling: SUCCESS - Pro status confirmed!');
            vscode.window.showInformationMessage(
                '\u{1F389} Pro Activated! Thank you for your support. All Pro features are now unlocked.',
                'Open Dashboard'
            ).then(choice => {
                if (choice === 'Open Dashboard') {
                    const panel = getSettingsPanel();
                    if (panel) panel.createOrShow(context.extensionUri, context);
                }
            });
        }
    }, 5000);
}

async function showReleasyCrossPromo(context) {
    const hasShown = context.globalState.get(RELEASY_PROMO_KEY, false);
    if (hasShown) return;

    // Only show to returning users (after at least 3 sessions)
    const stats = context.globalState.get(ROI_STATS_KEY, { sessionsThisWeek: 0 });
    const totalSessions = stats.sessionsThisWeek || 0;
    if (totalSessions < 3) return;

    // Mark as shown immediately to prevent multiple showings
    await context.globalState.update(RELEASY_PROMO_KEY, true);

    const title = "\u{1F389} New from the Multi Purpose Agent for TRAE team";
    const body = `Releasy AI \u{2014} Marketing for Developers

Turn your GitHub commits into Reddit posts automatically.

- AI analyzes your changes
- Generates engaging posts
- Auto-publishes to Reddit

Zero effort marketing for your side projects.`;

    const selection = await vscode.window.showInformationMessage(
        `${title}\n\n${body}`,
        { modal: true },
        "Check it out",
        "Maybe later"
    );

    if (selection === "Check it out") {
        vscode.env.openExternal(
            vscode.Uri.parse('https://releasyai.com?utm_source=auto-accept&utm_medium=extension&utm_campaign=version_promo')
        );
    }
}

function deactivate() {
    stopPolling();
    if (debugHandler) {
        debugHandler.stopServer();
    }
    if (cdpHandler) {
        cdpHandler.stop();
    }
}

module.exports = { activate, deactivate, Scheduler };
