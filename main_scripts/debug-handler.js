const vscode = require('vscode');
const http = require('http');
const path = require('path');
const fs = require('fs');

const GLOBAL_STATE_KEY = 'auto-accept-enabled-global';
const FREQ_STATE_KEY = 'auto-accept-frequency';
const BANNED_COMMANDS_KEY = 'auto-accept-banned-commands';
const ROI_STATS_KEY = 'auto-accept-roi-stats';
const LOG_FILE_NAME = 'auto-accept-cdp-TRAE.log';

class DebugHandler {
    constructor(context, helpers) {
        this.context = context;
        this.helpers = helpers;
        this.server = null;
        this.serverPort = 54321;
    }

    listActions() {
        return [
            { id: 'toggle', label: 'Toggle enabled', category: 'core' },
            { id: 'getEnabled', label: 'Get enabled', category: 'core' },

            { id: 'startQueue', label: 'Start queue', category: 'queue' },
            { id: 'pauseQueue', label: 'Pause queue', category: 'queue' },
            { id: 'resumeQueue', label: 'Resume queue', category: 'queue' },
            { id: 'skipPrompt', label: 'Skip prompt', category: 'queue' },
            { id: 'stopQueue', label: 'Stop queue', category: 'queue', requires_confirmation: true },
            { id: 'resetQueue', label: 'Reset queue', category: 'queue', requires_confirmation: true },
            {
                id: 'sendPrompt',
                label: 'Send prompt',
                category: 'queue',
                params_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
                examples: [{ label: 'Hello', params: { prompt: 'Hello from External Controller' } }]
            },
            {
                id: 'simulateEnter',
                label: 'Simulate Enter (CDP)',
                category: 'queue',
                params_schema: {
                    type: 'object',
                    properties: {
                        targetId: { type: 'string' },
                        includeCtrlFallback: { type: 'boolean' },
                        ctrlKey: { type: 'boolean' },
                        evalTimeoutMs: { type: 'number' }
                    }
                },
                examples: [
                    { label: 'Enter with Ctrl+Enter fallback', params: { includeCtrlFallback: true } },
                    { label: 'Ctrl+Enter only', params: { ctrlKey: true, includeCtrlFallback: false } }
                ]
            },

            { id: 'updateSchedule', label: 'Update schedule', category: 'schedule' },
            { id: 'getSchedule', label: 'Get schedule', category: 'schedule' },

            { id: 'getConversations', label: 'Get conversations', category: 'conversations' },
            {
                id: 'setTargetConversation',
                label: 'Set target conversation',
                category: 'conversations',
                params_schema: {
                    type: 'object',
                    properties: { conversationId: { type: 'string' } },
                    required: ['conversationId']
                }
            },
            { id: 'getPromptHistory', label: 'Get prompt history', category: 'conversations' },

            { id: 'updateBannedCommands', label: 'Update banned commands', category: 'safety', requires_confirmation: true },
            { id: 'getBannedCommands', label: 'Get banned commands', category: 'safety' },

            { id: 'getStats', label: 'Get stats', category: 'stats' },
            { id: 'getROIStats', label: 'Get ROI stats', category: 'stats' },

            { id: 'getLogs', label: 'Get logs', category: 'logs' },
            { id: 'clearLogs', label: 'Clear logs', category: 'logs', requires_confirmation: true },
            { id: 'openLogFile', label: 'Open log file', category: 'logs' },

            { id: 'setFrequency', label: 'Set frequency', category: 'utility' },
            { id: 'resetAllSettings', label: 'Reset all settings', category: 'utility', requires_confirmation: true },
            { id: 'checkPro', label: 'Check pro', category: 'utility' },

            { id: 'getSystemInfo', label: 'Get system info', category: 'system' },
            { id: 'forceRelaunch', label: 'Force relaunch', category: 'system', requires_confirmation: true },
            { id: 'getLockedOut', label: 'Get locked out', category: 'system' },
            { id: 'getFullState', label: 'Get full state', category: 'system' },
            { id: 'getServerStatus', label: 'Get server status', category: 'system' },
            { id: 'listChatCommands', label: 'List chat commands', category: 'system' },
            { id: 'executeExtensionCommand', label: 'Execute extension command', category: 'system', requires_confirmation: true },

            { id: 'getCDPStatus', label: 'Get CDP status', category: 'cdp' },
            { id: 'getCDPConnections', label: 'Get CDP connections', category: 'cdp' },
            { id: 'getCDPTargets', label: 'Get CDP targets', category: 'cdp' },
            {
                id: 'setPreferredCDPTarget',
                label: 'Set preferred CDP target',
                category: 'cdp',
                params_schema: {
                    type: 'object',
                    properties: { targetId: { type: 'string' } },
                    required: ['targetId']
                },
                requires_confirmation: true
            },
            { id: 'clearPreferredCDPTarget', label: 'Clear preferred CDP target', category: 'cdp', requires_confirmation: true },
            {
                id: 'evaluateInBrowser',
                label: 'Evaluate in browser',
                category: 'cdp',
                params_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
                requires_confirmation: true
            },
            {
                id: 'evaluateInBrowserOn',
                label: 'Evaluate in browser (target)',
                category: 'cdp',
                params_schema: {
                    type: 'object',
                    properties: { targetId: { type: 'string' }, code: { type: 'string' }, evalTimeoutMs: { type: 'number' } },
                    required: ['targetId', 'code']
                },
                requires_confirmation: true
            },
            {
                id: 'evaluateInBrowserAll',
                label: 'Evaluate in browser (all targets)',
                category: 'cdp',
                params_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
                requires_confirmation: true
            },
            { id: 'reinjectCdp', label: 'Reinject CDP helpers', category: 'cdp', requires_confirmation: true },

            { id: 'openSettingsPanel', label: 'Open settings panel', category: 'ui' },
            { id: 'uiAction', label: 'UI action', category: 'ui', requires_confirmation: true },
            { id: 'getUISnapshot', label: 'Get UI snapshot', category: 'ui' },
            { id: 'listUIElements', label: 'List UI elements', category: 'ui' },

            { id: 'listActions', label: 'List actions', category: 'system' }
        ];
    }

