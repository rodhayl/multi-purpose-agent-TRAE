const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_PORT = 9005;

function resolveKnownExtensionIds() {
    const ids = new Set(['rodhayl.multi-purpose-agent-trae']);
    try {
        const pkgPath = path.join(__dirname, '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const publisher = String(pkg?.publisher || '').trim().toLowerCase();
        const name = String(pkg?.name || '').trim().toLowerCase();
        if (publisher && name) {
            ids.add(`${publisher}.${name}`);
        }
    } catch (e) { }
    return Array.from(ids);
}

const KNOWN_EXTENSION_IDS = resolveKnownExtensionIds();

class CDPHandler {
    constructor(logger = console.log) {
        this.logger = logger;
        this.connections = new Map(); // port:pageId -> {ws, injected}
        this.isEnabled = false;
        this.msgId = 1;
        this.lastConfig = null;
        this.lastSuccessfulPromptTargetId = '';
        this.lastPromptTargetIds = [];
        this.preferredTargetId = '';
        this.basePort = BASE_PORT;
    }

    setPortConfig(basePort) {
        const parsedPort = Number(basePort);
        this.basePort = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
            ? parsedPort
            : BASE_PORT;
    }

    log(msg) {
        this.logger(`[CDP] ${msg}`);
    }

    /**
     * Check if the configured CDP port is active
     */
    async isCDPAvailable() {
        try {
            const pages = await this._getPages(this.basePort);
            return pages.length > 0;
        } catch (e) {
            return false;
        }
    }

    /**
     * Start/maintain the CDP connection and injection loop
     */
    async start(config) {
        this.isEnabled = true;
        this.lastConfig = config || null;
        this.workspaceName = config.workspaceName || null; // Store for later use in sendPrompt
        this.setPortConfig(config?.cdpPort);
        this.log(`Scanning port ${this.basePort}...`);
        if (this.workspaceName) {
            this.log(`Current workspace: ${this.workspaceName}`);
        }

        try {
            const pages = await this._getPages(this.basePort);
            for (const page of pages) {
                const id = `${this.basePort}:${page.id}`;
                if (!this.connections.has(id)) {
                    await this._connect(id, page.webSocketDebuggerUrl);
                }
                // Store page info with connection for later workspace matching
                if (this.connections.has(id)) {
                    const c = this.connections.get(id);
                    c.pageTitle = page.title || '';
                    c.pageUrl = page.url || '';
                }
                const conn = this.connections.get(id);
                if (!conn) continue;

                if (!conn.injected) {
                    const shouldInject = await this._probeShouldInject(id, config);
                    if (!shouldInject) continue;
                }

                await this._inject(id, config);
            }
        } catch (e) { }
    }

    async stop() {
        this.isEnabled = false;
        for (const [id, conn] of this.connections) {
            try {
                await this._evaluate(id, 'if(window.__autoAcceptStop) window.__autoAcceptStop()');
                conn.ws.close();
            } catch (e) { }
        }
        this.connections.clear();
    }

    async _getPages(port) {
        return new Promise((resolve, reject) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/list', timeout: 500 }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const pages = JSON.parse(body);
                        // Filter for debuggable pages with WebSocket
                        const filtered = pages.filter(p => {
                            if (!p.webSocketDebuggerUrl) return false;
                            if (p.type !== 'page' && p.type !== 'webview' && p.type !== 'iframe') return false;

                            // Exclude the extension settings webview target(s) without excluding the main workbench page.
                            // NOTE: The main Trae window title can include "Multi Purpose Agent for TRAE Settings" when that tab is focused,
                            // so filtering by title causes us to drop the ONLY usable page target and breaks prompt sending.
                            const url = String(p.url || '').toLowerCase();
                            const title = String(p.title || '').toLowerCase();
                            const hasKnownExtensionId = KNOWN_EXTENSION_IDS.some(extId =>
                                url.includes(`extensionid=${extId}`) || title.includes(`extensionid=${extId}`)
                            );
                            const hasSettingsViewSignature =
                                url.includes('autoacceptsettings');
                            const isOurExtensionWebview =
                                (url.includes('vscode-webview://') && (hasKnownExtensionId || hasSettingsViewSignature)) ||
                                (title.includes('vscode-webview://') && (hasKnownExtensionId || hasSettingsViewSignature));
                            if (isOurExtensionWebview) return false;

                            return true;
                        });
                        resolve(filtered);
                    } catch (e) { resolve([]); }
                });
            });
            req.on('error', () => resolve([]));
            req.on('timeout', () => { req.destroy(); resolve([]); });
        });
    }

    async _connect(id, url) {
        return new Promise((resolve) => {
            const ws = new WebSocket(url);
            ws.on('open', () => {
                this.connections.set(id, { ws, injected: false, skipProbeUntil: 0, lastProbeAt: 0 });
                this.log(`Connected to page ${id}`);
                resolve(true);
            });
            ws.on('error', () => resolve(false));
            ws.on('close', () => {
                this.connections.delete(id);
                this.log(`Disconnected from page ${id}`);
            });
        });
    }

    async _probeShouldInject(id, config) {
        const conn = this.connections.get(id);
        if (!conn) return false;
        const now = Date.now();
        if (conn.skipProbeUntil && now < conn.skipProbeUntil) return false;

        conn.lastProbeAt = now;
        try {
            const ide = 'trae';
            const probeRes = await this._evaluate(id, `(function(){
                function getDocuments(root) {
                    const docs = [];
                    try { docs.push(root); } catch (e) {}
                    try {
                        const iframes = root.querySelectorAll('iframe, frame');
                        for (const iframe of iframes) {
                            try {
                                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                                if (doc) docs.push(...getDocuments(doc));
                            } catch (e) {}
                        }
                    } catch (e) {}
                    return docs;
                }

                function queryAny(sel) {
                    const docs = getDocuments(document);
                    for (const d of docs) {
                        try {
                            const el = d.querySelector(sel);
                            if (el) return el;
                        } catch (e) {}
                    }
                    return null;
                }

                function hasIdSubstring(substr) {
                    const docs = getDocuments(document);
                    for (const d of docs) {
                        let els = [];
                        try { els = Array.from(d.querySelectorAll('[id]')); } catch (e) {}
                        for (const el of els) {
                            const id = String(el.id || '');
                            if (id.toLowerCase().includes(substr)) return true;
                        }
                    }
                    return false;
                }

                const title = String(document.title || '').toLowerCase();
                const hasInput = !!queryAny('textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror');
                const hasAnyAgentPanelId = hasIdSubstring('.agentpanel') || hasIdSubstring('agentpanel');
                const hasTraePanel = !!queryAny('#trae\\\\.agentPanel') || hasIdSubstring('trae.agentpanel');

                return JSON.stringify({
                    title,
                    hasInput,
                    hasAnyAgentPanelId,
                    hasTraePanel
                });
            })()`);

            const parsed = typeof probeRes?.result?.value === 'string'
                ? JSON.parse(probeRes.result.value)
                : null;

            const title = String(parsed?.title || '').toLowerCase();
            const hasInput = !!parsed?.hasInput;
            const hasTraePanel = !!parsed?.hasTraePanel;
            const hasAnyAgentPanelId = !!parsed?.hasAnyAgentPanelId;

            const shouldInject = hasTraePanel || (title.includes(ide) && hasInput) || (hasAnyAgentPanelId && hasInput);

            if (!shouldInject) {
                conn.skipProbeUntil = now + 20000;
            }

            return shouldInject;
        } catch (e) {
            conn.skipProbeUntil = now + 20000;
            return false;
        }
    }

    async _inject(id, config) {
        const conn = this.connections.get(id);
        if (!conn) return;

        try {
            if (!conn.injected) {
                const scriptPath = path.join(__dirname, '..', 'main_scripts', 'full_cdp_script.js');
                const script = fs.readFileSync(scriptPath, 'utf8');
                // Initial injection can take longer due to the size of the script.
                await this._evaluate(id, script, 15000);
                conn.injected = true;
                this.log(`Script injected into ${id}`);
            }

            // CRITICAL: do not start the browser-side loop unless the extension is enabled.
            const enabled = !!(config && config.enabled);
            if (enabled) {
                await this._evaluate(id, `if(window.__autoAcceptStart) window.__autoAcceptStart(${JSON.stringify(config)})`);
            } else {
                await this._evaluate(id, `if(window.__autoAcceptStop) window.__autoAcceptStop()`);
            }
        } catch (e) {
            this.log(`Injection failed for ${id}: ${e.message}`);
        }
    }

    async _ensurePromptInjected(id) {
        const conn = this.connections.get(id);
        if (!conn) return false;

        const hasHelpersExpr = 'Boolean(typeof window !== \"undefined\" && (window.__autoAcceptSendPrompt || window.__autoAcceptSendPromptToConversation))';

        try {
            const res = await this._evaluate(id, hasHelpersExpr, 2500);
            if (res?.result?.value) return true;
        } catch (e) { }

        // Webviews can reload and lose injected globals. Force reinject, then re-check.
        try { conn.injected = false; } catch (e) { }
        try {
            await this._inject(id, this.lastConfig || { enabled: false });
            const res2 = await this._evaluate(id, hasHelpersExpr, 4000);
            return !!res2?.result?.value;
        } catch (e) {
            return false;
        }
    }

    async _evaluate(id, expression, timeoutMs = 2000) {
        const conn = this.connections.get(id);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;

        return new Promise((resolve, reject) => {
            const currentId = this.msgId++;
            const timeout = setTimeout(() => reject(new Error('CDP Timeout')), timeoutMs);

            const onMessage = (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.id === currentId) {
                    conn.ws.off('message', onMessage);
                    clearTimeout(timeout);
                    resolve(msg.result);
                }
            };

            conn.ws.on('message', onMessage);
            conn.ws.send(JSON.stringify({
                id: currentId,
                method: 'Runtime.evaluate',
                params: { expression, userGesture: true, awaitPromise: true }
            }));
        });
    }

    /**
     * Public evaluate method for debug purposes.
     * Evaluates expression on ALL connections and returns the last successful result value.
     */
    async evaluate(expression) {
        let lastResult = null;
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, expression);
                if (res) lastResult = res.result?.value;
            } catch (e) { }
        }
        return lastResult;
    }

    async evaluateAll(expression) {
        const results = [];
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, expression);
                results.push({ id, ok: true, value: res?.result?.value ?? null });
            } catch (e) {
                results.push({ id, ok: false, error: e?.message || String(e) });
            }
        }
        return results;
    }

    async evaluateOn(id, expression, timeoutMs = 2000) {
        try {
            const res = await this._evaluate(id, expression, timeoutMs);
            return { ok: true, value: res?.result?.value ?? null };
        } catch (e) {
            return { ok: false, error: e?.message || String(e) };
        }
    }

    async reinject(options = {}) {
        const config = (options && typeof options === 'object' && options.config && typeof options.config === 'object')
            ? options.config
            : (this.lastConfig || { enabled: false });

        const results = [];
        for (const [id, conn] of this.connections) {
            try {
                if (conn) conn.injected = false;
            } catch (e) { }

            try {
                await this._inject(id, config);
                const hasHelpersExpr = 'Boolean(typeof window !== "undefined" && (window.__autoAcceptSendPrompt || window.__autoAcceptSendPromptToConversation || window.__autoAcceptProbePrompt))';
                const res = await this._evaluate(id, hasHelpersExpr, 5000);
                results.push({ id, ok: true, injected: true, hasHelpers: !!res?.result?.value });
            } catch (e) {
                results.push({ id, ok: false, error: e?.message || String(e) });
            }
        }

        return { ok: true, count: results.length, results };
    }

    async getStats() {
        const stats = { clicks: 0, blocked: 0, fileEdits: 0, terminalCommands: 0, lastActivityTime: 0, lastDomActivityTime: 0 };
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, 'JSON.stringify(window.__autoAcceptGetStats ? window.__autoAcceptGetStats() : {})');
                if (res?.result?.value) {
                    const s = JSON.parse(res.result.value);
                    stats.clicks += s.clicks || 0;
                    stats.blocked += s.blocked || 0;
                    stats.fileEdits += s.fileEdits || 0;
                    stats.terminalCommands += s.terminalCommands || 0;
                    stats.lastActivityTime = Math.max(stats.lastActivityTime, s.lastActivityTime || 0);
                    stats.lastDomActivityTime = Math.max(stats.lastDomActivityTime, s.lastDomActivityTime || 0);
                }
            } catch (e) { }
        }
        return stats;
    }

    async getSessionSummary() { return this.getStats(); } // Compatibility
    async setFocusState(isFocused) {
        for (const [id] of this.connections) {
            try {
                await this._evaluate(id, `if(window.__autoAcceptSetFocusState) window.__autoAcceptSetFocusState(${isFocused})`);
            } catch (e) { }
        }
    }

    async setProStatus(isPro) {
        for (const [id] of this.connections) {
            try {
                await this._evaluate(id, `if(window.__autoAcceptState) window.__autoAcceptState.isPro = ${isPro}`);
            } catch (e) { }
        }
    }

    getConnectionCount() { return this.connections.size; }

    async sendPrompt(text, targetConversation = '', options = {}) {
        if (!text) return 0;

        const connCount = this.connections.size;
        if (connCount === 0) {
            this.log(`ERROR: No CDP connections available! Cannot send prompt.`);
            return 0;
        }

        this.log(`Sending prompt to ${connCount} connection(s)${targetConversation ? ` (target: "${targetConversation}")` : ''}: "${text.substring(0, 50)}..."`);

        // Single send attempt via injected helper; if that fails, do ONE brute-force overwrite+send attempt.
        // The brute-force fallback is constrained to a single target and stops on first success to avoid duplicates.
        try {
            const primary = await this._sendPromptV2(text, targetConversation, options);
            if (primary > 0) return primary;

            try {
                const preferred = Array.isArray(this.lastPromptTargetIds) ? this.lastPromptTargetIds : [];
                const fallback = await this._sendPromptOverwriteFallback(text, targetConversation, {
                    ...options,
                    preferredTargetIds: preferred
                });
                return fallback;
            } catch (e) {
                this.log(`Prompt send fallback failed: ${e?.message || String(e)}`);
                return 0;
            }
        } catch (e) {
            this.log(`Prompt send (v2) failed: ${e?.message || String(e)}`);
            return 0;
        }
    }

    async simulateEnter(options = {}) {
        const connCount = this.connections.size;
        if (connCount === 0) {
            return { success: false, error: 'No CDP connections available' };
        }

        const includeCtrlFallback = options.includeCtrlFallback !== false;
        const ctrlKey = options.ctrlKey === true;
        const evalTimeoutMs = Number.isFinite(options?.evalTimeoutMs) ? options.evalTimeoutMs : 6000;

        const prefer =
            (typeof options.targetId === 'string' && options.targetId.trim() ? options.targetId.trim() : '') ||
            (typeof this.preferredTargetId === 'string' && this.preferredTargetId.trim() ? this.preferredTargetId.trim() : '') ||
            (typeof this.lastSuccessfulPromptTargetId === 'string' && this.lastSuccessfulPromptTargetId.trim() ? this.lastSuccessfulPromptTargetId.trim() : '') ||
            (Array.isArray(this.lastPromptTargetIds) && typeof this.lastPromptTargetIds[0] === 'string' ? this.lastPromptTargetIds[0] : '') ||
            '';

        const targetId = (prefer && this.connections.has(prefer)) ? prefer : (Array.from(this.connections.keys())[0] || '');
        if (!targetId || !this.connections.has(targetId)) {
            return { success: false, error: 'No valid target available for Enter simulation' };
        }

        const code = `(async function(){
            function getAllDocs(root){
                const docs = [];
                const seen = new Set();
                const push = (d) => { try{ if(!d || seen.has(d)) return; seen.add(d); docs.push(d); }catch(e){} };
                push(root || document);
                for (let i = 0; i < docs.length; i++) {
                    const doc = docs[i];
                    try {
                        const frames = doc.querySelectorAll('iframe,frame');
                        for (const iframe of frames) {
                            try {
                                const d = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
                                if (d) push(d);
                            } catch (e) { }
                        }
                    } catch (e) { }
                }
                return docs;
            }
            function getInputValue(el){
                try{
                    if(!el) return '';
                    if(el.tagName==='TEXTAREA'||el.tagName==='INPUT') return el.value||'';
                    return (el.innerText||el.textContent||'').trim();
                }catch(e){ return ''; }
            }
            function isVisible(el){
                try{
                    if(!el) return false;
                    const doc = el.ownerDocument || document;
                    const win = doc.defaultView || window;
                    const s = win.getComputedStyle(el);
                    const r = el.getBoundingClientRect();
                    return s.display!=='none' && s.visibility!=='hidden' && r.width>2 && r.height>2;
                }catch(e){ return false; }
            }
            function dispatchEnter(el, opts){
                try{
                    const doc = el.ownerDocument || document;
                    const win = doc.defaultView || window;
                    el.focus && el.focus();
                    const base={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true};
                    const params = Object.assign(base, opts || {});
                    el.dispatchEvent(new win.KeyboardEvent('keydown', params));
                    el.dispatchEvent(new win.KeyboardEvent('keypress', params));
                    el.dispatchEvent(new win.KeyboardEvent('keyup', params));
                    return true;
                }catch(e){
                    try{
                        const base={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true};
                        const params = Object.assign(base, opts || {});
                        el.dispatchEvent(new KeyboardEvent('keydown', params));
                        el.dispatchEvent(new KeyboardEvent('keypress', params));
                        el.dispatchEvent(new KeyboardEvent('keyup', params));
                        return true;
                    }catch(e2){ return false; }
                }
            }
            function findBestInDoc(doc){
                try{
                    const selector = 'textarea, input[type="text"], [contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror';
                    const els = Array.from(doc.querySelectorAll(selector));
                    let best = null;
                    let bestScore = -1;
                    const win = doc.defaultView || window;
                    for (const el of els) {
                        try {
                            if (!isVisible(el)) continue;
                            const rect = el.getBoundingClientRect();
                            let score = rect.width + rect.height;
                            const hint = ((el.getAttribute && el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute && el.getAttribute('aria-label') || '')).toLowerCase();
                            if (hint.includes('ask') || hint.includes('prompt') || hint.includes('chat') || hint.includes('message')) score += 200;
                            const bottomDist = Math.abs(win.innerHeight - rect.bottom);
                            score += Math.max(0, 400 - bottomDist);
                            if (score > bestScore) { bestScore = score; best = el; }
                        } catch (e) { }
                    }
                    return best;
                } catch (e) {
                    return null;
                }
            }

            try{
                const docs = getAllDocs(document);
                let target = null;

                for(const d of docs){
                    try{
                        const candidates = Array.from(d.querySelectorAll('textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], input[type="text"], .ProseMirror'));
                        for(const el of candidates){
                            try{
                                if(!isVisible(el)) continue;
                                const val = getInputValue(el);
                                if(val && val.length>0){
                                    target = el;
                                    break;
                                }
                            }catch(e){}
                        }
                        if(target) break;
                    }catch(e){}
                }

                if(!target){
                    for(const d of docs){
                        try{
                            const el = findBestInDoc(d);
                            if(el){ target = el; break; }
                        }catch(e){}
                    }
                }

                if(!target) return JSON.stringify({ ok:false, error:'no_candidate' });

                const before = getInputValue(target);
                const didEnter = dispatchEnter(target, ${ctrlKey ? '{ctrlKey:true}' : '{}'});

                await new Promise(r => setTimeout(r, 250));
                const after = getInputValue(target);

                let didCtrlEnter = false;
                if (${includeCtrlFallback ? 'true' : 'false'} && !${ctrlKey ? 'true' : 'false'}) {
                    if (after && after.length > 0) {
                        didCtrlEnter = dispatchEnter(target, { ctrlKey: true });
                        await new Promise(r => setTimeout(r, 250));
                    }
                }

                return JSON.stringify({
                    ok: true,
                    didEnter: !!didEnter,
                    didCtrlEnter: !!didCtrlEnter,
                    beforeLen: (before || '').length,
                    afterLen: (getInputValue(target) || '').length,
                    doc: String((target.ownerDocument && target.ownerDocument.location && target.ownerDocument.location.href) || '')
                });
            }catch(e){
                return JSON.stringify({ ok:false, error: (e && e.message) ? e.message : String(e) });
            }
        })()`;

        try {
            const res = await this._evaluate(targetId, code, evalTimeoutMs);
            const raw = res?.result?.value;
            let parsed = null;
            if (typeof raw === 'string') {
                try { parsed = JSON.parse(raw); } catch (e) { parsed = { ok: false, error: raw }; }
            } else {
                parsed = raw;
            }

            if (parsed && parsed.ok === true) {
                return { success: true, targetId, result: parsed };
            }
            return {
                success: false,
                targetId,
                error: (parsed && parsed.error) ? String(parsed.error) : 'Enter simulation failed',
                result: parsed
            };
        } catch (e) {
            return { success: false, targetId, error: e?.message || String(e) };
        }
    }

    async _sendPromptV2(text, targetConversation = '', options = {}) {
        if (!text) return 0;

        const connCount = this.connections.size;
        if (connCount === 0) return 0;

        const evalTimeoutMs = Number.isFinite(options?.evalTimeoutMs) ? options.evalTimeoutMs : 12000;

        // Probe each connection for the best prompt input target
        const connectionResults = [];
        for (const [id] of this.connections) {
            try {
                const probeRes = await this._evaluate(id, `(function(){
                    try {
                        if (typeof window !== "undefined" && window.__autoAcceptProbePrompt) {
                            return JSON.stringify(window.__autoAcceptProbePrompt());
                        }
                        // Fallback: basic scan (textarea or contenteditable)
                        const editables = document.querySelectorAll('[contenteditable]:not([contenteditable="false"])');
                        const textareas = document.querySelectorAll('textarea');
                        const any = (editables && editables.length > 0) || (textareas && textareas.length > 0);
                        return JSON.stringify({ hasInput: !!any, score: any ? 1 : 0 });
                    } catch (e) {
                        return JSON.stringify({ hasInput: false, score: 0, error: (e && e.message) ? e.message : String(e) });
                    }
                })()`);

                const parsed = typeof probeRes?.result?.value === 'string'
                    ? JSON.parse(probeRes.result.value)
                    : { hasInput: false, score: 0 };

                connectionResults.push({
                    id,
                    hasInput: !!parsed.hasInput,
                    score: typeof parsed.score === 'number' ? parsed.score : 0,
                    details: parsed
                });
            } catch (e) {
                connectionResults.push({ id, hasInput: false, score: 0, error: e.message });
            }
        }

        const scoredTargets = connectionResults.map(r => {
            const conn = this.connections.get(r.id);
            const title = (conn?.pageTitle || '').toLowerCase();
            const ws = this.workspaceName ? this.workspaceName.toLowerCase() : '';
            const workspaceMatch = ws ? (title.includes(ws) ? 1 : 0) : 0;
            const hasAgentPanel = r.details && r.details.hasAgentPanel ? 1 : 0;
            const hasInput = r.hasInput ? 1 : 0;
            return { ...r, workspaceMatch, hasAgentPanel, hasInput };
        });

        scoredTargets.sort((a, b) => {
            if (a.workspaceMatch !== b.workspaceMatch) return b.workspaceMatch - a.workspaceMatch;
            if (a.hasAgentPanel !== b.hasAgentPanel) return b.hasAgentPanel - a.hasAgentPanel;
            if (a.hasInput !== b.hasInput) return b.hasInput - a.hasInput;
            return (b.score || 0) - (a.score || 0);
        });

        // Sticky target: if we recently succeeded on a target, try it first.
        if (this.lastSuccessfulPromptTargetId) {
            const idx = scoredTargets.findIndex(t => t.id === this.lastSuccessfulPromptTargetId);
            if (idx > 0) {
                const [t] = scoredTargets.splice(idx, 1);
                scoredTargets.unshift(t);
            }
        }

        const preferredId = (typeof this.preferredTargetId === 'string' && this.preferredTargetId.trim())
            ? this.preferredTargetId.trim()
            : '';
        if (preferredId) {
            const preferredIdx = scoredTargets.findIndex(t => t.id === preferredId);
            if (preferredIdx > -1) {
                const preferred = scoredTargets[preferredIdx];
                if (preferred && preferred.hasInput) {
                    scoredTargets.splice(preferredIdx, 1);
                    scoredTargets.unshift(preferred);
                }
            }
        }

        this.lastPromptTargetIds = scoredTargets.map(t => t.id);

        // Simplified: try ONLY the best-scored target once.
        // This avoids multi-target fan-out which can duplicate prompts if the first target actually sends
        // but returns a falsy status due to UI/verification quirks.
        const target = scoredTargets[0];
        if (!target) return 0;

        this.log(`Prompt send (v2): Trying ${target.id} (score: ${target.score || 0})`);
        try {
            const injectedOk = await this._ensurePromptInjected(target.id);
            if (!injectedOk) {
                this.log(`Prompt send (v2): Missing injected prompt helpers on ${target.id}`);
                return 0;
            }

            const result = await this._evaluate(target.id, `(async function(){
                const out = { ok: false, method: null, error: null };
                try {
                    if(typeof window !== "undefined" && window.__autoAcceptSendPromptToConversation) {
                        const ok = await window.__autoAcceptSendPromptToConversation(${JSON.stringify(text)}, ${JSON.stringify(targetConversation)});
                        out.ok = !!ok;
                        out.method = 'sendPromptToConversation';
                        if(!out.ok) out.error = 'sendPromptToConversation returned falsy';
                        return JSON.stringify(out);
                    }
                    if(typeof window !== "undefined" && window.__autoAcceptSendPrompt) {
                        const ok = await window.__autoAcceptSendPrompt(${JSON.stringify(text)});
                        out.ok = !!ok;
                        out.method = 'sendPrompt';
                        if(!out.ok) out.error = 'sendPrompt returned falsy';
                        return JSON.stringify(out);
                    }
                    out.error = 'no injected send function found';
                    return JSON.stringify(out);
                } catch (e) {
                    out.error = (e && e.message) ? e.message : String(e);
                    return JSON.stringify(out);
                }
            })()`, evalTimeoutMs);

            const raw = result?.result?.value;
            let parsed = null;
            if (typeof raw === 'string') {
                try { parsed = JSON.parse(raw); } catch (e) { }
            }

            if (parsed?.ok) {
                this.log(`Prompt send (v2): Sent via ${parsed.method} on ${target.id}`);
                this.lastSuccessfulPromptTargetId = target.id;
                return 1;
            }

            if (parsed) {
                this.log(`Prompt send (v2): NOT sent on ${target.id} via ${parsed.method || 'unknown'}: ${parsed.error || 'unknown error'}`);
                return 0;
            }
            this.log(`Prompt send (v2): Not sent on ${target.id}: ${raw || 'unknown error'}`);
            return 0;
        } catch (e) {
            this.log(`Prompt send (v2): Failed on ${target.id}: ${e.message}`);
            return 0;
        }
    }

    /**
     * Overwrite+Send fallback used when the probe-based prompt send finds no inputs.
     * Attempts to set the composer text directly in each connection and dispatch Enter.
     */
    async _sendPromptOverwriteFallback(text, targetConversation = '', options = {}) {
        if (!text) return 0;
        const connCount = this.connections.size;
        if (connCount === 0) return 0;

        this.log('Attempting overwrite+send fallback to set composer and trigger send');

        const preferred = Array.isArray(options?.preferredTargetIds) ? options.preferredTargetIds.filter(Boolean) : [];
        const idsToTry = preferred.length ? preferred : Array.from(this.connections.keys());

        // IMPORTANT: stop on first success.
        // Sending on every connected CDP target can result in duplicated prompts when multiple
        // targets point at the same visible chat UI.
        for (const id of idsToTry) {
            if (!this.connections.has(id)) continue;
            try {
                const code = `(async function(){
                    function getAllDocs(root){
                        const docs = [];
                        const seen = new Set();
                        const push = (d) => { try{ if(!d || seen.has(d)) return; seen.add(d); docs.push(d); }catch(e){} };
                        push(root || document);
                        for (let i = 0; i < docs.length; i++) {
                            const doc = docs[i];
                            try {
                                const frames = doc.querySelectorAll('iframe,frame');
                                for (const iframe of frames) {
                                    try {
                                        const d = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
                                        if (d) push(d);
                                    } catch (e) { }
                                }
                            } catch (e) { }
                        }
                        return docs;
                    }
                    function getInputValue(el){ try{ if(!el) return ''; if(el.tagName==='TEXTAREA'||el.tagName==='INPUT') return el.value||''; return (el.innerText||el.textContent||'').trim(); }catch(e){return '';}}
                    function isVisible(el){ try{ if(!el) return false; const s=window.getComputedStyle(el); const r=el.getBoundingClientRect(); return s.display!=='none' && r.width>2 && s.visibility!=='hidden'; }catch(e){return false;}}
                    function setInput(el, txt){ try{ if(!el) return false; const doc = el.ownerDocument || document; if(el.tagName==='TEXTAREA'||el.tagName==='INPUT'){ const proto = el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype; const nativeSetter = Object.getOwnPropertyDescriptor(proto,'value')?.set; if(nativeSetter) nativeSetter.call(el, txt); else el.value = txt; el.dispatchEvent(new Event('input',{bubbles:true})); return true;} const ce = String(el.getAttribute && el.getAttribute('contenteditable') || '').toLowerCase(); if(el.isContentEditable || el.contentEditable==='true' || (ce && ce !== 'false') || el.getAttribute('role')==='textbox'){ try{ el.focus && el.focus(); }catch(e){} try{ if(doc.execCommand){ try{ doc.execCommand('selectAll', false, null); }catch(e){} try{ doc.execCommand('insertText', false, txt); }catch(e){} } }catch(e){} try{ el.dispatchEvent(new Event('input',{bubbles:true})); }catch(e){} return true;} try{ el.innerText = txt; el.dispatchEvent(new Event('input',{bubbles:true})); return true;}catch(e){return false;} }catch(e){return false;}}
                    function dispatchEnter(el, opts){ try{ el.focus(); const base={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}; const ev = new KeyboardEvent('keydown',Object.assign(base,opts||{})); el.dispatchEvent(ev); el.dispatchEvent(new KeyboardEvent('keypress',Object.assign(base,opts||{}))); el.dispatchEvent(new KeyboardEvent('keyup',Object.assign(base,opts||{}))); return true;}catch(e){return false;}}
                    function clickSendNear(el){
                        try{
                            const doc = el.ownerDocument || document;
                            const root = el.closest ? (el.closest('form') || el.parentElement || doc) : doc;
                            const sels = [
                                'button[type=\"submit\"]',
                                'button[aria-label*=\"Send\" i]',
                                'button[title*=\"Send\" i]',
                                'button[data-testid*=\"send\" i]',
                                'button[data-testid*=\"submit\" i]',
                                '[role=\"button\"][aria-label*=\"Send\" i]',
                                '[role=\"button\"][title*=\"Send\" i]'
                            ];
                            for(const s of sels){
                                const b = root.querySelector ? root.querySelector(s) : null;
                                if(b){ try{ b.click(); return true; }catch(e){} }
                            }
                        }catch(e){}
                        return false;
                    }
                    function findBestInDoc(doc){ const sel = 'textarea, input[type=\"text\"], [contenteditable]:not([contenteditable=\"false\"]), [role=\"textbox\"], .ProseMirror'; const els = Array.from(doc.querySelectorAll(sel)); let best=null; let bestScore=-1; for(const el of els){ try{ if(!isVisible(el)) continue; const rect = el.getBoundingClientRect(); let score = rect.width + rect.height; const hint = ((el.getAttribute('placeholder')||'') + ' ' + (el.getAttribute('aria-label')||'')).toLowerCase(); if(hint.includes('ask')||hint.includes('prompt')||hint.includes('chat')||hint.includes('message')) score += 200; if(score>bestScore){ bestScore=score; best=el;} }catch(e){} } return best; }

                    try{
                        const docs = getAllDocs(document);
                        // Prefer an input already containing text
                        for(const d of docs){
                            try{
                                const candidates = Array.from(d.querySelectorAll('textarea, [contenteditable]:not([contenteditable=\"false\"]), [role=\"textbox\"], input[type=\"text\"], .ProseMirror'));
                                for(const el of candidates){
                                    try{
                                        if(!isVisible(el)) continue;
                                        const val = getInputValue(el);
                                        if(val && val.length>0){
                                            setInput(el, ${JSON.stringify(text)});
                                            if(!clickSendNear(el)) dispatchEnter(el);
                                            // If Enter inserts newline, try Ctrl+Enter
                                            try{ if(getInputValue(el)) dispatchEnter(el,{ctrlKey:true}); }catch(e){}
                                            return {ok:true, reason:'overwrite_existing', doc: String(d.location && d.location.href || '')};
                                        }
                                    }catch(e){}
                                }
                            }catch(e){}
                        }

                        // Otherwise pick best in any accessible doc
                        let best = null;
                        for(const d of docs){
                            try{
                                const el = findBestInDoc(d);
                                if(el){ best = el; break; }
                            }catch(e){}
                        }
                        if(best){
                            setInput(best, ${JSON.stringify(text)});
                            if(!clickSendNear(best)) dispatchEnter(best);
                            try{ if(getInputValue(best)) dispatchEnter(best,{ctrlKey:true}); }catch(e){}
                            return {ok:true, reason:'best_candidate'};
                        }
                        return {ok:false, error:'no_candidate'};
                    } catch(e){ return {ok:false, error: e && e.message ? e.message : String(e)}; }
                })()`;

                const fallbackTimeoutMs = Number.isFinite(options?.fallbackTimeoutMs)
                    ? options.fallbackTimeoutMs
                    : (Number.isFinite(options?.evalTimeoutMs) ? Math.min(12000, options.evalTimeoutMs) : 8000);
                const result = await this._evaluate(id, code, fallbackTimeoutMs);
                const raw = result?.result?.value;
                let parsed = null;
                if (typeof raw === 'string') {
                    try { parsed = JSON.parse(raw); } catch (e) { parsed = raw; }
                } else parsed = raw;

                if (parsed && (parsed.ok === true || parsed === true)) {
                    this.log(`Fallback: Prompt overwritten and send triggered on ${id}`);
                    this.lastSuccessfulPromptTargetId = id;
                    return 1;
                } else {
                    this.log(`Fallback: Not sent on ${id}: ${JSON.stringify(parsed)}`);
                }
            } catch (e) {
                this.log(`Fallback failed for ${id}: ${e.message}`);
            }
        }

        this.log(`Fallback send complete: 0/${idsToTry.length} successful`);
        return 0;
    }

    async getAwayActions() {
        let total = 0;
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, `(function(){ 
                    if(typeof window !== "undefined" && window.__autoAcceptGetAwayActions) {
                        return window.__autoAcceptGetAwayActions();
                    }
                    return 0; 
                })()`);

                if (res && res.result && res.result.value !== undefined) {
                    total += parseInt(res.result.value) || 0;
                }
            } catch (e) { }
        }
        return total;
    }

    async resetStats() {
        const aggregatedStats = { clicks: 0, blocked: 0 };
        for (const [id] of this.connections) {
            try {
                const jsonRes = await this._evaluate(id, `(function(){ 
                    if(typeof window !== "undefined" && window.__autoAcceptResetStats) {
                        return JSON.stringify(window.__autoAcceptResetStats());
                    }
                    return JSON.stringify({ clicks: 0, blocked: 0 });
                })()`);

                if (jsonRes && jsonRes.result && jsonRes.result.value) {
                    const s = JSON.parse(jsonRes.result.value);
                    aggregatedStats.clicks += s.clicks || 0;
                    aggregatedStats.blocked += s.blocked || 0;
                }
            } catch (e) {
                this.log(`Failed to reset stats for ${id}: ${e.message}`);
            }
        }
        return aggregatedStats;
    }
    async getConversations() {
        return await this._getConversationsRobust();
    }

    async getCompletionStatus() {
        const statuses = {};
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, `JSON.stringify((function(){
                    try {
                        if (typeof window !== "undefined" && typeof window.__autoAcceptGetConversationSnapshot === "function") {
                            const snap = window.__autoAcceptGetConversationSnapshot();
                            return (snap && snap.completionStatus) ? snap.completionStatus : {};
                        }
                        return window.__autoAcceptState ? (window.__autoAcceptState.completionStatus || {}) : {};
                    } catch (e) {
                        return {};
                    }
                })())`);
                if (res?.result?.value) {
                    const statusObj = JSON.parse(res.result.value);
                    Object.assign(statuses, statusObj);
                }
            } catch (e) { }
        }
        return statuses;
    }

    async getActiveConversation() {
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, `(function(){
                    try {
                        if (typeof window !== "undefined" && typeof window.__autoAcceptGetConversationSnapshot === "function") {
                            const snap = window.__autoAcceptGetConversationSnapshot();
                            const name = snap && snap.activeTabName ? String(snap.activeTabName).trim() : '';
                            return name || 'current';
                        }
                        if (typeof window !== "undefined" && window.__autoAcceptGetActiveTabName) {
                            return window.__autoAcceptGetActiveTabName() || '';
                        }
                        return 'current';
                    } catch (e) {
                        return 'current';
                    }
                })()`);
                const val = res?.result?.value;
                if (typeof val === 'string' && val.trim()) {
                    return val.trim();
                }
            } catch (e) { }
        }
        return '';
    }

    async _getConversationsRobust() {
        const allTabs = new Set();
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, `JSON.stringify((function(){
                    try {
                        if (typeof window !== "undefined" && typeof window.__autoAcceptGetConversationSnapshot === "function") {
                            const snap = window.__autoAcceptGetConversationSnapshot();
                            return (snap && Array.isArray(snap.tabNames)) ? snap.tabNames : [];
                        }
                        return window.__autoAcceptState ? (window.__autoAcceptState.tabNames || []) : [];
                    } catch (e) {
                        return [];
                    }
                })())`);
                if (res?.result?.value) {
                    const tabs = JSON.parse(res.result.value);
                    if (Array.isArray(tabs)) {
                        tabs.forEach(t => allTabs.add(t));
                    }
                }
            } catch (e) { }
        }
        return Array.from(allTabs);
    }
}

module.exports = { CDPHandler };
