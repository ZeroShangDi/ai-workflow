import { useEffect, useRef } from 'react';

// One request cycle at a time. Timer begins after settlement; unmount aborts reads.
export function usePolling(callback, { enabled = true, interval = 2500, revision = 0 } = {}) {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  }, [callback]);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false,
      timer;
    const controller = new AbortController();
    async function tick() {
      try {
        await latest.current(controller.signal);
      } finally {
        if (!disposed) timer = setTimeout(tick, interval);
      }
    }
    tick();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, interval, revision]);
}
