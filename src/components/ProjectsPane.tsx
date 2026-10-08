import { useCallback, useEffect, useState } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
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
  const bridgeActive = useStore(
    (s) => s.settings.providers.find((p) => p.id === s.settings.activeProviderId)?.kind === "claude-code",
  );
  const startLearning = useStore((s) => s.startLearning);
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const [projects, setProjects] = useState<ProjectSummary[] | null | "loading">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    setProjects(baseUrl ? await fetchProjects(baseUrl) : null);
  }, [baseUrl]);

  // Asked on open, and again whenever the window comes back into focus: the
  // bridge is started or restarted in a terminal, so coming back from one is
  // exactly when the answer may have changed.
  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
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

  // The conversation opens behind Settings, so Settings closes once it exists;
  // the learning map then streams into the thread.
  const learn = async (project: ProjectSummary) => {
    setBusy(`learn:${project.slug}`);
    try {
      setSettingsOpen(false);
      await startLearning(project);
    } catch (err) {
      setSettingsOpen(true);
      setStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

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
        <div className="bridgestatus bridgestatus--warn" role="status">
          <span className="bridgestatus__dot" aria-hidden />
          <span className="bridgestatus__text">
            The Claude Code bridge is not running, or was started before projects existed. Start or
            restart it with <code>npm run bridge</code>.
          </span>
          <button type="button" className="btn btn--sm" onClick={() => void load()}>
            check again
          </button>
        </div>
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
              bridgeActive={bridgeActive}
              onSnapshot={() => void again(project)}
              onLearn={() => void learn(project)}
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
  bridgeActive,
  onSnapshot,
  onLearn,
}: {
  project: ProjectSummary;
  busy: boolean;
  bridgeActive: boolean;
  onSnapshot: () => void;
  onLearn: () => void;
}) {
  const current = project.snapshots.at(-1);
  const count = project.snapshots.length;
  // A snapshot the model can read carries a copy of the project's files.
  const readable = typeof current?.files === "number";
  const blocked = !readable
    ? "This snapshot was taken before the model could read one — take a new snapshot to start learning."
    : !bridgeActive
      ? "Learning reads the snapshot through Claude Code: choose “Claude Code (local bridge)” as the provider above."
      : null;
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
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={busy || blocked !== null}
          onClick={onLearn}
          title="Open a conversation that reads this snapshot and starts with a study map"
        >
          Start learning
        </button>
        <button type="button" className="btn btn--sm" disabled={busy} onClick={onSnapshot}>
          Snapshot again
        </button>
      </div>
      {blocked ? <p className="field__hint project__blocked">{blocked}</p> : null}
    </div>
  );
}
