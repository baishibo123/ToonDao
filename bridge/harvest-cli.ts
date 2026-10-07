/**
 * `npm run harvest` — the harvest from a terminal.
 *
 *   npm run harvest -- "<project folder>"                 print harvest.md
 *   npm run harvest -- "<project folder>" --out <dir>     write harvest.md and every session
 *   npm run harvest -- "<project folder>" --snapshot      register it and freeze a snapshot,
 *                                                         as "Add a project…" does in the app
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { estimateTokens, harvestProject, renderHarvest, renderSession } from "./harvest.ts";
import { snapshotProject, TOONDAO_HOME } from "./projects.ts";

const USAGE =
  'usage: npm run harvest -- "<project folder>" [--out <dir> | --snapshot] [--budget <tokens, at least 2000>]';

/** Returns an exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  let out: string | null = null;
  let snapshot = false;
  let budget = 20_000;
  const positional: string[] = [];
  while (args.length) {
    const arg = args.shift() ?? "";
    if (arg === "--out") out = args.shift() ?? null;
    else if (arg === "--snapshot") snapshot = true;
    else if (arg === "--budget") budget = Number(args.shift());
    else positional.push(arg);
  }
  const folder = positional[0];
  if (!folder || !Number.isFinite(budget) || budget < 2000 || (snapshot && out)) {
    console.error(USAGE);
    return 2;
  }

  try {
    if (snapshot) {
      const project = await snapshotProject(folder);
      const current = project.snapshots.at(-1);
      for (const source of current?.sources ?? []) {
        console.log(`${source.found ? "✓" : "·"} ${source.name}: ${source.detail}`);
      }
      console.log(
        `\nSnapshot ${current?.id} of "${project.name}" is in ${join(TOONDAO_HOME, "projects", project.slug, current?.id ?? "")}` +
          ` (~${current?.harvestTokens} tokens to read first; ${project.snapshots.length} snapshot${project.snapshots.length === 1 ? "" : "s"} in all).`,
      );
      return 0;
    }

    const harvest = await harvestProject(folder);
    const page = renderHarvest(harvest, { budgetTokens: budget });
    if (!out) {
      process.stdout.write(page);
      console.error(`\n[harvest] ~${estimateTokens(page)} tokens. Pass --out <dir> to also write every session in full.`);
      return 0;
    }
    await mkdir(join(out, "sessions"), { recursive: true });
    await writeFile(join(out, "harvest.md"), page, "utf8");
    for (const session of harvest.sessions) {
      await writeFile(join(out, "sessions", `${session.id}.md`), renderSession(session), "utf8");
    }
    for (const source of harvest.sources) console.log(`${source.found ? "✓" : "·"} ${source.name}: ${source.detail}`);
    console.log(
      `\nWrote ${join(out, "harvest.md")} (~${estimateTokens(page)} tokens) and ${harvest.sessions.length} session file${harvest.sessions.length === 1 ? "" : "s"}.`,
    );
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
