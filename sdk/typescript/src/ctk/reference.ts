// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/**
 * Reference in-memory agent + harness.
 *
 * The simplest possible conformant agent loop; exists so the
 * CTK can self-test without a real framework. Port of
 * `sdk/python/python/agent_hooks/ctk/reference.py`.
 */

import { randomUUID } from "node:crypto";

import {
  ApprovalResolver,
  CompositionConfig,
  EnforcementMode,
  Interceptor,
  InterceptionBlocked,
  JsonValue,
} from "../index";
import { AgentContextBuilder } from "../builder";
import { InterceptionEmitter } from "../emitter";
import type { Capability, Harness, RunOutcome, RunRecord, Scenario } from "./index";

type ToolArgs = Record<string, JsonValue>;

export class ReferenceHarness implements Harness {
  readonly name = "reference-agent";
  readonly capabilities: ReadonlySet<Capability> = new Set(["model_calls", "tool_calls"]);

  private scenario!: Scenario;
  private emitter!: InterceptionEmitter;
  private builder!: AgentContextBuilder;
  private toolLog: Array<{ name: string; args: ToolArgs }> = [];

  setup(
    scenario: Scenario,
    interceptors: Interceptor[],
    resolver: ApprovalResolver | null,
    mode: EnforcementMode,
    composition: CompositionConfig,
    identityProvider: 'jcs-sha256' | 'ctk-fault' | null,
  ): void {
    this.scenario = scenario;
    this.toolLog = [];
    const em = new InterceptionEmitter(mode, resolver);
    em.setComposition(composition);
    // §13.2: "ctk-fault" is a custom provider that throws, pinning the
    // §10.1 provider-failure rule (deny context_invalid pre-dispatch).
    em.setIdentityProvider(
      identityProvider === 'ctk-fault'
        ? { name: 'ctk-fault', fn: () => { throw new Error('ctk scripted provider fault'); } }
        : identityProvider,
    );
    for (const i of interceptors) em.register(i);
    this.emitter = em;
    this.builder = new AgentContextBuilder({
      agentId: "ref-agent",
      framework: "reference-agent",
      sessionId: randomUUID(),
    });
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
