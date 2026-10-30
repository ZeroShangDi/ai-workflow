const baseState = {
  mode: 'run',
  version: '0.1.0',
  currentState: 'IDLE',
  lastUpdated: '2026-01-01T00:00:00.000Z',
  plan: { summary: 'Factory test plan' },
  tasks: [],
  milestones: [],
};

export function createState(overrides = {}) {
  const state = JSON.parse(JSON.stringify(baseState));

  if (overrides.tasks) {
    state.tasks = overrides.tasks;
  }
  if (overrides.milestones) {
    state.milestones = overrides.milestones;
  }
  if (overrides.phase) {
    state.currentState = overrides.phase;
  }
  if (overrides.mode) {
    state.mode = overrides.mode;
  }
  if (overrides.version) {
    state.version = overrides.version;
  }

  return state;
}

export function createTask(overrides = {}) {
  return {
    id: overrides.id || 'T1',
    title: overrides.title || 'Test task',
    prompt: overrides.prompt || 'Do something',
    status: overrides.status || 'pending',
    deps: overrides.deps || [],
    ...overrides,
  };
}

export function createMilestone(overrides = {}) {
  return {
    id: overrides.id || 'M1',
    desc: overrides.desc || 'Test milestone',
    status: overrides.status || 'active',
    tasks: overrides.tasks || [],
    ...overrides,
  };
}
