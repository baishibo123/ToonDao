/**
 * The wire contract between the ToonDao app and the Claude Code bridge
 * (bridge/claude-code.ts).
 *
 * Both sides import this file: the browser adapter decodes with it, the Node
 * bridge encodes with it, so the two cannot drift. That is also why it has no
 * imports at all — the bridge runs this file directly under Node, where the
 * app's `@/` alias does not exist.
 *
 * The transport is the OpenAI chat-completions SSE shape the app already
 * speaks, plus three named events the bridge adds. An ordinary OpenAI-compatible
 * reader ignores named events, so the bridge also degrades to a plain provider.
 */

/**
 * What a request may reach beyond the text ToonDao assembled. Decided per
 * request from the message's context policy (src/lib/toolScope.ts), because an
 * outside source is context too.
 */
export type ToolScope = "none" | "research";

/** One tool call the model made while answering, as the reader should see it. */
export interface ToolUse {
  /** Tool name as Claude Code reports it, e.g. `WebSearch`. */
  name: string;
  /** What it looked up — the query or URL — flattened to one short line. */
  query: string;
}

/** Tokens for the whole request, as the bridge measured them. */
export interface Usage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

/**
 * The subscription's usage window, as Claude Code last reported it. The window
 * is shared with every other use of the same account, which is why the app
 * shows it at all.
 */
export interface RateLimit {
  /** `allowed`, `allowed_warning` or `rejected`; anything else is shown as-is. */
  status: string;
  /** Which window this is, e.g. `five_hour`. */
  window: string;
  /** Fraction of the window used, 0–1, when reported. */
  utilization: number | null;
  /** Unix seconds when the window resets, when reported. */
  resetsAt: number | null;
}

/**
 * The model Claude Code actually ran. An alias like `opus` is resolved by the
 * installed Claude Code, so which version answered depends on that install;
 * the reply records the resolved id so the reader never has to ask the model.
 */
export interface ModelInfo {
  model: string;
}

/**
 * A project snapshot a request may read (P-31). Names only: the bridge finds
 * the folder in its own registry, so a request never carries a path.
 */
export interface ProjectRef {
  slug: string;
  snapshot: string;
}

/** The body the adapter posts. Standard fields, plus one namespaced extension. */
export interface BridgeRequest {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  stream: true;
  toondao?: { toolScope?: ToolScope; project?: ProjectRef };
}

export const BRIDGE_EVENT = {
  tool: "toondao.tool",
  rate: "toondao.rate",
  usage: "toondao.usage",
  model: "toondao.model",
} as const;

/* ------------------------------------------------------------------ */
/* Projects — learning from a project the person built (P-28, P-29)    */
/* ------------------------------------------------------------------ */

/** A source the harvest looked for, and whether the project had it. */
export interface HarvestSource {
  name: string;
  found: boolean;
  detail: string;
}

/** One frozen harvest of a project, as `~/.toondao/projects/<slug>/<id>/` holds it. */
export interface SnapshotSummary {
  /** The snapshot's folder name: when it was taken, e.g. `2026-10-07T14-55-02Z`. */
  id: string;
  createdAt: string;
  /** The commit the project was at, when it is a git repository. */
  gitHead: string | null;
  sources: HarvestSource[];
  sessions: Array<{ id: string; title: string | null }>;
  /** Rough size of `harvest.md`, the page the model reads first. */
  harvestTokens: number;
  /**
   * How many of the project's own files the snapshot copied for the model to
   * read. Absent from snapshots taken before the model could read one, which
   * cannot start a learning conversation.
   */
  files?: number;
}

/** A project registered with the bridge. Its folder never travels in a request. */
export interface ProjectSummary {
  slug: string;
  name: string;
  root: string;
  /** Oldest first; the last is the current one. */
  snapshots: SnapshotSummary[];
}

