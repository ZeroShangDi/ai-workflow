/** AWF failures stay inside the plugin; never reject a DSH lifecycle or event callback. */
export function createIsolation(log = () => {}) {
  function report(label, error) {
    try {
      log('warn', `${label}失败：${error?.message || String(error)}（仅降级 AWF 功能，DSH 继续运行）`);
    } catch { /* diagnostics must not become another host failure */ }
  }

  return function isolate(label, run, fallback) {
    try {
      const result = run();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).catch((error) => {
          report(label, error);
          return fallback;
        });
      }
      return result;
    } catch (error) {
      report(label, error);
      return fallback;
    }
  };
}
