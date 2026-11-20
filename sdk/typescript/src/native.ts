// Copyright (c) Microsoft. All rights reserved.

/**
 * Loader for the napi-rs native module + typed re-export.
 *
 * `@napi-rs/cli build` emits `agent-hooks.<platform>.node` alongside a
 * generated ESM `binding.js` loader; this module re-exports it with types and
 * the `AgentHooksCoreError` unwrapping so callers get `.code`.
 */

import * as binding from "../binding.js";

/** Thrown by every native function on failure. `.code` is the §11
 *  `host_error:*` wire string, or a §7.7.6 `declaration_error:*`
 *  string from the declaration functions (the detail is then JSON
 *  findings, which `declaration.ts` retypes as `DeclarationError`). */
export class AgentHooksCoreError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "AgentHooksCoreError";
  }
}

function wrap<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  return (...a: A) => {
    try {
      return fn(...a);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      const sep = msg.indexOf("\u001f");
      if (sep > 0) throw new AgentHooksCoreError(msg.slice(0, sep), msg.slice(sep + 1));
      throw e;
    }
  };
}

export const native = {
  canonicalJson: wrap(binding.canonicalJson),
  contextIdentity: wrap(binding.contextIdentity),
  validateVerdict: wrap(binding.validateVerdict),
  normalizeInterceptorResponse: wrap(binding.normalizeInterceptorResponse),
  validateEnvelope: wrap(binding.validateEnvelope),
  applyTransform: wrap(binding.applyTransform),
  applyTransformCtx: wrap(binding.applyTransformCtx),
  validateTransformCtx: wrap(binding.validateTransformCtx),
  finalize: wrap(binding.finalize),
  composeAggregate: wrap(binding.composeAggregate),
  controlFailureSubstitute: wrap(binding.controlFailureSubstitute),
  managedOutcome: wrap(binding.managedOutcome),
  ctkScriptedIntercept: wrap(binding.ctkScriptedIntercept),
  ctkScriptedResolve: wrap(binding.ctkScriptedResolve),
  ctkShouldSkip: wrap(binding.ctkShouldSkip),
  ctkAssert: wrap(binding.ctkAssert),
  declarationVersions: binding.declarationVersions,
  declarationValidate: wrap(binding.declarationValidate),
  declarationResolve: wrap(binding.declarationResolve),
  declarationResolveSurface: wrap(binding.declarationResolveSurface),
};
