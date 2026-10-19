import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// Load order mirrors extension/manifest.json content_scripts:
// ["pointer-click.js", "content.js"] — one sandbox, shared globals.
const pointerClickSource = readFileSync(new URL('../extension/pointer-click.js', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');

const HANG_GUARD_MS = 5000;

/**
 * Harness for a tab the compositor is not painting: requestAnimationFrame
 * callbacks are never run, so any unbounded frame wait never settles.
 */
function createUnpaintedTabHarness() {
  let runtimeListener = null;

  const browser = {
    runtime: {
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        },
      },
    },
    storage: {
      local: {
        async get() { return {}; },
      },
      onChanged: {
        addListener() {},
      },
    },
  };

  const mockDocument = {
    title: 'Unpainted Tab Test',
    readyState: 'complete',
    head: { appendChild() {}, querySelector() { return null; } },
    body: { appendChild() {}, removeChild() {} },
    documentElement: { scrollHeight: 2000 },
    importNode(node) { return node; },
    createElement() {
      return {
        style: {},
        dataset: {},
        setAttribute() {},
        getAttribute() { return null; },
        appendChild() {},
        removeChild() {},
        addEventListener() {},
        removeEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
        attachShadow() {
          return {
            appendChild() {},
            querySelector() { return null; },
            querySelectorAll() { return []; },
          };
        },
      };
    },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };

  const windowObj = {
    location: { href: 'https://example.com/unpainted' },
    innerWidth: 1024,
    innerHeight: 768,
    scrollX: 0,
    scrollY: 0,
    addEventListener() {},
    removeEventListener() {},
  };
  windowObj.window = windowObj;
  windowObj.top = windowObj;

  const context = vm.createContext({
    browser,
    window: windowObj,
    document: mockDocument,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    // Firefox never fires these in an unpainted tab.
    requestAnimationFrame: () => {},
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    DOMParser: class {
      parseFromString() {
        return {
          documentElement: {
            querySelector() { return null; },
            querySelectorAll() { return []; },
          },
        };
      }
    },
  });

  vm.runInContext(pointerClickSource, context);
  vm.runInContext(contentSource, context);

  return {
    context,
    runtimeListener,
  };
}

describe('bounded animation-frame waits in an unpainted tab', () => {
  it('smartQuerySelector resolves when requestAnimationFrame never fires', async () => {
    const { context } = createUnpaintedTabHarness();

    const outcome = await Promise.race([
      context.smartQuerySelector('#never-present', { timeout: 300 }).then(
        (el) => (el === null ? 'resolved' : 'resolved-with-element'),
        (err) => `threw: ${err.message}`,
      ),
      new Promise((resolve) => setTimeout(() => resolve('hung'), HANG_GUARD_MS)),
    ]);

    assert.equal(outcome, 'resolved', 'smartQuerySelector must not wait for an animation frame that never fires');
  });

  it('checkPageReadiness resolves when requestAnimationFrame never fires', async () => {
    const { context } = createUnpaintedTabHarness();

    const outcome = await Promise.race([
      context.checkPageReadiness().then(
        (result) => (result && typeof result.rafWaitMs === 'number' ? 'resolved' : 'resolved-without-metrics'),
        (err) => `threw: ${err.message}`,
      ),
      new Promise((resolve) => setTimeout(() => resolve('hung'), HANG_GUARD_MS)),
    ]);

    assert.equal(outcome, 'resolved', 'checkPageReadiness must not wait for an animation frame that never fires');
  });
});
