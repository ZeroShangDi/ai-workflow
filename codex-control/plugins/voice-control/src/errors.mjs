export class VoiceControlError extends Error {
  constructor(code, message, { status = 400, details = null, cause } = {}) {
    super(message, { cause });
    this.name = 'VoiceControlError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function publicError(error) {
  if (error instanceof VoiceControlError) {
    return {
      status: error.status,
      body: {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Internal server error',
      },
    },
  };
}
