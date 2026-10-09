// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/**
 * Reference in-memory agent + harness.
 *
 * The simplest possible conformant agent loop; exists so the
 * CTK can self-test without a real framework. Port of
 * `sdk/python/python/agent_hooks/ctk/reference.py`.
 *
 * Every emitter it builds goes through the host declaration loader
 * (§7.7): for a field-based vector it writes the vector's mode,
 * composition and provider into a copy of its own document
 * (`reference.declaration.json`) and binds the scripted interceptors
 * through a `ctk.instance` kind, so the field-based vectors exercise
 * the loader too.
 */

import { randomUUID } from "node:crypto";

import {
  ApprovalResolver,
  CompositionConfig,
  EnforcementMode,
  HostRegistry,
  HostSurface,
  Interceptor,
  InterceptionBlocked,
  JsonValue,
} from "../index";
import { AgentContextBuilder } from "../builder";
import { InterceptionEmitter } from "../emitter";
import type { Capability, Harness, RunOutcome, RunRecord, Scenario } from "./index";
import { redactPaths } from "./runner";
import referenceDeclaration from "./reference.declaration.json";

type ToolArgs = Record<string, JsonValue>;

/** The reference harness's own declaration (§7.7.9), with an explicit
 * surface a claim can cite. */
export const REFERENCE_DECLARATION: Readonly<Record<string, JsonValue>> = Object.freeze(
  referenceDeclaration as Record<string, JsonValue>,
);

