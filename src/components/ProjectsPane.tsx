import { useCallback, useEffect, useState } from "react";
import { useStore } from "@/store/useStore";
import { chooseProject, fetchProjects, snapshotAgain } from "@/providers/claudeCode";
import type { ProjectSummary } from "@/lib/bridgeProtocol";

/**
 * Projects to learn from (P-29). "Add a project…" asks the bridge to open the
 * system's own folder dialog — the app never names a folder — and the bridge
 * freezes what the project holds about how it was built as a dated snapshot.
 * Each project shows what its latest snapshot found and what it lacks.
 */
export function ProjectsPane() {
  const baseUrl = useStore((s) => s.settings.providers.find((p) => p.kind === "claude-code")?.baseUrl ?? "");
  const [projects, setProjects] = useState<ProjectSummary[] | null | "loading">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    setProjects(baseUrl ? await fetchProjects(baseUrl) : null);
  }, [baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, waiting: string, task: () => Promise<string>) => {
    setBusy(key);
    setStatus({ kind: "ok", text: waiting });
    try {
      setStatus({ kind: "ok", text: await task() });
      await load();
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const add = () =>
    act("choose", "A folder dialog has opened — it may be behind this window.", async () => {
      const result = await chooseProject(baseUrl);
      if (result === "cancelled") return "No folder chosen.";
      const current = result.snapshots.at(-1);
      return `Snapshot of "${result.name}" taken: about ${current?.harvestTokens ?? 0} tokens for the model to read first.`;
    });

  const again = (project: ProjectSummary) =>
    act(project.slug, `Taking a new snapshot of "${project.name}"…`, async () => {
      const result = await snapshotAgain(baseUrl, project.slug);
      return `New snapshot of "${result.name}" taken; the earlier ones are kept.`;
    });

  return (
    <>
      <p className="pane__note">
        Learn from a project you built with Claude Code. Adding one opens your system&apos;s folder
        dialog; ToonDao then gathers what the project holds about how it was built — your Claude
        Code sessions, its git history and notes — and keeps a dated snapshot in{" "}
        <code>~/.toondao/projects</code>. It only reads, skips whatever git ignores, and redacts
        credentials pasted into chats.
      </p>

      {projects === null ? (
        <p className="tmpl__warn" role="status">
          The Claude Code bridge is not running, or was started before projects existed. Start or
          restart it with <code>npm run bridge</code>.
        </p>
      ) : null}

      <div className="pane__row">
        <button
          type="button"
          className="btn"
          disabled={!Array.isArray(projects) || busy !== null}
          onClick={() => void add()}
        >
          {busy === "choose" ? "Waiting for the folder dialog…" : "Add a project…"}
        </button>
      </div>

      {Array.isArray(projects)
        ? projects.map((project) => (
            <ProjectCard
              key={project.slug}
              project={project}
              busy={busy !== null}
              onSnapshot={() => void again(project)}
            />
          ))
        : null}

      {status ? (
        <p className={status.kind === "error" ? "tmpl__warn" : "field__hint"} role="status">
          {status.text}
        </p>
      ) : null}
    </>
  );
}

function ProjectCard({
  project,
  busy,
  onSnapshot,
}: {
  project: ProjectSummary;
  busy: boolean;
  onSnapshot: () => void;
}) {
  const current = project.snapshots.at(-1);
  const count = project.snapshots.length;
  return (
    <div className="project">
      <div className="project__head">
        <span className="project__name">{project.name}</span>
        <span className="project__root" title={project.root}>
          {project.root}
        </span>
      </div>
      {current ? (
        <>
          <ul className="project__sources">
            {current.sources.map((source) => (
              <li key={source.name} className={source.found ? undefined : "project__source--missing"}>
                <span aria-hidden>{source.found ? "✓" : "·"}</span> <strong>{source.name}</strong>{" "}
                — {source.detail}
              </li>
            ))}
          </ul>
          <p className="field__hint">
            Latest snapshot {new Date(current.createdAt).toLocaleString()} · about{" "}
            {current.harvestTokens.toLocaleString()} tokens to read first · {count} snapshot
            {count === 1 ? "" : "s"} kept
          </p>
        </>
      ) : null}
      <div className="pane__row project__actions">
        <button type="button" className="btn btn--sm" disabled={busy} onClick={onSnapshot}>
          Snapshot again
        </button>
      </div>
    </div>
  );
}
