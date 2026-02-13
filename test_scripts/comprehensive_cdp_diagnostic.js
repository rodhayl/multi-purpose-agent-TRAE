/**
 * COMPREHENSIVE CDP DIAGNOSTIC TOOL
 * Purpose: Deep analysis of CDP connections to find the Trae chat panel
 */

const http = require('http');
const WebSocket = require('ws');

async function fetchCDPTargets(port) {
    return new Promise((resolve) => {
        http.get({ hostname: '127.0.0.1', port, path: '/json/list', timeout: 2000 }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    resolve([]);
                }
            });
        }).on('error', () => resolve([])).on('timeout', () => resolve([]));
    });
}

async function evalInTarget(wsUrl, code) {
    return new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => { ws.close(); resolve({ error: 'timeout' }); }, 5000);

        ws.on('open', () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: code, returnByValue: true }
            }));
        });

        ws.on('message', (data) => {
            clearTimeout(timeout);
            const msg = JSON.parse(data.toString());
            if (msg.id === 1) {
                ws.close();
                resolve(msg.result?.result?.value || msg.result);
            }
        });

        ws.on('error', () => { clearTimeout(timeout); resolve({ error: 'connection_failed' }); });
    });
}

async function analyzeTarget(page, index) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`TARGET ${index}: ${page.type.toUpperCase()}`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Title: ${page.title || '(no title)'}`);
    console.log(`URL: ${(page.url || '').substring(0, 80)}`);
    console.log(`WebSocket: ${page.webSocketDebuggerUrl ? 'Available' : 'None'}`);

    if (!page.webSocketDebuggerUrl) {
        console.log(`⚠️  No WebSocket - skipping`);
        return null;
    }

    // Test 1: Document info
    console.log(`\n--- Test 1: Document Info ---`);
    const docInfo = await evalInTarget(page.webSocketDebuggerUrl, `
        JSON.stringify({
            title: document.title,
            url: window.location.href,
            body: document.body ? 'present' : 'missing',
            readyState: document.readyState
        })
    `);
    console.log(docInfo);

    // Test 2: Find contenteditable elements
    console.log(`\n--- Test 2: Contenteditable Elements ---`);
    const editables = await evalInTarget(page.webSocketDebuggerUrl, `
        (function() {
            const all = document.querySelectorAll('[contenteditable="true"]');
            const nonIme = Array.from(all).filter(e => !(e.className || '').includes('ime'));
            return JSON.stringify({
                total: all.length,
                nonIme: nonIme.length,
                details: nonIme.slice(0, 3).map(e => ({
                    tag: e.tagName,
                    className: (e.className || '').substring(0, 50),
                    visible: getComputedStyle(e).display !== 'none',
                    width: e.getBoundingClientRect().width,
                    height: e.getBoundingClientRect().height
                }))
            });
        })()
    `);
    console.log(editables);

    // Test 3: Check for chat-like elements
    console.log(`\n--- Test 3: Chat-like Elements ---`);
    const chatElements = await evalInTarget(page.webSocketDebuggerUrl, `
        JSON.stringify({
            textareas: document.querySelectorAll('textarea').length,
            inputs: document.querySelectorAll('input[type="text"]').length,
            roleTextbox: document.querySelectorAll('[role="textbox"]').length,
            proseMirror: document.querySelectorAll('.ProseMirror').length,
            hasAgentPanel: !!document.querySelector('[class*="agent"]'),
            hasChatPanel: !!document.querySelector('[class*="chat"]'),
            hasTraeAgentPanel: !!document.querySelector('#trae\\\\.agentPanel') || !!document.getElementById('trae.agentPanel')
        })
    `);
    console.log(chatElements);

    // Test 4: Check if __autoAcceptSendPrompt exists
    console.log(`\n--- Test 4: Extension Script Check ---`);
    const scriptCheck = await evalInTarget(page.webSocketDebuggerUrl, `
        JSON.stringify({
            hasFunction: typeof window.__autoAcceptSendPrompt === 'function',
            hasStart: typeof window.__autoAcceptStart === 'function',
            hasGetStats: typeof window.__autoAcceptGetStats === 'function'
        })
    `);
    console.log(scriptCheck);

    // Test 5: Trae smoke checks (panel detection + scoped prompt probing)
    console.log(`\n--- Test 5: Trae Smoke Checks ---`);
    const traeSmoke = await evalInTarget(page.webSocketDebuggerUrl, `
        (function(){
            try {
                const hasTraePanel = !!document.querySelector('#trae\\\\.agentPanel') || !!document.getElementById('trae.agentPanel');
                const hasProbe = typeof window.__autoAcceptProbePrompt === 'function';
                const probe = hasProbe ? window.__autoAcceptProbePrompt() : null;
                return JSON.stringify({ hasTraePanel, hasProbe, probe });
            } catch (e) {
                return JSON.stringify({ error: (e && e.message) ? e.message : String(e) });
            }
        })()
    `);
    console.log(traeSmoke);

    console.log(`\n--- Test 6: Continue Button Diagnostics ---`);
    const continueDiag = await evalInTarget(page.webSocketDebuggerUrl, `
        (function(){
            try {
                const hasDiag = typeof window.__autoAcceptGetContinueDiagnostics === 'function';
                const hasAll = typeof window.__autoAcceptGetContinueCandidatesAll === 'function';
                const diag = hasDiag ? window.__autoAcceptGetContinueDiagnostics() : null;
                const all = hasAll ? window.__autoAcceptGetContinueCandidatesAll() : null;
                const trimmed = all && all.candidates ? { ...all, candidates: all.candidates.slice(0, 20) } : all;
                return JSON.stringify({ hasDiag, hasAll, diag, all: trimmed });
            } catch (e) {
                return JSON.stringify({ error: (e && e.message) ? e.message : String(e) });
            }
        })()
    `);
    console.log(continueDiag);

    // Parse editables to see if this target has the chat input
    try {
        const parsed = typeof editables === 'string' ? JSON.parse(editables) : editables;
        if (parsed && parsed.nonIme > 0) {
            console.log(`\n🎯 POTENTIAL MATCH - Has ${parsed.nonIme} contenteditable element(s)`);
            return { index, page, hasContenteditable: true };
        }
    } catch (e) { }

    return { index, page, hasContenteditable: false };
}

async function main() {
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║        COMPREHENSIVE CDP DIAGNOSTIC - Trae Chat Finder        ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');

    const port = 9005;
    console.log(`Scanning CDP port ${port}...\n`);

    const pages = await fetchCDPTargets(port);
    console.log(`Found ${pages.length} total targets\n`);

    const matches = [];
    for (let i = 0; i < pages.length; i++) {
        const result = await analyzeTarget(pages[i], i);
        if (result && result.hasContenteditable) {
            matches.push(result);
        }
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log(`SUMMARY`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Total targets scanned: ${pages.length}`);
    console.log(`Targets with contenteditable: ${matches.length}`);

    if (matches.length > 0) {
        console.log(`\n✅ FOUND POTENTIAL CHAT INPUT(S):`);
        matches.forEach(m => {
            console.log(`  - Target ${m.index}: ${m.page.title || '(no title)'}`);
        });
    } else {
        console.log(`\n❌ NO CHAT INPUT FOUND`);
        console.log(`\nPossible reasons:`);
        console.log(`  1. Agent chat panel not open/visible`);
        console.log(`  2. Trae not launched with --remote-debugging-port=9005`);
        console.log(`  3. Chat panel uses different rendering (shadow DOM, iframe, etc.)`);
        console.log(`  4. Need to scan different port`);
    }
}

main().catch(console.error);