export class ReferenceHarness implements Harness {
  readonly name = "reference-agent";
  // host_declaration: every emitter is built through the loader.
  // JSON.parse rounds integers beyond 2^53 before any guard can run,
  // so neither int64_json nor bigint_json is declared (§4.4).
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    "model_calls",
    "tool_calls",
    "host_declaration",
  ]);

  private scenario!: Scenario;
  private emitter!: InterceptionEmitter;
  private builder!: AgentContextBuilder;
  private toolLog: Array<{ name: string; args: ToolArgs }> = [];

  hostSurface(): HostSurface {
    return HostSurface.fromCapabilities(this.capabilities, "continue");
  }

  declaration(): JsonValue {
    return JSON.parse(JSON.stringify(REFERENCE_DECLARATION)) as JsonValue;
  }

  private startSession(scenario: Scenario, emitter: InterceptionEmitter): void {
    this.scenario = scenario;
    this.toolLog = [];
    this.emitter = emitter;
    this.builder = new AgentContextBuilder({
      agentId: "ref-agent",
      framework: "reference-agent",
      sessionId: randomUUID(),
    });
  }

  setup(
    scenario: Scenario,
    interceptors: Interceptor[],
    resolver: ApprovalResolver | null,
    mode: EnforcementMode,
    composition: CompositionConfig,
    identityProvider: 'jcs-sha256' | 'ctk-fault' | null,
    redactForApproval: string[] = [],
  ): void {
    // Field-based vector: write the vector's configuration into a copy
    // of the reference document and bind the interceptors by index
    // through the `ctk.instance` kind.
    const doc = this.declaration() as Record<string, JsonValue>;
    const cfg = doc["configuration"] as Record<string, JsonValue>;
    cfg["mode"] = mode;
    cfg["composition"] = composition as unknown as JsonValue;
    const registry = HostRegistry.forConformance(this.hostSurface());
    if (identityProvider === "ctk-fault") {
      // §13.2: "ctk-fault" is a custom provider that throws, pinning the
      // §10.1 provider-failure rule (deny context_invalid pre-dispatch).
      registry.identityProvider("ctk-fault", () => {
        throw new Error("ctk scripted provider fault");
      });
    }
    cfg["identity_provider"] = identityProvider;
    const approval: Record<string, JsonValue> = { resolver: null, redactor: null };
    if (resolver !== null) {
      registry.approvalResolver("ctk-scripted", resolver);
      approval["resolver"] = "ctk-scripted";
    }
    if (redactForApproval.length > 0) {
      const paths = [...redactForApproval];
      registry.approvalRedactor("ctk-redact", (ctx) => redactPaths(ctx, paths));
      approval["redactor"] = "ctk-redact";
    }
    cfg["approval"] = approval;

    const slots: Array<Interceptor | undefined> = [...interceptors];
    registry.kind("ctk.instance", (config, ctx) => {
      const index = (config as Record<string, JsonValue> | null)?.["index"];
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        throw new Error("config.index must be an unsigned integer");
      }
      const instance = slots[index];
      if (instance === undefined) {
        throw new Error(`no interceptor instance ${index} for binding ${ctx.id}`);
      }
      slots[index] = undefined;
      return instance;
    });
    doc["bindings"] = interceptors.map((_, i) => ({
      id: `interceptor-${i}`,
      kind: "ctk.instance",
      config: { index: i },
    }));
    this.startSession(scenario, InterceptionEmitter.fromDeclarationValue(doc, registry));
  }

  setupDeclared(scenario: Scenario, document: JsonValue, registry: HostRegistry): void {
    // A refusal (DeclarationError) propagates to the runner (§7.7.9).
    this.startSession(scenario, InterceptionEmitter.fromDeclarationValue(document, registry));
  }

  async run(): Promise<RunRecord> {
    const s = this.scenario;
    const em = this.emitter;
    const b = this.builder;
    let outcome: RunOutcome = "completed";
    let final: JsonValue | null = null;

    const tools = new Map((s.tools ?? []).map((t) => [t.name, t]));
    const invokeTool = (name: string, args: ToolArgs): { value: JsonValue; is_error: boolean } => {
      const spec = tools.get(name);
      if (!spec) throw new Error(`tool ${name} not in scenario`);
      for (const bh of spec.behavior) {
        if (!bh.when_args || JSON.stringify(bh.when_args) === JSON.stringify(args)) {
          return { value: bh.return, is_error: bh.is_error ?? false };
        }
      }
      throw new Error(`tool ${name} invoked with ${JSON.stringify(args)}: no matching behavior`);
    };

    try {
      await em.emit(b.agentStartup([...tools.keys()].sort()));
      await em.emit(b.input(s.input.content, s.input.role));

      let messages: Array<{ role: string; content: JsonValue }> = [
        { role: s.input.role, content: s.input.content },
      ];

      for (const step of s.model_script ?? []) {
        const resp = step.respond;
        const preCtx = b.preModelCall("mock", [...messages]);
        await em.emit(preCtx);
        messages = preCtx.messages as typeof messages;

        await em.emit(
          b.postModelCall("mock", resp.content, resp.tool_calls, resp.finish_reason),
        );

        if (resp.tool_calls.length > 0) {
          for (const tc of resp.tool_calls) {
            try {
              const preTc = b.preToolCall(tc.id, tc.name, { ...tc.args });
              await em.emit(preTc);
              const args = (preTc.tool_call as { args: ToolArgs }).args;
              const { value, is_error } = invokeTool(tc.name, args);
              this.toolLog.push({ name: tc.name, args: { ...args } });
              await em.emit(b.postToolCall(tc.id, tc.name, { ...args }, value, is_error));
              messages.push({ role: "tool", content: value });
            } catch (e) {
              if (e instanceof InterceptionBlocked) {
                messages.push({ role: "tool", content: `blocked: ${e.result.verdict.reason}` });
              } else {
                throw e;
              }
            }
          }
          messages.push({ role: "assistant", content: resp.content ?? "" });
        } else {
          final = resp.content;
          break;
        }
      }

      if (final !== null) {
        const outCtx = b.output(final);
        await em.emit(outCtx);
        final = (outCtx.output as { content: JsonValue }).content;
      }
    } catch (e) {
      if (e instanceof InterceptionBlocked) {
        outcome = "blocked";
        final = null;
      } else {
        throw e;
      }
    }

    await em.emitUnchecked(b.agentShutdown(outcome === "completed" ? "completed" : "error"));

    return {
      outcome,
      final_output: final,
      tool_invocations: this.toolLog,
      identities: em.records.map(
        (r) => [r.input_identity, r.enforced_identity] as [string | null, string | null],
      ),
      records: em.records as unknown as JsonValue[],
    };
  }

  teardown(): void {
    // no-op
  }
}
