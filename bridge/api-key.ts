/**
 * The bridge's own API key, for the Messages API route (bridge/messages-api.ts).
 *
 * WHY A KEY AT ALL. The bridge listens on 127.0.0.1, which every account on the
 * machine can reach, and a shell built for the Anthropic API sends a key anyway.
 * So `/v1/messages` answers only a request that carries this one. It is not a
 * Claude credential: the bridge still never reads, stores or forwards one (the
 * runs use the person's own signed-in Claude Code), and this key never reaches
 * Claude Code either (`runEnv()` drops it).
 *
 * Where it comes from: `TOONDAO_API_KEY` when set, else `~/.toondao/api-key`,
 * which the first start creates, readable by its owner only.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TOONDAO_HOME } from "./projects.ts";

export const API_KEY_FILE = join(TOONDAO_HOME, "api-key");

/** Recognisably the bridge's, so it is never mistaken for an Anthropic key (`sk-ant-…`). */
const PREFIX = "tdk-";

export interface LoadedKey {
  key: string;
  source: "env" | "file" | "created";
}

/** The key the Messages API checks: the environment's, the saved one, or a new one saved owner-only. */
export async function loadApiKey(opts: { env?: NodeJS.ProcessEnv; file?: string } = {}): Promise<LoadedKey> {
  const env = opts.env ?? process.env;
  const file = opts.file ?? API_KEY_FILE;
  const fromEnv = env.TOONDAO_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };

  const saved = await readFile(file, "utf8").then(
    (text) => text.trim(),
    () => "",
  );
  if (saved) return { key: saved, source: "file" };

  const key = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${key}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(async (err: NodeJS.ErrnoException) => {
    // Another start created it a moment ago: use that one, so both agree.
    if (err.code !== "EEXIST") throw err;
  });
  await chmod(file, 0o600).catch(() => {});
  const written = (await readFile(file, "utf8")).trim();
  return { key: written, source: written === key ? "created" : "file" };
}

/**
 * Does the request carry the key? Either header an Anthropic client sends works:
 * `x-api-key: <key>` (the SDKs' default) or `Authorization: Bearer <key>`.
 */
export function checkApiKey(headers: { xApiKey?: string; authorization?: string }, key: string): boolean {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? "")?.[1];
  const offered = (headers.xApiKey || bearer || "").trim();
  if (!offered || !key) return false;
  const a = Buffer.from(offered, "utf8");
  const b = Buffer.from(key, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
