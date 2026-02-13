const fs = require('fs');
const path = require('path');

const readStdin = async () => {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => resolve(data));
        process.stdin.resume();
    });
};

const fmtTime = (ts) => {
    if (!ts || typeof ts !== 'number') return '';
    try { return new Date(ts).toISOString(); } catch (e) { return String(ts); }
};

const safeJsonParse = (s) => {
    try { return { ok: true, value: JSON.parse(s) }; } catch (e) { return { ok: false, error: e?.message || String(e) }; }
};

const parseDiagContinueLine = (line) => {
    const marker = '[DIAG_CONTINUE]';
    const idx = line.indexOf(marker);
    if (idx < 0) return null;
    const raw = line.slice(idx + marker.length).trim();
    const parsed = safeJsonParse(raw);
    if (parsed.ok) return { ok: true, raw, value: parsed.value };
    return { ok: false, raw, error: parsed.error };
};

const toInt = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

const analyzeEvents = (events) => {
    const byConnection = new Map();
    for (const ev of events) {
        const id = String(ev?.id || ev?.connectionId || ev?.diag?.id || 'unknown');
        if (!byConnection.has(id)) byConnection.set(id, []);
        byConnection.get(id).push(ev);
    }

    const issuesCount = {};
    const incIssue = (i) => { issuesCount[i] = (issuesCount[i] || 0) + 1; };

    let firstTs = null;
    let lastTs = null;
    for (const ev of events) {
        const ts = toInt(ev?.ts);
        if (ts !== null) {
            if (firstTs === null || ts < firstTs) firstTs = ts;
            if (lastTs === null || ts > lastTs) lastTs = ts;
        }
        const issues = ev?.diag?.continue?.issues;
        if (Array.isArray(issues)) for (const i of issues) incIssue(String(i));
    }

    const lines = [];
    lines.push(`DIAG_CONTINUE events: ${events.length}`);
    if (firstTs && lastTs) {
        lines.push(`Time range: ${fmtTime(firstTs)} → ${fmtTime(lastTs)}`);
    }

    const issueKeys = Object.keys(issuesCount);
    if (issueKeys.length) {
        issueKeys.sort((a, b) => (issuesCount[b] || 0) - (issuesCount[a] || 0));
        lines.push('Issue counts:');
        for (const k of issueKeys) lines.push(`  - ${k}: ${issuesCount[k]}`);
    }

    lines.push('Connections:');
    for (const [id, evs] of byConnection.entries()) {
        const last = evs.slice().sort((a, b) => (toInt(a.ts) || 0) - (toInt(b.ts) || 0)).at(-1) || {};
        const diag = last.diag || {};
        const state = diag.state || {};
        const scan = diag.scan || {};
        const cont = diag.continue || {};
        const banner = diag.banner || {};

        const total = toInt(cont.totalCandidates);
        const visible = toInt(cont.visibleCandidates);
        const shouldClick = cont.shouldClick === true;
        const attempts = toInt(cont?.last?.attempts);
        const verified = toInt(cont?.last?.verified);
        const lastResult = String(cont?.last?.lastResult || '');
        const dumpFile = last.dumpFile ? String(last.dumpFile) : '';

        lines.push(`  - ${id}`);
        lines.push(`    state: running=${!!state.isRunning} mode=${String(state.currentMode || '')} session=${toInt(state.sessionID) ?? ''}`);
        lines.push(`    scan: scopes=${toInt(scan.scopeCount) ?? ''} docs=${toInt(scan.docScopeCount) ?? ''} shadow=${toInt(scan.shadowScopeCount) ?? ''} scanned=${toInt(scan.scannedElements) ?? ''}`);
        lines.push(`    banner: detected=${!!banner.detected} matches=${Array.isArray(banner.matches) ? banner.matches.join(',') : ''}`);
        lines.push(`    continue: total=${total ?? ''} visible=${visible ?? ''} shouldClick=${shouldClick}`);
        lines.push(`    clicks: attempts=${attempts ?? ''} verified=${verified ?? ''} lastResult=${lastResult}`);
        if (dumpFile) lines.push(`    dumpFile: ${dumpFile}`);
    }

    const hints = [];

    const lastEv = events.slice().sort((a, b) => (toInt(a.ts) || 0) - (toInt(b.ts) || 0)).at(-1);
    if (lastEv?.diag) {
        const scan = lastEv.diag.scan || {};
        const cont = lastEv.diag.continue || {};
        const banner = lastEv.diag.banner || {};
        const total = toInt(cont.totalCandidates) || 0;
        const visible = toInt(cont.visibleCandidates) || 0;
        const scopes = toInt(scan.scopeCount) || 0;
        const scanned = toInt(scan.scannedElements) || 0;
        const shadowScopes = toInt(scan.shadowScopeCount);

        if (total === 0 && scanned > 50) {
            hints.push('No Continue candidates found despite scanning many elements. Likely UI label/selector mismatch or Continue is not in DOM-accessible nodes.');
        }
        if (total === 0 && scanned <= 10) {
            hints.push('Very few elements scanned. Possibly the wrong page/webview is targeted or the agent panel is not open.');
        }
        if (total > 0 && visible === 0) {
            hints.push('Continue candidates exist but none visible. Likely hidden/overlayed or inside non-visible container; check CSS visibility/pointer-events.');
        }
        if (banner?.detected && total === 0) {
            hints.push('Banner detected but Continue candidate list is empty. Likely Continue is rendered as non-standard element (icon button, div[tabindex], input) or in inaccessible surface.');
        }
        if (!banner?.detected && visible > 0) {
            hints.push('Continue is visible but banner gate not detected. Gating heuristics may be too strict; consider allowing Continue click by label alone.');
        }
        if (shadowScopes === 0) {
            hints.push('No open shadow roots detected. If Trae uses closed shadow DOM for Continue, DOM scanning cannot see it.');
        }
    }

    if (hints.length) {
        lines.push('Hints:');
        for (const h of [...new Set(hints)]) lines.push(`  - ${h}`);
    }

    return lines.join('\n');
};

