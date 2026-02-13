# Debug Testing Infrastructure

This document describes the comprehensive debug testing infrastructure for programmatically testing all extension functionality, including UI automation.

## Overview

The extension exposes a Debug Server on port `54321` that allows external scripts to:
- Query and modify all extension settings
- Execute IDE commands
- Interact with the Trae browser via CDP
- **Automate the Settings Panel UI** (WebView Bridge)

This enables 1-to-1 graphical testing that mirrors exactly what users click and interact with.

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                          Test Script                                  │
│                    (Node.js / comprehensive_test.js)                  │
└─────────────────────────────┬─────────────────────────────────────────┘
                              │ HTTP POST to localhost:54321
                              ▼
┌───────────────────────────────────────────────────────────────────────┐
│                       Debug Handler                                   │
│                 (main_scripts/debug-handler.js)                       │
│                                                                       │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│   │ Extension State │  │  CDP Handler    │  │ WebView Bridge  │     │
│   │ (Settings, etc) │  │ (Browser Ctrl)  │  │ (UI Automation) │     │
│   └─────────────────┘  └─────────────────┘  └─────────────────┘     │
└───────────────────────────────────────────────────────────────────────┘
                              │                        │
              ┌───────────────┘                        └───────────────┐
              ▼                                                        ▼
┌─────────────────────────┐                          ┌─────────────────────────┐
│   Trae Browser         │                          │   Settings Panel        │
│   (via CDP WebSocket)   │                          │   (Trae WebView)        │
└─────────────────────────┘                          └─────────────────────────┘
```

## Quick Start

### Prerequisites
1. Extension must be running in Trae
2. Debug mode enabled (default: `true` via `auto-accept.debugMode.enabled`)

### Running the Test Suite

```bash
cd c:\Users\rulfe\GitHub\multi-purpose-agent-TRAE
node test_scripts/comprehensive_test.js
```

Expected output:
```
╔════════════════════════════════════════════════════════════╗
║ Multi Purpose Agent for TRAE - Comprehensive Test Suite   ║
╚════════════════════════════════════════════════════════════╝

  ✅ Passed:  52
  ❌ Failed:  0
  ⏭️  Skipped: 1
  ⏱️  Duration: 3.75s

🎉 All tests passed!
```

## Debug Actions Reference

### Core Controls

| Action | Params | Description |
|--------|--------|-------------|
| `toggle` | - | Toggle extension ON/OFF |
| `getEnabled` | - | Get enabled state |

### Queue Control

| Action | Params | Description |
|--------|--------|-------------|
| `startQueue` | - | Start the prompt queue |
| `pauseQueue` | - | Pause queue execution |
| `resumeQueue` | - | Resume paused queue |
| `skipPrompt` | - | Skip current prompt |
| `stopQueue` | - | Stop queue completely |
| `getQueueStatus` | - | Get queue status object |

### Schedule Configuration

| Action | Params | Description |
|--------|--------|-------------|
| `updateSchedule` | `{ enabled, mode, prompts, ... }` | Update schedule settings |
| `getSchedule` | - | Get current schedule config |

### Browser Automation (CDP)

| Action | Params | Description |
|--------|--------|-------------|
| `evaluateInBrowser` | `{ code: string }` | Execute JS in Trae |
| `getCDPConnections` | - | List active CDP connections |
| `sendPrompt` | `{ prompt: string }` | Send prompt to agent chat |

### WebView UI Automation (NEW)

| Action | Params | Description |
|--------|--------|-------------|
| `openSettingsPanel` | - | Open the Settings Panel |
| `uiAction` | `{ type, target, value }` | Perform UI action |
| `getUISnapshot` | - | Get full UI state |
| `listUIElements` | - | List all interactive elements |

#### UI Action Types

```javascript
// Click a button
await sendCommand('uiAction', { type: 'click', target: 'startQueueBtn' });

// Toggle a checkbox
await sendCommand('uiAction', { type: 'setValue', target: 'scheduleEnabled', value: true });

// Read a value
await sendCommand('uiAction', { type: 'getValue', target: 'scheduleMode' });

// Get element text
await sendCommand('uiAction', { type: 'getText', target: 'queueStatusText' });

// Get full page snapshot
await sendCommand('uiAction', { type: 'getSnapshot' });

// List all elements
await sendCommand('uiAction', { type: 'listElements' });
```

### Utility Actions

| Action | Params | Description |
|--------|--------|-------------|
| `getFullState` | - | Complete extension state snapshot |
| `getSystemInfo` | - | Platform, Trae info |
| `getLogs` | `{ tailLines: number }` | Read log file |
| `getStats` | - | Get click/session stats |
| `getROIStats` | - | Get ROI analytics |

## Example: Writing Custom Tests

```javascript
const http = require('http');

function sendCommand(action, params = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ action, params });
        const req = http.request({
            hostname: '127.0.0.1',
            port: 54321,
            path: '/command',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', reject);
        req.end(data);
    });
}

// Example test
async function testMyFeature() {
    // 1. Set up state
    await sendCommand('updateSchedule', { enabled: true, mode: 'queue', prompts: ['Test'] });
    
    // 2. Open settings panel
    await sendCommand('openSettingsPanel');
    await new Promise(r => setTimeout(r, 500));
    
    // 3. Verify UI reflects state
    const snapshot = await sendCommand('getUISnapshot');
    console.assert(snapshot.snapshot.snapshot.scheduleEnabled === true);
    
    // 4. Click a button
    await sendCommand('uiAction', { type: 'click', target: 'startQueueBtn' });
    
    // 5. Verify effect
    const status = await sendCommand('getQueueStatus');
    console.assert(status.status.isRunningQueue === true);
    
    // 6. Clean up
    await sendCommand('stopQueue');
}
```

## Test Files

| File | Purpose |
|------|---------|
| `test_scripts/comprehensive_test.js` | Full test suite (52 tests) |
| `test_scripts/live_cdp_debug.js` | CDP connection debugging |
| `test_scripts/regression_chat_input.js` | Chat injection regression test |

## When to Use This

Use this debug testing infrastructure when:

1. **Developing new features** - Test programmatically without manual clicking
2. **Debugging issues** - Query full state, read logs remotely
3. **Regression testing** - Run automated test suite after changes
4. **UI verification** - Ensure Settings Panel renders correctly
5. **CI/CD integration** - Automate testing in build pipelines

## Related Documentation

- [Live CDP Debugging](./LIVE_CDP_DEBUGGING.md) - Browser-side debugging
- [Send Message to Agent Chat](./SEND_MESSAGE_TRAE_TO_AGENT_CHAT.md) - Chat injection details
