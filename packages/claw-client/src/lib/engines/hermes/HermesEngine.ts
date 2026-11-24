/**
 * HermesEngine — OpenHermes OS transport adapter.
 *
 * Replaces OpenClawEngine. Same public surface (so the hooks/UI keep working), but every RPC
 * goes through Hermes' own JSON-RPC gateway (JsonRpcGatewayClient, vendored in ../../hermes/vendor)
 * over `/api/ws` — reached through scripts/hermes-bridge.mjs, which does login + ws-ticket.
 *
 * Method map (OpenClaw → Hermes), details in docs/HERMES.md:
 *   chat.send           → prompt.submit            (status streaming|queued|steered|redirected)
 *   chat.abort          → session.interrupt
 *   chat.history        → session.resume (messages[])   [session.history for older pages]
 *   sessions.list       → session.list
 *   sessions.create     → session.create
 *   sessions.delete     → session.delete
 *   sessions.patch label→ session.title
 *   sessions.reset      → session.create (fresh) — Hermes has no in-place reset
 *   sessions.compact    → session.compress
 *   agent/chat events   → message.* / reasoning.* / tool.* / approval.* / error events
 *   openclawos.apps, artifacts, uploads, notifications, cron, tools.invoke → local stubs
 */
import { ERROR_SENTINEL } from "@/lib/chat/history-merger";
import type { AssistantTimelineSegment } from "@/lib/chat/timeline";
import { encodeAssistantTimelineSegment } from "@/lib/chat/timeline";
import type { CronJobRecord, CronRunEntry, CronStatusRecord } from "@/lib/cron";
import { ConnectionState } from "@/lib/gateway/types";
import type { GatewayEvent } from "@/lib/hermes/vendor/gateway-events";
import { JsonRpcGatewayClient } from "@/lib/hermes/vendor/json-rpc-gateway";
import type { NotificationRecord } from "@/lib/notifications";
import type { Settings } from "@/lib/storage";
import { getSettings } from "@/lib/storage";
import type { ClawThreadListItem, ModelChoice, SessionRow } from "@/types/gateway-responses";
import { EventType } from "@openuidev/react-headless";
import type {
  AgentInfo,
  AppRecord,
  AppStore,
  AppSummary,
  ArtifactRecord,
  ArtifactStore,
  ArtifactSummary,
  ConversationStore,
  Engine,
  EngineCapabilities,
  GatewayCommand,
  ModelInfo,
  SessionInfo,
  StoredMessage,
  UploadMeta,
  UploadRecord,
  UploadStore,
} from "../types";

const log = (...args: unknown[]) => console.info("[claw:hermes-engine]", ...args);
const warn = (...args: unknown[]) => console.warn("[claw:hermes-engine]", ...args);

/** The single synthetic "agent" the UI shows. Hermes has profiles, not OpenClaw-style agents. */
export const HERMES_AGENT_ID = "hermes";
const MAIN_SESSION_STORAGE_KEY = "openhermes.mainStoredSession";

export const DEFAULT_BRIDGE_PATH = "/hermes/ws";
export const DEFAULT_BRIDGE_PORT = 18791;

