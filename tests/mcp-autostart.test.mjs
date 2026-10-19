import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAutostart,
  parseAutostartCommand,
  probeHostSocket,
  withAutostartDetail,
  DEFAULT_RETRY_COOLDOWN_MS,
} from '../mcp/autostart.js';

describe('autostart command parsing', () => {
  it('parses a JSON array into an exact argv vector', () => {
    const argv = parseAutostartCommand('["systemctl","--user","start","claudezilla-bg"]');

    assert.deepEqual(argv, ['systemctl', '--user', 'start', 'claudezilla-bg']);
  });

  it('splits a plain string on whitespace without shell interpretation', () => {
    const argv = parseAutostartCommand('systemctl --user start claudezilla-bg');

    assert.deepEqual(argv, ['systemctl', '--user', 'start', 'claudezilla-bg']);
  });

  it('never treats shell metacharacters as syntax', () => {
    const argv = parseAutostartCommand('echo hi; rm -rf /tmp/x && whoami');

    assert.deepEqual(argv, ['echo', 'hi;', 'rm', '-rf', '/tmp/x', '&&', 'whoami']);
    assert.ok(!argv.includes(';'), 'the semicolon is an argument, not a separator');
  });

  it('rejects a malformed JSON command', () => {
    assert.throws(() => parseAutostartCommand('["unterminated'), /not valid JSON/);
    assert.throws(() => parseAutostartCommand('[]'), /non-empty JSON array/);
    assert.throws(() => parseAutostartCommand('[1,2]'), /non-empty JSON array/);
  });

  it('returns null when nothing is configured', () => {
    assert.equal(parseAutostartCommand(undefined), null);
    assert.equal(parseAutostartCommand(''), null);
    assert.equal(parseAutostartCommand('   '), null);
  });
});

describe('host socket probe', () => {
  it('detects a listening host socket', async () => {
    const socketPath = join(tmpdir(), `cz-probe-${process.pid}-${Date.now()}.sock`);
    const server = createServer((socket) => socket.destroy());
    await new Promise((resolve) => server.listen(socketPath, resolve));

    try {
      assert.equal(await probeHostSocket(socketPath), true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(socketPath, { force: true });
    }
  });

  it('reports a missing socket as down', async () => {
    assert.equal(await probeHostSocket('/tmp/claudezilla-does-not-exist.sock'), false);
  });

  it('does not depend on the filesystem for a Windows named pipe', async () => {
    // A named pipe is not a filesystem entry: existsSync on it is always
    // false, so a file-based probe could never succeed on Windows. The probe
    // must be a connection attempt, and must not touch the filesystem.
    const source = readFileSync(new URL('../mcp/autostart.js', import.meta.url), 'utf8');
    assert.ok(!/from 'node:fs'/.test(source), 'the autostart module must not import the filesystem');
    assert.ok(!/existsSync\s*\(/.test(source), 'the autostart module must not call existsSync');

    assert.equal(await probeHostSocket('\\\\.\\pipe\\claudezilla'), false);
  });
});

describe('autostart controller', () => {
  function makeAutostart({ env = {}, probe, runCommand, now, sleep } = {}) {
    const calls = { commands: [], probes: 0 };
    let clock = 1_000_000;
    const controller = createAutostart({
      env: { CLAUDEZILLA_AUTOSTART_CMD: 'launch-browser', ...env },
      socketPath: '/tmp/claudezilla-test.sock',
      now: now ?? (() => clock),
      sleep: sleep ?? (async (ms) => { clock += ms; }),
      probe: async (path) => {
        calls.probes += 1;
        return probe ? probe(calls.probes, path) : false;
      },
      runCommand: async (argv, opts) => {
        calls.commands.push({ argv, opts });
        return runCommand ? runCommand(argv, opts, calls) : { code: 0, stdout: '', stderr: '' };
      },
      log: () => {},
    });
    return { controller, calls, advance: (ms) => { clock += ms; } };
  }

  it('does nothing when the variable is unset', async () => {
    const { controller, calls } = makeAutostart({ env: { CLAUDEZILLA_AUTOSTART_CMD: '' } });

    const result = await controller.ensureStarted();

    assert.deepEqual(result, { started: false, reason: 'not-configured' });
    assert.equal(calls.commands.length, 0);
  });

  it('concurrent calls share a single launch', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let hostIsUp = false;
    const { controller, calls } = makeAutostart({
      probe: () => hostIsUp,
      runCommand: async () => {
        await gate;
        hostIsUp = true;
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    const first = controller.ensureStarted();
    const second = controller.ensureStarted();
    release();
    const [a, b] = await Promise.all([first, second]);

    assert.equal(calls.commands.length, 1, 'the launch command must run once');
    assert.equal(a.started, true);
    assert.equal(b.started, true);
    assert.ok(['launched', 'joined-launch'].includes(b.reason));
  });

  it('does not re-run the command after a successful launch', async () => {
    let hostIsUp = false;
    const { controller, calls } = makeAutostart({
      probe: () => hostIsUp,
      runCommand: async () => {
        hostIsUp = true;
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    await controller.ensureStarted();
    assert.equal(calls.commands.length, 1);

    const second = await controller.ensureStarted();
    assert.equal(second.started, false);
    assert.equal(second.reason, 'already-running');
    assert.equal(calls.commands.length, 1, 'the command must not run again');
  });

  it('surfaces the launch stderr and does not respawn within the cooldown', async () => {
    const { controller, calls, advance } = makeAutostart({
      runCommand: async () => ({ code: 1, stdout: '', stderr: 'systemd: unit not found' }),
    });

    const result = await controller.ensureStarted();

    assert.equal(result.started, false);
    assert.equal(result.reason, 'launch-failed');
    assert.match(result.stderr, /unit not found/);
    assert.equal(calls.commands.length, 1);

    // Inside the cooldown: no second spawn.
    advance(DEFAULT_RETRY_COOLDOWN_MS - 1000);
    const during = await controller.ensureStarted();
    assert.equal(during.reason, 'cooldown');
    assert.equal(calls.commands.length, 1, 'a failed start must not become a spawn storm');

    // After the cooldown a new attempt is allowed.
    advance(2000);
    await controller.ensureStarted();
    assert.equal(calls.commands.length, 2);
  });

  it('gives up after the wait window and reports it', async () => {
    const { controller } = makeAutostart({
      env: { CLAUDEZILLA_AUTOSTART_WAIT_MS: '1000' },
      probe: () => false,
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    });

    const result = await controller.ensureStarted();

    assert.equal(result.started, false);
    assert.equal(result.reason, 'launch-failed');
    assert.match(result.stderr, /did not come up within 1000 ms/);
  });

  it('re-probes after the host goes down', async () => {
    let hostIsUp = false;
    const { controller, calls } = makeAutostart({
      probe: () => hostIsUp,
      runCommand: async () => {
        hostIsUp = true;
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    await controller.ensureStarted();
    assert.equal(calls.commands.length, 1);

    // The host dies: the next call must notice and start it again.
    hostIsUp = false;
    controller.markHostDown();
    await controller.ensureStarted();

    assert.equal(calls.commands.length, 2);
  });

  it('composes the original error with the autostart detail', () => {
    const original = new Error('Claudezilla connection refused.');
    const startError = new Error('Autostart command failed (exit 1): boom');

    const composed = withAutostartDetail(original, startError);

    assert.match(composed.message, /connection refused/);
    assert.match(composed.message, /boom/);
    assert.equal(withAutostartDetail(original, null), original);
  });
});
