// The RPC error convention, in one place.
//
// methods.md v4: "Data field always carries { hint } written for the TUI to display
// verbatim." That is not decoration. The TUI's RpcError.hint is what screens render, so a
// hint that paraphrases the problem instead of naming the fix shows up as an unhelpful
// dialog in front of a user, and a MISSING hint shows up as a raw JSON-RPC message.
// Constructing errors anywhere else is how one of them ends up without a hint.

/** Standard JSON-RPC codes. */
export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;

/** Fixed by the contract: a spend-gated refusal, with the gate path in data.gate. */
export const ERR_SPEND_REFUSED = -32050;

/**
 * A contracted method whose backing capability has not shipped yet.
 *
 * Deliberately NOT -32601. A method-not-found says "this engine has no such method", which
 * for a frozen surface is a lie that sends the reader to the contract looking for a typo.
 * The TUI must be able to connect today and render honestly, which means every v4 method
 * answers, and the ones that cannot do the work yet say WHICH PHASE will make them work.
 *
 * -32001 sits in the JSON-RPC implementation-defined server-error range (-32000 to
 * -32099) and clear of -32050. The contract does not name a code for this case; it is
 * flagged to the leader as a line v5 should add.
 */
export const ERR_NOT_IMPLEMENTED = -32001;

export class RpcError extends Error {
  constructor(code, message, data = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    // Never ship an error without a hint: the TUI displays data.hint verbatim.
    this.data = { ...data, hint: data.hint || message };
  }

  toResponse(id) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: this.code, message: this.message, data: this.data } };
  }
}

export function invalidParams(message, hint) {
  return new RpcError(ERR_INVALID_PARAMS, message, { hint: hint || message });
}

/// A method that exists, is contracted, and cannot do the work yet. `phase` is required:
/// "not implemented" without a phase tells a user nothing about whether to wait or act.
export function notImplemented(method, phase, detail) {
  return new RpcError(ERR_NOT_IMPLEMENTED, `${method} is not implemented yet`, {
    method,
    phase,
    // "the frozen surface" rather than a version number: a hint that names v4 while the
    // contract is at v5 is a small lie that outlives every edit nobody thought to grep.
    hint: `${method} is part of the frozen RPC surface but its engine capability ships in ${phase}. ${detail || ''}`.trim(),
  });
}

/// A spend refusal. `gate` is the gate path when an owner gate is involved, and null when
/// the refusal is a missing per-call confirmation, which is the other refusal shape the
/// contract defines.
export function spendRefused(what, hint, gate = null) {
  return new RpcError(ERR_SPEND_REFUSED, `${what} is spend-touching and was refused`, { gate, hint });
}

/// Translate anything thrown into a response. An unexpected error still has to carry a
/// hint, and it must not leak a stack trace to a UI.
export function toErrorResponse(error, id, method) {
  if (error instanceof RpcError) return error.toResponse(id);
  // The gym's SpendRefusedError arrives with the contract's code and data already set.
  if (error?.code === ERR_SPEND_REFUSED && error?.data) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: ERR_SPEND_REFUSED, message: error.message, data: error.data } };
  }
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: ERR_INTERNAL,
      message: error?.message || 'engine error',
      data: { hint: `${method || 'The engine'} failed: ${error?.message || 'unknown error'}` },
    },
  };
}