/** Default bridge URL: same host the page was served from, bridge port. */
export function defaultBridgeUrl(): string {
  if (typeof window === "undefined")
    return `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}${DEFAULT_BRIDGE_PATH}`;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.hostname}:${DEFAULT_BRIDGE_PORT}${DEFAULT_BRIDGE_PATH}`;
}

/** Hermes threads are addressed by their stored session id; no key encoding. */
export function resolveChatSessionKey(threadId: string, _agentIds?: Set<string>): string {
  return threadId;
}

export interface CompactSessionResult {
  ok: boolean;
  compacted: boolean;
  tokensBefore: number | null;
  tokensAfter: number | null;
  reason: string | null;
}

export interface HermesEngineConfig {
  id: string;
  name: string;
  enabled: boolean;
  gatewayUrl: string;
}

export interface HermesApprovalRequest {
  sessionId: string; // stored thread id
  requestId: string;
  command?: string;
  description?: string;
  toolName?: string | null;
  choices?: string[];
}

export interface HermesEngineEvents {
  onConnectionStateChange: (state: ConnectionState) => void;
  onPairingRequired: (deviceId: string | null) => void;
  onAuthFailed: () => void;
  onSettingsChanged: (settings: Settings) => void;
  onSessionMetaChanged: (meta: Map<string, SessionRow>) => void;
  onModelsChanged: (models: ModelChoice[]) => void;
  onModelDefaultsChanged: (defaults: {
    workspaceDefault: string | null;
    byAgent: Map<string, string>;
    defaultAgentId: string | null;
  }) => void;
  onKnownAgentIdsChanged: (ids: Set<string>) => void;
  onSessionChanged: (sessionKey: string) => void;
  onCronChanged: () => void;
  /** Optional: an approval card should be shown. */
  onApprovalRequest?: (req: HermesApprovalRequest) => void;
}

// ── Hermes wire shapes (subset of gateway-contract.generated.ts) ─────────────
interface TranscriptRow {
  role: string;
  text?: string | null;
  content?: unknown;
  tool_call_id?: string | null;
  timestamp?: number | null;
  row_id?: number | null;
  name?: string | null;
  context?: string | null;
  args?: unknown;
  reasoning?: string | null;
}
interface SessionLiveInfo {
  model?: string;
  provider?: string;
  [k: string]: unknown;
}
interface SessionCreateResult {
  session_id: string;
  stored_session_id: string;
  messages?: TranscriptRow[];
  info?: SessionLiveInfo;
}
interface SessionResumeResult {
  session_id: string;
  messages?: TranscriptRow[];
  info?: SessionLiveInfo;
  session_key?: string;
  running?: boolean;
}
interface SessionListRow {
  id: string;
  title?: string;
  preview?: string;
  started_at?: number;
  message_count?: number;
  source?: string;
}

interface RunListener {
  onEvent: (event: GatewayEvent) => void;
  onClose: () => void;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function rowTitle(row: SessionListRow): string {
  const t = (row.title ?? "").trim();
  if (t) return t;
  const p = (row.preview ?? "").trim();
  if (p) return p.length > 60 ? `${p.slice(0, 60)}…` : p;
  return row.id;
}

/** Collapse Hermes transcript rows into UI messages (assistant+tool rows → one assistant bubble). */
export function transcriptToStored(rows: TranscriptRow[]): StoredMessage[] {
  const out: StoredMessage[] = [];
  let cur: Extract<StoredMessage, { role: "assistant" }> | null = null;
  const flush = () => {
    if (cur) {
      out.push(cur);
      cur = null;
    }
  };
  const ensure = (id: string) => {
    if (!cur) cur = { id, role: "assistant", content: "", timeline: [], toolCalls: [] };
    return cur;
  };
  rows.forEach((r, i) => {
    const id = r.row_id != null ? `row-${r.row_id}` : `idx-${i}`;
    if (r.role === "user") {
      flush();
      out.push({ id, role: "user", content: r.text ?? stringify(r.content) });
    } else if (r.role === "assistant") {
      const a = ensure(id);
      if (r.reasoning) a.timeline!.push({ type: "reasoning", text: r.reasoning });
      const text = (r.text ?? "").trim();
      if (text) {
        // earlier text in the same turn (text next to tool calls) → superseded draft
        if (a.content) a.timeline!.push({ type: "assistant_update", text: a.content });
        a.content = text;
      }
    } else if (r.role === "tool") {
      const a = ensure(id);
      const callId = r.tool_call_id ?? `tool-${i}`;
      const args = stringify(r.args ?? {});
      a.timeline!.push({ type: "tool_call", toolCallId: callId, toolName: r.name ?? "tool", args });
      a.toolCalls!.push({
        id: callId,
        type: "function",
        function: { name: r.name ?? "tool", arguments: args },
      });
      // Hermes' projected history carries the call (name/context/args) but not the result text.
      a.timeline!.push({
        type: "tool_result",
        toolCallId: callId,
        output: r.context ? `(${r.context})` : "(result not included in Hermes history)",
      });
    }
  });
  flush();
  return out.map((m) => {
    if (m.role !== "assistant") return m;
    const { timeline, toolCalls, ...rest } = m;
    return {
      ...rest,
      ...(timeline?.length ? { timeline } : {}),
      ...(toolCalls?.length ? { toolCalls } : {}),
    } as StoredMessage;
  });
}

export class HermesEngine implements Engine {
  readonly id: string;

  readonly capabilities: EngineCapabilities = {
    loadSession: true,
    listSessions: true,
    deleteSessions: true,
    multiAgent: false,
    sessionConfig: true,
    artifacts: false, // stub
    apps: false, // stub
    uploads: false, // stub
  };

  private client: JsonRpcGatewayClient | null = null;
  private gatewayUrl: string;
  private events: HermesEngineEvents;
  private _connectionState: ConnectionState = ConnectionState.DISCONNECTED;
  private _sessionMeta = new Map<string, SessionRow>();
  private _availableModels: ModelChoice[] = [];
  private _settings: Settings | null;

  private liveByStored = new Map<string, string>();
  private storedByLive = new Map<string, string>();
  private runListeners = new Map<string, RunListener>(); // key: live session id
  private pendingApprovals = new Map<string, HermesApprovalRequest>(); // key: stored
  private offEvent: (() => void) | null = null;
  private offState: (() => void) | null = null;

  private _isReady = false;
  private _readyDeferred: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (e: Error) => void;
  } | null = null;

  private get _engineReady(): Promise<void> {
    if (this._isReady) return Promise.resolve();
    if (!this._readyDeferred) {
      let resolve!: () => void, reject!: (e: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      promise.catch(() => {});
      this._readyDeferred = { promise, resolve, reject };
    }
    return this._readyDeferred.promise;
  }

  constructor(config: HermesEngineConfig, events: HermesEngineEvents) {
    this.id = config.id;
    this.gatewayUrl = config.gatewayUrl || defaultBridgeUrl();
    this._settings = getSettings() ?? { gatewayUrl: this.gatewayUrl };
    this.events = events;
  }

  // ── Stores ───────────────────────────────────────────────────────────────

  readonly conversations: ConversationStore = {
    listSessions: () => this._listSessions(),
    getSession: (id) => this._getSession(id),
    createSession: (agentId, title) => this._createSessionRecord(agentId, title),
    deleteSession: (id) => this._deleteSessionRecord(id),
    renameSession: (id, title) => this._renameSessionRecord(id, title),
    loadHistory: (id) => this._loadHistory(id),
    getSessionConfig: (id) => this._getSessionConfig(id),
    setSessionConfig: (id, key, value) => this._setSessionConfig(id, key, value),
  };

  // STUB: openclawos.artifacts has no Hermes counterpart (phase 2: plugin-backed store).
  readonly artifacts: ArtifactStore = {
    listArtifacts: async (): Promise<ArtifactSummary[]> => [],
    getArtifact: async (): Promise<ArtifactRecord | null> => null,
    deleteArtifact: async () => {},
  };

  // STUB: openclawos.apps has no Hermes counterpart (phase 2: plugin-backed store).
  readonly apps: AppStore = {
    listApps: async (): Promise<AppSummary[]> => [],
    getApp: async (): Promise<AppRecord | null> => null,
    deleteApp: async () => {},
    // STUB: tools.invoke — Hermes exposes tools to the agent, not to the browser.
    invokeTool: async (tool: string) => {
      throw new Error(`tools.invoke("${tool}") is not available through the Hermes gateway (stub)`);
    },
  };

  // STUB: uploads — local no-ops; Hermes takes files via image.attach/input.detect_drop (phase 2).
  readonly uploads: UploadStore = {
    putUpload: async (): Promise<UploadMeta | null> => null,
    listUploads: async (): Promise<UploadMeta[]> => [],
    getUpload: async (): Promise<UploadRecord | null> => null,
    deleteUpload: async () => {},
  };

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this._setConnectionState(ConnectionState.CONNECTING);
    const client = new JsonRpcGatewayClient({ requestIdPrefix: "ohos", requestTimeoutMs: 120_000 });
    this.client = client;
    this.offEvent = client.onAny((e) => this._handleEvent(e));
    this.offState = client.onState((s) => {
      if (s === "open") return; // CONNECTED is announced on gateway.ready
      if (s === "connecting") this._setConnectionState(ConnectionState.CONNECTING);
      else if (s === "error") this._setConnectionState(ConnectionState.UNREACHABLE);
      else if (s === "closed") {
        this._isReady = false;
        this._setConnectionState(ConnectionState.DISCONNECTED);
      }
    });
    try {
      await client.connect(this.gatewayUrl);
    } catch (e) {
      warn("connect failed:", e);
      this._setConnectionState(ConnectionState.UNREACHABLE);
    }
  }

  async disconnect(): Promise<void> {
    this._isReady = false;
    this._readyDeferred?.reject(new Error("disconnected"));
    this._readyDeferred = null;
    this.offEvent?.();
    this.offState?.();
    this.client?.close();
    this.client = null;
  }

  reconnect(newSettings: Settings): void {
    this._settings = newSettings;
    if (newSettings.gatewayUrl) this.gatewayUrl = newSettings.gatewayUrl;
    this.events.onSettingsChanged(newSettings);
    void this.disconnect().then(() => this.connect());
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }
  get settings(): Settings | null {
    return this._settings;
  }
  get sessionMeta(): Map<string, SessionRow> {
    return this._sessionMeta;
  }
  get availableModels(): ModelChoice[] {
    return this._availableModels;
  }

  // ── Engine interface ─────────────────────────────────────────────────────

  async listAgents(): Promise<AgentInfo[]> {
    return [{ id: HERMES_AGENT_ID, name: "Hermes" }];
  }

  async listModels(): Promise<ModelInfo[]> {
    return this._availableModels.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      contextWindow: m.contextWindow,
    }));
  }

  async sendMessage(
    threadId: string,
    messages: unknown[],
    abortController: AbortController,
  ): Promise<Response> {
    const last = messages[messages.length - 1] as { content?: unknown } | undefined;
    const raw = last?.content;
    const text =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? raw
              .filter((c: unknown) => (c as { type?: string } | null)?.type === "text")
              .map((c: unknown) => (c as { text?: string } | null)?.text ?? "")
              .join("")
          : "";

    const encoder = new TextEncoder();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const write = (event: Record<string, unknown>) => {
      try {
        ctrl.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      } catch {
        /* closed */
      }
    };

    let live = "";
    let listener: RunListener | null = null;
    const closeStream = () => {
      if (listener && live && this.runListeners.get(live) === listener)
        this.runListeners.delete(live);
      try {
        ctrl.close();
      } catch {
        /* already closed */
      }
    };

    // AbortController fires on Stop AND on thread switches — only close the local stream.
    abortController.signal.addEventListener("abort", () => closeStream());

    try {
      await this._engineReady;
      const stored = await this._resolveStored(threadId);
      live = await this._ensureLive(stored);

      const mapper = createHermesMapper(write, closeStream, (req) => {
        const full: HermesApprovalRequest = { ...req, sessionId: stored };
        this.pendingApprovals.set(stored, full);
        this.events.onApprovalRequest?.(full);
      });
      listener = { onEvent: mapper.onEvent, onClose: closeStream };
      this.runListeners.get(live)?.onClose();
      this.runListeners.set(live, listener);

      const res = await this.client!.request<{ status?: string }>("prompt.submit", {
        session_id: live,
        text,
        surface: "openhermes-os",
      });
      log(`prompt.submit → ${res?.status ?? "?"} (stored=${stored} live=${live})`);
    } catch (err) {
      write({
        type: EventType.RUN_ERROR,
        message: err instanceof Error ? err.message : "Failed to send",
      });
      closeStream();
    }

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  async abort(threadId: string): Promise<void> {
    const stored = this._storedFor(threadId);
    const live = stored ? this.liveByStored.get(stored) : undefined;
    if (!live) return;
    await this.client?.request("session.interrupt", { session_id: live }).catch(() => {});
  }

  /** approval.respond — choice is one of the request's `choices` (e.g. "once" | "session" | "deny"). */
  async respondApproval(threadId: string, choice: string, requestId?: string): Promise<boolean> {
    const stored = this._storedFor(threadId);
    const live = stored ? this.liveByStored.get(stored) : undefined;
    if (!live) return false;
    try {
      await this.client!.request("approval.respond", {
        session_id: live,
        choice,
        ...(requestId ? { request_id: requestId } : {}),
      });
      if (stored) this.pendingApprovals.delete(stored);
      return true;
    } catch (e) {
      warn("approval.respond failed:", e);
      return false;
    }
  }

  // ── Helpers used by useGateway ───────────────────────────────────────────

  async fetchThreadList(): Promise<ClawThreadListItem[]> {
    this.events.onKnownAgentIdsChanged(new Set([HERMES_AGENT_ID]));
    const items: ClawThreadListItem[] = [
      {
        id: HERMES_AGENT_ID,
        title: "Hermes",
        createdAt: Date.now(),
        clawKind: "main",
        clawAgentId: HERMES_AGENT_ID,
      },
    ];
    const mainStored = this._mainStored();
    try {
      await this._engineReady;
      const res = await this.client!.request<{ sessions?: SessionListRow[] }>("session.list", {
        limit: 50,
      });
      const meta = new Map<string, SessionRow>(this._sessionMeta);
      for (const row of res?.sessions ?? []) {
        meta.set(row.id, {
          key: row.id,
          label: row.title ?? null,
          derivedTitle: row.preview ?? null,
          updatedAt: row.started_at ? row.started_at * 1000 : null,
        });
        if (row.id === mainStored) continue; // shown as the main thread
        items.push({
          id: row.id,
          title: rowTitle(row),
          createdAt: row.started_at ? row.started_at * 1000 : Date.now(),
          clawKind: "extra",
          clawAgentId: HERMES_AGENT_ID,
        });
      }
      this._sessionMeta = meta;
      this.events.onSessionMetaChanged(new Map(meta));
    } catch (e) {
      warn("session.list failed:", e);
    }
    return items;
  }

  async patchSession(sessionKey: string, patch: Record<string, unknown>): Promise<boolean> {
    const stored = this._storedFor(sessionKey);
    if (!stored) return false;
    try {
      await this._engineReady;
      if (typeof patch["label"] === "string") {
        await this.client!.request("session.title", { session_id: stored, title: patch["label"] });
        const prev = this._sessionMeta.get(stored);
        this._sessionMeta.set(stored, {
          ...(prev ?? { key: stored }),
          key: stored,
          label: patch["label"] as string,
        });
        this.events.onSessionMetaChanged(new Map(this._sessionMeta));
      }
      // verboseLevel / thinkingLevel / model: no session-scoped Hermes equivalent wired yet (stub → ok)
      return true;
    } catch (e) {
      warn("session.title failed:", e);
      return false;
    }
  }

  // STUB: notifications / cron — openclawos.notifications and cron.* have no Hermes gateway counterpart.
  async listNotifications(): Promise<NotificationRecord[]> {
    return [];
  }
  async markNotificationsRead(_ids?: string[]): Promise<boolean> {
    return true;
  }
  async upsertNotification(
    _notification: Omit<NotificationRecord, "id" | "createdAt" | "updatedAt" | "unread" | "readAt">,
  ): Promise<boolean> {
    return false;
  }
  async listCronJobs(): Promise<CronJobRecord[]> {
    return [];
  }
  async listCronRuns(): Promise<CronRunEntry[]> {
    return [];
  }
  async getCronStatus(): Promise<CronStatusRecord | null> {
    return null;
  }
  async updateCronJob(_id: string, _patch: Record<string, unknown>): Promise<boolean> {
    return false;
  }
  async runCronJob(_id: string, _mode: "force" | "due" = "force"): Promise<boolean> {
    return false;
  }
  async removeCronJob(_id: string): Promise<boolean> {
    return false;
  }

  async subscribeSessions(): Promise<void> {
    /* Hermes pushes `sessions.changed` to every connection; nothing to subscribe. */
  }

  /** Hermes has no in-place reset: start a fresh session and rebind the thread to it. */
  async resetSession(threadId: string): Promise<boolean> {
    try {
      await this._engineReady;
      const res = await this.client!.request<SessionCreateResult>("session.create", {});
      this._bind(res.stored_session_id, res.session_id);
      if (threadId === HERMES_AGENT_ID) this._setMainStored(res.stored_session_id);
      this.events.onSessionChanged(threadId);
      return true;
    } catch (e) {
      warn("resetSession failed:", e);
      return false;
    }
  }

  async compactSession(threadId: string): Promise<CompactSessionResult> {
    const stored = this._storedFor(threadId);
    try {
      if (!stored) throw new Error("no session");
      const live = await this._ensureLive(stored);
      const r = await this.client!.request<{
        status?: string | null;
        before_tokens?: number | null;
        after_tokens?: number | null;
      }>("session.compress", { session_id: live });
      return {
        ok: true,
        compacted: r?.status === "compressed" || (r?.after_tokens ?? 0) < (r?.before_tokens ?? 0),
        tokensBefore: r?.before_tokens ?? null,
        tokensAfter: r?.after_tokens ?? null,
        reason: r?.status ?? null,
      };
    } catch (e) {
      return {
        ok: false,
        compacted: false,
        tokensBefore: null,
        tokensAfter: null,
        reason: String(e),
      };
    }
  }

  // STUB: slash-command autocomplete — Hermes' catalog (commands.catalog) is not mapped yet.
  async fetchGatewayCommands(): Promise<GatewayCommand[]> {
    return [];
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async _request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this._engineReady;
    return this.client!.request<T>(method, params);
  }

  private _setConnectionState(state: ConnectionState): void {
    this._connectionState = state;
    this.events.onConnectionStateChange(state);
  }

  private _handleEvent(e: GatewayEvent): void {
    if (e.type === "gateway.ready") {
      log("gateway.ready ✓");
      this.events.onPairingRequired(null);
      this._setConnectionState(ConnectionState.CONNECTED);
      this._isReady = true;
      this._readyDeferred?.resolve();
      this.events.onKnownAgentIdsChanged(new Set([HERMES_AGENT_ID]));
      this.events.onModelDefaultsChanged({
        workspaceDefault: null,
        byAgent: new Map(),
        defaultAgentId: HERMES_AGENT_ID,
      });
      return;
    }
    if (e.type === "sessions.changed") {
      // Global event (no session id): ask the UI to re-pull the thread list's current thread.
      const stored = e.session_id ? this.storedByLive.get(e.session_id) : undefined;
      if (stored) this.events.onSessionChanged(stored);
      return;
    }
    if (e.type === "session.info" && e.session_id) {
      const info = e.payload as SessionLiveInfo | undefined;
      const stored = this.storedByLive.get(e.session_id);
      if (info?.model && stored) {
        const id = `${info.provider ?? "hermes"}/${info.model}`;
        if (!this._availableModels.some((m) => m.id === id)) {
          this._availableModels = [
            ...this._availableModels,
            { id, name: info.model, provider: info.provider ?? "hermes" },
          ];
          this.events.onModelsChanged(this._availableModels);
        }
        this._sessionMeta.set(stored, {
          ...(this._sessionMeta.get(stored) ?? { key: stored }),
          key: stored,
          model: id,
        });
        this.events.onSessionMetaChanged(new Map(this._sessionMeta));
      }
      return;
    }
    if (e.type === "session.title" && e.session_id) {
      const stored =
        (e.payload?.session_id as string | undefined) ?? this.storedByLive.get(e.session_id);
      const title = e.payload?.title as string | undefined;
      if (stored && title) {
        this._sessionMeta.set(stored, {
          ...(this._sessionMeta.get(stored) ?? { key: stored }),
          key: stored,
          label: title,
        });
        this.events.onSessionMetaChanged(new Map(this._sessionMeta));
      }
      return;
    }
    if (e.session_id) this.runListeners.get(e.session_id)?.onEvent(e);
  }

  private _bind(stored: string, live: string): void {
    this.liveByStored.set(stored, live);
    this.storedByLive.set(live, stored);
  }

  private _mainStored(): string | null {
    try {
      return typeof window !== "undefined"
        ? window.localStorage.getItem(MAIN_SESSION_STORAGE_KEY)
        : null;
    } catch {
      return null;
    }
  }
  private _setMainStored(id: string): void {
    try {
      window.localStorage.setItem(MAIN_SESSION_STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  }

  /** Stored id for a thread id ("hermes" = the pinned main session; may be unset before first use). */
  private _storedFor(threadId: string): string | null {
    return threadId === HERMES_AGENT_ID ? this._mainStored() : threadId;
  }

  private async _resolveStored(threadId: string): Promise<string> {
    const existing = this._storedFor(threadId);
    if (existing) return existing;
    const res = await this._request<SessionCreateResult>("session.create", {});
    this._bind(res.stored_session_id, res.session_id);
    this._setMainStored(res.stored_session_id);
    return res.stored_session_id;
  }

  private async _ensureLive(stored: string): Promise<string> {
    const known = this.liveByStored.get(stored);
    if (known) return known;
    const res = await this._request<SessionResumeResult>("session.resume", { session_id: stored });
    this._bind(stored, res.session_id);
    return res.session_id;
  }

  // ConversationStore ───────────────────────────────────────────────────────

  private async _listSessions(): Promise<SessionInfo[]> {
    try {
      const res = await this._request<{ sessions?: SessionListRow[] }>("session.list", {
        limit: 100,
      });
      return (res?.sessions ?? []).map((row) => ({
        id: row.id,
        agentId: HERMES_AGENT_ID,
        title: rowTitle(row),
        createdAt: new Date((row.started_at ?? Date.now() / 1000) * 1000).toISOString(),
      }));
    } catch (e) {
      warn("session.list failed:", e);
      return [];
    }
  }

  private async _getSession(threadId: string): Promise<SessionInfo | null> {
    const stored = this._storedFor(threadId);
    if (!stored) return null;
    const meta = this._sessionMeta.get(stored);
    return {
      id: threadId,
      agentId: HERMES_AGENT_ID,
      title: meta?.label ?? undefined,
      createdAt: new Date(meta?.updatedAt ?? Date.now()).toISOString(),
    };
  }

  private async _createSessionRecord(agentId: string, title?: string): Promise<SessionInfo> {
    const res = await this._request<SessionCreateResult>("session.create", {});
    this._bind(res.stored_session_id, res.session_id);
    if (title) {
      await this._request("session.title", { session_id: res.stored_session_id, title }).catch(
        () => {},
      );
    }
    log("createSession", res.stored_session_id);
    return { id: res.stored_session_id, agentId, title, createdAt: new Date().toISOString() };
  }

  private async _deleteSessionRecord(threadId: string): Promise<void> {
    const stored = this._storedFor(threadId);
    if (!stored) return;
    await this._request("session.delete", { session_id: stored });
    const live = this.liveByStored.get(stored);
    if (live) this.storedByLive.delete(live);
    this.liveByStored.delete(stored);
    if (threadId === HERMES_AGENT_ID) {
      try {
        window.localStorage.removeItem(MAIN_SESSION_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
  }

  private async _renameSessionRecord(threadId: string, title: string): Promise<void> {
    const stored = this._storedFor(threadId);
    if (!stored) return;
    await this._request("session.title", { session_id: stored, title });
  }

  private async _loadHistory(threadId: string): Promise<StoredMessage[]> {
    const stored = this._storedFor(threadId);
    if (!stored) return [];
    try {
      const res = await this._request<SessionResumeResult>("session.resume", {
        session_id: stored,
      });
      this._bind(stored, res.session_id);
      return transcriptToStored(res.messages ?? []);
    } catch (e) {
      warn("session.resume (history) failed:", e);
      return [];
    }
  }

  private async _getSessionConfig(threadId: string): Promise<Record<string, string>> {
    const stored = this._storedFor(threadId);
    const model = stored ? this._sessionMeta.get(stored)?.model : null;
    return model ? { model } : {};
  }

  private async _setSessionConfig(threadId: string, key: string, value: string): Promise<void> {
    await this.patchSession(threadId, { [key]: value });
  }
}

// ── Hermes events → AG-UI NDJSON ───────────────────────────────────────────────

function createHermesMapper(
  write: (e: Record<string, unknown>) => void,
  close: () => void,
  onApproval: (r: Omit<HermesApprovalRequest, "sessionId">) => void,
) {
  let messageId: string | null = null;
  let emittedText = false;
  const activeTools = new Set<string>();

  const seg = (s: AssistantTimelineSegment) =>
    write({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: encodeAssistantTimelineSegment(s),
    });
  const start = (turn?: string) => {
    if (!messageId) {
      messageId = turn ?? crypto.randomUUID();
      write({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
    }
  };
  const finish = () => {
    start();
    write({ type: EventType.TEXT_MESSAGE_END, messageId });
    write({ type: EventType.RUN_FINISHED });
    activeTools.clear();
    close();
  };
  const fail = (message: string) => {
    start();
    write({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: `${ERROR_SENTINEL}${message}`,
    });
    finish();
  };

  return {
    onEvent(e: GatewayEvent) {
      const p: any = e.payload ?? {};
      switch (e.type) {
        case "message.start":
          start(typeof p.turn_id === "string" ? p.turn_id : undefined);
          return;
        case "message.delta":
        case "message.interim": {
          if (typeof p.text === "string" && p.text) {
            start();
            emittedText = true;
            write({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: p.text });
          }
          return;
        }
        case "reasoning.delta": {
          if (typeof p.text === "string" && p.text) {
            start();
            seg({ type: "reasoning", text: p.text });
          }
          return;
        }
        // `thinking.delta` is the spinner face ("◉_◉ computing…") — not content; ignored on purpose.
        case "tool.start": {
          start();
          const id = String(p.tool_id ?? crypto.randomUUID());
          const name = String(p.name ?? "tool");
          const args = stringify(p.args ?? p.args_text ?? {});
          activeTools.add(id);
          seg({ type: "tool_call", toolCallId: id, toolName: name, ...(args ? { args } : {}) });
          write({
            type: EventType.TOOL_CALL_START,
            toolCallId: id,
            toolCallName: name,
            parentMessageId: messageId,
          });
          write({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: args });
          return;
        }
        case "tool.complete": {
          start();
          const id = String(p.tool_id ?? "");
          const output =
            stringify(p.result_text ?? p.result ?? p.summary ?? "") ||
            "Tool finished without output.";
          seg({
            type: "tool_result",
            toolCallId: id,
            output,
            ...(typeof p.duration_s === "number"
              ? { durationMs: Math.round(p.duration_s * 1000) }
              : {}),
          });
          write({ type: EventType.TOOL_CALL_END, toolCallId: id });
          activeTools.delete(id);
          return;
        }
        case "approval.request":
          start();
          seg({
            type: "tool_call",
            toolCallId: String(p.request_id ?? "approval"),
            toolName: "approval-required",
            args: stringify({ command: p.command, description: p.description }),
          });
          onApproval({
            requestId: String(p.request_id ?? ""),
            command: p.command,
            description: p.description,
            toolName: p.tool_name,
            choices: Array.isArray(p.choices) ? p.choices.map(String) : undefined,
          });
          return;
        case "message.complete": {
          start();
          if (p.status === "error") {
            fail(String(p.error ?? p.failure_reason ?? "Agent error"));
            return;
          }
          if (!emittedText && typeof p.text === "string" && p.text) {
            emittedText = true;
            write({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: p.text });
          }

          const u: any = p.usage;
          if (u) {
            seg({
              type: "usage",
              inputTokens: u.input ?? u.prompt ?? 0,
              outputTokens: u.output ?? u.completion ?? 0,
              ...(typeof u.cache_read === "number" ? { cacheReadTokens: u.cache_read } : {}),
              ...(typeof u.cache_write === "number" ? { cacheWriteTokens: u.cache_write } : {}),
              ...(typeof u.total === "number" ? { totalTokens: u.total } : {}),
            });
          }
          finish();
          return;
        }
        case "error":
          fail(String(p.message ?? "Agent error"));
          return;
        default:
          return;
      }
    },
  };
}