/** The bridge's answer to "choose a project": the project, or that the dialog was cancelled. */
export type ChooseResult = { project: ProjectSummary } | { cancelled: true };

/** Lenient reading of a project list from the bridge; anything malformed is dropped. */
export function decodeProjects(value: unknown): ProjectSummary[] {
  const list = isRecord(value) && Array.isArray(value.projects) ? value.projects : [];
  return list.flatMap((item) => {
    const project = decodeProject(item);
    return project ? [project] : [];
  });
}

export function decodeProject(value: unknown): ProjectSummary | null {
  if (!isRecord(value) || typeof value.slug !== "string" || typeof value.root !== "string") return null;
  const snapshots = Array.isArray(value.snapshots) ? value.snapshots : [];
  return {
    slug: value.slug,
    name: str(value.name) || value.slug,
    root: value.root,
    snapshots: snapshots.filter(isRecord).map((s) => ({
      id: str(s.id),
      createdAt: str(s.createdAt),
      gitHead: typeof s.gitHead === "string" ? s.gitHead : null,
      sources: (Array.isArray(s.sources) ? s.sources : []).filter(isRecord).map((src) => ({
        name: str(src.name),
        found: src.found === true,
        detail: str(src.detail),
      })),
      sessions: (Array.isArray(s.sessions) ? s.sessions : []).filter(isRecord).map((x) => ({
        id: str(x.id),
        title: typeof x.title === "string" ? x.title : null,
      })),
      harvestTokens: num(s.harvestTokens),
      ...(typeof s.files === "number" && Number.isFinite(s.files) ? { files: s.files } : {}),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Encoding — the bridge side                                          */
/* ------------------------------------------------------------------ */

export function sseText(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`;
}

export function sseEvent(
  name: (typeof BRIDGE_EVENT)[keyof typeof BRIDGE_EVENT],
  payload: ToolUse | RateLimit | Usage | ModelInfo,
): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function sseError(message: string): string {
  return `data: ${JSON.stringify({ error: { message } })}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

/* ------------------------------------------------------------------ */
/* Decoding — the app side                                             */
/* ------------------------------------------------------------------ */

export type BridgeFrame =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolUse }
  | { kind: "rate"; rateLimit: RateLimit }
  | { kind: "usage"; usage: Usage }
  | { kind: "model"; model: string }
  | { kind: "error"; message: string }
  | { kind: "done" };

/** One SSE frame (event name + data) → what it means, or null to ignore it. */
export function decodeBridgeFrame(event: string, data: string): BridgeFrame | null {
  if (data === "[DONE]") return { kind: "done" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  switch (event) {
    case BRIDGE_EVENT.tool:
      return typeof parsed.name === "string"
        ? { kind: "tool", tool: { name: parsed.name, query: str(parsed.query) } }
        : null;
    case BRIDGE_EVENT.rate:
      return {
        kind: "rate",
        rateLimit: {
          status: str(parsed.status),
          window: str(parsed.window),
          utilization: numOrNull(parsed.utilization),
          resetsAt: numOrNull(parsed.resetsAt),
        },
      };
    case BRIDGE_EVENT.model:
      return typeof parsed.model === "string" && parsed.model
        ? { kind: "model", model: parsed.model }
        : null;
    case BRIDGE_EVENT.usage:
      return {
        kind: "usage",
        usage: {
          inputTokens: num(parsed.inputTokens),
          cacheCreationInputTokens: num(parsed.cacheCreationInputTokens),
          cacheReadInputTokens: num(parsed.cacheReadInputTokens),
          outputTokens: num(parsed.outputTokens),
        },
      };
  }

  if (isRecord(parsed.error)) {
    return { kind: "error", message: str(parsed.error.message) || "bridge error" };
  }
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const delta = isRecord(choices[0]) && isRecord(choices[0].delta) ? choices[0].delta : null;
  const text = delta && typeof delta.content === "string" ? delta.content : "";
  return text ? { kind: "text", text } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
