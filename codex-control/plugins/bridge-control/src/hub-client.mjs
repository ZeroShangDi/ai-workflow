const COMMON_METHODS = Object.freeze([
  'latestUserTranscript',
  'getPending',
]);

const VOICE_METHODS = Object.freeze([
  ...COMMON_METHODS,
  'createWork',
  'findWork',
  'getStatus',
  'sendMessage',
  'readWork',
  'readEvents',
  'resolveAnswer',
  'resolveApproval',
  'stopWork',
  'ackAnnouncement',
]);

const WORK_METHODS = Object.freeze([
  'emitProgress',
  'requestInput',
  'requestApproval',
  'publishArtifact',
  'finishWork',
]);

export function requiredHubMethods(profile) {
  if (profile === 'voice-controller') return VOICE_METHODS;
  if (profile === 'work-reporter') return WORK_METHODS;
  throw new Error(`Unknown bridge-control profile: ${profile}`);
}

export function assertHubClient(hub, profile) {
  if (!hub || typeof hub !== 'object') {
    throw new TypeError('A Hub client is required');
  }
  const missing = requiredHubMethods(profile).filter((method) => typeof hub[method] !== 'function');
  if (missing.length) {
    throw new TypeError(`Hub client is missing methods for ${profile}: ${missing.join(', ')}`);
  }
  return hub;
}

export function isUnknownResult(value) {
  return value?.status === 'unknown'
    || value?.outcome === 'unknown'
    || value?.result === 'unknown';
}

export function unknownWriteReceipt(idempotencyKey) {
  return {
    status: 'unknown',
    idempotencyKey,
    retryable: false,
    reconciliationRequired: true,
    message: 'The write result is unknown. Reconcile state before issuing another write.',
  };
}
