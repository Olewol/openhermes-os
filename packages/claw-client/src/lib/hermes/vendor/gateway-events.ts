/**
 * OpenHermes OS: slim stand-in for Hermes' `apps/shared/src/gateway-events.ts` (+ the 7.6k-line
 * generated contract). Only the shapes the vendored JsonRpcGatewayClient needs are declared here;
 * event payloads are `unknown`-ish records and are narrowed in ../HermesEngine.ts.
 * Wire contract: ~/.hermes/hermes-agent/apps/shared/src/gateway-contract.openrpc.json (Hermes 0.23.2).
 * Based on Hermes Agent (MIT, Copyright (c) 2025 Nous Research).
 */

export type GatewayEventName = string

/** One `event` notification's `params` (envelope fields as stamped by tui_gateway/event_replay.py). */
export interface GatewayEvent<_K extends GatewayEventName = GatewayEventName> {
  replayed?: boolean
  replayEpoch?: string
  connectionId?: string
  authority_epoch?: number
  execution_generation?: number
  admission_id?: string
  replay_epoch?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any
  profile?: string
  seq?: number
  session_id?: string
  type: string
}

export interface ClientCapabilitiesResult {
  server_requests: string[]
  declines_not_shown?: boolean
  canonical_clarify_batch?: boolean
}
