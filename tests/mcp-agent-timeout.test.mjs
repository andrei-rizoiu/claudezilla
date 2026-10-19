import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentReaper,
  resolveAgentTimeout,
  DEFAULT_AGENT_TIMEOUT_MS,
} from '../mcp/agent-reaper.js';

describe('idle-agent reaper timeout policy', () => {
  it('an unset value still reaps at 600 000 ms', () => {
    const policy = resolveAgentTimeout({});

    assert.equal(policy.disabled, false);
    assert.equal(policy.timeoutMs, 600000);
    assert.equal(policy.timeoutMs, DEFAULT_AGENT_TIMEOUT_MS);
  });

  it('a positive value overrides the default', () => {
    const policy = resolveAgentTimeout({ CLAUDEZILLA_AGENT_TIMEOUT_MS: '3600000' });

    assert.equal(policy.disabled, false);
    assert.equal(policy.timeoutMs, 3600000);
  });

  it('CLAUDEZILLA_AGENT_TIMEOUT_MS=0 disables the reaper', () => {
    const policy = resolveAgentTimeout({ CLAUDEZILLA_AGENT_TIMEOUT_MS: '0' });

    assert.equal(policy.disabled, true);
  });
});

describe('idle-agent reaper behaviour', () => {
  function makeReaper({ env = {}, now = () => Date.now() } = {}) {
    const policy = resolveAgentTimeout(env);
    const cleaned = [];
    const reaper = createAgentReaper({
      timeoutMs: policy.timeoutMs,
      disabled: policy.disabled,
      now,
      onCleanup: async (agentId) => { cleaned.push(agentId); },
    });
    return { reaper, cleaned, policy };
  }

  it('with CLAUDEZILLA_AGENT_TIMEOUT_MS=0 the reaper sends no cleanupOrphanedTabs', async () => {
    let clock = 1_000_000;
    const { reaper, cleaned } = makeReaper({
      env: { CLAUDEZILLA_AGENT_TIMEOUT_MS: '0' },
      now: () => clock,
    });

    reaper.touch('agent-a');
    // Far beyond any timeout: a disabled reaper must still not clean up.
    clock += 24 * 60 * 60 * 1000;

    assert.deepEqual(await reaper.sweep(), []);
    assert.deepEqual(cleaned, []);
    assert.equal(reaper.start(), null, 'a disabled reaper must not schedule a sweep');
  });

  it('an unset value reaps an agent that has been silent for 600 000 ms', async () => {
    let clock = 1_000_000;
    const { reaper, cleaned } = makeReaper({ now: () => clock });

    reaper.touch('agent-a');
    clock += 599_999;
    assert.deepEqual(await reaper.sweep(), [], 'not yet idle enough');
    assert.deepEqual(cleaned, []);

    clock += 2;
    assert.deepEqual(await reaper.sweep(), ['agent-a']);
    assert.deepEqual(cleaned, ['agent-a']);
  });

  it('a heartbeat keeps the agent alive', async () => {
    let clock = 1_000_000;
    const { reaper, cleaned } = makeReaper({ now: () => clock });

    reaper.touch('agent-a');
    clock += 500_000;
    reaper.touch('agent-a');
    clock += 500_000;

    assert.deepEqual(await reaper.sweep(), []);
    assert.deepEqual(cleaned, []);
  });

  it('a failed cleanup is retried on the next sweep', async () => {
    let clock = 1_000_000;
    let attempts = 0;
    const policy = resolveAgentTimeout({ CLAUDEZILLA_AGENT_TIMEOUT_MS: '1000' });
    const reaper = createAgentReaper({
      timeoutMs: policy.timeoutMs,
      disabled: policy.disabled,
      now: () => clock,
      onCleanup: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('extension not connected');
      },
    });

    reaper.touch('agent-a');
    clock += 2000;

    await reaper.sweep();
    assert.equal(attempts, 1);

    await reaper.sweep();
    assert.equal(attempts, 2, 'a failed cleanup must be retried');
  });
});
