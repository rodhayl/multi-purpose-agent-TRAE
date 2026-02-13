const assert = require('assert');
const { CDPHandler } = require('../main_scripts/cdp-handler');

console.log('\n=== CDPHandler Prompt Sending Tests ===\n');

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.log(`✗ ${name}`);
    console.error('  ', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  }
}

(async () => {
  await test('sendPrompt delegates to _sendPromptV2', async () => {
    const handler = new CDPHandler();
    // prepare a fake connection so sendPrompt doesn't short-circuit
    handler.connections = new Map();
    handler.connections.set('fake:1', { ws: {}, injected: true });

    let called = false;
    handler._sendPromptV2 = async () => { called = true; return 1; };

    const res = await handler.sendPrompt('hi');
    assert.strictEqual(called, true);
    assert.strictEqual(res, 1);
  });

  await test('sendPrompt falls back to overwrite when v2 returns 0', async () => {
    const handler = new CDPHandler();
    handler.connections = new Map();
    handler.connections.set('fake:1', { ws: {}, injected: true });

    let v2Calls = 0;
    let fallbackCalls = 0;
    handler._sendPromptV2 = async () => { v2Calls++; return 0; };
    handler._sendPromptOverwriteFallback = async () => { fallbackCalls++; return 1; };

    const res = await handler.sendPrompt('hi');
    assert.strictEqual(res, 1);
    assert.strictEqual(v2Calls, 1);
    assert.strictEqual(fallbackCalls, 1);
  });

  await test('_sendPromptV2 tries connections until one succeeds', async () => {
    const handler = new CDPHandler();
    // prepare fake connections
    handler.connections = new Map();
    handler.connections.set('c1', { ws: {}, injected: true, pageTitle: 'A - Trae' });
    handler.connections.set('c2', { ws: {}, injected: true, pageTitle: 'B - Trae' });

    const sendCalls = [];
    handler._evaluate = async (id, expression) => {
      // helper presence check (avoid counting as a send attempt)
      if (String(expression).startsWith('Boolean(')) {
        return { result: { value: true } };
      }

      // probe
      if (expression.includes('__autoAcceptProbePrompt')) {
        const probe = id === 'c1'
          ? { hasInput: true, score: 10, hasAgentPanel: false }
          : { hasInput: true, score: 5, hasAgentPanel: true };
        return { result: { value: JSON.stringify(probe) } };
      }

      // send attempt
      if (expression.includes('__autoAcceptSendPromptToConversation') || expression.includes('__autoAcceptSendPrompt')) {
        sendCalls.push(id);
        const ok = id === 'c2';
        return { result: { value: JSON.stringify({ ok, method: 'sendPromptToConversation', error: ok ? null : 'nope' }) } };
      }

      return { result: { value: JSON.stringify({}) } };
    };

    const res = await handler._sendPromptV2('test prompt', '');
    assert.strictEqual(res, 1);
    // Prefers hasAgentPanel even if score is lower.
    assert.deepStrictEqual(sendCalls, ['c2']);
  });

  await test('_sendPromptV2 prefers preferredTargetId over sticky target', async () => {
    const handler = new CDPHandler();
    handler.connections = new Map();
    handler.connections.set('c1', { ws: {}, injected: true, pageTitle: 'A - Trae' });
    handler.connections.set('c2', { ws: {}, injected: true, pageTitle: 'B - Trae' });

    handler.lastSuccessfulPromptTargetId = 'c2';
    handler.preferredTargetId = 'c1';

    const sendCalls = [];
    handler._evaluate = async (id, expression) => {
      if (String(expression).startsWith('Boolean(')) {
        return { result: { value: true } };
      }

      if (expression.includes('__autoAcceptProbePrompt')) {
        const probe = id === 'c1'
          ? { hasInput: true, score: 1, hasAgentPanel: false }
          : { hasInput: true, score: 999, hasAgentPanel: true };
        return { result: { value: JSON.stringify(probe) } };
      }

      if (expression.includes('__autoAcceptSendPromptToConversation') || expression.includes('__autoAcceptSendPrompt')) {
        sendCalls.push(id);
        return { result: { value: JSON.stringify({ ok: true, method: 'sendPromptToConversation' }) } };
      }

      return { result: { value: JSON.stringify({}) } };
    };

    const res = await handler._sendPromptV2('test prompt', '');
    assert.strictEqual(res, 1);
    assert.deepStrictEqual(sendCalls, ['c1']);
  });

  console.log('\nAll CDPHandler prompt sending tests done.');
})();
