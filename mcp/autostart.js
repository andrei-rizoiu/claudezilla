/**
 * Optional on-demand browser start.
 *
 * When CLAUDEZILLA_AUTOSTART_CMD is set and the host is not reachable, the
 * command is run once and the start waits for the host to bind its socket.
 * A browser that is used only for occasional unattended jobs (a headless
 * profile next to the user's main browser) then starts itself on the first
 * tool call instead of failing with "extension not connected".
 *
 * SECURITY: the command is never handed to a shell. It is an argv vector —
 * a JSON array, or a plain string split on whitespace — executed with
 * execFile(..., { shell: false }), so nothing in the environment can be
 * interpreted as shell syntax.
 *
 * The readiness probe is a connection attempt, not a file check: on Windows
 * the host socket is a named pipe, which is not a filesystem entry, so
 * fs.existsSync on it is always false.
 */

import { execFile } from 'node:child_process';
import { connect } from 'node:net';

export const DEFAULT_AUTOSTART_WAIT_MS = 45000;
export const DEFAULT_LAUNCH_TIMEOUT_MS = 20000;
export const DEFAULT_RETRY_COOLDOWN_MS = 60000;
const PROBE_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 1000;

/**
 * Parse the autostart command into an argv vector.
 *
 * A JSON array is the exact form and is preferred:
 *   CLAUDEZILLA_AUTOSTART_CMD='["systemctl","--user","start","claudezilla-bg"]'
 * A plain string is split on whitespace and is never interpreted by a shell:
 *   CLAUDEZILLA_AUTOSTART_CMD='systemctl --user start claudezilla-bg'
 *
 * @param {string|undefined} value
 * @returns {string[]|null} argv, or null when nothing is configured
 * @throws {Error} when the value is configured but cannot be parsed
 */
