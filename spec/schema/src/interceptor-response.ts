// Copyright (c) Microsoft. All rights reserved.

// interceptor-response.schema.json: the response envelope (§5.5).

import { Extensions } from "./common";
import { Verdict } from "./verdict";

/**
 * The envelope form: a verdict plus transport metadata.
 * @additionalProperties false
 */
export interface ResponseEnvelope {
  verdict: Verdict;
  /**
   * Opaque namespaced transport metadata (§4.6), including provider receipts
   * under extensions.<provider>.receipt. Canonical extensions are bounded at
   * 65536 bytes (§5.5).
   */
  extensions?: Extensions;
}

/**
 * Response envelope adopted under P-006 (Decided 2026-10-15) as part of the 0.1
 * contract (§5.5). Bare Verdict remains valid; transport metadata never changes
 * enforcement.
 * @title Agent Hooks — interceptor response
 */
export type InterceptorResponse = Verdict | ResponseEnvelope;
