/**
 * FULL CDP CORE BUNDLE
 * Monolithic script for browser-side injection.
 * Combines utils, auto-accept, analytics, and lifecycle management.
 */
(function () {
    "use strict";

    // Guard: Bail out immediately if not in a browser context (e.g., service worker)
    if (typeof window === 'undefined') return;

    // ============================================================
    // ANALYTICS MODULE (Embedded)
    // Clean, modular analytics with separated concerns.
    // See: main_scripts/analytics/ for standalone module files
    // ============================================================
    const Analytics = (function () {
        // --- Constants ---
        const TERMINAL_KEYWORDS = ['run', 'execute', 'command', 'terminal'];
        const SECONDS_PER_CLICK = 5;
        const TIME_VARIANCE = 0.2;

        const ActionType = {
            FILE_EDIT: 'file_edit',
            TERMINAL_COMMAND: 'terminal_command'
        };

        // --- State Management ---
        function createDefaultStats() {
            return {
                clicksThisSession: 0,
                blockedThisSession: 0,
                sessionStartTime: null,
                fileEditsThisSession: 0,
                terminalCommandsThisSession: 0,
                continueClicksAttemptedThisSession: 0,
                continueClicksVerifiedThisSession: 0,
                lastContinueClickAt: 0,
                lastContinueClickVerifiedAt: 0,
                lastContinueClickResult: '',
                lastContinueButtonText: '',
                actionsWhileAway: 0,
                isWindowFocused: true,
                lastConversationUrl: null,
                lastConversationStats: null,
                lastActivityTime: Date.now(),
                lastDomActivityTime: 0
            };
        }

        function getStats() {
            return window.__autoAcceptState?.stats || createDefaultStats();
        }

        function getStatsMutable() {
            return window.__autoAcceptState.stats;
        }

        // --- Click Tracking ---
        function categorizeClick(buttonText) {
            const text = (buttonText || '').toLowerCase();
            for (const keyword of TERMINAL_KEYWORDS) {
                if (text.includes(keyword)) return ActionType.TERMINAL_COMMAND;
            }
            return ActionType.FILE_EDIT;
        }

        function trackClick(buttonText, log) {
            const stats = getStatsMutable();
            stats.clicksThisSession++;
            stats.lastActivityTime = Date.now();
            log(`[Stats] Click tracked. Total: ${stats.clicksThisSession}`);

            const category = categorizeClick(buttonText);
            if (category === ActionType.TERMINAL_COMMAND) {
                stats.terminalCommandsThisSession++;
                log(`[Stats] Terminal command. Total: ${stats.terminalCommandsThisSession}`);
            } else {
                stats.fileEditsThisSession++;
                log(`[Stats] File edit. Total: ${stats.fileEditsThisSession}`);
            }

            let isAway = false;
            if (!stats.isWindowFocused) {
                stats.actionsWhileAway++;
                isAway = true;
                log(`[Stats] Away action. Total away: ${stats.actionsWhileAway}`);
            }

            return { category, isAway, totalClicks: stats.clicksThisSession };
        }

        function trackBlocked(log) {
            const stats = getStatsMutable();
            stats.blockedThisSession++;
            stats.lastActivityTime = Date.now();
            log(`[Stats] Blocked. Total: ${stats.blockedThisSession}`);
        }

        // --- ROI Reporting ---
        function collectROI(log) {
            const stats = getStatsMutable();
            const collected = {
                clicks: stats.clicksThisSession || 0,
                blocked: stats.blockedThisSession || 0,
                sessionStart: stats.sessionStartTime
            };
            log(`[ROI] Collected: ${collected.clicks} clicks, ${collected.blocked} blocked`);
            stats.clicksThisSession = 0;
            stats.blockedThisSession = 0;
            stats.sessionStartTime = Date.now();
            return collected;
        }

        // --- Session Summary ---
        function getSessionSummary() {
            const stats = getStats();
            const clicks = stats.clicksThisSession || 0;
            const baseSecs = clicks * SECONDS_PER_CLICK;
            const minMins = Math.max(1, Math.floor((baseSecs * (1 - TIME_VARIANCE)) / 60));
            const maxMins = Math.ceil((baseSecs * (1 + TIME_VARIANCE)) / 60);

            return {
                clicks,
                fileEdits: stats.fileEditsThisSession || 0,
                terminalCommands: stats.terminalCommandsThisSession || 0,
                blocked: stats.blockedThisSession || 0,
                estimatedTimeSaved: clicks > 0 ? `${minMins}–${maxMins} minutes` : null
            };
        }

        // --- Away Actions ---
        function consumeAwayActions(log) {
            const stats = getStatsMutable();
            const count = stats.actionsWhileAway || 0;
            log(`[Away] Consuming away actions: ${count}`);
            stats.actionsWhileAway = 0;
            return count;
        }

        function isUserAway() {
            return !getStats().isWindowFocused;
        }

        // --- Focus Management ---
        // NOTE: Browser-side focus events are UNRELIABLE in webview contexts.
        // The Trae extension pushes the authoritative focus state via __autoAcceptSetFocusState.
        // We only keep a minimal initializer here that defaults to focused=true.

        function initializeFocusState(log) {
            const state = window.__autoAcceptState;
            if (state && state.stats) {
                // Default to focused (assume user is present) - extension will correct this
                state.stats.isWindowFocused = true;
                log('[Focus] Initialized (awaiting extension sync)');
            }
        }

        // --- Initialization ---
        function initialize(log) {
            if (!window.__autoAcceptState) {
                window.__autoAcceptState = {
                    isRunning: false,
                    tabNames: [],
                    activeTabName: '',
                    completionStatus: {},
                    sessionID: 0,
                    currentMode: null,
                    bannedCommands: [],
                    isPro: true, // Pro features always enabled
                    stats: createDefaultStats()
                };
                log('[Analytics] State initialized');
            } else if (!window.__autoAcceptState.stats) {
                window.__autoAcceptState.stats = createDefaultStats();
                log('[Analytics] Stats added to existing state');
            } else {
                if (!window.__autoAcceptState.completionStatus) window.__autoAcceptState.completionStatus = {};
                const s = window.__autoAcceptState.stats;
                if (s.actionsWhileAway === undefined) s.actionsWhileAway = 0;
                if (s.isWindowFocused === undefined) s.isWindowFocused = true;
                if (s.fileEditsThisSession === undefined) s.fileEditsThisSession = 0;
                if (s.terminalCommandsThisSession === undefined) s.terminalCommandsThisSession = 0;
                if (s.continueClicksAttemptedThisSession === undefined) s.continueClicksAttemptedThisSession = 0;
                if (s.continueClicksVerifiedThisSession === undefined) s.continueClicksVerifiedThisSession = 0;
                if (s.lastContinueClickAt === undefined) s.lastContinueClickAt = 0;
                if (s.lastContinueClickVerifiedAt === undefined) s.lastContinueClickVerifiedAt = 0;
                if (s.lastContinueClickResult === undefined) s.lastContinueClickResult = '';
                if (s.lastContinueButtonText === undefined) s.lastContinueButtonText = '';
            }

            initializeFocusState(log);

            if (!window.__autoAcceptState.stats.sessionStartTime) {
                window.__autoAcceptState.stats.sessionStartTime = Date.now();
            }

            log('[Analytics] Initialized');
        }

        // Set focus state (called from extension via CDP)
        function setFocusState(isFocused, log) {
            const state = window.__autoAcceptState;
            if (!state || !state.stats) return;

            const wasAway = !state.stats.isWindowFocused;
            state.stats.isWindowFocused = isFocused;
            state.stats.lastActivityTime = Date.now();

            if (log) {
                log(`[Focus] Extension sync: focused=${isFocused}, wasAway=${wasAway}`);
            }
        }

        // Public API
        return {
            initialize,
            trackClick,
            trackBlocked,
            categorizeClick,
            ActionType,
            collectROI,
            getSessionSummary,
            consumeAwayActions,
            isUserAway,
            getStats,
            setFocusState,
            markActivity: (t = Date.now()) => {
                const stats = getStatsMutable();
                if (!stats) return;
                stats.lastActivityTime = typeof t === 'number' ? t : Date.now();
            },
            markDomActivity: (t = Date.now()) => {
                const stats = getStatsMutable();
                if (!stats) return;
                const ts = typeof t === 'number' ? t : Date.now();
                stats.lastDomActivityTime = ts;
                stats.lastActivityTime = ts;
            }
        };
    })();

    // --- LOGGING ---
    const log = (msg, isSuccess = false) => {
        // Simple log for CDP interception
        console.log(`[AutoAccept] ${msg}`);
    };

    // Initialize Analytics
    Analytics.initialize(log);

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

    const queryAllScoped = (rootEl, selector) => {
        try {
            if (!rootEl || rootEl === document) return queryAll(selector);
            const results = [];
            try { results.push(...Array.from(rootEl.querySelectorAll(selector))); } catch (e) { }
            try {
                const frames = rootEl.querySelectorAll('iframe, frame');
                for (const iframe of frames) {
                    try {
                        const doc = iframe.contentDocument || iframe.contentWindow?.document;
                        if (doc) {
                            try { results.push(...Array.from(doc.querySelectorAll(selector))); } catch (e) { }
                        }
                    } catch (e) { }
                }
            } catch (e) { }
            return results;
        } catch (e) {
            return queryAll(selector);
        }
    };

    const getDeepQueryScopes = (rootNode) => {
        const scopes = [];
        const seen = new Set();
        const queue = [];
        const showElements = (typeof NodeFilter !== 'undefined' && NodeFilter.SHOW_ELEMENT) ? NodeFilter.SHOW_ELEMENT : 1;

        const push = (n) => {
            try {
                if (!n || seen.has(n)) return;
                seen.add(n);
                queue.push(n);
                if (typeof n.querySelectorAll === 'function') scopes.push(n);
            } catch (e) { }
        };

        push(rootNode || document);

        while (queue.length) {
            const cur = queue.shift();
            let base = null;
            try {
                base = cur && cur.nodeType === 9 ? cur.documentElement : cur;
            } catch (e) {
                base = null;
            }
            if (!base) continue;

            const doc = base.ownerDocument || (cur && cur.nodeType === 9 ? cur : document);
            if (!doc || typeof doc.createTreeWalker !== 'function') continue;

            let walker = null;
            try {
                walker = doc.createTreeWalker(base, showElements);
            } catch (e) {
                walker = null;
            }
            if (!walker) continue;

            let el = walker.currentNode;
            while (el) {
                try {
                    const sr = el.shadowRoot;
                    if (sr) push(sr);
                } catch (e) { }

                const tag = String(el.tagName || '').toLowerCase();
                if (tag === 'iframe' || tag === 'frame') {
                    try {
                        const iframeDoc = el.contentDocument || el.contentWindow?.document;
                        if (iframeDoc) push(iframeDoc);
                    } catch (e) { }
                }

                try {
                    el = walker.nextNode();
                } catch (e) {
                    break;
                }
            }
        }

        return scopes;
    };

    const queryAllDeep = (rootNode, selector) => {
        const results = [];
        const scopes = getDeepQueryScopes(rootNode || document);
        for (const scope of scopes) {
            try { results.push(...Array.from(scope.querySelectorAll(selector))); } catch (e) { }
        }
        return results;
    };

    const getElementLabel = (el) => {
        try {
            if (!el) return '';
            const parts = [];
            const push = (v) => {
                const s = String(v || '').replace(/\s+/g, ' ').trim();
                if (s) parts.push(s);
            };

            push(el.textContent || '');

            const attr = (name) => {
                try { return el.getAttribute ? el.getAttribute(name) : ''; } catch (e) { return ''; }
            };

            push(attr('aria-label'));
            push(attr('title'));
            push(attr('data-tooltip'));
            push(attr('data-tooltip-content'));
            push(attr('data-tooltip-text'));

            const labelledBy = attr('aria-labelledby');
            if (labelledBy) {
                const doc = el.ownerDocument || document;
                for (const id of String(labelledBy).split(/\s+/g).filter(Boolean)) {
                    try {
                        const ref = doc.getElementById(id);
                        if (ref) push(ref.textContent || '');
                    } catch (e) { }
                }
            }

            if (parts.length === 0 && typeof el.querySelector === 'function') {
                try {
                    const child = el.querySelector('[aria-label],[title],[data-tooltip],[data-tooltip-content],[data-tooltip-text]');
                    if (child) {
                        try { push(child.textContent || ''); } catch (e) { }
                        try { push(child.getAttribute('aria-label') || ''); } catch (e) { }
                        try { push(child.getAttribute('title') || ''); } catch (e) { }
                        try { push(child.getAttribute('data-tooltip') || ''); } catch (e) { }
                        try { push(child.getAttribute('data-tooltip-content') || ''); } catch (e) { }
                        try { push(child.getAttribute('data-tooltip-text') || ''); } catch (e) { }
                    }
                } catch (e) { }
            }

            return parts.join(' ').replace(/\s+/g, ' ').trim();
        } catch (e) {
            return '';
        }
    };

    const getContinueText = (el) => {
        try {
            if (!el) return '';
            const parts = [];
            const push = (v) => {
                const s = String(v || '').replace(/\s+/g, ' ').trim();
                if (s) parts.push(s);
            };

            push(getElementLabel(el));

            const attr = (name) => {
                try { return el.getAttribute ? el.getAttribute(name) : ''; } catch (e) { return ''; }
            };

            push(attr('aria-description'));
            push(attr('aria-roledescription'));
            push(attr('data-testid'));
            push(attr('data-test'));
            push(attr('data-qa'));
            push(attr('data-action'));
            push(attr('name'));
            push(attr('value'));

            try { push(String(el.id || '').trim()); } catch (e) { }
            try {
                const cls = String(el.className || '').trim();
                if (cls) {
                    const tokens = cls.split(/\s+/g).filter(Boolean).slice(0, 6);
                    if (tokens.length) push(tokens.join(' '));
                }
            } catch (e) { }

            return parts.join(' ').replace(/\s+/g, ' ').trim();
        } catch (e) {
            return '';
        }
    };

    const matchesContinueLike = (text) => {
        try {
            const lower = String(text || '').toLowerCase();
            if (!lower.includes('continue')) return false;
            if (lower.includes('discontinue')) return false;
            return true;
        } catch (e) {
            return false;
        }
    };

    const CONTINUE_CANDIDATE_SELECTOR = 'button, [role="button"], [role="link"], a, input[type="button"], input[type="submit"], div[tabindex], span[tabindex]';
    const ACTION_BUTTON_SELECTOR = 'button, [role="button"], input[type="button"], input[type="submit"]';
    const CONTINUE_ATTR_SUBSTRING_SELECTOR = '[aria-label*="continue" i], [title*="continue" i], [data-tooltip*="continue" i], [data-tooltip-content*="continue" i], [data-tooltip-text*="continue" i], [data-testid*="continue" i], [data-test*="continue" i], [data-qa*="continue" i], [data-action*="continue" i], [id*="continue" i], [class*="continue" i]';

    const composedContains = (container, node) => {
        try {
            if (!container || !node) return false;
            if (container.contains && container.contains(node)) return true;
            let cur = node;
            let depth = 0;
            while (cur && depth < 30) {
                if (cur === container) return true;
                if (cur.parentNode) cur = cur.parentNode;
                else if (cur.host) cur = cur.host;
                else if (cur.getRootNode) {
                    const root = cur.getRootNode();
                    cur = root && root.host ? root.host : null;
                } else cur = null;
                depth++;
            }
            return false;
        } catch (e) {
            return false;
        }
    };

    // Helper to strip time suffixes like "3m", "4h", "12s"
    const stripTimeSuffix = (text) => {
        return (text || '').trim().replace(/\s*\d+[smh]$/, '').trim();
    };

    // Helper to deduplicate tab names by appending (2), (3), etc.
    const deduplicateNames = (names) => {
        const counts = {};
        return names.map(name => {
            if (counts[name] === undefined) {
                counts[name] = 1;
                return name;
            } else {
                counts[name]++;
                return `${name} (${counts[name]})`;
            }
        });
    };

    const updateTabNames = (tabs) => {
        const rawNames = Array.from(tabs).map(tab => stripTimeSuffix(tab.textContent));
        const tabNames = deduplicateNames(rawNames);

        if (JSON.stringify(window.__autoAcceptState.tabNames) !== JSON.stringify(tabNames)) {
            log(`updateTabNames: Detected ${tabNames.length} tabs: ${tabNames.join(', ')}`);
            window.__autoAcceptState.tabNames = tabNames;
        }
    };

    function isClickBlocked(el, win) {
        try {
            if (!el) return true;
            if ('disabled' in el && el.disabled) return true;
            const aria = String(el.getAttribute?.('aria-disabled') || '').toLowerCase();
            if (aria === 'true') return true;
            const w = win || window;
            const style = w.getComputedStyle ? w.getComputedStyle(el) : null;
            if (style && (style.pointerEvents === 'none' || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return true;
            return false;
        } catch (e) {
            return false;
        }
    }

    function isInputBlocked(el, win) {
        try {
            if (!el) return true;
            const tag = String(el.tagName || '').toUpperCase();
            if ((tag === 'TEXTAREA' || tag === 'INPUT') && (el.disabled || el.readOnly)) return true;
            const aria = String(el.getAttribute?.('aria-disabled') || '').toLowerCase();
            if (aria === 'true') return true;
            const ce = el.getAttribute?.('contenteditable');
            if (ce && String(ce).toLowerCase() === 'false') {
                try {
                    const desc = el.querySelector ? el.querySelector('[contenteditable]:not([contenteditable="false"])') : null;
                    if (desc && isElementVisible(desc)) return false;
                } catch (e) { }
                return true;
            }
            const w = win || window;
            const style = w.getComputedStyle ? w.getComputedStyle(el) : null;
            if (style && (style.pointerEvents === 'none' || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return true;
            return false;
        } catch (e) {
            return false;
        }
    }

    function scanConversationTabs(panel) {
        try {
            const root = panel || document;
            const tabCandidates = [];
            const selectors = [
                '[role="tab"]',
                '[data-testid*="tab" i]',
                'button[aria-controls]',
                'button.grow,div.grow,span.grow'
            ];

            for (const scope of getDeepQueryScopes(root)) {
                for (const sel of selectors) {
                    let nodes = [];
                    try { nodes = Array.from(scope.querySelectorAll(sel)); } catch (e) { nodes = []; }
                    for (const el of nodes) {
                        try {
                            if (!el || !isElementVisible(el)) continue;
                            const isGrow = sel.includes('.grow') || (typeof el.className === 'string' && el.className.split(/\s+/g).includes('grow'));
                            if (isGrow) {
                                const inTabList = !!(el.closest && el.closest('[role="tablist"]'));
                                if (!inTabList) continue;
                            }
                            const label = stripTimeSuffix(String(el.textContent || '').replace(/\s+/g, ' ').trim());
                            if (!label || label.length < 1 || label.length > 120) continue;
                            const isActive =
                                String(el.getAttribute?.('aria-selected') || '').toLowerCase() === 'true' ||
                                String(el.getAttribute?.('aria-current') || '').toLowerCase() === 'page' ||
                                String(el.getAttribute?.('data-state') || '').toLowerCase() === 'active' ||
                                /\b(active|selected|current)\b/i.test(String(el.className || '')) ||
                                (typeof el.tabIndex === 'number' && el.tabIndex === 0);
                            tabCandidates.push({ el, label, isActive });
                        } catch (e) { }
                    }
                }
            }

            const counts = {};
            const tabs = tabCandidates.map(t => {
                const base = t.label;
                const prev = counts[base] || 0;
                counts[base] = prev + 1;
                const name = prev === 0 ? base : `${base} (${prev + 1})`;
                return { ...t, name };
            });

            const tabNames = tabs.map(t => t.name).filter(Boolean);
            const activeCand = tabs.find(t => t.isActive) || tabs[0] || null;
            const activeTabName = activeCand ? activeCand.name : '';

            return { tabNames, activeTabName, tabs };
        } catch (e) {
            return { tabNames: [], activeTabName: '', tabs: [] };
        }
    }

    function detectConversationWorking(panel) {
        try {
            const root = panel || document;

            try {
                const busyEl = root.querySelector ? root.querySelector('[aria-busy="true"]') : null;
                if (busyEl && isElementVisible(busyEl)) return true;
            } catch (e) { }

            const stopSelectors = [
                'button[aria-label*="stop" i]',
                'button[title*="stop" i]',
                '[role="button"][aria-label*="stop" i]',
                '[role="button"][title*="stop" i]',
                'button[aria-label*="cancel" i]',
                'button[title*="cancel" i]'
            ];
            for (const scope of getDeepQueryScopes(root)) {
                for (const sel of stopSelectors) {
                    let nodes = [];
                    try { nodes = Array.from(scope.querySelectorAll(sel)); } catch (e) { nodes = []; }
                    for (const el of nodes) {
                        if (el && isElementVisible(el) && !isClickBlocked(el, scope.defaultView || window)) return true;
                    }
                }
            }

            return false;
        } catch (e) {
            return false;
        }
    }

    window.__autoAcceptGetConversationSnapshot = function () {
        try {
            const panel = getAgentPanelRoot('trae');
            const state = window.__autoAcceptState || (window.__autoAcceptState = {});
            if (!state.completionStatus) state.completionStatus = {};
            if (!Array.isArray(state.tabNames)) state.tabNames = [];

            const tabs = scanConversationTabs(panel);
            const tabNames = (tabs.tabNames && tabs.tabNames.length > 0) ? tabs.tabNames : ['current'];
            const activeTabName = (tabs.activeTabName && String(tabs.activeTabName).trim()) ? String(tabs.activeTabName).trim() : 'current';
            const working = detectConversationWorking(panel);

            state.tabNames = tabNames;
            state.activeTabName = activeTabName;

            const status = {};
            for (const name of tabNames) status[name] = 'idle';
            status[activeTabName] = working ? 'working' : 'idle';
            state.completionStatus = status;

            return { tabNames, activeTabName, completionStatus: status, working, ts: Date.now() };
        } catch (e) {
            return { tabNames: ['current'], activeTabName: 'current', completionStatus: { current: 'idle' }, working: false, ts: Date.now() };
        }
    };

    // --- 3. BANNED COMMAND DETECTION ---
    /**
     * Traverses nearby containers to find terminal command text being executed.
     */
    function findNearbyCommandText(el) {
        const commandSelectors = ['pre', 'code', 'pre code'];
        let commandText = '';

        // Strategy 1: Walk up to find parent containers, then search their previous siblings
        let container = el.parentElement;
        let depth = 0;
        const maxDepth = 10; // Walk up to 10 levels

        while (container && depth < maxDepth) {
            // Search previous siblings of this container for PRE/CODE blocks
            let sibling = container.previousElementSibling;
            let siblingCount = 0;

            while (sibling && siblingCount < 5) {
                // Check if sibling itself is a PRE/CODE
                if (sibling.tagName === 'PRE' || sibling.tagName === 'CODE') {
                    const text = sibling.textContent.trim();
                    if (text.length > 0) {
                        commandText += ' ' + text;
                        log(`[BannedCmd] Found <${sibling.tagName}> sibling at depth ${depth}: "${text.substring(0, 100)}..."`);
                    }
                }

                // Check children of sibling for PRE/CODE
                for (const selector of commandSelectors) {
                    const codeElements = sibling.querySelectorAll(selector);
                    for (const codeEl of codeElements) {
                        if (codeEl && codeEl.textContent) {
                            const text = codeEl.textContent.trim();
                            if (text.length > 0 && text.length < 5000) {
                                commandText += ' ' + text;
                                log(`[BannedCmd] Found <${selector}> in sibling at depth ${depth}: "${text.substring(0, 100)}..."`);
                            }
                        }
                    }
                }

                sibling = sibling.previousElementSibling;
                siblingCount++;
            }

            // If we found command text, we're done
            if (commandText.length > 10) {
                break;
            }

            container = container.parentElement;
            depth++;
        }

        // Strategy 2: Fallback - check immediate button siblings
        if (commandText.length === 0) {
            let btnSibling = el.previousElementSibling;
            let count = 0;
            while (btnSibling && count < 3) {
                for (const selector of commandSelectors) {
                    const codeElements = btnSibling.querySelectorAll ? btnSibling.querySelectorAll(selector) : [];
                    for (const codeEl of codeElements) {
                        if (codeEl && codeEl.textContent) {
                            commandText += ' ' + codeEl.textContent.trim();
                        }
                    }
                }
                btnSibling = btnSibling.previousElementSibling;
                count++;
            }
        }

        // Strategy 3: Check aria-label and title attributes
        if (el.getAttribute('aria-label')) {
            commandText += ' ' + el.getAttribute('aria-label');
        }
        if (el.getAttribute('title')) {
            commandText += ' ' + el.getAttribute('title');
        }

        const result = commandText.trim().toLowerCase();
        if (result.length > 0) {
            log(`[BannedCmd] Extracted command text (${result.length} chars): "${result.substring(0, 150)}..."`);
        }
        return result;
    }

    /**
     * Check if a command is banned based on user-defined patterns.
     * Supports both literal substring matching and regex patterns.
     * 
     * Pattern format (line by line in settings):
     *   - Plain text: matches as literal substring (case-insensitive)
     *   - /pattern/: treated as regex (e.g., /rm\s+-rf/ matches "rm -rf")
     * 
     * @param {string} commandText - The extracted command text to check
     * @returns {boolean} True if command matches any banned pattern
     */
    function isCommandBanned(commandText, element) {
        // If we already logged this element as blocked, return true to skip clicking,
        // but DO NOT track stats again to prevent infinite loop.
        if (element && element.dataset.autoAcceptBlocked) {
            return true;
        }

        const state = window.__autoAcceptState;
        const bannedList = state.bannedCommands || [];

        if (bannedList.length === 0) return false;
        if (!commandText || commandText.length === 0) return false;

        const lowerText = commandText.toLowerCase();

        for (const banned of bannedList) {
            const pattern = banned.trim();
            if (!pattern || pattern.length === 0) continue;

            try {
                // Check if pattern is a regex (starts and ends with /)
                let isMatch = false;
                if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
                    const lastSlash = pattern.lastIndexOf('/');
                    const regexPattern = pattern.substring(1, lastSlash);
                    const flags = pattern.substring(lastSlash + 1) || 'i';
                    const regex = new RegExp(regexPattern, flags);
                    if (regex.test(commandText)) {
                        log(`[BANNED] Command blocked by regex: /${regexPattern}/${flags}`);
                        isMatch = true;
                    }
                } else {
                    const lowerPattern = pattern.toLowerCase();
                    if (lowerText.includes(lowerPattern)) {
                        log(`[BANNED] Command blocked by pattern: "${pattern}"`);
                        isMatch = true;
                    }
                }

                if (isMatch) {
                    Analytics.trackBlocked(log);
                    // Mark element so we don't count it again
                    if (element) {
                        element.dataset.autoAcceptBlocked = 'true';
                    }
                    return true;
                }
            } catch (e) {
                // Fallback
                if (lowerText.includes(pattern.toLowerCase())) {
                    log(`[BANNED] Command blocked by pattern (fallback): "${pattern}"`);
                    Analytics.trackBlocked(log);
                    if (element) element.dataset.autoAcceptBlocked = 'true';
                    return true;
                }
            }
        }
        return false;
    }

    // --- 4. CLICKING LOGIC ---
    function isAcceptButton(el) {
        const label = getElementLabel(el);
        const text = String(label || '').trim().toLowerCase();
        if (text.length === 0 || text.length > 140) return false;
        const patterns = ['accept', 'run', 'apply', 'execute', 'confirm', 'allow once', 'allow'];
        const rejects = ['skip', 'reject', 'cancel', 'close', 'refine'];
        if (rejects.some(r => text.includes(r))) return false;
        if (!patterns.some(p => text.includes(p))) return false;

        // Check if this is a command execution button by looking for "run command" or similar
        const isCommandButton = text.includes('run command') || text.includes('execute') || text.includes('run');

        // If it's a command button, check if the command is banned
        if (isCommandButton) {
            const nearbyText = findNearbyCommandText(el);
            if (isCommandBanned(nearbyText, el)) {
                log(`[BANNED] Skipping button: "${text}" - command is banned`);
                return false;
            }
        }

        const style = window.getComputedStyle(el);
        if (style.pointerEvents === 'none') return false;
        return isClickable(el);
    }

    /**
     * Check if an element is still visible in the DOM.
     * @param {Element} el - Element to check
     * @returns {boolean} True if element is visible
     */
    function isElementVisible(el) {
        if (!el || !el.isConnected) return false;
        const doc = el.ownerDocument || document;
        const win = doc.defaultView || window;
        let style = null;
        try { style = win.getComputedStyle ? win.getComputedStyle(el) : null; } catch (e) { style = null; }
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (!style) return true;
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden') return false;
        if (style.opacity === '0') return false;
        return true;
    }

    /**
     * Wait for an element to disappear (removed from DOM or hidden).
     * @param {Element} el - Element to watch
     * @param {number} timeout - Max time to wait in ms
     * @returns {Promise<boolean>} True if element disappeared
     */
    function waitForDisappear(el, timeout = 500) {
        return new Promise(resolve => {
            const startTime = Date.now();
            const check = () => {
                if (!isElementVisible(el)) {
                    resolve(true);
                } else if (Date.now() - startTime >= timeout) {
                    resolve(false);
                } else {
                    requestAnimationFrame(check);
                }
            };
            // Give a small initial delay for the click to register
            setTimeout(check, 50);
        });
    }

    async function performClick(selectors) {
        let rootEl = null;
        if (selectors && selectors.length && typeof selectors[selectors.length - 1] === 'object' && selectors[selectors.length - 1] && selectors[selectors.length - 1].__rootEl) {
            rootEl = selectors.pop().__rootEl;
        }
        const found = [];
        selectors.forEach(s => queryAllScoped(rootEl, s).forEach(el => found.push(el)));
        let clicked = 0;
        let verified = 0;
        const uniqueFound = [...new Set(found)];

        for (const el of uniqueFound) {
            // Check if element is still valid (might have been removed by previous click in this loop)
            if (!el.isConnected) continue;

            if (isAcceptButton(el)) {
                const buttonText = (el.textContent || "").trim();
                log(`Clicking: "${buttonText}"`);

                // Dispatch click
                el.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                clicked++;

                // Wait for button to disappear (verification)
                const disappeared = await waitForDisappear(el);

                if (disappeared) {
                    // Only count if button actually disappeared (action was successful)
                    Analytics.trackClick(buttonText, log);
                    verified++;
                    log(`[Stats] Click verified (button disappeared)`);
                } else {
                    log(`[Stats] Click not verified (button still visible after 500ms)`);
                }
            }
        }

        if (clicked > 0) {
            log(`[Click] Attempted: ${clicked}, Verified: ${verified}`);
        }
        return verified;
    }

    function matchesThinkingLimitText(rawText) {
        try {
            const raw = String(rawText || '').toLowerCase();
            if (!raw) return false;
            const head = raw.length > 12000 ? raw.slice(0, 12000) : raw;
            const tail = raw.length > 12000 ? raw.slice(-12000) : raw;
            const text = head + '\n' + tail;
            if (!text.includes('continue')) return false;
            return (
                text.includes('model thinking limit reached') ||
                text.includes('thinking limit reached') ||
                text.includes('token limit reached') ||
                text.includes('context limit reached') ||
                (text.includes('limit reached') && text.includes('please') && text.includes('continue'))
            );
        } catch (e) {
            return false;
        }
    }

    function hasThinkingLimitMessage(rootEl) {
        try {
            if (!rootEl || rootEl === document) {
                const docs = getDocuments(document);
                for (const doc of docs) {
                    try {
                        const el = doc && (doc.body || doc.documentElement);
                        if (matchesThinkingLimitText(el && el.innerText ? el.innerText : '')) return true;
                    } catch (e) { }
                }
                return false;
            }

            if (matchesThinkingLimitText(rootEl.innerText || '')) return true;

            const docs = [];
            try { docs.push(rootEl.ownerDocument || document); } catch (e) { docs.push(document); }
            try {
                const frames = rootEl.querySelectorAll('iframe, frame');
                for (const iframe of frames) {
                    try {
                        const doc = iframe.contentDocument || iframe.contentWindow?.document;
                        if (doc) docs.push(doc);
                    } catch (e) { }
                }
            } catch (e) { }

            for (const doc of docs) {
                try {
                    const el = doc && (doc.body || doc.documentElement);
                    if (matchesThinkingLimitText(el && el.innerText ? el.innerText : '')) return true;
                } catch (e) { }
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function findThinkingLimitContinueCandidate(rootEl) {
        try {
            const doc = rootEl && rootEl.nodeType === 9 ? rootEl : (rootEl && rootEl.ownerDocument ? rootEl.ownerDocument : document);
            const root = rootEl && rootEl.nodeType === 9
                ? (rootEl.body || rootEl.documentElement)
                : (rootEl || (doc.body || doc.documentElement));
            if (!root || !doc) return null;

            const looksInteractive = (el) => {
                try {
                    if (!el || el.nodeType !== 1) return false;
                    const tag = String(el.tagName || '').toLowerCase();
                    if (tag === 'button' || tag === 'a' || tag === 'input') return true;
                    const role = String(el.getAttribute ? (el.getAttribute('role') || '') : '').toLowerCase();
                    if (role === 'button' || role === 'link') return true;
                    const tabindex = el.getAttribute ? el.getAttribute('tabindex') : null;
                    if (tabindex !== null && tabindex !== undefined && String(tabindex).trim() !== '') return true;
                    if (typeof el.onclick === 'function') return true;
                    const onclickAttr = el.getAttribute ? el.getAttribute('onclick') : null;
                    if (onclickAttr) return true;
                    const style = window.getComputedStyle(el);
                    if (String(style.cursor || '').toLowerCase() === 'pointer') return true;
                    return false;
                } catch (e) {
                    return false;
                }
            };

            const findInteractiveTargetFromTextEl = (textEl) => {
                try {
                    if (!textEl) return null;
                    // Prefer obvious interactive ancestors first.
                    const preferred = textEl.closest
                        ? (textEl.closest('button,[role="button"],[role="link"],a,input[type="button"],input[type="submit"]') || null)
                        : null;
                    if (preferred) return preferred;
                    let cur = textEl;
                    for (let i = 0; i < 6; i++) {
                        if (!cur) break;
                        if (looksInteractive(cur)) return cur;
                        cur = cur.parentElement;
                    }
                    return null;
                } catch (e) {
                    return null;
                }
            };

            // Find a container that includes the thinking-limit copy.
            let container = null;
            try {
                const SHOW_TEXT = (typeof NodeFilter !== 'undefined' && NodeFilter.SHOW_TEXT) ? NodeFilter.SHOW_TEXT : 4;
                const walker = doc.createTreeWalker(root, SHOW_TEXT);
                let node = walker.nextNode();
                while (node) {
                    const t = String(node.nodeValue || '');
                    if (t && matchesThinkingLimitText(t)) {
                        container = node.parentElement || null;
                        break;
                    }
                    node = walker.nextNode();
                }
            } catch (e) { }

            // If we couldn't find a text node, fall back to scanning the root's text.
            if (!container) {
                try {
                    if (!matchesThinkingLimitText(root.innerText || '')) return null;
                    container = root;
                } catch (e) {
                    return null;
                }
            }

            // Walk up a few levels to get a stable banner container.
            let banner = container;
            for (let i = 0; i < 6; i++) {
                if (!banner) break;
                let txt = '';
                try { txt = String(banner.innerText || ''); } catch (e) { txt = ''; }
                if (matchesThinkingLimitText(txt)) {
                    // Prefer the smallest ancestor that still contains the message and has a clickable action.
                    const hasAction = (() => {
                        try { return !!banner.querySelector?.(ACTION_BUTTON_SELECTOR + ',a'); } catch (e) { return false; }
                    })();
                    if (hasAction) break;
                }
                banner = banner.parentElement;
            }

            if (!banner) return null;

            const candidates = [];
            try { candidates.push(...Array.from(banner.querySelectorAll(CONTINUE_CANDIDATE_SELECTOR))); } catch (e) { }
            if (candidates.length === 0) {
                // Fallback: Trae may render the Continue control as a plain element with text "Continue"
                // (no role/tabindex/attrs). Find exact "Continue" text nodes and pick a likely interactive ancestor.
                try {
                    const SHOW_TEXT = (typeof NodeFilter !== 'undefined' && NodeFilter.SHOW_TEXT) ? NodeFilter.SHOW_TEXT : 4;
                    const walker = doc.createTreeWalker(banner, SHOW_TEXT);
                    let node = walker.nextNode();
                    let guard = 0;
                    while (node && guard < 3000) {
                        guard++;
                        const t = String(node.nodeValue || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        if (t === 'continue') {
                            const parent = node.parentElement || null;
                            const target = parent ? findInteractiveTargetFromTextEl(parent) : null;
                            if (target) candidates.push(target);
                            else if (parent && isElementVisible(parent) && isClickable(parent)) candidates.push(parent);
                        }
                        node = walker.nextNode();
                        if (candidates.length >= 8) break;
                    }
                } catch (e) { }
            }
            if (candidates.length === 0) return null;

            const scored = [];
            for (const el of candidates) {
                try {
                    if (!el || !el.isConnected) continue;
                    if (!isElementVisible(el)) continue;
                    const style = window.getComputedStyle(el);
                    if (String(style.pointerEvents || '') === 'none') continue;
                    if (!isClickable(el)) continue;

                    const label = getContinueText(el);
                    const labelLower = String(label || '').toLowerCase();
                    const rect = el.getBoundingClientRect();

                    let score = 0;
                    // Strongly prefer a short, exact continue label to avoid selecting the banner text itself.
                    const trimmed = labelLower.replace(/\s+/g, ' ').trim();
                    if (trimmed === 'continue') score += 2500;
                    else if (matchesContinueLike(trimmed) && trimmed.length <= 40) score += 1000;
                    else continue;
                    // Right side actions tend to be the continue control.
                    score += Math.round(rect.x);
                    // Prefer button/anchor nodes over generic tabindex containers.
                    const tag = String(el.tagName || '').toLowerCase();
                    if (tag === 'button' || tag === 'a') score += 200;
                    scored.push({ el, score });
                } catch (e) { }
            }

            scored.sort((a, b) => b.score - a.score);
            return scored.length > 0 ? scored[0].el : null;
        } catch (e) {
            return null;
        }
    }

    function findContinueElement(rootEl) {
        const candidates = [];
        try { queryAllDeep(rootEl || document, CONTINUE_CANDIDATE_SELECTOR).forEach(e => candidates.push(e)); } catch (e) { }
        try {
            queryAllDeep(rootEl || document, CONTINUE_ATTR_SUBSTRING_SELECTOR).forEach(e => {
                try {
                    if (!e) return;
                    const target = e.closest ? e.closest('button, [role="button"], [role="link"], a, input[type="button"], input[type="submit"], div[tabindex], span[tabindex]') : null;
                    candidates.push(target || e);
                } catch (e2) { }
            });
        } catch (e) { }

        const unique = [...new Set(candidates)];
        let panel = null;
        let panelRect = null;
        try { panel = getAgentPanelRoot('trae'); } catch (e) { }
        try { if (panel) panelRect = panel.getBoundingClientRect(); } catch (e) { panelRect = null; }

        const scored = [];
        for (const el of unique) {
            try {
                if (!el) continue;
                if (!isClickable(el)) continue;
                const style = window.getComputedStyle(el);
                if (style.pointerEvents === 'none') continue;

                const label = getContinueText(el);
                if (!label) continue;
                const trimmed = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
                if (!(trimmed === 'continue' || (matchesContinueLike(trimmed) && trimmed.length <= 40))) continue;

                const rect = el.getBoundingClientRect();
                let score = 0;
                if (panel && composedContains(panel, el)) score += 5000;
                if (panelRect && rect) {
                    if (rect.y > (panelRect.y + panelRect.height * 0.4)) score += 600;
                    score += Math.max(0, Math.min(panelRect.height, rect.height));
                }
                score += Math.min(Math.max(0, rect.width * rect.height), 80000) / 200;

                scored.push({ el, score });
            } catch (e) { }
        }

        scored.sort((a, b) => b.score - a.score);
        if (scored.length > 0) return scored[0].el;

        // Fallback: locate exact "Continue" text nodes and click a likely interactive ancestor.
        try {
            const looksInteractive = (el) => {
                try {
                    if (!el || el.nodeType !== 1) return false;
                    const tag = String(el.tagName || '').toLowerCase();
                    if (tag === 'button' || tag === 'a' || tag === 'input') return true;
                    const role = String(el.getAttribute ? (el.getAttribute('role') || '') : '').toLowerCase();
                    if (role === 'button' || role === 'link') return true;
                    const tabindex = el.getAttribute ? el.getAttribute('tabindex') : null;
                    if (tabindex !== null && tabindex !== undefined && String(tabindex).trim() !== '') return true;
                    if (typeof el.onclick === 'function') return true;
                    const onclickAttr = el.getAttribute ? el.getAttribute('onclick') : null;
                    if (onclickAttr) return true;
                    const style = window.getComputedStyle(el);
                    if (String(style.cursor || '').toLowerCase() === 'pointer') return true;
                    return false;
                } catch (e) {
                    return false;
                }
            };

            const findInteractiveTargetFromTextEl = (textEl) => {
                try {
                    if (!textEl) return null;
                    const preferred = textEl.closest
                        ? (textEl.closest('button,[role="button"],[role="link"],a,input[type="button"],input[type="submit"]') || null)
                        : null;
                    if (preferred) return preferred;
                    let cur = textEl;
                    for (let i = 0; i < 7; i++) {
                        if (!cur) break;
                        if (looksInteractive(cur)) return cur;
                        cur = cur.parentElement;
                    }
                    return null;
                } catch (e) {
                    return null;
                }
            };

            const scopes = getDeepQueryScopes(rootEl || document);
            const found = [];
            for (const scope of scopes) {
                try {
                    const doc = scope && scope.nodeType === 9 ? scope : (scope && scope.ownerDocument ? scope.ownerDocument : document);
                    const root = scope && scope.nodeType === 9 ? (scope.body || scope.documentElement) : scope;
                    if (!doc || !root) continue;
                    const SHOW_TEXT = (typeof NodeFilter !== 'undefined' && NodeFilter.SHOW_TEXT) ? NodeFilter.SHOW_TEXT : 4;
                    const walker = doc.createTreeWalker(root, SHOW_TEXT);
                    let node = walker.nextNode();
                    let guard = 0;
                    while (node && guard < 6000) {
                        guard++;
                        const t = String(node.nodeValue || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        if (t === 'continue') {
                            const parent = node.parentElement || null;
                            const target = parent ? findInteractiveTargetFromTextEl(parent) : null;
                            if (target && isElementVisible(target) && isClickable(target)) {
                                found.push(target);
                            } else if (parent && isElementVisible(parent) && isClickable(parent)) {
                                // Last resort: click the exact-text node parent. Event bubbling may still trigger the action.
                                found.push(parent);
                            }
                        }
                        node = walker.nextNode();
                        if (found.length >= 12) break;
                    }
                } catch (e) { }
                if (found.length >= 12) break;
            }

            const uniqueFound = [...new Set(found)];
            if (uniqueFound.length === 0) return null;
            const scoredText = [];
            for (const el of uniqueFound) {
                try {
                    const style = window.getComputedStyle(el);
                    if (String(style.pointerEvents || '') === 'none') continue;
                    const rect = el.getBoundingClientRect();
                    let score = 0;
                    if (panel && composedContains(panel, el)) score += 5000;
                    score += Math.round(rect.x);
                    const tag = String(el.tagName || '').toLowerCase();
                    if (tag === 'button' || tag === 'a') score += 200;
                    scoredText.push({ el, score });
                } catch (e) { }
            }
            scoredText.sort((a, b) => b.score - a.score);
            return scoredText.length > 0 ? scoredText[0].el : null;
        } catch (e) {
            return null;
        }
    }

    async function clickContinueIfPresent(rootEl) {
        try {
            let btn = findThinkingLimitContinueCandidate(rootEl) || findContinueElement(rootEl);
            if (!btn && rootEl !== document) btn = findThinkingLimitContinueCandidate(document) || findContinueElement(document);
            if (!btn) return false;

            // Cooldown: prevent rapid double-clicks on the same Continue button across polling ticks.
            // Without this, a slow UI update can cause two "Continue" sends before the button disappears.
            try {
                const s = window.__autoAcceptState && window.__autoAcceptState.stats ? window.__autoAcceptState.stats : null;
                const last = s ? Number(s.lastContinueClickAt || 0) : 0;
                if (last && (Date.now() - last) < 2500) {
                    if (s) s.lastContinueClickResult = 'cooldown';
                    return false;
                }
            } catch (e) { }

            let shouldClick = hasThinkingLimitMessage(rootEl);
            if (!shouldClick && rootEl !== document) shouldClick = hasThinkingLimitMessage(document);
            let panel = null;
            let panelRect = null;
            try { panel = getAgentPanelRoot('trae'); } catch (e) { }
            try { if (panel) panelRect = panel.getBoundingClientRect(); } catch (e) { panelRect = null; }
            const isInPanel = !!(panel && composedContains(panel, btn));

            if (!shouldClick) {
                try {
                    const label = `${String(btn.textContent || '').trim()} ${String(btn.getAttribute ? (btn.getAttribute('aria-label') || '') : '').trim()}`.toLowerCase();
                    if (label.includes('continue generating') || label.includes('continue response') || label.includes('continue output')) {
                        shouldClick = true;
                    }
                } catch (e) { }
            }

            if (!shouldClick && isInPanel && panelRect) {
                try {
                    const rect = btn.getBoundingClientRect();
                    if (rect && rect.y > (panelRect.y + panelRect.height * 0.4)) shouldClick = true;
                } catch (e) { }
            }
            if (!shouldClick) {
                try {
                    const container = btn.closest ? btn.closest('section, article, main, div') : null;
                    const raw = String((container && container.innerText) ? container.innerText : (btn.parentElement && btn.parentElement.innerText ? btn.parentElement.innerText : '')).toLowerCase();
                    if (raw) {
                        const head = raw.length > 12000 ? raw.slice(0, 12000) : raw;
                        const tail = raw.length > 12000 ? raw.slice(-12000) : raw;
                        const text = head + '\n' + tail;
                        shouldClick =
                            text.includes('continue') &&
                            (
                                text.includes('model thinking limit reached') ||
                                text.includes('thinking limit reached') ||
                                text.includes('token limit reached') ||
                                text.includes('context limit reached') ||
                                (text.includes('limit reached') && text.includes('please') && text.includes('continue'))
                            );
                    }
                } catch (e) { }
            }

            if (!shouldClick) {
                try {
                    const s = window.__autoAcceptState && window.__autoAcceptState.stats ? window.__autoAcceptState.stats : null;
                    if (s) {
                        s.lastContinueClickResult = 'gate_failed';
                        s.lastContinueButtonText = String(btn.textContent || '').trim().substring(0, 80);
                    }
                } catch (e) { }
                return false;
            }

            const before = Date.now();
            try {
                const s = window.__autoAcceptState && window.__autoAcceptState.stats ? window.__autoAcceptState.stats : null;
                if (s) {
                    s.continueClicksAttemptedThisSession = (s.continueClicksAttemptedThisSession || 0) + 1;
                    s.lastContinueClickAt = before;
                    s.lastContinueClickResult = 'attempted';
                    s.lastContinueButtonText = String(btn.textContent || '').trim().substring(0, 80);
                }
            } catch (e) { }
            try {
                // IMPORTANT: trigger a single click action
                if (typeof btn.click === 'function') btn.click();
                else btn.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
            } catch (e) {
                // best-effort only
            }

            const disappeared = await waitForDisappear(btn, 1200);
            if (disappeared) {
                Analytics.markActivity(before);
                try {
                    const s = window.__autoAcceptState && window.__autoAcceptState.stats ? window.__autoAcceptState.stats : null;
                    if (s) {
                        s.continueClicksVerifiedThisSession = (s.continueClicksVerifiedThisSession || 0) + 1;
                        s.lastContinueClickVerifiedAt = Date.now();
                        s.lastContinueClickResult = 'verified_button_disappeared';
                    }
                } catch (e) { }
                log('[Continue] Clicked and verified (button disappeared)');
                return true;
            }

            const start = Date.now();
            while (Date.now() - start < 2000) {
                await new Promise(r => setTimeout(r, 100));
                if (!hasThinkingLimitMessage(rootEl)) {
                    Analytics.markActivity(before);
                    try {
                        const s = window.__autoAcceptState && window.__autoAcceptState.stats ? window.__autoAcceptState.stats : null;
                        if (s) {
                            s.continueClicksVerifiedThisSession = (s.continueClicksVerifiedThisSession || 0) + 1;
                            s.lastContinueClickVerifiedAt = Date.now();
                            s.lastContinueClickResult = 'verified_banner_cleared';
                        }
                    } catch (e) { }
                    log('[Continue] Clicked and verified (banner cleared)');
                    return true;
                }
            }

            try {
                const s = window.__autoAcceptState && window.__autoAcceptState.stats ? window.__autoAcceptState.stats : null;
                if (s) {
                    s.lastContinueClickResult = 'not_verified';
                }
            } catch (e) { }
            log('[Continue] Click attempted but not verified');
            return false;
        } catch (e) {
            return false;
        }
    }

    function getTraeAgentPanelRoot() {
        try {
            const panels = queryAll('#trae\\.agentPanel');
            if (panels && panels.length > 0) {
                const visible = panels.find(p => {
                    try {
                        const rect = p.getBoundingClientRect();
                        return rect.width > 50 && rect.height > 50;
                    } catch (e) { return false; }
                });
                return visible || panels[0];
            }
            return document.getElementById('trae.agentPanel') || document.querySelector('#trae\\.agentPanel');
        } catch (e) {
            try { return document.getElementById('trae.agentPanel'); } catch (e2) { }
        }
        return null;
    }

    function getAgentPanelRoot(ide) {
        return getTraeAgentPanelRoot();
    }

    // --- 5. LIFECYCLE API ---
    // --- Update banned commands list ---
    window.__autoAcceptUpdateBannedCommands = function (bannedList) {
        const state = window.__autoAcceptState;
        state.bannedCommands = Array.isArray(bannedList) ? bannedList : [];
        log(`[Config] Updated banned commands list: ${state.bannedCommands.length} patterns`);
        if (state.bannedCommands.length > 0) {
            log(`[Config] Banned patterns: ${state.bannedCommands.join(', ')}`);
        }
    };

    // --- Get current stats for ROI notification ---
    window.__autoAcceptGetStats = function () {
        const stats = Analytics.getStats();
        return {
            clicks: stats.clicksThisSession || 0,
            blocked: stats.blockedThisSession || 0,
            sessionStart: stats.sessionStartTime,
            fileEdits: stats.fileEditsThisSession || 0,
            terminalCommands: stats.terminalCommandsThisSession || 0,
            actionsWhileAway: stats.actionsWhileAway || 0,
            lastActivityTime: stats.lastActivityTime || 0,
            lastDomActivityTime: stats.lastDomActivityTime || 0
        };
    };

    // --- Reset stats (called when extension wants to collect and reset) ---
    window.__autoAcceptResetStats = function () {
        return Analytics.collectROI(log);
    };

    // --- Get session summary for notifications ---
    window.__autoAcceptGetSessionSummary = function () {
        return Analytics.getSessionSummary();
    };

    // --- Get and reset away actions count ---
    window.__autoAcceptGetAwayActions = function () {
        return Analytics.consumeAwayActions(log);
    };

    // --- Set focus state (called from extension - authoritative source) ---
    window.__autoAcceptSetFocusState = function (isFocused) {
        Analytics.setFocusState(isFocused, log);
    };

    window.__autoAcceptStart = function (config) {
        try {
            const ide = 'trae';
            const isPro = config.isPro !== false;
            const continuePolicy = String(config.continuePolicy || 'auto'); // 'auto' | 'ask'
            const continueBlockUntilGone = !!config.continueBlockUntilGone;
            const autoClickContinueOnOpenOrStart = !!config.autoClickContinueOnOpenOrStart;

            // Update banned commands from config
            if (config.bannedCommands) {
                window.__autoAcceptUpdateBannedCommands(config.bannedCommands);
            }

            log(`__autoAcceptStart called: ide=${ide}, isPro=${isPro}`);

            const state = window.__autoAcceptState;

            // Skip restart only if EXACTLY the same config
            if (state.isRunning && state.currentMode === ide) {
                // Still apply runtime config updates without restarting the loop.
                state.continuePolicy = continuePolicy;
                state.continueBlockUntilGone = continueBlockUntilGone;
                state.autoClickContinueOnOpenOrStart = autoClickContinueOnOpenOrStart;
                // If user just enabled this setting while running, do a one-time probe.
                if (autoClickContinueOnOpenOrStart) state._pendingAutoContinueProbe = true;
                log(`Already running with same config, skipping`);
                return;
            }

            // Stop previous loop if switching
            if (state.isRunning) {
                log(`Stopping previous session...`);
                state.isRunning = false;
            }

            state.isRunning = true;
            state.currentMode = ide;
            state.sessionID++;
            const sid = state.sessionID;
            state.continuePolicy = continuePolicy;
            state.continueBlockUntilGone = continueBlockUntilGone;
            state.autoClickContinueOnOpenOrStart = autoClickContinueOnOpenOrStart;
            state._panelWasPresent = false;
            state._pendingAutoContinueProbe = autoClickContinueOnOpenOrStart;

            // Reset transient per-session state to avoid stale "working" statuses blocking the queue.
            state.tabNames = [];
            state.activeTabName = '';
            state.completionStatus = {};

            // Initialize session start time if not set (for stats tracking)
            if (!state.stats.sessionStartTime) {
                state.stats.sessionStartTime = Date.now();
            }

            try {
                if (state._domObserver) {
                    try { state._domObserver.disconnect(); } catch (e) { }
                    state._domObserver = null;
                }
            } catch (e) { }

            try {
                const rootEl = getAgentPanelRoot(ide);
                if (rootEl && typeof MutationObserver !== 'undefined') {
                    let last = 0;
                    const obs = new MutationObserver(() => {
                        const now = Date.now();
                        if (now - last < 1000) return;
                        last = now;
                        Analytics.markDomActivity(now);
                    });
                    obs.observe(rootEl, { subtree: true, childList: true, characterData: true });
                    state._domObserver = obs;
                }
            } catch (e) { }

            Analytics.markActivity();
            log(`Agent Loaded (IDE: ${ide}, isPro: ${isPro})`, true);

            log(`Starting poll loop...`);
            (async function staticLoop() {
                while (state.isRunning && state.sessionID === sid) {
                    const panel = getAgentPanelRoot(ide);
                    // Never act on the whole document; only operate inside the agent panel.
                    if (!panel) {
                        state._panelWasPresent = false;
                        await new Promise(r => setTimeout(r, Math.max(250, config.pollInterval || 1000)));
                        continue;
                    }

                    try {
                        if (typeof window.__autoAcceptGetConversationSnapshot === 'function') {
                            window.__autoAcceptGetConversationSnapshot();
                        }
                    } catch (e) { }

                    // One-shot auto "Continue" probe on app start and when the conversation panel becomes available.
                    if (state.autoClickContinueOnOpenOrStart) {
                        if (!state._panelWasPresent) {
                            state._panelWasPresent = true;
                            state._pendingAutoContinueProbe = true;
                        }
                        if (state._pendingAutoContinueProbe) {
                            state._pendingAutoContinueProbe = false;
                            try {
                                const ok = await clickContinueIfPresent(panel);
                                log(`[Continue] Auto-click on open/start: ${ok ? 'clicked' : 'no-action'}`);
                            } catch (e) { }
                        }
                    } else {
                        state._panelWasPresent = true;
                        state._pendingAutoContinueProbe = false;
                    }

                    // If user blocked the current visible Continue, keep blocking until it disappears.
                    if (state.continueBlockUntilGone) {
                        try {
                            const stillThere = !!findContinueElement(panel);
                            if (!stillThere) state.continueBlockUntilGone = false;
                        } catch (e) { }
                    } else if (state.continuePolicy === 'auto') {
                        await clickContinueIfPresent(panel);
                    }

                    await performClick([ACTION_BUTTON_SELECTOR, { __rootEl: panel }]);
                    await new Promise(r => setTimeout(r, config.pollInterval || 1000));
                }
            })();
        } catch (e) {
            log(`ERROR in __autoAcceptStart: ${e.message}`);
            console.error('[AutoAccept] Start error:', e);
        }
    };

    // --- Continue controls (used by extension to avoid auto-resuming on enable) ---
    window.__autoAcceptHasContinue = function () {
        try {
            const panel = getAgentPanelRoot('trae');
            // Only consider "Continue" actionable when the thinking-limit banner copy is present.
            // This avoids clicking unrelated "Continue" controls in the IDE UI.
            const bannerPresent = (() => {
                try {
                    if (hasThinkingLimitMessage(document)) return true;
                    if (panel && hasThinkingLimitMessage(panel)) return true;
                    return false;
                } catch (e) {
                    return false;
                }
            })();

            if (!bannerPresent) return false;

            if (!panel) {
                // Banner may be rendered outside the panel container (global overlay).
                return !!(findThinkingLimitContinueCandidate(document) || findContinueElement(document));
            }
            return !!(findThinkingLimitContinueCandidate(panel) || findContinueElement(panel) || findThinkingLimitContinueCandidate(document) || findContinueElement(document));
        } catch (e) {
            return false;
        }
    };

    window.__autoAcceptSetContinuePolicy = function (policy) {
        try {
            const state = window.__autoAcceptState;
            if (!state) return false;
            state.continuePolicy = String(policy || 'auto');
            return true;
        } catch (e) {
            return false;
        }
    };

    window.__autoAcceptSetContinueBlockUntilGone = function (block) {
        try {
            const state = window.__autoAcceptState;
            if (!state) return false;
            state.continueBlockUntilGone = !!block;
            return true;
        } catch (e) {
            return false;
        }
    };

    window.__autoAcceptForceClickContinueOnce = async function () {
        try {
            const panel = getAgentPanelRoot('trae');
            let btn = null;
            try { if (panel) btn = findThinkingLimitContinueCandidate(panel) || findContinueElement(panel); } catch (e) { }
            if (!btn) {
                try { btn = findThinkingLimitContinueCandidate(document) || findContinueElement(document); } catch (e) { }
            }
            if (!btn) return false;
            const before = Date.now();
            try {
                if (typeof btn.click === 'function') btn.click();
                else {
                    const doc = btn.ownerDocument || document;
                    const win = doc.defaultView || window;
                    btn.dispatchEvent(new win.MouseEvent('click', { view: win, bubbles: true, cancelable: true }));
                }
            } catch (e) { }
            const disappeared = await waitForDisappear(btn, 1500);
            if (disappeared) Analytics.markActivity(before);
            return !!disappeared;
        } catch (e) {
            return false;
        }
    };

    window.__autoAcceptStop = function () {
        const state = window.__autoAcceptState;
        if (state) {
            state.isRunning = false;
            state.currentMode = null;
            state.tabNames = [];
            state.activeTabName = '';
            state.completionStatus = {};
            try {
                if (state._domObserver) {
                    try { state._domObserver.disconnect(); } catch (e) { }
                    state._domObserver = null;
                }
            } catch (e) { }
        }
        log("Agent Stopped.");
    };

    // Active conversation helper (used by the queue to target "Current (Active Tab)")
    window.__autoAcceptGetActiveTabName = function () {
        try {
            if (typeof window !== 'undefined' && typeof window.__autoAcceptGetConversationSnapshot === 'function') {
                const snap = window.__autoAcceptGetConversationSnapshot();
                const name = snap && snap.activeTabName ? String(snap.activeTabName).trim() : '';
                return name || 'current';
            }
        } catch (e) { }
        try {
            const state = window.__autoAcceptState;
            const name = state && state.activeTabName ? String(state.activeTabName).trim() : '';
            return name || 'current';
        } catch (e) {
            return 'current';
        }
    };

    // --- Prompt Sending (CDP) ---

    function getInputValue(el) {
        try {
            if (!el) return '';
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
            return (el.innerText || el.textContent || '').trim();
        } catch (e) {
            return '';
        }
    }

    function getInputHint(el) {
        try {
            if (!el) return '';
            const attrs = [
                el.getAttribute('placeholder'),
                el.getAttribute('aria-label'),
                el.getAttribute('data-placeholder'),
                el.getAttribute('title')
            ].filter(Boolean);
            return attrs.join(' ').trim();
        } catch (e) {
            return '';
        }
    }

    function isProbablyIMEOverlay(className) {
        // Only exclude actual "ime" tokens to avoid false positives like "time"/"timestamp".
        const c = (className || '').toLowerCase();
        return /\bime\b/.test(c) || c.includes('ime-text-area');
    }

    function scorePromptInputCandidate(el) {
        try {
            const rect = el.getBoundingClientRect();
            const visible = isElementVisible(el);
            if (!visible) return -1;
            if (rect.width < 120 || rect.height < 18) return -1;

            const className = el.className || '';
            if (isProbablyIMEOverlay(className)) return -1;

            const hint = (getInputHint(el) + ' ' + className).toLowerCase();
            if (hint.includes('model')) {
                try {
                    const role = String(el.getAttribute?.('role') || '').toLowerCase();
                    const inModelSelector = !!el.closest?.(
                        '[role="combobox"],[aria-haspopup="listbox"],[aria-label*="model" i],[data-testid*="model" i],[class*="model" i]'
                    );
                    if (inModelSelector || role === 'combobox') return -1;
                } catch (e) { }

                if (
                    hint.includes('select model') ||
                    hint.includes('choose model') ||
                    hint.includes('model selector') ||
                    hint.includes('search model')
                ) return -1;
            }
            const doc = el.ownerDocument || document;
            const win = doc.defaultView || window;
            const bottomDistance = Math.abs(win.innerHeight - rect.bottom);

            let score = 0;
            score += Math.min(rect.width, 1200) / 8;
            score += Math.min(rect.height, 200) / 4;
            score += Math.max(0, 400 - bottomDistance) / 4;

            if (el.isContentEditable || el.contentEditable === 'true') score += 8;
            if (hint.includes('ask anything')) score += 80;
            if (hint.includes('ask') || hint.includes('message') || hint.includes('prompt') || hint.includes('chat')) score += 35;
            if (hint.includes('composer')) score += 20;

            // Prefer inputs inside likely chat containers
            try {
                if (el.closest) {
                    if (el.closest('#trae\\.agentPanel')) score += 25;
                    if (el.closest('[class*="chat" i]')) score += 12;
                    if (el.closest('[data-testid*="chat" i]')) score += 12;
                }
            } catch (e) { }

            return score;
        } catch (e) {
            return -1;
        }
    }

    function resolveEditablePromptInput(el) {
        try {
            if (!el) return null;
            const tag = String(el.tagName || '').toUpperCase();
            if (tag === 'TEXTAREA' || tag === 'INPUT') return el;
            const ce = String(el.getAttribute?.('contenteditable') ?? '').toLowerCase();
            if ((el.contentEditable === 'true' || el.isContentEditable) && ce !== 'false') return el;

            // Many rich editors expose a non-editable wrapper (often role="textbox") that contains
            // the actual [contenteditable="true"] element. Prefer the real editable descendant.
            const candidates = [];
            const selector = '[contenteditable]:not([contenteditable="false"]), textarea, input[type="text"], .ProseMirror';
            for (const scope of getDeepQueryScopes(el)) {
                try {
                    if (!scope || typeof scope.querySelectorAll !== 'function') continue;
                    candidates.push(...Array.from(scope.querySelectorAll(selector)));
                } catch (e) { }
            }

            let best = null;
            let bestScore = -Infinity;
            for (const c of candidates) {
                if (!c || c === el) continue;
                // Only accept true descendants (avoid picking some unrelated editor elsewhere in the doc)
                try { if (el.contains && !el.contains(c)) continue; } catch (e) { }
                const score = scorePromptInputCandidate(c);
                if (score > bestScore) {
                    bestScore = score;
                    best = c;
                }
            }
            return best || el;
        } catch (e) {
            return el;
        }
    }

    function findBestPromptInput() {
        const candidates = [];

        // Include role="textbox" to catch some custom editors.
        const selector = 'textarea, input[type="text"], [contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror';
        const els = queryAll(selector);
        const seen = new Set();
        for (const el of els) {
            const resolved = resolveEditablePromptInput(el);
            if (!resolved || seen.has(resolved)) continue;
            seen.add(resolved);

            let score = scorePromptInputCandidate(resolved);
            if (score >= 0) {
                // Small bonus when we resolved from a wrapper to a real editable element.
                if (resolved !== el) score += 4;
                candidates.push({ el: resolved, score });
            }
        }

        candidates.sort((a, b) => b.score - a.score);
        return candidates.length > 0 ? candidates[0].el : null;
    }

    function findBestPromptInputScoped(rootEl) {
        const candidates = [];
        const selector = 'textarea, input[type="text"], [contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror';
        const els = queryAllScoped(rootEl, selector);
        const seen = new Set();
        for (const el of els) {
            const resolved = resolveEditablePromptInput(el);
            if (!resolved || seen.has(resolved)) continue;
            seen.add(resolved);

            let score = scorePromptInputCandidate(resolved);
            if (score >= 0) {
                if (resolved !== el) score += 4;
                candidates.push({ el: resolved, score });
            }
        }
        candidates.sort((a, b) => b.score - a.score);
        return candidates.length > 0 ? candidates[0].el : null;
    }

    function isClickable(el) {
        try {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return false;
            const doc = el.ownerDocument || document;
            const win = doc.defaultView || window;
            const style = win.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            if (style.pointerEvents === 'none') return false;
            if ('disabled' in el && el.disabled) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    function findSendButtonNearInput(inputBox) {
        const roots = [];
        try {
            const form = inputBox?.closest ? inputBox.closest('form') : null;
            if (form) roots.push(form);
        } catch (e) { }

        try {
            if (inputBox?.parentElement) roots.push(inputBox.parentElement);
        } catch (e) { }

        roots.push(document);

        const selectors = [
            'button[type="submit"]',
            'button[aria-label*="Send" i]',
            'button[title*="Send" i]',
            'button[data-testid*="send" i]',
            'button[data-testid*="submit" i]',
            '[role="button"][aria-label*="Send" i]',
            '[role="button"][title*="Send" i]'
        ];

        const queryAllDeepScoped = (rootNode, selector) => {
            try {
                const scopes = getDeepQueryScopes(rootNode);
                const out = [];
                for (const scope of scopes) {
                    try {
                        if (scope && typeof scope.querySelectorAll === 'function') {
                            out.push(...Array.from(scope.querySelectorAll(selector)));
                        }
                    } catch (e) { }
                }
                return out;
            } catch (e) {
                return [];
            }
        };

        for (const root of roots) {
            for (const sel of selectors) {
                const btn = root.querySelector ? root.querySelector(sel) : null;
                if (isClickable(btn)) return btn;
                // Also search in shadow roots for icon-only send buttons.
                for (const deepBtn of queryAllDeepScoped(root, sel)) {
                    if (isClickable(deepBtn)) return deepBtn;
                }
            }

            const candidates = root.querySelectorAll ? root.querySelectorAll('button,[role="button"]') : [];
            const deepCandidates = queryAllDeepScoped(root, 'button,[role="button"]');
            for (const btn of [...Array.from(candidates), ...deepCandidates]) {
                try {
                    const label = (
                        (btn.getAttribute('aria-label') || '') + ' ' +
                        (btn.getAttribute('title') || '') + ' ' +
                        (btn.getAttribute('data-testid') || '') + ' ' +
                        (btn.textContent || '')
                    ).trim().toLowerCase();
                    if (!label) continue;
                    if (
                        label === 'send' ||
                        label.includes('send') ||
                        label.includes('submit') ||
                        label.includes('enviar') ||
                        label.includes('发送') ||
                        label.includes('送信') ||
                        label.includes('전송')
                    ) {
                        if (isClickable(btn)) return btn;
                    }
                } catch (e) {
                    // ignore
                }
            }
        }

        // Heuristic fallback: find a clickable element adjacent to the input (icon-only "send" buttons often lack labels).
        try {
            const inputRect = inputBox.getBoundingClientRect();
            const searchRoot = roots[0] && roots[0] !== document ? roots[0] : (inputBox.parentElement || document);
            const near = [];
            for (const scope of getDeepQueryScopes(searchRoot)) {
                try {
                    if (!scope || typeof scope.querySelectorAll !== 'function') continue;
                    near.push(...Array.from(scope.querySelectorAll('button,[role="button"],div[tabindex],span[tabindex]')));
                } catch (e) { }
            }
            let best = null;
            let bestScore = -Infinity;

            for (const el of near) {
                if (!isClickable(el)) continue;
                if (el === inputBox) continue;
                if (el.contains && el.contains(inputBox)) continue;

                const r = el.getBoundingClientRect();
                const dx = r.left - inputRect.right;
                const dy = Math.abs(((r.top + r.bottom) / 2) - ((inputRect.top + inputRect.bottom) / 2));

                // Must be near the right edge of the composer, and roughly aligned vertically.
                if (dx < -20 || dx > 180) continue;
                if (dy > 70) continue;

                const hasSvg = !!el.querySelector('svg');
                let score = 0;
                score += hasSvg ? 30 : 0;
                score += (180 - dx);
                score += (70 - dy);

                // Prefer slightly larger targets (common for icon buttons).
                score += Math.min(60, r.width + r.height);

                if (score > bestScore) {
                    bestScore = score;
                    best = el;
                }
            }

            if (best) return best;
        } catch (e) { }
        return null;
    }

    async function setPromptText(inputBox, text) {
        try {
            let target = resolveEditablePromptInput(inputBox) || inputBox;
            const doc = target?.ownerDocument || document;
            const win = doc.defaultView || window;
            const desired = String(text);
            const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
            const desiredNorm = normalize(desired);

            const coerceEditableDescendant = () => {
                try {
                    const ce = String(target?.getAttribute?.('contenteditable') ?? '').toLowerCase();
                    if (ce === 'false' && target && typeof target.querySelector === 'function') {
                        const desc = target.querySelector('[contenteditable]:not([contenteditable="false"]), textarea, input[type="text"], .ProseMirror');
                        if (desc) target = desc;
                    }
                } catch (e) { }
            };

            const dispatchInput = () => {
                try { target.dispatchEvent(new win.Event('input', { bubbles: true })); } catch (e) { }
            };

            const matches = () => {
                try { return normalize(getInputValue(target)) === desiredNorm; } catch (e) { return false; }
            };

            const waitForMatch = async (timeoutMs = 240) => {
                const start = Date.now();
                while (Date.now() - start < timeoutMs) {
                    if (matches()) return true;
                    await new Promise(r => setTimeout(r, 15));
                }
                return matches();
            };

            coerceEditableDescendant();
            target?.focus?.();

            if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
                const proto = target.tagName === 'TEXTAREA'
                    ? win.HTMLTextAreaElement.prototype
                    : win.HTMLInputElement.prototype;
                const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (nativeSetter) {
                    nativeSetter.call(target, desired);
                } else {
                    target.value = desired;
                }
                dispatchInput();
                return true;
            }

            const ce = String(target.getAttribute?.('contenteditable') ?? '').toLowerCase();
            if (target.isContentEditable || target.contentEditable === 'true' || (ce && ce !== 'false') || target.classList?.contains('ProseMirror') || target.getAttribute?.('role') === 'textbox') {
                // Best-effort: use execCommand selectAll+insertText (known to work in the PoC) and verify.
                // Avoid dispatching synthetic InputEvents with `data`, which can duplicate text in Lexical.
                try {
                    if (doc.execCommand) {
                        try { doc.execCommand('selectAll', false, null); } catch (e) { }
                        try { doc.execCommand('insertText', false, desired); } catch (e) { }
                    }
                } catch (e) { }
                dispatchInput();
                if (await waitForMatch()) return true;

                // Retry with an explicit range selection confined to the target.
                try {
                    const sel = win.getSelection ? win.getSelection() : null;
                    if (sel && doc.createRange) {
                        const range = doc.createRange();
                        range.selectNodeContents(target);
                        sel.removeAllRanges();
                        sel.addRange(range);
                        if (doc.execCommand) {
                            try { doc.execCommand('insertText', false, desired); } catch (e) { }
                        }
                    }
                } catch (e) { }
                dispatchInput();
                if (await waitForMatch()) return true;

                // Final fallback: direct DOM replacement.
                try { target.textContent = desired; } catch (e) { }
                try { target.innerText = desired; } catch (e) { }
                dispatchInput();
                await new Promise(r => setTimeout(r, 0));
                return matches();
            }

            try { target.innerText = desired; } catch (e) { return false; }
            dispatchInput();
            await new Promise(r => setTimeout(r, 0));
            return matches();
        } catch (e) {
            return false;
        }
    }

    window.__autoAcceptProbePrompt = function () {
        try {
            const panel = getAgentPanelRoot('trae');
            const inputCandidate = panel ? findBestPromptInputScoped(panel) : findBestPromptInput();
            const inputBox = resolveEditablePromptInput(inputCandidate);
            if (!inputBox || !isElementVisible(inputBox)) {
                return {
                    hasInput: false,
                    score: 0,
                    hasAgentPanel: !!panel
                };
            }
            const rect = inputBox.getBoundingClientRect();
            const className = String(inputBox.className || '');
            const c = className.toLowerCase();

            let score = 0;
            if (panel) score += 1000;
            score += 200;
            if (c.includes('cursor-text') || c.includes('overflow')) score += 200;
            score += Math.min(rect.width, 1200) / 10;
            score += Math.min(rect.height, 300) / 10;

            const sendBtn = findSendButtonNearInput(inputBox);
            return {
                hasInput: true,
                score,
                hasAgentPanel: !!panel,
                inIframe: (inputBox.ownerDocument && inputBox.ownerDocument !== document),
                tagName: inputBox.tagName,
                hint: getInputHint(inputBox),
                className: className.substring(0, 120),
                rect: { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) },
                hasSendButton: !!sendBtn
            };
        } catch (e) {
            return { hasInput: false, score: 0, error: e?.message || String(e) };
        }
    };

    window.__autoAcceptGetContinueDiagnostics = function () {
        const safeTextMatch = (rawText) => {
            const raw = String(rawText || '').toLowerCase();
            if (!raw) return { detected: false, matches: [] };
            const head = raw.length > 12000 ? raw.slice(0, 12000) : raw;
            const tail = raw.length > 12000 ? raw.slice(-12000) : raw;
            const text = head + '\n' + tail;
            if (!text.includes('continue')) return { detected: false, matches: [] };

            const matches = [];
            if (text.includes('model thinking limit reached')) matches.push('model_thinking_limit_reached');
            if (text.includes('thinking limit reached')) matches.push('thinking_limit_reached');
            if (text.includes('token limit reached')) matches.push('token_limit_reached');
            if (text.includes('context limit reached')) matches.push('context_limit_reached');
            if (text.includes('limit reached') && text.includes('please') && text.includes('continue')) matches.push('limit_reached_please_continue');
            return { detected: matches.length > 0, matches };
        };

        const state = window.__autoAcceptState || {};
        const stats = state.stats || {};

        let panel = null;
        try { panel = getAgentPanelRoot('trae'); } catch (e) { }

        const scopes = [];
        try { scopes.push(...getDeepQueryScopes(document)); } catch (e) { }
        const candidateEls = [];
        for (const scope of scopes) {
            try { candidateEls.push(...Array.from(scope.querySelectorAll(CONTINUE_CANDIDATE_SELECTOR))); } catch (e) { }
        }
        for (const scope of scopes) {
            try {
                const nodes = Array.from(scope.querySelectorAll(CONTINUE_ATTR_SUBSTRING_SELECTOR));
                for (const n of nodes) {
                    try {
                        const target = n && n.closest ? n.closest('button, [role="button"], [role="link"], a, input[type="button"], input[type="submit"], div[tabindex], span[tabindex]') : null;
                        candidateEls.push(target || n);
                    } catch (e) { }
                }
            } catch (e) { }
        }

        const seen = new Set();
        const candidates = [];
        for (const el of candidateEls) {
            try {
                if (!el || seen.has(el)) continue;
                seen.add(el);
                const label = getContinueText(el);
                const textFallback = String(el.textContent || '').replace(/\s+/g, ' ').trim();
                const combined = (label && label.trim().length > 0) ? label : textFallback;
                const lower = String(combined || '').toLowerCase().replace(/\s+/g, ' ').trim();
                if (!(lower === 'continue' || (matchesContinueLike(lower) && lower.length <= 40))) continue;
                const visible = isElementVisible(el);
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                candidates.push({
                    text: String(combined || '').substring(0, 120),
                    visible,
                    disabled: !!el.disabled,
                    pointerEvents: String(style.pointerEvents || ''),
                    display: String(style.display || ''),
                    visibility: String(style.visibility || ''),
                    rect: { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) }
                });
            } catch (e) { }
        }

        const visibleCount = candidates.filter(c => c.visible).length;

        let bannerMatch = { detected: false, matches: [] };
        try { bannerMatch = safeTextMatch((document.body || document.documentElement || {}).innerText || ''); } catch (e) { }
        if (!bannerMatch.detected && panel) {
            try { bannerMatch = safeTextMatch(panel.innerText || ''); } catch (e) { }
        }

        // If we detected the banner but failed to find any structured candidates, look for exact "Continue" text
        // and attempt to identify an interactive ancestor for diagnostics.
        if (bannerMatch.detected && candidates.length === 0) {
            try {
                const looksInteractive = (el) => {
                    try {
                        if (!el || el.nodeType !== 1) return false;
                        const tag = String(el.tagName || '').toLowerCase();
                        if (tag === 'button' || tag === 'a' || tag === 'input') return true;
                        const role = String(el.getAttribute ? (el.getAttribute('role') || '') : '').toLowerCase();
                        if (role === 'button' || role === 'link') return true;
                        const tabindex = el.getAttribute ? el.getAttribute('tabindex') : null;
                        if (tabindex !== null && tabindex !== undefined && String(tabindex).trim() !== '') return true;
                        if (typeof el.onclick === 'function') return true;
                        const onclickAttr = el.getAttribute ? el.getAttribute('onclick') : null;
                        if (onclickAttr) return true;
                        const style = window.getComputedStyle(el);
                        if (String(style.cursor || '').toLowerCase() === 'pointer') return true;
                        return false;
                    } catch (e) {
                        return false;
                    }
                };

                const findInteractiveTargetFromTextEl = (textEl) => {
                    try {
                        if (!textEl) return null;
                        const preferred = textEl.closest
                            ? (textEl.closest('button,[role="button"],[role="link"],a,input[type="button"],input[type="submit"]') || null)
                            : null;
                        if (preferred) return preferred;
                        let cur = textEl;
                        for (let i = 0; i < 7; i++) {
                            if (!cur) break;
                            if (looksInteractive(cur)) return cur;
                            cur = cur.parentElement;
                        }
                        return null;
                    } catch (e) {
                        return null;
                    }
                };

                const scopes2 = getDeepQueryScopes(document);
                const matched = [];
                for (const scope of scopes2) {
                    try {
                        const doc2 = scope && scope.nodeType === 9 ? scope : (scope && scope.ownerDocument ? scope.ownerDocument : document);
                        const root2 = scope && scope.nodeType === 9 ? (scope.body || scope.documentElement) : scope;
                        if (!doc2 || !root2) continue;
                        const SHOW_TEXT = (typeof NodeFilter !== 'undefined' && NodeFilter.SHOW_TEXT) ? NodeFilter.SHOW_TEXT : 4;
                        const walker = doc2.createTreeWalker(root2, SHOW_TEXT);
                        let node = walker.nextNode();
                        let guard = 0;
                        while (node && guard < 6000) {
                            guard++;
                            const t = String(node.nodeValue || '').replace(/\s+/g, ' ').trim().toLowerCase();
                            if (t === 'continue') {
                                const parent = node.parentElement || null;
                                const target = parent ? findInteractiveTargetFromTextEl(parent) : null;
                                if (target && isElementVisible(target) && isClickable(target)) matched.push(target);
                                else if (parent && isElementVisible(parent) && isClickable(parent)) matched.push(parent);
                            }
                            node = walker.nextNode();
                            if (matched.length >= 6) break;
                        }
                    } catch (e) { }
                    if (matched.length >= 6) break;
                }

                const seen2 = new Set();
                for (const el of matched) {
                    if (!el || seen2.has(el)) continue;
                    seen2.add(el);
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    candidates.push({
                        text: 'continue (text-match)',
                        visible: isElementVisible(el),
                        disabled: !!el.disabled,
                        pointerEvents: String(style.pointerEvents || ''),
                        display: String(style.display || ''),
                        visibility: String(style.visibility || ''),
                        rect: { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) }
                    });
                }
            } catch (e) { }
        }

        const visibleCount2 = candidates.filter(c => c.visible).length;
        const shouldClick = !!bannerMatch.detected && visibleCount2 > 0;

        const issues = [];
        if (!state.isRunning) issues.push('NOT_RUNNING');
        if (candidateEls.length > 50 && candidates.length === 0) issues.push('NO_CONTINUE_CANDIDATES');
        if (bannerMatch.detected && visibleCount2 === 0) issues.push('BANNER_DETECTED_NO_VISIBLE_CONTINUE');
        if (!bannerMatch.detected && visibleCount2 > 0) issues.push('CONTINUE_VISIBLE_BUT_BANNER_NOT_DETECTED');
        if (stats.lastContinueClickResult === 'not_verified') issues.push('CLICK_ATTEMPTED_NOT_VERIFIED');
        if (stats.lastContinueClickResult === 'gate_failed') issues.push('GATE_FAILED');

        let docScopeCount = null;
        let shadowScopeCount = null;
        try {
            docScopeCount = scopes.filter(s => s && s.nodeType === 9).length;
            shadowScopeCount = scopes.filter(s => s && typeof s.host !== 'undefined').length;
        } catch (e) { }
        if (shadowScopeCount === 0) issues.push('NO_OPEN_SHADOW_ROOTS');

        return {
            ts: Date.now(),
            state: {
                isRunning: !!state.isRunning,
                currentMode: state.currentMode || null,
                sessionID: state.sessionID || 0
            },
            scan: {
                scopeCount: scopes.length,
                docScopeCount,
                shadowScopeCount,
                scannedElements: candidateEls.length
            },
            banner: bannerMatch,
            continue: {
                totalCandidates: candidates.length,
                visibleCandidates: visibleCount2,
                shouldClick,
                issues,
                candidates: candidates.slice(0, 8),
                last: {
                    attempts: stats.continueClicksAttemptedThisSession || 0,
                    verified: stats.continueClicksVerifiedThisSession || 0,
                    lastClickAt: stats.lastContinueClickAt || 0,
                    lastVerifiedAt: stats.lastContinueClickVerifiedAt || 0,
                    lastResult: stats.lastContinueClickResult || '',
                    lastButtonText: stats.lastContinueButtonText || ''
                }
            }
        };
    };

    window.__autoAcceptGetContinueCandidatesAll = function () {
        const buildDomPath = (el) => {
            try {
                const parts = [];
                let cur = el;
                let depth = 0;
                while (cur && depth < 8) {
                    const tag = String(cur.tagName || '').toLowerCase();
                    if (!tag) break;
                    let part = tag;
                    const id = String(cur.id || '').trim();
                    if (id) {
                        part += `#${id}`;
                        parts.unshift(part);
                        break;
                    }
                    const cls = String(cur.className || '').trim();
                    if (cls) {
                        const tokens = cls.split(/\s+/g).filter(Boolean).slice(0, 3);
                        if (tokens.length > 0) part += `.${tokens.join('.')}`;
                    }
                    parts.unshift(part);
                    cur = cur.parentElement;
                    depth++;
                }
                return parts.join(' > ').substring(0, 240);
            } catch (e) {
                return '';
            }
        };

        const docs = [];
        try { docs.push(...getDeepQueryScopes(document)); } catch (e) { }

        const candidateEls = [];
        for (const doc of docs) {
            try { candidateEls.push(...Array.from(doc.querySelectorAll(CONTINUE_CANDIDATE_SELECTOR))); } catch (e) { }
        }
        for (const doc of docs) {
            try {
                const nodes = Array.from(doc.querySelectorAll(CONTINUE_ATTR_SUBSTRING_SELECTOR));
                for (const n of nodes) {
                    try {
                        const target = n && n.closest ? n.closest('button, [role="button"], [role="link"], a, input[type="button"], input[type="submit"], div[tabindex], span[tabindex]') : null;
                        candidateEls.push(target || n);
                    } catch (e) { }
                }
            } catch (e) { }
        }

        const seen = new Set();
        const candidates = [];
        let truncated = false;
        const maxItems = 2000;

        for (const el of candidateEls) {
            try {
                if (!el || seen.has(el)) continue;
                seen.add(el);

                const label = getContinueText(el);
                const textFallback = String(el.textContent || '').replace(/\s+/g, ' ').trim();
                const combined = (label && label.trim().length > 0) ? label : textFallback;
                const lower = String(combined || '').toLowerCase().replace(/\s+/g, ' ').trim();
                if (!(lower === 'continue' || (matchesContinueLike(lower) && lower.length <= 40))) continue;

                const visible = isElementVisible(el);
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                const tagName = String(el.tagName || '');
                const role = String(el.getAttribute ? (el.getAttribute('role') || '') : '');
                const href = tagName.toLowerCase() === 'a' ? String(el.getAttribute ? (el.getAttribute('href') || '') : '') : '';
                const id = String(el.id || '').substring(0, 120);
                const className = String(el.className || '').substring(0, 180);
                const outerHTML = String(el.outerHTML || '').replace(/\s+/g, ' ').trim().substring(0, 600);

                candidates.push({
                    tagName,
                    role,
                    id,
                    className,
                    href: href.substring(0, 300),
                    text: String(combined || '').substring(0, 240),
                    visible,
                    disabled: !!el.disabled,
                    pointerEvents: String(style.pointerEvents || ''),
                    display: String(style.display || ''),
                    visibility: String(style.visibility || ''),
                    rect: { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) },
                    domPath: buildDomPath(el),
                    outerHTML
                });

                if (candidates.length >= maxItems) {
                    truncated = true;
                    break;
                }
            } catch (e) { }
        }

        return {
            ts: Date.now(),
            docCount: docs.filter(d => d && d.nodeType === 9).length,
            scopeCount: docs.length,
            scannedElements: candidateEls.length,
            totalCandidates: candidates.length,
            truncated,
            candidates
        };
    };

    const clickLikeUser = (el) => {
        try {
            if (!el) return false;
            const doc = el.ownerDocument || document;
            const win = doc.defaultView || window;
            el.scrollIntoView?.({ block: 'center', inline: 'center' });
            el.focus?.();
            const rect = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
            const clientX = rect.left + Math.max(1, rect.width / 2);
            const clientY = rect.top + Math.max(1, rect.height / 2);
            const common = { bubbles: true, cancelable: true, view: win, clientX, clientY };
            try { el.dispatchEvent(new win.PointerEvent('pointerdown', { ...common, pointerType: 'mouse', buttons: 1 })); } catch (e) { }
            try { el.dispatchEvent(new win.MouseEvent('mousedown', { ...common, buttons: 1 })); } catch (e) { }
            try { el.dispatchEvent(new win.MouseEvent('mouseup', { ...common, buttons: 1 })); } catch (e) { }
            try { el.dispatchEvent(new win.MouseEvent('click', { ...common, buttons: 1 })); } catch (e) { }
            try { if (typeof el.click === 'function') el.click(); } catch (e) { }
            return true;
        } catch (e) {
            return false;
        }
    };

    window.__autoAcceptSendPrompt = async function (text) {
        try {
            log(`[Prompt] Request to send: "${String(text).substring(0, 50)}..."`);

            const panel = getAgentPanelRoot('trae');

            const inputCandidate = panel ? findBestPromptInputScoped(panel) : findBestPromptInput();
            const inputBox = resolveEditablePromptInput(inputCandidate);
            if (!inputBox) {
                log('[Prompt] ERROR: No suitable input found!');
                return false;
            }

            const doc = inputBox.ownerDocument || document;
            const win = doc.defaultView || window;
            const cls = String(inputBox.className || '').substring(0, 80);
            const candTag = inputCandidate ? String(inputCandidate.tagName || '') : '';
            log(`[Prompt] Using input: ${inputBox.tagName} (from ${candTag || 'unknown'}), hasAgentPanel=${!!panel}, inIframe=${doc !== document}, class="${cls}"`);

            const dispatchEnter = (opts = {}) => {
                const params = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ...opts };
                try {
                    inputBox.dispatchEvent(new win.KeyboardEvent('keydown', params));
                    inputBox.dispatchEvent(new win.KeyboardEvent('keypress', params));
                    inputBox.dispatchEvent(new win.KeyboardEvent('keyup', params));
                } catch (e) {
                    inputBox.dispatchEvent(new KeyboardEvent('keydown', params));
                    inputBox.dispatchEvent(new KeyboardEvent('keypress', params));
                    inputBox.dispatchEvent(new KeyboardEvent('keyup', params));
                }
            };

            const sendBtnPrimary = findSendButtonNearInput(inputCandidate || inputBox);

            if (isInputBlocked(inputBox, win)) {
                log('[Prompt] Input is disabled/readonly; deferring send without editing composer');
                return false;
            }

            const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
            const wanted = normalize(String(text));
            const currentBeforeRaw = String(getInputValue(inputBox) || '');
            const currentBefore = normalize(currentBeforeRaw);
            const needsSet = currentBefore !== wanted;
            const isWorking = !!(panel && detectConversationWorking(panel));
            if (isWorking) {
                log('[Prompt] Conversation is working; deferring send without editing composer');
                return false;
            }

            // If the UI is not currently sendable (common while the assistant is busy), do not touch
            // the composer on retries. IMPORTANT: the send button is often disabled when the composer
            // is empty, so we only defer when we *already* have the wanted text set.
            if (sendBtnPrimary && isClickBlocked(sendBtnPrimary, win) && !needsSet) {
                log('[Prompt] Send button present but disabled; deferring send without editing composer');
                return false;
            }

            // Idempotency: if the composer already has the desired text (common during retries),
            // do NOT re-set it (prevents accidental duplication).
            let mutatedComposer = false;
            if (needsSet) {
                if (!(await setPromptText(inputBox, String(text)))) {
                    log('[Prompt] ERROR: Failed to set prompt text');
                    return false;
                }
                mutatedComposer = true;
            } else {
                log('[Prompt] Input already matches desired text; skipping set');
            }

            // 300ms delay is required for React/UI state to update before Enter is handled.
            await new Promise(r => setTimeout(r, 300));

            // Guard: do not attempt to send if the composer does not actually contain the desired prompt.
            // This prevents sending concatenated/partial content when prior attempts inserted extra text.
            try {
                const wantedNow = normalize(String(text));
                let currentNow = normalize(getInputValue(inputBox));
                if (currentNow !== wantedNow) {
                    log(`[Prompt] Composer text mismatch after set; retrying set once (wanted="${wantedNow.substring(0, 60)}..." got="${currentNow.substring(0, 60)}...")`);
                    await setPromptText(inputBox, String(text));
                    await new Promise(r => setTimeout(r, 150));
                    currentNow = normalize(getInputValue(inputBox));
                    if (currentNow !== wantedNow) {
                        log('[Prompt] ERROR: Composer did not match desired prompt after retry; aborting send');
                        if (mutatedComposer) {
                            try { await setPromptText(inputBox, currentBeforeRaw); } catch (e) { }
                        }
                        return false;
                    }
                }
            } catch (e) { }

            // After text is set, if the send button exists and is still disabled, do not spam Enter/clicks.
            // Keep the composer as-is and let the scheduler retry later.
            try {
                const sendBtnAfterSet = findSendButtonNearInput(inputCandidate || inputBox) || sendBtnPrimary;
                if (sendBtnAfterSet && isClickBlocked(sendBtnAfterSet, win)) {
                    log('[Prompt] Send button still disabled after setting text; deferring send');
                    if (mutatedComposer) {
                        try { await setPromptText(inputBox, currentBeforeRaw); } catch (e) { }
                    }
                    return false;
                }
            } catch (e) { }

            const snippet = normalize(String(text)).toLowerCase().slice(0, 96);

            const verifySent = async () => {
                const start = Date.now();
                const maxMs = 1800;
                while (Date.now() - start < maxMs) {
                    await new Promise(r => setTimeout(r, 120));
                    let cur = '';
                    try { cur = normalize(getInputValue(inputBox)); } catch (e) { cur = ''; }
                    const curLower = String(cur || '').toLowerCase();
                    if (!curLower) return true;
                    if (snippet && curLower.indexOf(snippet) === -1) return true;
                }
                try {
                    const p = getAgentPanelRoot('trae');
                    const t = String((p && (p.innerText || p.textContent)) || '').toLowerCase();
                    if (snippet && t.indexOf(snippet) !== -1) return true;
                } catch (e) { }
                return false;
            };

            if (sendBtnPrimary && !isClickBlocked(sendBtnPrimary, win)) {
                clickLikeUser(sendBtnPrimary);
                Analytics.markActivity();
                const ok = await verifySent();
                log(`[Prompt] Send button result: ${ok ? 'sent' : 'not-sent'}`);
                return !!ok;
            }

            inputBox.focus();
            dispatchEnter();
            Analytics.markActivity();
            const ok = await verifySent();
            log(`[Prompt] Enter result: ${ok ? 'sent' : 'not-sent'}`);
            return !!ok;
        } catch (e) {
            log(`[Prompt] ERROR: ${e?.message || String(e)}`);
            return false;
        }
    };

    // Send prompt to specific conversation (click tab first)
    window.__autoAcceptSendPromptToConversation = async (text, targetConversation) => {
        log(`[Prompt] sendPromptToConversation: "${text.substring(0, 50)}..." target: "${targetConversation || 'current'}"`);

        const normalize = (s) => stripTimeSuffix(String(s || '')).replace(/\s+/g, ' ').trim();

        const waitForActive = async (name, timeoutMs = 2000) => {
            const wanted = normalize(name);
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                await new Promise(r => setTimeout(r, 75));
                try {
                    const panel = getAgentPanelRoot('trae');
                    const snap = scanConversationTabs(panel);
                    const active = normalize(snap.activeTabName);
                    if (active && active.toLowerCase() === wanted.toLowerCase()) return true;
                } catch (e) { }
            }
            return false;
        };

        const target = normalize(targetConversation);
        if (target && target.toLowerCase() !== 'current') {
            try {
                const panel = getAgentPanelRoot('trae');
                const tabsInfo = scanConversationTabs(panel);
                const tabs = Array.isArray(tabsInfo.tabs) ? tabsInfo.tabs : [];
                const wantedLower = target.toLowerCase();

                let match = tabs.find(t => normalize(t.name).toLowerCase() === wantedLower) || null;
                if (!match) match = tabs.find(t => normalize(t.label).toLowerCase() === wantedLower) || null;
                if (!match) match = tabs.find(t => normalize(t.name).toLowerCase().includes(wantedLower)) || null;
                if (!match) match = tabs.find(t => normalize(t.label).toLowerCase().includes(wantedLower)) || null;

                const alreadyActive = normalize(tabsInfo.activeTabName).toLowerCase() === (match ? normalize(match.name).toLowerCase() : wantedLower);
                if (!alreadyActive) {
                    if (!match || !match.el || !isElementVisible(match.el)) return false;
                    const doc = match.el.ownerDocument || document;
                    const win = doc.defaultView || window;
                    if (isClickBlocked(match.el, win)) return false;
                    clickLikeUser(match.el);
                    await waitForActive(match.name || match.label || target, 2000);
                }
            } catch (e) {
                return false;
            }
        }

        // Now send to current input, and return success status
        if (window.__autoAcceptSendPrompt) {
            return !!(await window.__autoAcceptSendPrompt(text));
        }
        return false;
    };

    log("Core Bundle Initialized.", true);
})();