    getLogFilePath() {
        try {
            const storagePath = (this.context && this.context.globalStorageUri && this.context.globalStorageUri.fsPath)
                ? this.context.globalStorageUri.fsPath
                : (this.context && this.context.globalStoragePath ? this.context.globalStoragePath : null);
            if (storagePath) {
                try { fs.mkdirSync(storagePath, { recursive: true }); } catch (e) { }
                return path.join(storagePath, LOG_FILE_NAME);
            }
        } catch (e) { }
        return path.join(this.context.extensionPath, LOG_FILE_NAME);
    }

    log(message) {
        try {
            const logPath = path.join(__dirname, '..', 'trace.log');
            fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
        } catch (e) {
            // Ignore file write errors
        }

        if (this.helpers.log) {
            this.helpers.log(message);
        } else {
            console.log(message);
        }
    }

    async handleCommand(action, params = {}) {
        const scheduler = this.helpers.getScheduler ? this.helpers.getScheduler() : null;
        const isEnabled = this.context.globalState.get(GLOBAL_STATE_KEY, false);

        try {
            switch (action) {
                case 'listActions':
                    return { success: true, actions: this.listActions() };

                // === Core Controls ===
                case 'toggle':
                    await vscode.commands.executeCommand('auto-accept.toggle');
                    return { success: true, enabled: this.context.globalState.get(GLOBAL_STATE_KEY, false) };
                case 'getEnabled':
                    return { success: true, enabled: isEnabled };

                // === Queue Control ===
                case 'startQueue':
                    // DEFENSIVE CHECK: Don't start if prompts are empty
                    if (scheduler) {
                        const configPrompts = vscode.workspace.getConfiguration('auto-accept.schedule').get('prompts', []);
                        if (!configPrompts || configPrompts.length === 0) {
                            return { success: false, error: 'Queue is empty' };
                        }
                    }
                    await vscode.commands.executeCommand('auto-accept.startQueue', { source: 'manual' });
                    return { success: true };
                case 'pauseQueue':
                    if (scheduler) { scheduler.pauseQueue(); return { success: true }; }
                    return { success: false, error: 'Scheduler not initialized' };
                case 'resumeQueue':
                    if (scheduler) { scheduler.resumeQueue(); return { success: true }; }
                    return { success: false, error: 'Scheduler not initialized' };
                case 'skipPrompt':
                    if (scheduler) { await scheduler.skipPrompt(); return { success: true }; }
                    return { success: false, error: 'Scheduler not initialized' };
                case 'stopQueue':
                    if (scheduler) { scheduler.stopQueue(); return { success: true }; }
                    return { success: false, error: 'Scheduler not initialized' };
                case 'resetQueue':
                    if (scheduler) { await scheduler.resetQueue(); return { success: true }; }
                    return { success: false, error: 'Scheduler not initialized' };
                case 'sendPrompt':
                    // Send prompt via scheduler (ensures history is updated)
                    if (scheduler && scheduler.cdpHandler && params.prompt) {
                        // Use scheduler's sendPrompt and await the full promise chain
                        const promptResult = await scheduler.sendPrompt(params.prompt); // awaits the promptQueue chain
                        const ok = !!(promptResult && promptResult.success === true);
                        if (ok) return { success: true, method: 'CDP', result: promptResult };
                        return {
                            success: false,
                            method: 'CDP',
                            error: (promptResult && promptResult.error) ? promptResult.error : 'Prompt not delivered',
                            result: promptResult
                        };
                    }
                    if (!params.prompt) return { success: false, error: 'No prompt provided' };
                    return { success: false, error: 'Scheduler or CDPHandler not initialized' };
                case 'getQueueStatus':
                    // Re-implementing logic here or calling command? Command is safer if it exists, but getStatus is direct.
                    // Extension.js has no public command for getQueueStatus that returns data (showQueueMenu is UI).
                    if (scheduler) {
                        return { success: true, status: scheduler.getStatus() };
                    }
                    return { success: true, status: { enabled: false, isRunningQueue: false, queueLength: 0, queueIndex: 0 } };

                // === Schedule Configuration ===
                case 'updateSchedule':
                    // Reuse existing update logic by checking params
                    const schedConfig = vscode.workspace.getConfiguration('auto-accept.schedule');
                    if (params.enabled !== undefined) await schedConfig.update('enabled', params.enabled, vscode.ConfigurationTarget.Global);
                    if (params.mode !== undefined) await schedConfig.update('mode', params.mode, vscode.ConfigurationTarget.Global);
                    if (params.value !== undefined) await schedConfig.update('value', params.value, vscode.ConfigurationTarget.Global);
                    if (params.prompt !== undefined) await schedConfig.update('prompt', params.prompt, vscode.ConfigurationTarget.Global);
                    if (params.prompts !== undefined) await schedConfig.update('prompts', params.prompts, vscode.ConfigurationTarget.Global);
                    if (params.queueMode !== undefined) await schedConfig.update('queueMode', params.queueMode, vscode.ConfigurationTarget.Global);
                    if (params.silenceTimeout !== undefined) await schedConfig.update('silenceTimeout', params.silenceTimeout, vscode.ConfigurationTarget.Global);
                    if (params.checkPromptEnabled !== undefined) await schedConfig.update('checkPrompt.enabled', params.checkPromptEnabled, vscode.ConfigurationTarget.Global);
                    if (params.checkPromptText !== undefined) await schedConfig.update('checkPrompt.text', params.checkPromptText, vscode.ConfigurationTarget.Global);
                    return { success: true };

                case 'getSchedule':
                    const sched = vscode.workspace.getConfiguration('auto-accept.schedule');
                    return {
                        success: true,
                        schedule: {
                            enabled: sched.get('enabled'),
                            mode: sched.get('mode'),
                            value: sched.get('value'),
                            prompt: sched.get('prompt'),
                            prompts: sched.get('prompts', []),
                            queueMode: sched.get('queueMode', 'consume'),
                            silenceTimeout: sched.get('silenceTimeout', 30),
                            checkPromptEnabled: sched.get('checkPrompt.enabled', false),
                            checkPromptText: sched.get('checkPrompt.text', '')
                        }
                    };

                // === Conversations ===
                case 'getConversations':
                    if (scheduler) {
                        const convs = await scheduler.getConversations();
                        return { success: true, conversations: convs };
                    }
                    return { success: true, conversations: [] };
                case 'setTargetConversation':
                    await vscode.commands.executeCommand('auto-accept.setTargetConversation', params.conversationId);
                    return { success: true };
                case 'getPromptHistory':
                    if (scheduler) {
                        return { success: true, history: scheduler.getHistory() };
                    }
                    return { success: true, history: [] };

                // === Banned Commands (Safety) ===
                case 'updateBannedCommands':
                    // Reuse command which handles state + session sync
                    await vscode.commands.executeCommand('auto-accept.updateBannedCommands', params.commands);
                    return { success: true };
                case 'getBannedCommands':
                    return { success: true, commands: this.context.globalState.get(BANNED_COMMANDS_KEY, []) };

                // === Stats ===
                case 'getStats':
                    return { success: true, stats: this.context.globalState.get('auto-accept-stats', {}) };
                case 'getROIStats':
                    const roiStats = await vscode.commands.executeCommand('auto-accept.getROIStats');
                    return { success: true, roiStats };

                // === Logs ===
                case 'getLogs':
                    return this.getLogs(params.tailLines);
                case 'clearLogs':
                    return this.clearLogs();
                case 'openLogFile':
                    return this.openLogFile();

                // === Utility ===
                case 'setFrequency':
                    await vscode.commands.executeCommand('auto-accept.updateFrequency', params.value);
                    return { success: true };
                case 'resetAllSettings':
                    await vscode.commands.executeCommand('auto-accept.resetSettings');
                    return { success: true };
                case 'checkPro':
                    const isPro = this.helpers.getIsPro ? this.helpers.getIsPro() : true;
                    return { success: true, isPro };

                // === Advanced / System ===
                case 'getSystemInfo':
                    return {
                        success: true,
                        info: {
                            platform: process.platform,
                            nodeVersion: process.versions.node,
                            appName: vscode.env.appName,
                            machineId: vscode.env.machineId,
                            time: new Date().toISOString()
                        }
                    };
                case 'forceRelaunch':
                    await vscode.commands.executeCommand('auto-accept.relaunch');
                    return { success: true };
                case 'getLockedOut':
                    const locked = this.helpers.getLockedOut ? this.helpers.getLockedOut() : false;
                    return { success: true, isLockedOut: locked };

                // === Full State Snapshot ===
                case 'getFullState':
                    return this.getFullState();

                case 'getServerStatus':
                    return {
                        success: true,
                        server: {
                            running: !!this.server,
                            port: this.serverPort
                        }
                    };

                case 'getCDPStatus':
                    // Get detailed CDP connection status
                    const cdpHandler = scheduler ? scheduler.cdpHandler : null;
                    if (cdpHandler) {
                        return {
                            success: true,
                            cdp: {
                                connectionCount: cdpHandler.getConnectionCount(),
                                isEnabled: cdpHandler.isEnabled || false,
                                connections: Array.from(cdpHandler.connections.keys())
                            }
                        };
                    }
                    return { success: false, error: 'CDPHandler not available' };

                case 'listChatCommands':
                    // List all available commands that might be chat-related
                    try {
                        const allCommands = await vscode.commands.getCommands(true);
                        const chatCommands = allCommands.filter(cmd =>
                            cmd.includes('chat') ||
                            cmd.includes('Chat') ||
                            cmd.includes('agent') ||
                            cmd.includes('Agent') ||
                            cmd.includes('ai') ||
                            cmd.includes('AI') ||
                            cmd.includes('copilot') ||
                            cmd.includes('Copilot')
                        ).sort();
                        return { success: true, commands: chatCommands, count: chatCommands.length };
                    } catch (e) {
                        return { success: false, error: e.message };
                    }

                case 'executeExtensionCommand':
                    // Execute arbitrary extension command (for testing)
                    if (params.command) {
                        try {
                            const args = params.args || [];
                            const result = await vscode.commands.executeCommand(params.command, ...args);
                            return { success: true, command: params.command, result: result };
                        } catch (e) {
                            return { success: false, command: params.command, error: e.message };
                        }
                    }
                    return { success: false, error: 'No command provided' };

                case 'evaluateInBrowser':
                    // Evaluate arbitrary JavaScript in the browser context for debugging
                    // This allows testing selectors and input methods without rebuilding
                    if (params.code && scheduler && scheduler.cdpHandler) {
                        try {
                            const result = await scheduler.cdpHandler.evaluate(params.code);
                            return { success: true, result: result };
                        } catch (e) {
                            return { success: false, error: e.message };
                        }
                    }
                    if (!params.code) return { success: false, error: 'No code provided' };
                    return { success: false, error: 'CDP handler not available' };

                case 'evaluateInBrowserOn':
                    if (params.code && params.targetId && scheduler && scheduler.cdpHandler) {
                        try {
                            const timeoutMs = Number.isFinite(params.evalTimeoutMs) ? params.evalTimeoutMs : 6000;
                            const result = await scheduler.cdpHandler.evaluateOn(params.targetId, params.code, timeoutMs);
                            return { success: true, targetId: params.targetId, result };
                        } catch (e) {
                            return { success: false, targetId: params.targetId, error: e.message };
                        }
                    }
                    if (!params.code) return { success: false, error: 'No code provided' };
                    if (!params.targetId) return { success: false, error: 'No targetId provided' };
                    return { success: false, error: 'CDP handler not available' };

                case 'evaluateInBrowserAll':
                    if (params.code && scheduler && scheduler.cdpHandler) {
                        try {
                            const results = await scheduler.cdpHandler.evaluateAll(params.code);
                            return { success: true, results };
                        } catch (e) {
                            return { success: false, error: e.message };
                        }
                    }
                    if (!params.code) return { success: false, error: 'No code provided' };
                    return { success: false, error: 'CDP handler not available' };

                case 'reinjectCdp':
                    if (scheduler && scheduler.cdpHandler && typeof scheduler.cdpHandler.reinject === 'function') {
                        try {
                            const result = await scheduler.cdpHandler.reinject(params || {});
                            return { success: true, ...result };
                        } catch (e) {
                            return { success: false, error: e.message };
                        }
                    }
                    return { success: false, error: 'CDP handler not available' };

                case 'simulateEnter':
                    if (scheduler && scheduler.cdpHandler) {
                        try {
                            const result = await scheduler.cdpHandler.simulateEnter(params || {});
                            if (result && result.success === true) {
                                return { success: true, method: 'CDP', ...result };
                            }
                            return {
                                success: false,
                                method: 'CDP',
                                error: (result && result.error) ? String(result.error) : 'Enter simulation failed',
                                ...result
                            };
                        } catch (e) {
                            return { success: false, method: 'CDP', error: e.message };
                        }
                    }
                    return { success: false, error: 'CDP handler not available' };

                case 'getCDPConnections':
                    // List all CDP connections and their page info
                    if (scheduler && scheduler.cdpHandler) {
                        const connections = [];
                        for (const [id, conn] of scheduler.cdpHandler.connections) {
                            connections.push({ id, injected: conn.injected });
                        }
                        return { success: true, connections, count: connections.length };
                    }
                    return { success: false, error: 'CDP handler not available', errorCode: 'NOT_READY' };

                case 'getCDPTargets':
                    if (scheduler && scheduler.cdpHandler) {
                        const targets = [];
                        for (const [id, conn] of scheduler.cdpHandler.connections) {
                            targets.push({
                                id,
                                injected: !!conn.injected,
                                pageTitle: conn.pageTitle || '',
                                pageUrl: conn.pageUrl || ''
                            });
                        }
                        return { success: true, targets, count: targets.length };
                    }
                    return { success: false, error: 'CDP handler not available', errorCode: 'NOT_READY' };

                case 'setPreferredCDPTarget': {
                    const cdpHandler = scheduler ? scheduler.cdpHandler : null;
                    const targetId = (params && typeof params.targetId === 'string') ? params.targetId.trim() : '';
                    if (!cdpHandler) return { success: false, error: 'CDP handler not available', errorCode: 'NOT_READY' };
                    if (!targetId) return { success: false, error: 'No targetId provided', errorCode: 'BAD_REQUEST' };
                    if (!cdpHandler.connections || !cdpHandler.connections.has(targetId)) {
                        return { success: false, error: `Unknown targetId: ${targetId}`, errorCode: 'NOT_FOUND' };
                    }
                    cdpHandler.preferredTargetId = targetId;
                    return { success: true, preferredTargetId: targetId };
                }

                case 'clearPreferredCDPTarget': {
                    const cdpHandler = scheduler ? scheduler.cdpHandler : null;
                    if (!cdpHandler) return { success: false, error: 'CDP handler not available', errorCode: 'NOT_READY' };
                    cdpHandler.preferredTargetId = '';
                    return { success: true, preferredTargetId: '' };
                }

                // === WebView UI Testing ===
                case 'uiAction':
                    // Forward UI action to Settings Panel WebView
                    const SettingsPanel = require('../settings-panel').SettingsPanel;
                    if (SettingsPanel.currentPanel) {
                        SettingsPanel.currentPanel.handleDebugUIAction(params);
                        // Wait briefly for async result
                        await new Promise(resolve => setTimeout(resolve, 100));
                        const uiResult = SettingsPanel.currentPanel.getLastUIResult();
                        return { success: true, result: uiResult };
                    }
                    return { success: false, error: 'Settings panel not open. Open it first via auto-accept.openSettings command.' };

                case 'getUISnapshot':
                    // Get full Settings Panel UI state
                    const SP = require('../settings-panel').SettingsPanel;
                    if (SP.currentPanel) {
                        SP.currentPanel.handleDebugUIAction({ type: 'getSnapshot' });
                        await new Promise(resolve => setTimeout(resolve, 100));
                        const snapshot = SP.currentPanel.getLastUIResult();
                        return { success: true, snapshot };
                    }
                    return { success: false, error: 'Settings panel not open' };

                case 'listUIElements':
                    // List all interactive elements in Settings Panel
                    const Panel = require('../settings-panel').SettingsPanel;
                    if (Panel.currentPanel) {
                        Panel.currentPanel.handleDebugUIAction({ type: 'listElements' });
                        await new Promise(resolve => setTimeout(resolve, 100));
                        const elements = Panel.currentPanel.getLastUIResult();
                        return { success: true, ...elements };
                    }
                    return { success: false, error: 'Settings panel not open' };

                case 'openSettingsPanel':
                    // Open or focus the settings panel
                    await vscode.commands.executeCommand('auto-accept.openSettings');
                    return { success: true };

                default:
                    return { success: false, error: `Unknown debug action: ${action}`, errorCode: 'UNKNOWN_ACTION' };
            }
        } catch (err) {
            this.log(`[DebugHandler] Error executing ${action}: ${err.message}`);
            return { success: false, error: err.message, errorCode: 'INTERNAL_ERROR' };
        }
    }