export function parseAutostartCommand(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`CLAUDEZILLA_AUTOSTART_CMD is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== 'string')) {
      throw new Error('CLAUDEZILLA_AUTOSTART_CMD must be a non-empty JSON array of strings');
    }
    return parsed;
  }

  const argv = trimmed.split(/\s+/).filter(Boolean);
  return argv.length ? argv : null;
}

/**
 * Probe the host socket with a connection attempt.
 *
 * A Windows named pipe is not a filesystem entry, so a file-existence check
 * can never succeed there; connecting can.
 *
 * @param {string} socketPath - Unix socket path or Windows named pipe
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<boolean>} true when the host accepted the connection
 */
export function probeHostSocket(socketPath, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (up) => {
      if (settled) return;
      settled = true;
      resolve(up);
    };

    let socket;
    try {
      socket = connect(socketPath);
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      socket.destroy();
      finish(false);
    }, timeoutMs);
    timer.unref?.();

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      finish(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Run an argv vector without a shell.
 *
 * @param {string[]} argv
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function runArgv(argv, { timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, shell: false }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || (err ? err.message : ''),
      });
    });
  });
}

/**
 * Compose a request failure with the autostart detail, so the user sees the
 * original "not connected" error and what the start command said.
 *
 * @param {Error} err - the original request error
 * @param {Error|null} startError - the autostart failure, if any
 * @returns {Error} the original error, with the autostart detail appended
 */
export function withAutostartDetail(err, startError) {
  if (!startError) return err;
  err.message = `${err.message}\n\n${startError.message}`;
  return err;
}

/**
 * Create the autostart controller.
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} options.socketPath - Host socket path or Windows named pipe
 * @param {(argv: string[], opts: {timeoutMs: number}) => Promise<{code: number, stdout: string, stderr: string}>} [options.runCommand]
 * @param {(socketPath: string) => Promise<boolean>} [options.probe]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(message: string) => void} [options.log]
 * @returns {{ensureStarted: () => Promise<{started: boolean, reason: string, stderr?: string}>, markHostDown: () => void, isConfigured: () => boolean, state: () => object}}
 */
export function createAutostart({
  env = process.env,
  socketPath,
  runCommand = runArgv,
  probe = probeHostSocket,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (message) => console.error(message),
} = {}) {
  const configured = env.CLAUDEZILLA_AUTOSTART_CMD || '';
  const waitMs = Number(env.CLAUDEZILLA_AUTOSTART_WAIT_MS) > 0
    ? Number(env.CLAUDEZILLA_AUTOSTART_WAIT_MS)
    : DEFAULT_AUTOSTART_WAIT_MS;
  const launchTimeoutMs = Number(env.CLAUDEZILLA_AUTOSTART_LAUNCH_TIMEOUT_MS) > 0
    ? Number(env.CLAUDEZILLA_AUTOSTART_LAUNCH_TIMEOUT_MS)
    : DEFAULT_LAUNCH_TIMEOUT_MS;
  const cooldownMs = Number(env.CLAUDEZILLA_AUTOSTART_RETRY_COOLDOWN_MS) >= 0
    ? Number(env.CLAUDEZILLA_AUTOSTART_RETRY_COOLDOWN_MS)
    : DEFAULT_RETRY_COOLDOWN_MS;

  let hostUp = null; // null = unknown, true = reachable, false = known down
  let launchPromise = null;
  let lastFailureAt = 0;

  function isConfigured() {
    return Boolean(configured.trim());
  }

  /** The host stopped answering: the next call re-probes and may re-launch. */
  function markHostDown() {
    hostUp = false;
  }

  async function launch() {
    const argv = parseAutostartCommand(configured);
    if (!argv) throw new Error('CLAUDEZILLA_AUTOSTART_CMD is not set');

    log(`[claudezilla] No host at ${socketPath}; starting browser: ${argv.join(' ')}`);

    let result;
    try {
      result = await runCommand(argv, { timeoutMs: launchTimeoutMs });
    } catch (e) {
      lastFailureAt = now();
      throw new Error(`Autostart command could not be run: ${e.message}`);
    }

    if (result.code !== 0) {
      lastFailureAt = now();
      throw new Error(
        `Autostart command failed (exit ${result.code})${result.stderr ? `: ${result.stderr.trim()}` : ''}`,
      );
    }

    // Wait for the host to bind its socket. The host is ready as soon as it
    // accepts a connection; the extension attaches to the host separately.
    const deadline = now() + waitMs;
    while (now() < deadline) {
      if (await probe(socketPath)) {
        hostUp = true;
        return;
      }
      await sleep(PROBE_INTERVAL_MS);
    }

    lastFailureAt = now();
    throw new Error(`Browser did not come up within ${waitMs} ms`);
  }

  /**
   * Make sure the host is running, launching it if needed.
   *
   * @returns {Promise<{started: boolean, reason: string, stderr?: string}>}
   */
  async function ensureStarted() {
    if (!isConfigured()) return { started: false, reason: 'not-configured' };

    if (hostUp === true) return { started: false, reason: 'already-running' };

    if (hostUp === null) {
      if (await probe(socketPath)) {
        hostUp = true;
        return { started: false, reason: 'already-running' };
      }
      hostUp = false;
    }

    // A launch is already running: wait for it instead of starting a second.
    if (launchPromise) {
      await launchPromise;
      return { started: true, reason: 'joined-launch' };
    }

    // A failed launch is not retried immediately: a browser that cannot start
    // would otherwise turn every tool call into another spawn.
    if (lastFailureAt && now() - lastFailureAt < cooldownMs) {
      return { started: false, reason: 'cooldown' };
    }

    launchPromise = launch().finally(() => { launchPromise = null; });
    try {
      await launchPromise;
    } catch (e) {
      return { started: false, reason: 'launch-failed', error: e, stderr: e.message };
    }
    return { started: true, reason: 'launched' };
  }

  function state() {
    return { configured: isConfigured(), hostUp, waitingForLaunch: Boolean(launchPromise) };
  }

  return { ensureStarted, markHostDown, isConfigured, state };
}
