const COMMON_METHODS = Object.freeze([
  'latestUserTranscript',
  'getPending',
  'ensureWorkspace',
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

export function requiredBackendMethods(profile) {
  if (profile === 'voice-controller') return VOICE_METHODS;
  if (profile === 'work-reporter') return WORK_METHODS;
  throw new Error(`Unknown bridge-control profile: ${profile}`);
}

export function assertControlBackend(backend, profile) {
  if (!backend || typeof backend !== 'object') {
    throw new TypeError('A control backend is required');
  }
  const missing = requiredBackendMethods(profile).filter((method) => typeof backend[method] !== 'function');
  if (missing.length) {
    throw new TypeError(`Control backend is missing methods for ${profile}: ${missing.join(', ')}`);
  }
  return backend;
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
