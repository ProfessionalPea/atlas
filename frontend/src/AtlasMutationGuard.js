// The intelligence layer injects one navigation button into Atlas's existing
// React-owned nav. Ignore mutations that happen *inside that injected button*
// so re-rendering its icon/active state cannot trigger its own observer again.
// All other MutationObserver records pass through untouched.
if (typeof window !== 'undefined' && window.MutationObserver && !window.__atlasMutationGuardInstalled) {
  window.__atlasMutationGuardInstalled = true;
  const NativeMutationObserver = window.MutationObserver;

  class AtlasMutationObserver extends NativeMutationObserver {
    constructor(callback) {
      super((records, observer) => {
        const meaningful = records.filter(record => {
          const target = record.target;
          const element = target?.nodeType === 1 ? target : target?.parentElement;
          return !element?.closest?.('[data-atlas-video-library="1"]');
        });
        if (meaningful.length) callback(meaningful, observer);
      });
    }
  }

  window.MutationObserver = AtlasMutationObserver;
}