    getLogs(tailLinesParam) {
        const logPath = this.getLogFilePath();
        try {
            if (fs.existsSync(logPath)) {
                const stat = fs.statSync(logPath);
                const maxBytes = 250000;
                const tailLines = tailLinesParam || 300;
                const start = Math.max(0, stat.size - maxBytes);
                const fd = fs.openSync(logPath, 'r');
                const buf = Buffer.alloc(stat.size - start);
                fs.readSync(fd, buf, 0, buf.length, start);
                fs.closeSync(fd);
                const lines = buf.toString('utf8').split(/\r?\n/).filter(l => l.length > 0);
                const tail = lines.slice(-tailLines).join('\n');
                return { success: true, logs: tail, linesCount: Math.min(tailLines, lines.length), totalSize: stat.size };
            }
            return { success: true, logs: '', linesCount: 0, totalSize: 0 };
        } catch (e) {
            return { success: false, error: `Failed to read logs: ${e.message}` };
        }
    }

    clearLogs() {
        const logPath = this.getLogFilePath();
        try {
            fs.writeFileSync(logPath, '', 'utf8');
            return { success: true };
        } catch (e) {
            return { success: false, error: `Failed to clear logs: ${e.message}` };
        }
    }

    async openLogFile() {
        const logPath = this.getLogFilePath();
        if (fs.existsSync(logPath)) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
            await vscode.window.showTextDocument(doc, { preview: false });
            return { success: true };
        }
        return { success: false, error: 'Log file not found' };
    }

    getFullState() {
        const scheduler = this.helpers.getScheduler ? this.helpers.getScheduler() : null;
        const scheduleConfig = vscode.workspace.getConfiguration('auto-accept.schedule');

        return {
            success: true,
            state: {
                enabled: this.context.globalState.get(GLOBAL_STATE_KEY, false),
                frequency: this.context.globalState.get(FREQ_STATE_KEY, 1000),
                schedule: {
                    enabled: scheduleConfig.get('enabled'),
                    mode: scheduleConfig.get('mode'),
                    value: scheduleConfig.get('value'),
                    prompt: scheduleConfig.get('prompt'),
                    prompts: scheduleConfig.get('prompts', []),
                    queueMode: scheduleConfig.get('queueMode', 'consume'),
                    silenceTimeout: scheduleConfig.get('silenceTimeout', 30)
                },
                queueStatus: scheduler ? scheduler.getStatus() : null,
                bannedCommands: this.context.globalState.get(BANNED_COMMANDS_KEY, []),
                stats: this.context.globalState.get('auto-accept-stats', {}),
                isPro: this.helpers.getIsPro ? this.helpers.getIsPro() : true,
                isLockedOut: this.helpers.getLockedOut ? this.helpers.getLockedOut() : false,
                debugMode: true
            }
        };
    }

    startServer() {
        if (this.server) return;

        // Check if debug mode is enabled
        const debugEnabled = vscode.workspace.getConfiguration('auto-accept.debugMode').get('enabled', false);
        if (!debugEnabled) return;

        try {
            this.server = http.createServer(async (req, res) => {
                const makeRequestId = (value) => {
                    if (typeof value === 'string' && value.trim()) return value.trim();
                    return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
                };
                const writeJson = (status, obj) => {
                    res.writeHead(status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(obj));
                };

                // CORS headers
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

                if (req.method === 'OPTIONS') {
                    res.writeHead(200);
                    res.end();
                    return;
                }

                if (req.method !== 'POST') {
                    const requestId = makeRequestId(req.headers['x-request-id']);
                    writeJson(405, { success: false, requestId, error: 'Method not allowed, use POST', errorCode: 'METHOD_NOT_ALLOWED' });
                    return;
                }

                let body = '';
                // Safety: limit body size to ~1MB
                let bodySize = 0;
                const MAX_BODY_SIZE = 1024 * 1024;

                req.on('data', chunk => {
                    bodySize += chunk.length;
                    if (bodySize > MAX_BODY_SIZE) {
                        const requestId = makeRequestId(req.headers['x-request-id']);
                        writeJson(413, { success: false, requestId, error: 'Payload too large', errorCode: 'PAYLOAD_TOO_LARGE' });
                        req.destroy();
                        return;
                    }
                    body += chunk.toString();
                });

                req.on('end', async () => {
                    let requestId = makeRequestId(req.headers['x-request-id']);
                    try {
                        let data = {};
                        if (body) {
                            try {
                                data = JSON.parse(body);
                            } catch (e) {
                                writeJson(400, { success: false, requestId, error: 'Invalid JSON', errorCode: 'BAD_REQUEST' });
                                return;
                            }
                        }

                        if (data && typeof data.requestId === 'string' && data.requestId.trim()) {
                            requestId = makeRequestId(data.requestId);
                        }

                        const { action, params } = data;
                        if (!action) {
                            writeJson(400, { success: false, requestId, error: 'Missing action', errorCode: 'BAD_REQUEST' });
                            return;
                        }

                        const source = `${req.socket?.remoteAddress}:${req.socket?.remotePort}`;
                        this.log(`[DebugServer] Received action: ${action} from ${source}`);
                        if (action === 'uiAction' && data.params && data.params.type === 'click') {
                            this.log(`[ALERT] UI CLICK DETECTED FROM ${source} ON TARGET ${data.params.target}`);
                        }

                        // Delegate to handleCommand
                        const result = await this.handleCommand(action, params);
                        const normalized = (result && typeof result === 'object') ? { ...result } : { success: true, result };
                        if (normalized.requestId === undefined) normalized.requestId = requestId;
                        if (normalized.success === false) {
                            if (typeof normalized.error === 'string' && normalized.error) {
                                if (!normalized.errorCode) normalized.errorCode = 'API_ERROR';
                            } else if (normalized.error && typeof normalized.error === 'object') {
                                const errObj = normalized.error;
                                const msg = errObj.message || errObj.msg;
                                normalized.error = typeof msg === 'string' && msg ? msg : 'API returned success:false';
                                if (!normalized.errorCode && errObj.code) normalized.errorCode = String(errObj.code);
                                if (!normalized.errorCode) normalized.errorCode = 'API_ERROR';
                            } else {
                                normalized.error = 'API returned success:false';
                                if (!normalized.errorCode) normalized.errorCode = 'API_ERROR';
                            }
                        }

                        writeJson(200, normalized);
                    } catch (e) {
                        writeJson(500, { success: false, requestId, error: e.message, errorCode: 'INTERNAL_ERROR' });
                    }
                });
            });

            this.server.listen(this.serverPort, '127.0.0.1', () => {
                this.log(`Debug Server running on http://127.0.0.1:${this.serverPort}`);
            });

            this.server.on('error', (e) => {
                this.log(`Debug Server Error: ${e.message}`);
                if (e.code === 'EADDRINUSE') {
                    this.log('Port 54321 is busy. Debug server could not start.');
                }
                this.stopServer(); // Cleanup
            });

        } catch (e) {
            this.log(`Failed to start Debug Server: ${e.message}`);
        }
    }

    stopServer() {
        if (this.server) {
            this.server.close();
            this.server = null;
            this.log('Debug Server stopped');
        }
    }
}

module.exports = { DebugHandler };
