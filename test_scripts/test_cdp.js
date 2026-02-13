const { CDPHandler } = require('../main_scripts/cdp-handler');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const EventEmitter = require('events');
const WebSocket = require('ws');

console.log('--- Testing CDPHandler Script Composition ---');

console.log('--- Initializing handler ---');
const handler = new CDPHandler();
console.log('--- Composing script ---');
const scriptPath = path.join(__dirname, '..', 'main_scripts', 'full_cdp_script.js');
const script = fs.readFileSync(scriptPath, 'utf8');
console.log('--- Script loaded, length:', script.length, '---');

assert(script.includes('window.__autoAcceptState'), 'Script should include state initialization');
assert(script.includes('window.__autoAcceptStart'), 'Script should include start function');
assert(script.includes('window.__autoAcceptStop'), 'Script should include stop function');
assert(script.includes('window.__autoAcceptSendPrompt'), 'Script should include prompt sending');
assert(script.includes('window.__autoAcceptUpdateBannedCommands'), 'Script should include banned command updates');
assert(script.includes('function staticLoop'), 'Script should include loop logic');

assert(!script.includes('import '), 'Script should not have ES module imports');
assert(!script.includes('export '), 'Script should not have ES module exports');

assert(script.includes('Agent Loaded (IDE:') || script.includes('__autoAcceptStart called:'), 'Script should include IDE handling');

function extractByRegex(label, source, re) {
    const m = source.match(re);
    assert(m && m[0], `${label}: missing match`);
    return m[0];
}

const sendStart = script.indexOf('window.__autoAcceptSendPromptToConversation');
assert(sendStart >= 0, 'sendPromptToConversation: missing export');
const sendEnd = script.indexOf('log("Core Bundle Initialized.', sendStart);
assert(sendEnd >= 0, 'sendPromptToConversation: missing end sentinel');
const sendToConversationBlock = script.slice(sendStart, sendEnd);
const hasScanTabs = sendToConversationBlock.includes('scanConversationTabs');
const hasClickLike = sendToConversationBlock.includes('clickLikeUser');
assert(hasClickLike, 'sendPromptToConversation should include clickLikeUser');
assert(hasScanTabs, 'sendPromptToConversation should call scanConversationTabs');

assert(
    script.includes('window.__autoAcceptProbePrompt') && script.includes('!inputBox || !isElementVisible(inputBox)'),
    '__autoAcceptProbePrompt should reject invisible inputs'
);

assert(
    script.includes('return { tabNames, activeTabName, tabs };'),
    'scanConversationTabs should return stable tab objects for targeting'
);

assert(
    script.includes('window.__autoAcceptGetConversationSnapshot();'),
    'staticLoop should refresh conversation snapshot to avoid stale tab names'
);

assert(
    script.includes('Conversation is working; deferring send without editing composer'),
    '__autoAcceptSendPrompt should defer while working without editing composer'
);

console.log('✓ Script composition test passed');

console.log('\n--- Testing CDPHandler Command Sending (Mocked) ---');

class MockWS extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.sent = []; }
    send(str) {
        this.sent.push(JSON.parse(str));
        const msg = JSON.parse(str);
        setImmediate(() => {
            this.emit('message', JSON.stringify({
                id: msg.id,
                result: { result: { value: 2 } }
            }));
        });
    }
}

async function testCommands() {
    const mockWS = new MockWS();
    mockWS.readyState = WebSocket.OPEN;
    handler.connections.set('p1', { ws: mockWS, injected: false });

    const res = await handler.evaluate('1+1');
    assert(res === 2, 'Evaluate should return value');
    assert(mockWS.sent[0].method === 'Runtime.evaluate', 'Method should match');
    assert(mockWS.sent[0].params.expression === '1+1', 'Params should match');

    console.log('✓ Command sending test passed');
}

function classifyContinueDump(payload) {
    const diag = payload && payload.diag ? payload.diag : null;
    const dump = payload && payload.dump ? payload.dump : null;
    const scan = diag && diag.scan ? diag.scan : {};
    const banner = diag && diag.banner ? diag.banner : {};
    const cont = diag && diag.continue ? diag.continue : {};
    const issues = [];

    const scannedElements = Number.isFinite(scan.scannedElements) ? scan.scannedElements : Number(dump && dump.scannedElements ? dump.scannedElements : 0);
    const totalCandidates = Number.isFinite(cont.totalCandidates) ? cont.totalCandidates : Number(dump && dump.totalCandidates ? dump.totalCandidates : 0);
    const shadowScopeCount = Number.isFinite(scan.shadowScopeCount) ? scan.shadowScopeCount : null;

    if (scannedElements > 50 && totalCandidates === 0) issues.push('NO_CONTINUE_CANDIDATES');
    if (shadowScopeCount === 0) issues.push('NO_OPEN_SHADOW_ROOTS');
    if (banner && banner.detected === false && totalCandidates === 0) issues.push('BANNER_NOT_DETECTED_AND_NO_CANDIDATES');
    if (diag && diag.state && diag.state.isRunning === false) issues.push('NOT_RUNNING');

    let rootCause = 'UNKNOWN';
    if (issues.includes('NO_CONTINUE_CANDIDATES') && issues.includes('NO_OPEN_SHADOW_ROOTS')) {
        rootCause = 'CONTINUE_NOT_DOM_DISCOVERABLE_OR_LABEL_MISMATCH';
    } else if (issues.includes('NO_CONTINUE_CANDIDATES')) {
        rootCause = 'CONTINUE_LABEL_OR_SELECTOR_MISMATCH';
    }

    return { issues, rootCause };
}

