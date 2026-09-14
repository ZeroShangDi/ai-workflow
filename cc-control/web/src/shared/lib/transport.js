// Composition boundary: pages always use the same client, regardless of transport.
let current = {
  fetch: (...args) => globalThis.fetch(...args),
  socket: url => new WebSocket(url),
  mode: 'live',
};
export function configureTransport(transport) { current = { ...current, ...transport }; }
export function getTransport() { return current; }
