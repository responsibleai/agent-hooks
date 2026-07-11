// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/**
 * Loader for the napi-rs native module + typed re-export.
 *
 * `@napi-rs/cli build` emits `agent-hooks.<platform>.node` alongside a
 * generated `index.js` loader; this module re-exports it with types and
 * the `AgentHooksCoreError` unwrapping so callers get `.code`.
 */

// napi-rs emits a platform-detecting loader at ../binding.js (see
// package.json scripts.build:native --js binding.js).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const binding = require("../binding.js") as {
  specVersion(): string;
  canonicalJson(valueJson: string): string;
  contextIdentity(ctxJson: string): string;
  validateVerdict(verdictJson: string): string;
  validateEnvelope(ctxJson: string): string;
  applyTransform(targetJson: string, path: string, valueJson: string): string;
  applyTransformCtx(ctxJson: string, path: string, valueJson: string): string;
  validateTransformCtx(ctxJson: string, path: string, valueJson: string): string;
  finalize(ctxJson: string, verdictJson: string, mode: string, optionsJson: string): string;
  composeAggregate(compositionJson: string, verdictsJson: string): string;
  ctkScriptedIntercept(rulesJson: string, ctxJson: string): string;
  ctkScriptedResolve(rulesJson: string, ctxJson: string, identity: string): string;
  ctkShouldSkip(vectorJson: string, capsJson: string): string;
  ctkAssert(vectorJson: string, recordedJson: string, runRecordJson: string): string;
};

/** Thrown by every native function on failure. `.code` is the §11
 *  `host_error:*` wire string. */
export class AgentHooksCoreError extends Error {
  constructor(
    public readonly code: string,
    detail: string,
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
  specVersion: binding.specVersion,
  canonicalJson: wrap(binding.canonicalJson),
  contextIdentity: wrap(binding.contextIdentity),
  validateVerdict: wrap(binding.validateVerdict),
  validateEnvelope: wrap(binding.validateEnvelope),
  applyTransform: wrap(binding.applyTransform),
  applyTransformCtx: wrap(binding.applyTransformCtx),
  validateTransformCtx: wrap(binding.validateTransformCtx),
  finalize: wrap(binding.finalize),
  composeAggregate: wrap(binding.composeAggregate),
  ctkScriptedIntercept: wrap(binding.ctkScriptedIntercept),
  ctkScriptedResolve: wrap(binding.ctkScriptedResolve),
  ctkShouldSkip: wrap(binding.ctkShouldSkip),
  ctkAssert: wrap(binding.ctkAssert),
};
