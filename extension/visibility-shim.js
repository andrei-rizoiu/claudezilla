/**
 * Claudezilla visibility shim
 *
 * Single-page apps driven by an agent (Teams, WhatsApp Web, Concur) pause
 * themselves when the page reports it is hidden or unfocused: virtual
 * lists stop rendering, loading stalls. The agent's window is rarely the
 * one the user is looking at, so this shim makes the page always see
 * itself as visible and focused:
 *
 *   - document.hidden → false, document.visibilityState → 'visible'
 *   - document.hasFocus() → true
 *   - visibilitychange, and blur / focus fired on the window or document,
 *     are stopped before any page listener runs
 *
 * It changes only what page scripts are told. It cannot make Firefox paint
 * a tab it is not painting; selecting the tab in a dedicated window
 * (background.js, bringToFrontInDedicatedWindow) handles that part.
 *
 * Runs at document_start in every frame of the hosts listed in
 * manifest.json, before any page script.
 */
(() => {
  const page = window.wrappedJSObject;
  if (!page || page.__claudezillaVisibilityShim) return;

  try {
    const docProto = page.Document.prototype;
    const getter = value => ({
      configurable: true,
      enumerable: true,
      get: exportFunction(function () { return value; }, window)
    });

    Object.defineProperty(docProto, 'hidden', getter(false));
    Object.defineProperty(docProto, 'visibilityState', getter('visible'));
    Object.defineProperty(docProto, 'hasFocus', {
      configurable: true,
      writable: true,
      value: exportFunction(function hasFocus() { return true; }, window)
    });

    Object.defineProperty(page, '__claudezillaVisibilityShim', { value: true });
  } catch (e) {
    console.log('[claudezilla] Visibility shim could not patch the page:', e.message);
    return;
  }

  // Registered at document_start, so these capture listeners run before
  // any listener the page adds.
  const swallow = event => event.stopImmediatePropagation();
  const swallowWindowLevel = event => {
    if (event.target === window || event.target === document) {
      event.stopImmediatePropagation();
    }
  };

  window.addEventListener('visibilitychange', swallow, true);
  document.addEventListener('visibilitychange', swallow, true);
  window.addEventListener('blur', swallowWindowLevel, true);
  window.addEventListener('focus', swallowWindowLevel, true);
})();
