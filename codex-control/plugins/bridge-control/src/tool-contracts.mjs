const nullableString = { type: ['string', 'null'] };

const draftSchema = {
  type: 'object',
  properties: {
    project: { type: 'string', description: 'Omit to use the configured fixed workspace; set only when the user explicitly requests another project.' },
    request: { type: 'string' },
    title: { type: 'string' },
    cwd: { type: 'string' },
    agent: { type: 'string' },
  },
  additionalProperties: false,
};

const interactionProperties = {
  sessionId: { type: 'string' },
  interactionId: { type: 'string' },
  binding: { type: 'string' },
};

export const VOICE_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'bridge_chat_control_config_load',
    description: 'Load and validate an integration configuration from an absolute file path.',
    inputSchema: {
      type: 'object',
      properties: {
        configPath: { type: 'string', description: 'Absolute path to the integration JSON file' },
      },
      required: ['configPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_control_workspace_ensure',
    description: 'Check the configured workspace and return its stable project identity. Initialize the directory only when explicitly requested.',
    inputSchema: {
      type: 'object',
      properties: {
        createDirectory: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_create',
    description: 'Create or refine a work-creation draft. Completion never creates work before bridge_chat_confirm verifies the latest user transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        draftId: { type: 'string' },
        binding: { type: 'string' },
        draft: draftSchema,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_confirm',
    description: 'Resolve the pending create draft from the latest real user transcript. No model-supplied confirmation boolean is accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        draftId: { type: 'string' },
        binding: { type: 'string' },
      },
      required: ['sessionId', 'draftId', 'binding'],
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_find',
    description: 'Find bounded work or conversation candidates through CMB.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_status',
    description: 'Read current state, progress, pending interactions, and result summary for work.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        workId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_send',
    description: 'Send, queue, or steer a message without waiting for long-running completion.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        workId: { type: 'string' },
        text: { type: 'string', minLength: 1, maxLength: 100000 },
        mode: { type: 'string', enum: ['send', 'queue', 'steer'] },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_read',
    description: 'Read bounded work history, results, errors, or artifacts by stable cursors.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        workId: { type: 'string' },
        view: { type: 'string', enum: ['history', 'result', 'errors', 'activity', 'artifacts'] },
        before: nullableString,
        after: nullableString,
        maxChars: { type: 'integer', minimum: 1, maximum: 100000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_events',
    description: 'Read control events after a cursor, including notices announced by voice-control.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        after: nullableString,
        topics: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_pending',
    description: 'Read one pending question or approval with its immutable binding.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        interactionId: { type: 'string' },
      },
      required: ['sessionId', 'interactionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_answer',
    description: 'Submit explicit answers for one bound question interaction.',
    inputSchema: {
      type: 'object',
      properties: {
        ...interactionProperties,
        answers: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              questionId: { type: 'string' },
              text: { type: 'string', minLength: 1 },
            },
            required: ['questionId', 'text'],
            additionalProperties: false,
          },
        },
      },
      required: ['sessionId', 'interactionId', 'binding', 'answers'],
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_approve',
    description: 'Resolve one bound approval after the backend verifies the latest real user utterance.',
    inputSchema: {
      type: 'object',
      properties: {
        ...interactionProperties,
        decision: { type: 'string', enum: ['approve', 'reject'] },
      },
      required: ['sessionId', 'interactionId', 'binding', 'decision'],
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_stop',
    description: 'Stop or interrupt a running work item. This is separate from stopping the voice conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        workId: { type: 'string' },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
]);

export const WORK_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'bridge_chat_emit_progress',
    description: 'Append a bounded progress event for this work session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        text: { type: 'string', minLength: 1, maxLength: 4000 },
        percent: { type: 'number', minimum: 0, maximum: 100 },
        artifact: {
          type: 'object',
          properties: {
            artifactId: { type: 'string' },
            kind: { type: 'string' },
            uri: { type: 'string' },
            title: { type: 'string' },
          },
          required: ['artifactId', 'kind', 'uri'],
          additionalProperties: false,
        },
      },
      required: ['sessionId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_request_input',
    description: 'Create a pending question with stable question IDs and an immutable interaction binding.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              questionId: { type: 'string' },
              prompt: { type: 'string', minLength: 1 },
              kind: { type: 'string', enum: ['text', 'choice', 'confirmation'] },
              choices: { type: 'array', items: { type: 'string' } },
            },
            required: ['questionId', 'prompt'],
            additionalProperties: false,
          },
        },
        speak: { type: 'string' },
        expiresAt: nullableString,
      },
      required: ['sessionId', 'questions'],
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_request_approval',
    description: 'Create a bound approval request describing the operation, target, impact, and reversibility.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        operation: { type: 'string', minLength: 1 },
        target: { type: 'string', minLength: 1 },
        impact: { type: 'string', minLength: 1 },
        reversibility: { type: 'string', enum: ['reversible', 'irreversible', 'unknown'] },
        speak: { type: 'string', minLength: 1 },
        expiresAt: nullableString,
      },
      required: ['sessionId', 'operation', 'target', 'impact', 'reversibility', 'speak'],
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_publish_artifact',
    description: 'Register an existing artifact reference for later retrieval.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        artifact: {
          type: 'object',
          properties: {
            artifactId: { type: 'string' },
            kind: { type: 'string' },
            uri: { type: 'string' },
            title: { type: 'string' },
          },
          required: ['artifactId', 'kind', 'uri'],
          additionalProperties: false,
        },
      },
      required: ['sessionId', 'artifact'],
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_finish',
    description: 'Record a terminal work outcome with a stable result summary.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        outcome: { type: 'string', enum: ['completed', 'failed', 'interrupted', 'blocked'] },
        summary: { type: 'string', minLength: 1, maxLength: 12000 },
        resultRef: nullableString,
        artifactIds: { type: 'array', maxItems: 100, items: { type: 'string' } },
      },
      required: ['sessionId', 'outcome', 'summary'],
      additionalProperties: false,
    },
  },
]);

export const DEV_TOOL_DEFINITION = Object.freeze({
  name: 'bridge_chat',
  description: 'Development-only convenience for a simple CMB chat round trip. Never valid for confirmation, approval, or announcement handling.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      project: { type: 'string' },
      title: { type: 'string' },
      text: { type: 'string', minLength: 1, maxLength: 100000 },
      timeoutMs: { type: 'integer', minimum: 5000, maximum: 600000 },
    },
    required: ['text'],
    additionalProperties: false,
  },
});

export const HOST_TOOL_NAMES = Object.freeze(['bridge_chat_ack']);
