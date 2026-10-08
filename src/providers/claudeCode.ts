import type { ChatMessage, ProviderConfig } from "@/types";
import { ProviderError, type ChatOpts, type Delta, type Provider } from "./types";
import { readSSE } from "./sse";
import { errorDetail, joinUrl } from "./openai";
import {
  decodeBridgeFrame,
  decodeProject,
  decodeProjects,
  type BridgeRequest,
  type ProjectSummary,
} from "@/lib/bridgeProtocol";

/**
 * The Claude Code bridge (bridge/claude-code.ts), as a provider.
 *
 * On the wire it is the OpenAI-compatible adapter plus one request field — the
 * tool scope the message's policy allows — and three named events coming back:
 * the tools the model used, the account's usage window, and the token count.
 * Decoding goes through the same file the bridge encodes with, so the two ends
 * cannot drift.
 */
export function createClaudeCodeProvider(config: ProviderConfig): Provider {
  return {
    id: config.id,
    async *streamChat(messages: ChatMessage[], opts: ChatOpts): AsyncIterable<Delta> {
      const url = joinUrl(config.baseUrl, "chat/completions");
      const body: BridgeRequest = {
        model: opts.model,
        messages,
        stream: true,
        toondao: { toolScope: opts.toolScope ?? "none", ...(opts.project ? { project: opts.project } : {}) },
      };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      }).catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        throw new ProviderError(
          `Could not reach the Claude Code bridge at ${url}. Start it with: npm run bridge`,
        );
      });

      if (!res.ok || !res.body) {
        throw new ProviderError(`${res.status} ${res.statusText}${await errorDetail(res)}`, res.status);
      }

      for await (const { event, data } of readSSE(res.body, opts.signal)) {
        const frame = decodeBridgeFrame(event, data);
        if (!frame) continue;
        switch (frame.kind) {
          case "done":
            return;
          case "error":
            throw new ProviderError(frame.message);
          case "text":
            yield { text: frame.text };
            break;
          case "tool":
            yield { text: "", tool: frame.tool };
            break;
          case "rate":
            yield { text: "", rateLimit: frame.rateLimit };
            break;
          case "usage":
            yield { text: "", usage: frame.usage };
            break;
          case "model":
            yield { text: "", model: frame.model };
            break;
        }
      }
    },
  };
}

/** What the bridge says about the Claude Code it drives. Asking costs nothing. */
export interface BridgeHealth {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  subscriptionType: string | null;
  orgName: string | null;
}

export async function fetchBridgeHealth(baseUrl: string, signal?: AbortSignal): Promise<BridgeHealth | null> {
  try {
    const res = await fetch(joinUrl(baseUrl, "health"), { ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    return (await res.json()) as BridgeHealth;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Projects (P-29)                                                     */
/* ------------------------------------------------------------------ */

/** The projects the bridge has registered, or null when it cannot be reached (or predates projects). */
export async function fetchProjects(baseUrl: string): Promise<ProjectSummary[] | null> {
  try {
    const res = await fetch(joinUrl(baseUrl, "projects"));
    if (!res.ok) return null;
    return decodeProjects(await res.json());
  } catch {
    return null;
  }
}

/**
 * Ask the bridge to open the system folder dialog and snapshot the folder the
 * person picks. Resolves when they choose or cancel; no path is ever sent.
 */
export async function chooseProject(baseUrl: string): Promise<ProjectSummary | "cancelled"> {
  const body = await postToBridge(joinUrl(baseUrl, "projects/choose"));
  if (body && typeof body === "object" && "cancelled" in body) return "cancelled";
  return projectFrom(body);
}

/** Take a new snapshot of a registered project. */
export async function snapshotAgain(baseUrl: string, slug: string): Promise<ProjectSummary> {
  return projectFrom(await postToBridge(joinUrl(baseUrl, `projects/${encodeURIComponent(slug)}/snapshot`)));
}

function projectFrom(body: unknown): ProjectSummary {
  const project = decodeProject(body && typeof body === "object" ? (body as { project?: unknown }).project : null);
  if (!project) throw new ProviderError("The bridge answered without a project.");
  return project;
}

async function postToBridge(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch {
    throw new ProviderError("The bridge is not running. Start it with: npm run bridge");
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) return body;
  const message =
    body && typeof body === "object" && typeof (body as { error?: { message?: unknown } }).error?.message === "string"
      ? String((body as { error: { message: string } }).error.message)
      : `The bridge answered ${res.status}.`;
  // A bridge started before projects existed has no such route at all.
  if (res.status === 404 && message.startsWith("No route")) {
    throw new ProviderError("This bridge is older than the app. Restart it: Ctrl-C, then npm run bridge.", 404);
  }
  throw new ProviderError(message, res.status);
}
