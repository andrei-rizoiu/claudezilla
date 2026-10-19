/**
 * Idle-agent reaper.
 *
 * Tracks agent heartbeats and asks the extension to close the tabs of agents
 * that have been silent for longer than the timeout. The timeout comes from
 * CLAUDEZILLA_AGENT_TIMEOUT_MS (milliseconds); 0 disables the reaper
 * entirely, for setups where a person works inside a tab while the agent
 * stays idle, which otherwise looks identical to a crashed agent.
 */

export const DEFAULT_AGENT_TIMEOUT_MS = 600000; // 10 minutes
export const CLEANUP_INTERVAL_MS = 60000; // 1 minute between sweeps

/**
 * Resolve the idle-agent timeout policy.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{disabled: boolean, timeoutMs: number}} 0 disables the reaper
 */
export function resolveAgentTimeout(env = process.env) {
  const raw = Number(env.CLAUDEZILLA_AGENT_TIMEOUT_MS);
  if (raw === 0) return { disabled: true, timeoutMs: 0 };
  if (Number.isFinite(raw) && raw > 0) return { disabled: false, timeoutMs: raw };
  return { disabled: false, timeoutMs: DEFAULT_AGENT_TIMEOUT_MS };
}

/**
 * Create a reaper for idle agents.
 *
 * @param {object} options
 * @param {number} options.timeoutMs - Silence after which an agent is orphaned
 * @param {boolean} [options.disabled] - When true the reaper never reaps
 * @param {(agentId: string, idleMs: number) => Promise<unknown>} options.onCleanup
 * @param {() => number} [options.now] - Clock, injectable for tests
 * @param {number} [options.intervalMs] - Delay between sweeps
 * @returns {{touch: (agentId: string) => void, sweep: () => Promise<string[]>, start: () => object|null, stop: () => void}}
 */
export function createAgentReaper({
  timeoutMs,
  disabled = false,
  onCleanup,
  now = () => Date.now(),
  intervalMs = CLEANUP_INTERVAL_MS,
}) {
  const heartbeats = new Map(); // agentId -> lastSeenTimestamp

  /** Record that an agent is still alive. */
  function touch(agentId) {
    if (!agentId || agentId === 'unknown') return;
    heartbeats.set(agentId, now());
  }

  /**
   * Close the tabs of every agent that has been silent for too long.
   * @returns {Promise<string[]>} the agent ids that were reaped
   */
  async function sweep() {
    if (disabled) return [];
    const timestamp = now();
    const orphaned = [];
    for (const [agentId, lastSeen] of heartbeats.entries()) {
      if (timestamp - lastSeen > timeoutMs) {
        orphaned.push({ agentId, idleMs: timestamp - lastSeen });
      }
    }

    for (const { agentId, idleMs } of orphaned) {
      try {
        await onCleanup(agentId, idleMs);
        // Only forget the agent once its tabs were actually cleaned up, so a
        // failed sweep is retried on the next one.
        heartbeats.delete(agentId);
      } catch (error) {
        console.error(`[claudezilla] Error cleaning up orphaned agent ${agentId}:`, error.message);
      }
    }
    return orphaned.map(({ agentId }) => agentId);
  }

  let intervalId = null;

  /** Start the periodic sweep. A disabled reaper never schedules one. */
  function start() {
    if (disabled || intervalId) return intervalId;
    intervalId = setInterval(() => {
      sweep().catch((e) => console.error('[claudezilla] Cleanup error:', e));
    }, intervalMs);
    // .unref() so the process can exit naturally when the stdio transport
    // closes, without this interval pinning the event loop open.
    intervalId.unref?.();
    return intervalId;
  }

  /** Stop the periodic sweep. */
  function stop() {
    if (!intervalId) return;
    clearInterval(intervalId);
    intervalId = null;
  }

  return { touch, sweep, start, stop, heartbeats };
}