async function testContinueDumpFixtures() {
    console.log('\n--- Testing Continue Logic Against Dump Fixtures ---');
    const fixturePath = path.join(__dirname, '..', 'test_fixtures', 'continue_dumps_20260124.json');
    const raw = fs.readFileSync(fixturePath, 'utf8');
    const items = JSON.parse(raw);
    assert(Array.isArray(items) && items.length >= 1, 'Fixture file should contain at least one dump');

    for (const item of items) {
        assert(item && item.payload, 'Each fixture item should include payload');
        const payload = item.payload;
        assert(payload.diag && payload.diag.scan, 'Payload should include diag.scan');
        assert(payload.dump, 'Payload should include dump');

        const scanned = payload.dump.scannedElements;
        const total = payload.dump.totalCandidates;

        assert(scanned >= 50, `Expected scannedElements >= 50 for ${item.sourceFile}`);
        assert.strictEqual(total, 0, `Expected totalCandidates=0 for ${item.sourceFile}`);

        const classified = classifyContinueDump(payload);
        assert(classified.issues.includes('NO_CONTINUE_CANDIDATES'), `Expected NO_CONTINUE_CANDIDATES for ${item.sourceFile}`);
        assert(classified.issues.includes('NO_OPEN_SHADOW_ROOTS'), `Expected NO_OPEN_SHADOW_ROOTS for ${item.sourceFile}`);
        assert.strictEqual(classified.rootCause, 'CONTINUE_NOT_DOM_DISCOVERABLE_OR_LABEL_MISMATCH', `Unexpected rootCause for ${item.sourceFile}`);
    }

    console.log('✓ Continue dump fixture tests passed');
}

testCommands()
    .then(() => testContinueDumpFixtures())
    .then(async () => {
        if (process.env.AUTO_ACCEPT_CDP_LIVE !== '1') return;

        const http = require('http');

        function httpGetJson(url) {
            return new Promise((resolve, reject) => {
                http.get(url, (res) => {
                    let buf = '';
                    res.on('data', (d) => { buf += d; });
                    res.on('end', () => {
                        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
                    });
                }).on('error', reject);
            });
        }

        async function wsEval(ws, expression) {
            return new Promise((resolve, reject) => {
                const id = Date.now() + Math.floor(Math.random() * 10000);
                const onMessage = (data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.id !== id) return;
                        ws.off('message', onMessage);
                        resolve(msg);
                    } catch (e) {
                        ws.off('message', onMessage);
                        reject(e);
                    }
                };
                ws.on('message', onMessage);
                ws.send(JSON.stringify({
                    id,
                    method: 'Runtime.evaluate',
                    params: { expression, returnByValue: true, awaitPromise: true }
                }));
            });
        }

        const targets = await httpGetJson('http://127.0.0.1:9005/json/list');
        assert(Array.isArray(targets) && targets.length > 0, 'Expected at least one CDP target');
        const t = targets.find(x => x && x.webSocketDebuggerUrl) || targets[0];
        assert(t && t.webSocketDebuggerUrl, 'Expected a target with webSocketDebuggerUrl');

        await new Promise((resolve, reject) => {
            const ws = new WebSocket(t.webSocketDebuggerUrl);
            ws.on('open', async () => {
                try {
                    await wsEval(ws, 'typeof window.__autoAcceptSendPromptToConversation');
                    await wsEval(ws, 'typeof window.__autoAcceptGetConversationSnapshot');
                    await wsEval(ws, 'JSON.stringify(window.__autoAcceptGetConversationSnapshot ? window.__autoAcceptGetConversationSnapshot() : null)');
                    ws.close();
                    resolve();
                } catch (e) {
                    try { ws.close(); } catch (e2) { }
                    reject(e);
                }
            });
            ws.on('error', reject);
        });

        console.log('✓ Live CDP smoke check passed');
    })
    .catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
