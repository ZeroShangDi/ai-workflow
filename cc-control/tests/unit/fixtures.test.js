import { describe, it, expect } from 'vitest';
import { createState, createTask, createMilestone } from '../fixtures/state-factory.js';

describe('state factory', () => {
  it('should create a default state', () => {
    const state = createState();
    expect(state.mode).toBe('run');
    expect(state.currentState).toBe('IDLE');
    expect(state.plan.tasks).toEqual([]);
  });

  it('should create a state with custom tasks', () => {
    const task = createTask({ id: 'T1', desc: 'Test', status: 'active' });
    const state = createState({ tasks: [task] });
    expect(state.plan.tasks).toHaveLength(1);
    expect(state.plan.tasks[0].id).toBe('T1');
  });

  it('should create a state with custom milestones', () => {
    const milestone = createMilestone({ id: 'M1', tasks: ['T1'] });
    const state = createState({ milestones: [milestone] });
    expect(state.milestones).toHaveLength(1);
    expect(state.milestones[0].id).toBe('M1');
  });

  it('should create a state with custom phase', () => {
    const state = createState({ phase: 'CODE' });
    expect(state.currentState).toBe('CODE');
  });

  it('should create a task with defaults', () => {
    const task = createTask({ id: 'T2' });
    expect(task.id).toBe('T2');
    expect(task.status).toBe('pending');
    expect(task.complexity).toBe('simple');
    expect(task.deps).toEqual([]);
  });
});
