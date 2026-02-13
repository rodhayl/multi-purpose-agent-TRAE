/**
 * Unit Tests for Scheduler Class
 * Tests the Sequential Prompt Queue implementation
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Dynamic mock config - can be modified per test
let mockConfig = {
    enabled: true,
    mode: 'queue',
    value: '30',
    prompt: 'Status report',
    prompts: ['Task A', 'Task B'],
    queueMode: 'consume',
    silenceTimeout: 30,
    'checkPrompt.enabled': false,
    'checkPrompt.text': 'Check prompt'
};

// Reset config to defaults
function resetMockConfig() {
    mockConfig = {
        enabled: true,
        mode: 'queue',
        value: '30',
        prompt: 'Status report',
        prompts: ['Task A', 'Task B'],
        queueMode: 'consume',
        silenceTimeout: 30,
        'checkPrompt.enabled': false,
        'checkPrompt.text': 'Check prompt'
    };
}

// Mock vscode
const mockVscode = {
    workspace: {
        getConfiguration: (section) => ({
            get: (key, defaultValue) => {
                if (section === 'auto-accept.schedule') {
                    return mockConfig[key] !== undefined ? mockConfig[key] : defaultValue;
                }
                if (section === 'auto-accept.debugMode') {
                    if (key === 'enabled') return true;
                    return defaultValue;
                }
                return defaultValue;
            },
            update: async () => true
        })
    },
    window: {
        showInformationMessage: () => { },
        showWarningMessage: () => { },
        showErrorMessage: () => { }
    },
    ConfigurationTarget: { Global: 1 }
};

// Load the real Scheduler with a mocked vscode module
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return mockVscode;
    return originalLoad.call(this, request, parent, isMain);
};
const { Scheduler } = require('../extension.js');
const { DebugHandler } = require('../main_scripts/debug-handler');

// Mock CDPHandler
const mockCdpHandler = {
    sendPrompt: async (text, targetConversation) => {
        mockCdpHandler.lastPrompt = text;
        mockCdpHandler.lastTarget = targetConversation || '';
        mockCdpHandler.sendCount = (mockCdpHandler.sendCount || 0) + 1;
        return 1; // Return count (1 tab) to match real implementation
    },
    getStats: async () => ({ clicks: mockCdpHandler.clickCount || 0 }),
    lastPrompt: null,
    lastTarget: '',
    sendCount: 0,
    clickCount: 0
};

// Create a simplified Scheduler for testing
class TestScheduler {
    constructor(context, cdpHandler, logFn) {
        this.context = context;
        this.cdpHandler = cdpHandler;
        this.log = logFn || (() => { });
        this.runtimeQueue = [];
        this.queueIndex = 0;
        this.isRunningQueue = false;
        this.config = {};
        this.enabled = false;
        this.lastClickTime = 0;
        this.lastClickCount = 0;
        this.taskStartTime = 0;

        // Multi-queue ready fields
        this.targetConversation = '';
        this.promptHistory = [];
        this.conversationStatus = 'idle';
        this.isPaused = false;
        this.promptQueue = Promise.resolve();
    }

    loadConfig() {
        const cfg = mockVscode.workspace.getConfiguration('auto-accept.schedule');
        this.enabled = cfg.get('enabled', false);
        this.config = {
            mode: cfg.get('mode', 'interval'),
            prompts: cfg.get('prompts', []),
            queueMode: cfg.get('queueMode', 'consume'),
            silenceTimeout: cfg.get('silenceTimeout', 30) * 1000,
            checkPromptEnabled: cfg.get('checkPrompt.enabled', false),
            checkPromptText: cfg.get('checkPrompt.text', 'Check prompt')
        };
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

    async startQueue() {
        this.loadConfig();
        if (this.config.mode !== 'queue') {
            return { error: 'Not in queue mode' };
        }

        this.runtimeQueue = this.buildRuntimeQueue();
        this.queueIndex = 0;
        this.isRunningQueue = true;
        this.lastClickCount = 0;
        this.lastClickTime = Date.now();
        this.taskStartTime = Date.now();

        if (this.runtimeQueue.length === 0) {
            this.isRunningQueue = false;
            return { error: 'Queue is empty' };
        }

        await this.executeCurrentQueueItem();
        return { success: true };
    }

    async advanceQueue() {
        if (!this.isRunningQueue) return;

        const completedItem = this.runtimeQueue[this.queueIndex];

        // In consume mode, only consume after completing a TASK item (not after check prompts).
        if (this.config.queueMode === 'consume' && completedItem && completedItem.type === 'task') {
            // Simulate extension behavior by consuming from config prompts
            if (Array.isArray(mockConfig.prompts) && mockConfig.prompts.length > 0) {
                mockConfig.prompts = mockConfig.prompts.slice(1);
            }
        }

        this.queueIndex++;
        this.lastClickCount = 0;
        this.lastClickTime = Date.now();
        this.taskStartTime = Date.now();

        if (this.queueIndex >= this.runtimeQueue.length) {
            if (this.config.queueMode === 'loop' && this.runtimeQueue.length > 0) {
                this.queueIndex = 0;
            } else {
                this.isRunningQueue = false;
                return { completed: true };
            }
        }

        await this.executeCurrentQueueItem();
        return { advanced: true };
    }

    async executeCurrentQueueItem() {
        if (this.queueIndex >= this.runtimeQueue.length) return;
        const item = this.runtimeQueue[this.queueIndex];
        try {
            await this.sendQueueItemText(item.text);
        } catch (e) {
            if (item.type !== 'check') throw e;
        }
    }

    async sendPrompt(text) {
        if (text && this.cdpHandler) {
            await this.cdpHandler.sendPrompt(text, this.targetConversation);
        }
    }

    async queuePrompt(text) {
        this.promptQueue = this.promptQueue.then(async () => {
            if (text && this.cdpHandler) {
                await this.cdpHandler.sendPrompt(text, this.targetConversation);
            }
        }).catch(err => {
            this.log(`Scheduler Error: ${err.message}`);
        });
        return this.promptQueue;
    }

    async sendQueueItemText(text) {
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
            isPaused: this.isPaused
        };
    }

    // Multi-queue ready methods
    addToHistory(text, conversationId) {
        this.promptHistory.push({
            text: text.substring(0, 100),
            fullText: text,
            timestamp: Date.now(),
            status: 'sent',
            conversationId: conversationId || this.targetConversation || 'current'
        });
        if (this.promptHistory.length > 50) {
            this.promptHistory.shift();
        }
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

    setTargetConversation(id) {
        this.targetConversation = id || '';
    }

    // Queue control methods
    pauseQueue() {
        if (!this.isRunningQueue || this.isPaused) return false;
        this.isPaused = true;
        return true;
    }

    resumeQueue() {
        if (!this.isRunningQueue || !this.isPaused) return false;
        this.isPaused = false;
        return true;
    }

    async skipPrompt() {
        if (!this.isRunningQueue) return false;
        this.queueIndex++;
        this.isPaused = false;
        if (this.queueIndex >= this.runtimeQueue.length) {
            this.isRunningQueue = false;
            this.conversationStatus = 'idle';
        }
        return true;
    }

    stopQueue() {
        if (!this.isRunningQueue && this.runtimeQueue.length === 0) return false;
        this.isRunningQueue = false;
        this.runtimeQueue = [];
        this.queueIndex = 0;
        this.conversationStatus = 'idle';
        this.isPaused = false;
        return true;
    }

    getCurrentPrompt() {
        if (!this.isRunningQueue || this.queueIndex >= this.runtimeQueue.length) return null;
        return this.runtimeQueue[this.queueIndex];
    }
}

// Test Suite
console.log('\n=== Scheduler Unit Tests ===\n');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        resetMockConfig();
        mockCdpHandler.lastPrompt = null;
        await fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (e) {
        console.log(`✗ ${name}`);
        console.log(`  Error: ${e.message}`);
        failed++;
    }
}

async function runTests() {
    // Test 1: buildRuntimeQueue without check prompts
    await test('buildRuntimeQueue creates correct queue without check prompts', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        scheduler.loadConfig();

        const queue = scheduler.buildRuntimeQueue();

        assert.strictEqual(queue.length, 2);
        assert.strictEqual(queue[0].type, 'task');
        assert.strictEqual(queue[0].text, 'Task A');
        assert.strictEqual(queue[1].text, 'Task B');
    });

    // Test 2: buildRuntimeQueue with check prompts
    await test('buildRuntimeQueue interleaves check prompts correctly', async () => {
        mockConfig['checkPrompt.enabled'] = true;
        mockConfig['checkPrompt.text'] = 'Check this';

        const scheduler = new TestScheduler({}, mockCdpHandler);
        scheduler.loadConfig();

        const queue = scheduler.buildRuntimeQueue();

        assert.strictEqual(queue.length, 4);
        assert.strictEqual(queue[0].type, 'task');
        assert.strictEqual(queue[1].type, 'check');
        assert.strictEqual(queue[1].text, 'Check this');
    });

    // Test 3: startQueue sends first prompt
    await test('startQueue sends first prompt', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        const result = await scheduler.startQueue();

        assert.strictEqual(result.success, true);
        assert.strictEqual(mockCdpHandler.lastPrompt, 'Task A');
        assert.strictEqual(scheduler.isRunningQueue, true);
    });

    // Test 4: startQueue with empty queue
    await test('startQueue returns error for empty queue', async () => {
        mockConfig.prompts = [];

        const scheduler = new TestScheduler({}, mockCdpHandler);
        const result = await scheduler.startQueue();

        assert.strictEqual(result.error, 'Queue is empty');
        assert.strictEqual(scheduler.isRunningQueue, false);
    });

    // Test 5: advanceQueue moves to next item
    await test('advanceQueue moves to next item', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        await scheduler.startQueue();

        await scheduler.advanceQueue();

        assert.strictEqual(scheduler.queueIndex, 1);
        assert.strictEqual(mockCdpHandler.lastPrompt, 'Task B');
    });

    // Test 6: Queue completes and stops in consume mode
    await test('Queue completes and stops in consume mode', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        await scheduler.startQueue();

        await scheduler.advanceQueue(); // Task B
        const result = await scheduler.advanceQueue(); // Complete

        assert.strictEqual(result.completed, true);
        assert.strictEqual(scheduler.isRunningQueue, false);
    });

    // Test 7: Queue loops in loop mode
    await test('Queue loops in loop mode', async () => {
        mockConfig.queueMode = 'loop';

        const scheduler = new TestScheduler({}, mockCdpHandler);
        await scheduler.startQueue();

        await scheduler.advanceQueue(); // Task B
        await scheduler.advanceQueue(); // Loop to Task A

        assert.strictEqual(scheduler.queueIndex, 0);
        assert.strictEqual(scheduler.isRunningQueue, true);
    });

    // Test 9: getStatus returns correct info
    await test('getStatus returns correct queue information', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        await scheduler.startQueue();

        const status = scheduler.getStatus();

        assert.strictEqual(status.isRunningQueue, true);
        assert.strictEqual(status.queueLength, 2);
        assert.strictEqual(status.queueIndex, 0);
    });

    // Test 10: getStatus shows correct info when not started
    await test('getStatus shows Not Started when queue not running', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        scheduler.loadConfig();

        const status = scheduler.getStatus();

        assert.strictEqual(status.isRunningQueue, false);
        assert.strictEqual(status.queueLength, 0); // Runtime queue not built yet
    });

    // Test 12: getStatus tracks queue progress correctly
    await test('getStatus tracks queue progress through items', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        await scheduler.startQueue();

        let status = scheduler.getStatus();
        assert.strictEqual(status.queueIndex, 0);
        assert.strictEqual(status.queueLength, 2);

        await scheduler.advanceQueue();
        status = scheduler.getStatus();
        assert.strictEqual(status.queueIndex, 1);
    });

    // Test 13: getStatus shows completed state
    await test('getStatus shows completed state after queue finishes', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        await scheduler.startQueue();
        await scheduler.advanceQueue(); // Task B
        await scheduler.advanceQueue(); // Complete

        const status = scheduler.getStatus();

        assert.strictEqual(status.isRunningQueue, false);
        assert.strictEqual(status.queueIndex, 2);
    });

    // Test 14: Mode returned in status
    await test('getStatus includes mode in response', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        scheduler.loadConfig();

        const status = scheduler.getStatus();

        assert.strictEqual(status.mode, 'queue');
    });

    // Test 15: addToHistory creates entry
    await test('addToHistory creates history entry', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        scheduler.addToHistory('Test prompt for history', 'chat-1');

        assert.strictEqual(scheduler.promptHistory.length, 1);
        assert.strictEqual(scheduler.promptHistory[0].text, 'Test prompt for history');
        assert.strictEqual(scheduler.promptHistory[0].conversationId, 'chat-1');
    });

    // Test 16: getHistory returns formatted entries
    await test('getHistory returns formatted entries with timeAgo', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        scheduler.addToHistory('Recent prompt', '');

        const history = scheduler.getHistory();

        assert.strictEqual(history.length, 1);
        assert.strictEqual(history[0].timeAgo, 'just now');
        assert.strictEqual(history[0].conversation, 'current');
    });

    // Test 17: History respects 50-item limit
    await test('History respects 50-item limit', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);

        // Add 55 items
        for (let i = 0; i < 55; i++) {
            scheduler.addToHistory(`Prompt ${i}`, 'chat');
        }

        assert.strictEqual(scheduler.promptHistory.length, 50);
        assert.strictEqual(scheduler.promptHistory[0].text, 'Prompt 5'); // First 5 removed
    });

    // Test 18: formatTimeAgo formats correctly
    await test('formatTimeAgo formats time correctly', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        const now = Date.now();

        assert.strictEqual(scheduler.formatTimeAgo(now - 30000), 'just now');
        assert.strictEqual(scheduler.formatTimeAgo(now - 120000), '2m ago');
        assert.strictEqual(scheduler.formatTimeAgo(now - 7200000), '2h ago');
    });

    // Test 19: setTargetConversation updates state
    await test('setTargetConversation updates target', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);

        scheduler.setTargetConversation('my-chat');
        assert.strictEqual(scheduler.targetConversation, 'my-chat');

        scheduler.setTargetConversation('');
        assert.strictEqual(scheduler.targetConversation, '');
    });

    // Test 20: pauseQueue/resumeQueue toggle pause state
    await test('pauseQueue and resumeQueue toggle pause state', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        scheduler.isRunningQueue = true;
        scheduler.runtimeQueue = [{ text: 'test' }];

        assert.strictEqual(scheduler.isPaused, false);
        scheduler.pauseQueue();
        assert.strictEqual(scheduler.isPaused, true);
        scheduler.resumeQueue();
        assert.strictEqual(scheduler.isPaused, false);
    });

    // Test 21: skipPrompt advances queue
    await test('skipPrompt advances queue index', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        scheduler.isRunningQueue = true;
        scheduler.runtimeQueue = [{ text: 'one' }, { text: 'two' }, { text: 'three' }];
        scheduler.queueIndex = 0;

        await scheduler.skipPrompt();
        assert.strictEqual(scheduler.queueIndex, 1);
    });

    // Test 22: stopQueue clears queue
    await test('stopQueue clears queue and resets state', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        scheduler.isRunningQueue = true;
        scheduler.runtimeQueue = [{ text: 'one' }, { text: 'two' }];
        scheduler.queueIndex = 1;
        scheduler.isPaused = true;

        scheduler.stopQueue();
        assert.strictEqual(scheduler.isRunningQueue, false);
        assert.strictEqual(scheduler.runtimeQueue.length, 0);
        assert.strictEqual(scheduler.queueIndex, 0);
        assert.strictEqual(scheduler.isPaused, false);
    });

    // Test 23: getCurrentPrompt returns current item
    await test('getCurrentPrompt returns current queue item', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        scheduler.isRunningQueue = true;
        scheduler.runtimeQueue = [{ text: 'first' }, { text: 'second' }];
        scheduler.queueIndex = 1;

        const current = scheduler.getCurrentPrompt();
        assert.strictEqual(current.text, 'second');
    });

    // Test 24: queuePrompt passes targetConversation to CDP handler
    await test('queuePrompt passes targetConversation to CDP handler', async () => {
        const scheduler = new TestScheduler({}, mockCdpHandler);
        scheduler.enabled = true;
        scheduler.targetConversation = 'test-conversation';

        const initialCount = mockCdpHandler.sendCount;
        await scheduler.queuePrompt('Hello world');
        await scheduler.promptQueue; // Wait for queue to complete

        assert.strictEqual(mockCdpHandler.lastPrompt, 'Hello world');
        assert.strictEqual(mockCdpHandler.lastTarget, 'test-conversation');
        assert.strictEqual(mockCdpHandler.sendCount, initialCount + 1);
    });

    await test('consume mode does not consume on check prompts', async () => {
        resetMockConfig();
        mockConfig.mode = 'queue';
        mockConfig.queueMode = 'consume';
        mockConfig.prompts = ['A', 'B'];
        mockConfig['checkPrompt.enabled'] = true;
        mockConfig['checkPrompt.text'] = 'Check prompt';

        const scheduler = new TestScheduler({}, mockCdpHandler);
        scheduler.loadConfig();
        scheduler.runtimeQueue = scheduler.buildRuntimeQueue(); // [task A, check, task B, check]
        scheduler.isRunningQueue = true;
        scheduler.queueIndex = 0;

        // Complete task A -> should consume A
        await scheduler.advanceQueue();
        assert.deepStrictEqual(mockConfig.prompts, ['B']);

        // Complete check prompt -> should NOT consume B
        await scheduler.advanceQueue();
        assert.deepStrictEqual(mockConfig.prompts, ['B']);
    });

    await test('check prompts use same send path as tasks', async () => {
        let queuePromptCalls = 0;
        let sendPromptCalls = 0;

        const cdp = {
            getConnectionCount: () => 1,
            getCompletionStatus: async () => ({ current: 'idle' }),
            getActiveConversation: async () => 'current',
            getStats: async () => ({ clicks: 0, lastActivityTime: 0, lastDomActivityTime: 0 }),
            evaluateAll: async () => [],
            sendPrompt: async () => 1
        };

        const scheduler = new Scheduler({}, cdp, () => { });
        scheduler.config = { mode: 'queue', value: '30', silenceTimeout: 30 * 1000 };
        scheduler.isRunningQueue = true;
        scheduler.runtimeQueue = [{ type: 'check', text: 'Check unified send path', afterIndex: 0 }];
        scheduler.queueIndex = 0;
        scheduler.taskStartTime = Date.now() - 15000;
        scheduler.hasSentCurrentItem = false;
        scheduler.lastDomActivityTime = 0;

        const origQueuePrompt = scheduler.queuePrompt.bind(scheduler);
        scheduler.queuePrompt = async (text, options = {}) => {
            queuePromptCalls++;
            return origQueuePrompt(text, options);
        };
        scheduler.sendPrompt = async () => {
            sendPromptCalls++;
            return { success: true, sentCount: 1 };
        };

        await scheduler.executeCurrentQueueItem();
        await scheduler.promptQueue;

        assert.strictEqual(sendPromptCalls, 0);
        assert.strictEqual(queuePromptCalls, 1);
    });

    await test('Scheduler does not send while busy even when DOM is idle', async () => {
        let sendCount = 0;
        const busyCdp = {
            getConnectionCount: () => 1,
            getCompletionStatus: async () => ({ current: 'working' }),
            getActiveConversation: async () => 'current',
            getStats: async () => ({ clicks: 0, lastActivityTime: 0, lastDomActivityTime: 0 }),
            evaluateAll: async () => [],
            sendPrompt: async () => {
                sendCount++;
                return 1;
            }
        };

        const scheduler = new Scheduler({}, busyCdp, () => { });
        scheduler.config = { mode: 'queue', value: '30', silenceTimeout: 30 * 1000 };
        scheduler.isRunningQueue = true;
        scheduler.runtimeQueue = [{ type: 'task', text: 'Hello', index: 0 }];
        scheduler.queueIndex = 0;
        scheduler.taskStartTime = Date.now() - 15000;
        scheduler.hasSentCurrentItem = false;
        scheduler.lastDomActivityTime = 0;

        await scheduler.executeCurrentQueueItem();
        await scheduler.promptQueue;

        assert.strictEqual(sendCount, 0);
        assert.strictEqual(scheduler.hasSentCurrentItem, false);
        assert.strictEqual(scheduler.conversationStatus, 'waiting');
    });

    await test('Scheduler does not send while busy and DOM is active', async () => {
        let sendCount = 0;
        const activeBusyCdp = {
            getConnectionCount: () => 1,
            getCompletionStatus: async () => ({ current: 'working' }),
            getActiveConversation: async () => 'current',
            getStats: async () => ({ clicks: 0, lastActivityTime: Date.now(), lastDomActivityTime: Date.now() }),
            evaluateAll: async () => [],
            sendPrompt: async () => {
                sendCount++;
                return 1;
            }
        };

        const scheduler = new Scheduler({}, activeBusyCdp, () => { });
        scheduler.config = { mode: 'queue', value: '30', silenceTimeout: 30 * 1000 };
        scheduler.isRunningQueue = true;
        scheduler.runtimeQueue = [{ type: 'task', text: 'Hello', index: 0 }];
        scheduler.queueIndex = 0;
        scheduler.taskStartTime = Date.now() - 15000;
        scheduler.hasSentCurrentItem = false;
        scheduler.lastDomActivityTime = Date.now() - 1000;

        await scheduler.executeCurrentQueueItem();
        await scheduler.promptQueue;

        assert.strictEqual(sendCount, 0);
        assert.strictEqual(scheduler.hasSentCurrentItem, false);
        assert.strictEqual(scheduler.conversationStatus, 'waiting');
    });

    await test('Scheduler de-dupes resend when transcript contains prompt in iframe', async () => {
        let sendCount = 0;
        let transcriptHasPromptInIframe = false;

        const cdp = {
            getConnectionCount: () => 1,
            getCompletionStatus: async () => ({ current: 'idle' }),
            getActiveConversation: async () => 'current',
            getStats: async () => ({ clicks: 0, lastActivityTime: 0, lastDomActivityTime: 0 }),
            evaluateAll: async (expression) => {
                const expr = String(expression || '');
                const iframeAware = expr.includes('iframe') && expr.includes('frame');
                const notPanelScoped = !expr.includes('trae.agentPanel') && !expr.includes('#trae\\\\.agentPanel');
                assert.strictEqual(notPanelScoped, true);
                return [{ id: 'c1', ok: true, value: iframeAware && transcriptHasPromptInIframe }];
            },
            sendPrompt: async () => {
                sendCount++;
                return 0;
            }
        };

        const scheduler = new Scheduler({}, cdp, () => { });
        scheduler.config = { mode: 'queue', value: '30', silenceTimeout: 30 * 1000 };
        scheduler.isRunningQueue = true;
        scheduler.runtimeQueue = [{ type: 'task', text: 'Loop test: Hello world', index: 0 }];
        scheduler.queueIndex = 0;
        scheduler.taskStartTime = Date.now() - 15000;
        scheduler.hasSentCurrentItem = false;
        scheduler.lastDomActivityTime = 0;

        await scheduler.executeCurrentQueueItem();
        await scheduler.promptQueue;

        assert.strictEqual(sendCount, 1);
        assert.strictEqual(scheduler.hasSentCurrentItem, false);
        assert.strictEqual(scheduler.conversationStatus, 'waiting');

        transcriptHasPromptInIframe = true;
        scheduler.lastSendAttemptTime = Date.now() - 5000;

        await scheduler.executeCurrentQueueItem();
        await scheduler.promptQueue;

        assert.strictEqual(sendCount, 1);
        assert.strictEqual(scheduler.hasSentCurrentItem, true);
        assert.strictEqual(scheduler.conversationStatus, 'running');
    });

    await test('Scheduler treats prompt as sent when transcript contains it after reported failure', async () => {
        let sendCount = 0;
        let transcriptHasPromptInIframe = true;

        const cdp = {
            getConnectionCount: () => 1,
            getCompletionStatus: async () => ({ current: 'idle' }),
            getActiveConversation: async () => 'current',
            getStats: async () => ({ clicks: 0, lastActivityTime: 0, lastDomActivityTime: 0 }),
            evaluateAll: async (expression) => {
                const expr = String(expression || '');
                const iframeAware = expr.includes('iframe') && expr.includes('frame');
                return [{ id: 'c1', ok: true, value: iframeAware && transcriptHasPromptInIframe }];
            },
            sendPrompt: async () => {
                sendCount++;
                return 0;
            }
        };

        const scheduler = new Scheduler({}, cdp, () => { });
        scheduler.config = { mode: 'queue', value: '30', silenceTimeout: 30 * 1000 };
        scheduler.isRunningQueue = true;
        scheduler.runtimeQueue = [{ type: 'task', text: 'After-fail transcript: Hello world', index: 0 }];
        scheduler.queueIndex = 0;
        scheduler.taskStartTime = Date.now() - 15000;
        scheduler.hasSentCurrentItem = false;
        scheduler.lastDomActivityTime = 0;

        await scheduler.executeCurrentQueueItem();
        await scheduler.promptQueue;

        assert.strictEqual(sendCount, 1);
        assert.strictEqual(scheduler.hasSentCurrentItem, true);
        assert.strictEqual(scheduler.conversationStatus, 'running');
    });

    await test('Scheduler does not auto-skip check prompt on send failure', async () => {
        let sendCount = 0;

        const cdp = {
            getConnectionCount: () => 1,
            getCompletionStatus: async () => ({ current: 'idle' }),
            getActiveConversation: async () => 'current',
            getStats: async () => ({ clicks: 0, lastActivityTime: 0, lastDomActivityTime: 0 }),
            evaluateAll: async () => [{ id: 'c1', ok: true, value: false }],
            sendPrompt: async () => {
                sendCount++;
                return 0;
            }
        };

        const scheduler = new Scheduler({}, cdp, () => { });
        scheduler.config = { mode: 'queue', value: '30', silenceTimeout: 30 * 1000 };
        scheduler.isRunningQueue = true;
        scheduler.runtimeQueue = [{ type: 'check', text: 'Check prompt that fails', afterIndex: 0 }];
        scheduler.queueIndex = 0;
        scheduler.taskStartTime = Date.now() - 15000;
        scheduler.hasSentCurrentItem = false;
        scheduler.lastDomActivityTime = 0;

        await scheduler.executeCurrentQueueItem();
        await scheduler.promptQueue;

        assert.strictEqual(sendCount, 1);
        assert.strictEqual(scheduler.queueIndex, 0);
        assert.strictEqual(scheduler.hasSentCurrentItem, false);
        assert.strictEqual(scheduler.conversationStatus, 'waiting');
        assert.strictEqual(scheduler.isRunningQueue, true);
    });

    await test('Debug server: bad JSON returns requestId and errorCode', async () => {
        const handler = new DebugHandler(
            {
                globalState: { get: () => false },
                extensionPath: path.join(__dirname, '..'),
                globalStorageUri: { fsPath: path.join(__dirname, '..', '.tmp') }
            },
            { log: () => { }, getScheduler: () => null }
        );

        handler.serverPort = 0;
        handler.startServer();
        await new Promise((resolve, reject) => {
            handler.server.once('listening', resolve);
            handler.server.once('error', reject);
        });
        const port = handler.server.address().port;

        try {
            const result = await new Promise((resolve, reject) => {
                const req = http.request(
                    {
                        hostname: '127.0.0.1',
                        port,
                        path: '/',
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-request-id': 'rid_123'
                        }
                    },
                    (res) => {
                        let buf = '';
                        res.on('data', (d) => { buf += d; });
                        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
                    }
                );
                req.on('error', reject);
                req.end('{');
            });

            assert.strictEqual(result.status, 400);
            const json = JSON.parse(result.body);
            assert.strictEqual(json.success, false);
            assert.strictEqual(json.requestId, 'rid_123');
            assert.strictEqual(json.errorCode, 'BAD_REQUEST');
        } finally {
            handler.stopServer();
        }
    });

    await test('Debug server: listActions includes listActions and echoes requestId', async () => {
        const handler = new DebugHandler(
            {
                globalState: { get: () => false },
                extensionPath: path.join(__dirname, '..'),
                globalStorageUri: { fsPath: path.join(__dirname, '..', '.tmp') }
            },
            { log: () => { }, getScheduler: () => null }
        );

        handler.serverPort = 0;
        handler.startServer();
        await new Promise((resolve, reject) => {
            handler.server.once('listening', resolve);
            handler.server.once('error', reject);
        });
        const port = handler.server.address().port;

        try {
            const result = await new Promise((resolve, reject) => {
                const req = http.request(
                    {
                        hostname: '127.0.0.1',
                        port,
                        path: '/',
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    },
                    (res) => {
                        let buf = '';
                        res.on('data', (d) => { buf += d; });
                        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
                    }
                );
                req.on('error', reject);
                req.end(JSON.stringify({ action: 'listActions', requestId: 'rid_list' }));
            });

            assert.strictEqual(result.status, 200);
            const json = JSON.parse(result.body);
            assert.strictEqual(json.success, true);
            assert.strictEqual(json.requestId, 'rid_list');
            assert(Array.isArray(json.actions), 'Expected actions to be an array');
            assert(json.actions.some(a => a && a.id === 'listActions'), 'Expected listActions in action catalog');
        } finally {
            handler.stopServer();
        }
    });

    await test('Debug server: setPreferredCDPTarget updates cdpHandler and getCDPTargets returns metadata', async () => {
        const cdpHandler = {
            connections: new Map([
                ['t1', { injected: true, pageTitle: 'Page One', pageUrl: 'https://example.test/one' }]
            ]),
            preferredTargetId: ''
        };
        const scheduler = { cdpHandler };

        const handler = new DebugHandler(
            {
                globalState: { get: () => false },
                extensionPath: path.join(__dirname, '..'),
                globalStorageUri: { fsPath: path.join(__dirname, '..', '.tmp') }
            },
            { log: () => { }, getScheduler: () => scheduler }
        );

        handler.serverPort = 0;
        handler.startServer();
        await new Promise((resolve, reject) => {
            handler.server.once('listening', resolve);
            handler.server.once('error', reject);
        });
        const port = handler.server.address().port;

        try {
            const setRes = await new Promise((resolve, reject) => {
                const req = http.request(
                    {
                        hostname: '127.0.0.1',
                        port,
                        path: '/',
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    },
                    (res) => {
                        let buf = '';
                        res.on('data', (d) => { buf += d; });
                        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
                    }
                );
                req.on('error', reject);
                req.end(JSON.stringify({ action: 'setPreferredCDPTarget', requestId: 'rid_set', params: { targetId: 't1' } }));
            });

            assert.strictEqual(setRes.status, 200);
            const setJson = JSON.parse(setRes.body);
            assert.strictEqual(setJson.success, true);
            assert.strictEqual(setJson.requestId, 'rid_set');
            assert.strictEqual(setJson.preferredTargetId, 't1');
            assert.strictEqual(cdpHandler.preferredTargetId, 't1');

            const targetsRes = await new Promise((resolve, reject) => {
                const req = http.request(
                    {
                        hostname: '127.0.0.1',
                        port,
                        path: '/',
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    },
                    (res) => {
                        let buf = '';
                        res.on('data', (d) => { buf += d; });
                        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
                    }
                );
                req.on('error', reject);
                req.end(JSON.stringify({ action: 'getCDPTargets', requestId: 'rid_targets' }));
            });

            assert.strictEqual(targetsRes.status, 200);
            const targetsJson = JSON.parse(targetsRes.body);
            assert.strictEqual(targetsJson.success, true);
            assert.strictEqual(targetsJson.requestId, 'rid_targets');
            assert.strictEqual(targetsJson.count, 1);
            assert(Array.isArray(targetsJson.targets), 'Expected targets to be an array');
            assert.deepStrictEqual(targetsJson.targets[0], {
                id: 't1',
                injected: true,
                pageTitle: 'Page One',
                pageUrl: 'https://example.test/one'
            });
        } finally {
            handler.stopServer();
        }
    });

    await test('removed feature tokens are absent', async () => {
        const repoRoot = path.join(__dirname, '..');
        const includeExts = new Set(['.js', '.md', '.json', '.bat', '.txt', '.ignore']);
        const ignoredDirNames = new Set(['node_modules', 'dist', '.git', 'media']);
        const tokens = [
            'backgroundMode',
            'tabRotation',
            'kingmode',
            'Kingmode',
            'Background Mode',
            'Tab Rotation',
            'background mode',
            'tab rotation',
            'overlay.js',
            '__autoAcceptBgOverlay',
            '__autoAcceptBgStyles',
            'hideBackgroundOverlay',
            'setBackgroundMode',
            'getBackgroundMode',
            'setTabRotation',
            'getTabRotation'
        ];

        function listFiles(dir) {
            const out = [];
            let entries = [];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch (e) {
                return out;
            }

            for (const ent of entries) {
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                    if (ignoredDirNames.has(ent.name)) continue;
                    out.push(...listFiles(full));
                    continue;
                }
                if (!ent.isFile()) continue;
                const ext = path.extname(ent.name);
                if (includeExts.has(ext)) out.push(full);
                else if (ent.name === '.vscodeignore' || ent.name === '.gitignore') out.push(full);
            }
            return out;
        }

        const files = [
            path.join(repoRoot, 'extension.js'),
            path.join(repoRoot, 'settings-panel.js'),
            path.join(repoRoot, 'package.json'),
            path.join(repoRoot, 'README.md'),
            path.join(repoRoot, 'WORKFLOW.md'),
            path.join(repoRoot, 'DEBUG_MANUAL.md'),
            path.join(repoRoot, 'GEMINI.md'),
            ...listFiles(path.join(repoRoot, 'main_scripts')),
            ...listFiles(path.join(repoRoot, 'test_scripts')),
            ...listFiles(path.join(repoRoot, 'docs')),
            ...listFiles(path.join(repoRoot, 'test'))
        ].filter(p => fs.existsSync(p));

        const selfPath = path.join(repoRoot, 'test', 'scheduler.test.js');
        const filteredFiles = files.filter(p => path.resolve(p) !== path.resolve(selfPath));

        const hits = [];
        for (const filePath of filteredFiles) {
            let content = '';
            try {
                content = fs.readFileSync(filePath, 'utf8');
            } catch (e) {
                continue;
            }
            for (const token of tokens) {
                if (content.includes(token)) {
                    hits.push(`${path.relative(repoRoot, filePath)} -> ${token}`);
                }
            }
        }

        assert.strictEqual(hits.length, 0, `Found removed tokens:\n${hits.join('\n')}`);
    });

    // Results
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(e => {
    console.error('Test runner error:', e);
    process.exit(1);
});
