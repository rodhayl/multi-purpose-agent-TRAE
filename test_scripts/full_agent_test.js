/**
 * FULL AUTO-ACCEPT AGENT - CONSOLE EDITION
 * Incorporates: utils, auto-accept, and simple-poll (Trae)
 * 
 * Usage:
 * 1. Paste this entire script into the console.
 * 2. Run: startAgent({ ide: 'trae' })
 */
(function () {
    "use strict";

    // --- 0. LOGGER ---
    const log = (msg, isSuccess = false) => {
        const color = isSuccess ? "#00ff00" : "#3b82f6";
        console.log(`%c[AutoAccept-Agent] ${msg}`, `color: ${color}; font-weight: bold;`);
    };

    // --- 1. UTILS ---
    const getDocuments = (root = document) => {
        let docs = [root];
        try {
            const iframes = root.querySelectorAll('iframe, frame');
            for (const iframe of iframes) {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (iframeDoc) docs.push(...getDocuments(iframeDoc));
                } catch (e) { }
            }
        } catch (e) { }
        return docs;
    };

    const queryAll = (selector) => {
        const results = [];
        getDocuments().forEach(doc => {
            try { results.push(...Array.from(doc.querySelectorAll(selector))); } catch (e) { }
        });
        return results;
    };

    const getIDEName = () => {
        const title = document.title.toLowerCase();
        if (title.includes('trae') || !!document.getElementById('trae.agentPanel')) return 'trae';
        return 'trae';
    };

    // --- 2. CORE CLICKING LOGIC ---
    function isElementVisible(el) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0.1 && rect.width > 0 && rect.height > 0;
    }

    function isElementClickable(el) {
        const style = window.getComputedStyle(el);
        return style.pointerEvents !== 'none' && !el.disabled && !el.hasAttribute('disabled');
    }

    function isAcceptButton(el) {
        const ACCEPT_PATTERNS = [
            { pattern: 'accept', exact: false }, { pattern: 'accept all', exact: false }, { pattern: 'acceptalt', exact: false },
            { pattern: 'run command', exact: false }, { pattern: 'run', exact: false }, { pattern: 'run code', exact: false },
            { pattern: 'run cell', exact: false }, { pattern: 'run all', exact: false }, { pattern: 'run selection', exact: false },
            { pattern: 'run and debug', exact: false }, { pattern: 'run test', exact: false }, { pattern: 'apply', exact: true },
            { pattern: 'execute', exact: true }, { pattern: 'resume', exact: true }, { pattern: 'retry', exact: true }, { pattern: 'try again', exact: false }
        ];
        const REJECT_PATTERNS = ['skip', 'reject', 'cancel', 'discard', 'deny', 'close', 'other'];

        if (!el || !el.textContent) return false;
        const text = el.textContent.trim().toLowerCase();
        if (text.length === 0 || text.length > 50) return false;

        const matched = ACCEPT_PATTERNS.some(p => p.exact ? text === p.pattern : text.includes(p.pattern));
        if (!matched || REJECT_PATTERNS.some(p => text.includes(p))) return false;

        return isElementVisible(el) && isElementClickable(el);
    }

    function performClick(targetSelectors, panelSelector = null) {
        if (panelSelector) {
            getDocuments().forEach(doc => {
                const panel = doc.querySelector(panelSelector);
                if (panel) panel.focus();
            });
        }

        const targets = Array.isArray(targetSelectors) ? targetSelectors : [targetSelectors];
        const discovered = [];

        // Special Scan
        if (targets.includes('div.full-input-box')) {
            getDocuments().forEach(doc => {
                const box = doc.querySelector('div.full-input-box');
                if (box) {
                    let sib = box.previousElementSibling;
                    let depth = 0;
                    while (sib && depth < 5) {
                        sib.querySelectorAll('button, [class*="button"], [class*="anysphere"]').forEach(b => discovered.push(b));
                        sib = sib.previousElementSibling;
                        depth++;
                    }
                }
            });
        }

        targets.forEach(s => queryAll(s).forEach(el => discovered.push(el)));

        let count = 0;
        [...new Set(discovered)].forEach(el => {
            if (isAcceptButton(el)) {
                log(`Clicking: "${el.textContent.trim()}"`);
                el.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                count++;
            }
        });
        return count;
    }

    function autoAccept(buttons) {
        let targetSelectors = [];
        let panelSelector = null;

        if (buttons.includes("accept") || buttons.includes("retry")) {
            targetSelectors.push("button");
            panelSelector = "#trae\\.agentPanel";
        }

        return performClick(targetSelectors, panelSelector);
    }

    // --- 3. MAIN AGENT CONTROLLER ---
    window.__autoAcceptState = { isRunning: false, sessionID: 0, currentMode: null };

    window.startAgent = function (config = {}) {
        const ide = config.ide || getIDEName();
        const newMode = 'simple';

        if (window.__autoAcceptState.isRunning) {
            window.stopAgent();
        }

        window.__autoAcceptState.isRunning = true;
        window.__autoAcceptState.sessionID++;
        window.__autoAcceptState.currentMode = newMode;
        const sid = window.__autoAcceptState.sessionID;

        log(`Agent Started (IDE: ${ide}, Mode: ${newMode}, Session: ${sid})`, true);

        const buttons = ['accept', 'retry'];
        const interval = config.pollInterval || 1000;
        (async function simpleLoop() {
            while (window.__autoAcceptState.isRunning && window.__autoAcceptState.sessionID === sid) {
                autoAccept(buttons);
                await new Promise(r => setTimeout(r, interval));
            }
        })();
    };

    window.stopAgent = function () {
        window.__autoAcceptState.isRunning = false;
        log("Agent Stopped.");
    };

    log("Agent Injected. Commands: startAgent(config), stopAgent()", true);
    console.log("Example: %cstartAgent({ ide: 'trae' })", "color: #fbbf24; font-family: monospace;");
})();
