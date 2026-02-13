# Multi Purpose Agent for TRAE

[Open VSX Listing](https://open-vsx.org/extension/rodhayl/multi-purpose-agent-trae)

Automate repetitive approval and prompt-driving workflows in TRAE with queue orchestration, CDP-backed chat injection, safety guardrails, and deep debug tooling.

Open VSX listing: https://open-vsx.org/extension/rodhayl/multi-purpose-agent-trae

## Core Functionality

- Auto-click automation for agent action buttons (accept/retry) while extension is ON
- Continue banner automation on conversation open/app start (enabled by default)
- Scheduled prompting in three modes: `interval`, `daily`, and `queue`
- Queue runtime controls: start, pause, resume, skip current, and stop
- Queue completion logic with silence detection and max-wait behavior
- Optional intermediate check prompts between queued tasks
- Safety filtering for dangerous terminal command patterns
- CDP-backed prompt sending and page introspection for robust automation
- Built-in logs, diagnostics, queue telemetry, and ROI tracking
- Relaunch guidance when TRAE is not started with the required CDP flag

## How "Enable Check Prompt" Works

When `Enable Check Prompt` is ON (`auto-accept.schedule.checkPrompt.enabled`), the extension inserts one additional prompt between your queued prompts.

Practical behavior in queue mode:

1. Send queued prompt A.
2. Wait for completion/silence based on queue rules.
3. Send check prompt text (`auto-accept.schedule.checkPrompt.text`).
4. Wait again for completion/silence.
5. Send queued prompt B.

This is useful when you want the agent to behave like a coworker who validates prior output before moving on, for example:

- Review the previous implementation for gaps or regressions
- Generate a short report before the next task
- Run or propose tests before continuing
- Confirm acceptance criteria are met between queue items

Tip: keep the check prompt concise and explicit (review scope, test expectations, and output format).

## Commands

Primary commands contributed by the extension:

- `auto-accept.toggle` — Toggle automation ON/OFF
- `auto-accept.openSettings` — Open settings panel
- `auto-accept.debugCommand` — Execute debug actions programmatically

Runtime command surface also includes queue and control actions:

- `auto-accept.startQueue`
- `auto-accept.pauseQueue`
- `auto-accept.resumeQueue`
- `auto-accept.skipPrompt`
- `auto-accept.stopQueue`
- `auto-accept.showQueueMenu`
- `auto-accept.resetSettings`

## Configuration

Main settings namespace: `auto-accept.*`

### Continue

- `auto-accept.continue.autoClickOnOpenOrStart` (default: `true`)
	- Auto-clicks Continue banner when opening a conversation or on app start, while extension is ON.

### Scheduler

- `auto-accept.schedule.enabled` (default: `false`)
	- Enables scheduled automation.
- `auto-accept.schedule.mode` (`interval` | `daily` | `queue`, default: `interval`)
	- Chooses scheduling strategy.
- `auto-accept.schedule.value` (default: `30`)
	- `interval`: minutes between sends.
	- `daily`: target time in `HH:MM`.
	- `queue`: max-wait seconds per queue item.
- `auto-accept.schedule.prompt` (default: `Status report please`)
	- Prompt text for interval/daily mode.
- `auto-accept.schedule.prompts` (default: `[]`)
	- Ordered prompt list for queue mode.
- `auto-accept.schedule.queueMode` (`consume` | `loop`, default: `consume`)
	- `consume`: remove completed prompts.
	- `loop`: cycle through prompts continuously.
- `auto-accept.schedule.silenceTimeout` (default: `30`)
	- Idle seconds required before considering a queue task complete.

### Check Prompt

- `auto-accept.schedule.checkPrompt.enabled` (default: `false`)
	- Enables intermediate review/check prompt between queued prompts.
- `auto-accept.schedule.checkPrompt.text`
	- The exact intermediate instruction sent between queue items.

### CDP & Debug

- `auto-accept.cdp.port` (default: `9005`)
	- CDP port used by the extension (single configured port; no automatic port scanning fallback).
- `auto-accept.debugMode.enabled` (default: `false`)
	- Enables debug command/server tooling for automation and diagnostics.

## Debug & Testing Capabilities

The extension includes a debug server (`localhost:54321`) and extensive script-based testing helpers.

- Full state inspection and control via debug actions
- Browser-side JavaScript evaluation via CDP
- Settings panel UI automation bridge
- Queue state and prompt history inspection
- Log retrieval and diagnostics

See:

- [docs/DEBUG_TESTING.md](docs/DEBUG_TESTING.md)
- [docs/LIVE_CDP_DEBUGGING.md](docs/LIVE_CDP_DEBUGGING.md)
- [docs/SEND_MESSAGE_TRAE_TO_AGENT_CHAT.md](docs/SEND_MESSAGE_TRAE_TO_AGENT_CHAT.md)
- [docs/WORKFLOW.md](docs/WORKFLOW.md)

## Development

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run compile
```

Default test command:

```bash
npm test
```

Additional automation and diagnostic scripts are available under `test_scripts/`.

## Publishing

Package VSIX:

```bash
npm run package
```

Package for Open VSX:

```bash
npm run package:openvsx
```

Publish to Open VSX (requires token):

```bash
npm run publish:openvsx -- -p <OPEN_VSX_TOKEN>
```

If you'd like me to publish the extension I can run the above command — please provide an Open VSX personal token (keep it private). After you supply the token I will execute the publish step and confirm the listing.

## Recommended Production Setup

- Launch TRAE with `--remote-debugging-port=9005` (or your configured `auto-accept.cdp.port`)
- Keep Debug Mode OFF unless you actively need diagnostics
- Use `queueMode=consume` for deterministic execution histories
- Use check prompts for review gates, not for primary task content
- Keep banned command patterns aligned with your organization security policy

## License

MIT
