import { createMockServer } from './server.js';
import { configureTransport } from '../src/shared/lib/transport.js';

export function startMock() {
  const scenario = new URLSearchParams(location.search).get('scenario') || 'demo';
  const server = createMockServer({ scenario });
  const timer = setInterval(() => server.advance(), 3000);
  configureTransport({
    mode: 'mock',
    async fetch(input, options = {}) {
      options.signal?.throwIfAborted();
      await new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(delay); reject(options.signal.reason); };
        const delay = setTimeout(() => { options.signal?.removeEventListener('abort', cancel); resolve(); }, 100);
        options.signal?.addEventListener('abort', cancel, { once: true });
      });
      options.signal?.throwIfAborted();
      const result = server.handle(input, { method: options.method, body: options.body ? JSON.parse(options.body) : {} });
      return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
    },
    socket(input) {
      const url = new URL(input);
      const socket = { readyState: 0, close() { unsubscribe(); socket.readyState = 3; socket.onclose?.({}); }, send() {} };
      const unsubscribe = server.subscribe((project, event) => {
        if (socket.readyState === 1 && (!url.searchParams.get('p') || project === url.searchParams.get('p'))) socket.onmessage?.({ data: JSON.stringify(event) });
      });
      queueMicrotask(() => { if (socket.readyState === 0) { socket.readyState = 1; socket.onopen?.({}); } });
      return socket;
    },
  });
  return { scenario: server.scenario, advance: server.advance, stop: () => clearInterval(timer) };
}
