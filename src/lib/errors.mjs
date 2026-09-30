/**
 * Structured errors.
 *
 * Two families matter to an agent:
 *   - ToolError      : the agent asked for something impossible or wrong (bad selector,
 *                      no page attached). The message is written to be *self-correcting*:
 *                      it says what to do next, so the agent can retry without a human.
 *   - GuardrailError : the agent tried to do something we deliberately forbid. It carries
 *                      the rule id plus a safer alternative.
 */

export class ToolError extends Error {
  constructor(message, { hint, details } = {}) {
    super(message);
    this.name = 'ToolError';
    this.hint = hint;
    this.details = details;
  }
  toPayload() {
    return {
      error: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export class GuardrailError extends ToolError {
  constructor(message, { rule, hint, details } = {}) {
    super(message, { hint, details });
    this.name = 'GuardrailError';
    this.rule = rule;
  }
  toPayload() {
    return { ...super.toPayload(), guardrail: this.rule };
  }
}

export class ConnectionError extends ToolError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'ConnectionError';
  }
}

/** Wrap anything thrown into a ToolError so the MCP layer always has a payload. */
export function asToolError(err) {
  if (err instanceof ToolError) return err;
  const wrapped = new ToolError(err?.message ? String(err.message) : String(err));
  wrapped.cause = err;
  return wrapped;
}