const analyzeDumpFile = (dumpPath) => {
    const res = { ok: false, dumpPath, exists: false, error: null, summary: null };
    if (!dumpPath) return res;
    try {
        res.exists = fs.existsSync(dumpPath);
        if (!res.exists) return res;
        const raw = fs.readFileSync(dumpPath, 'utf8');
        const parsed = safeJsonParse(raw);
        if (!parsed.ok) {
            res.error = `JSON parse failed: ${parsed.error}`;
            return res;
        }
        const dump = parsed.value || {};
        const total = toInt(dump?.dump?.totalCandidates ?? dump?.dump?.total ?? dump?.dump?.candidates?.length ?? dump?.totalCandidates) ?? null;
        const scannedElements = toInt(dump?.dump?.scannedElements ?? dump?.diag?.scan?.scannedElements ?? dump?.scannedElements) ?? null;
        const truncated = dump?.dump?.truncated ?? dump?.truncated ?? null;
        const candidates = Array.isArray(dump?.dump?.candidates) ? dump.dump.candidates : (Array.isArray(dump?.candidates) ? dump.candidates : []);
        const sample = candidates.slice(0, 12).map(c => ({
            tagName: c?.tagName,
            role: c?.role,
            text: String(c?.text || '').substring(0, 160),
            aria: String(c?.aria || '').substring(0, 160),
            visible: c?.visible,
            disabled: c?.disabled,
            pointerEvents: c?.pointerEvents,
            display: c?.display,
            visibility: c?.visibility,
            domPath: c?.domPath
        }));
        res.ok = true;
        res.summary = { totalCandidates: total, scannedElements, truncated, sample };
        return res;
    } catch (e) {
        res.error = e?.message || String(e);
        return res;
    }
};

async function main() {
    const args = process.argv.slice(2);
    const wantJson = args.includes('--json');
    const fileArg = args.find(a => a && !a.startsWith('--')) || null;

    let content = '';
    let sourceLabel = '';
    if (fileArg) {
        const p = path.resolve(process.cwd(), fileArg);
        sourceLabel = p;
        try {
            content = fs.readFileSync(p, 'utf8');
        } catch (e) {
            console.error(`Failed to read file: ${p}`);
            console.error(e?.message || String(e));
            process.exit(1);
        }
    } else {
        sourceLabel = 'stdin';
        content = await readStdin();
        if (!content || !content.trim()) {
            console.log('Usage: node test_scripts/analyze_continue_log.js <path-to-auto-accept-cdp-TRAE.log>');
            console.log('   or (PowerShell): Get-Content <log> -Raw | node test_scripts/analyze_continue_log.js');
            process.exit(2);
        }
    }

    const lines = content.split(/\r?\n/g);
    const parsed = [];
    const parseErrors = [];
    for (const line of lines) {
        if (!line.includes('[DIAG_CONTINUE]')) continue;
        const p = parseDiagContinueLine(line);
        if (!p) continue;
        if (!p.ok) {
            parseErrors.push({ line: line.slice(0, 4000), error: p.error });
            continue;
        }
        const v = p.value;
        parsed.push(v);
    }

    const dumpAnalyses = [];
    for (const ev of parsed) {
        const dumpFile = ev?.dumpFile ? String(ev.dumpFile) : '';
        if (!dumpFile) continue;
        const a = analyzeDumpFile(dumpFile);
        dumpAnalyses.push(a);
    }

    const out = {
        source: sourceLabel,
        diagContinueCount: parsed.length,
        diagContinueParseErrors: parseErrors.length,
        analysis: analyzeEvents(parsed),
        dumps: dumpAnalyses
    };

    if (wantJson) {
        console.log(JSON.stringify(out, null, 2));
        return;
    }

    console.log(`Source: ${out.source}`);
    if (parseErrors.length) {
        console.log(`DIAG_CONTINUE parse errors: ${parseErrors.length}`);
        console.log(JSON.stringify(parseErrors.slice(0, 3), null, 2));
    }
    console.log(out.analysis);

    const okDumps = dumpAnalyses.filter(d => d.ok);
    if (okDumps.length) {
        console.log('Dump summaries:');
        for (const d of okDumps.slice(0, 6)) {
            console.log(`- ${d.dumpPath}`);
            console.log(JSON.stringify(d.summary, null, 2));
        }
    } else if (dumpAnalyses.length) {
        const missing = dumpAnalyses.filter(d => !d.exists).length;
        const failed = dumpAnalyses.filter(d => d.exists && !d.ok).length;
        console.log(`Dump read summary: total=${dumpAnalyses.length} missing=${missing} failed=${failed}`);
    }
}

main().catch((e) => {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
});
