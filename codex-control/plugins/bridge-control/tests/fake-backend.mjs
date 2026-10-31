export function createVoiceBackend(overrides = {}) {
  return {
    latestUserTranscript: async () => ({ turnId: 'turn-1', text: '创建任务' }),
    getPending: async () => null,
    ensureWorkspace: async ({ workspace }) => ({ status: 'exists', workspace, requiresConfigUpdate: false }),
    createWork: async () => ({ status: 'accepted', workId: 'work-1' }),
    findWork: async () => ({ candidates: [] }),
    getStatus: async () => ({ status: 'idle' }),
    sendMessage: async () => ({ status: 'accepted' }),
    readWork: async () => ({ items: [] }),
    readEvents: async () => ({ events: [], nextCursor: null }),
    resolveAnswer: async () => ({ status: 'accepted' }),
    resolveApproval: async () => ({ status: 'accepted' }),
    stopWork: async () => ({ status: 'accepted' }),
    ackAnnouncement: async () => ({ status: 'accepted' }),
    configureEventFiles: (eventFiles) => eventFiles,
    ...overrides,
  };
}

export function createWorkBackend(overrides = {}) {
  return {
    emitProgress: async () => ({ status: 'accepted' }),
    requestInput: async () => ({ status: 'pending', interactionId: 'question-1', binding: 'bind-q' }),
    requestApproval: async () => ({ status: 'pending', interactionId: 'approval-1', binding: 'bind-a' }),
    publishArtifact: async () => ({ status: 'accepted' }),
    finishWork: async () => ({ status: 'accepted' }),
    ...overrides,
  };
}
