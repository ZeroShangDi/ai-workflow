// Addresses only. HTTP/WS implementation belongs to shared/lib/http.js.
export const API = Object.freeze({
  status: '/status',
  snapshot: '/status?snapshot=1',
  state: '/awf/state',
  runs: '/run/status',
  events: '/run/events',
  submitRun: '/run/submit',
  workflowMode: '/run/state/mode',
  send: '/send',
  respond: '/respond',
  stop: '/stop',
  decisions: '/awf/decisions',
  proposals: '/awf/dynamic-planning/proposals',
  metrics: '/awf/metrics',
  diagnostics: '/awf/diagnostics',
  eventPage: (cursor, limit = 500) => `/run/events?afterSeq=${cursor}&limit=${limit}`,
  resolveDecision: id => `/awf/decisions/${encodeURIComponent(id)}/resolve`,
  overrideDecision: id => `/awf/decisions/${encodeURIComponent(id)}/override`,
  approveProposal: id => `/run/dynamic-planning/proposals/${encodeURIComponent(id)}/approve`
});
