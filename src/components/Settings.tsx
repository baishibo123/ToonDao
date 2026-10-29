import { useState } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import type { ProviderConfig } from "@/types";
import { TemplateEditor } from "@/components/TemplateEditor";
import { DataPane } from "@/components/DataPane";
import { ProjectsPane } from "@/components/ProjectsPane";
import { BridgeStatus } from "@/components/BridgeStatus";
import { TEXT_SIZES } from "@/lib/textSize";

/**
 * A key field that says "blank for local" on a hosted provider is telling the
 * user the opposite of the truth. Keyed on where the request actually goes.
 */
function keyPlaceholder(provider: ProviderConfig): string {
  if (isLocalUrl(provider.baseUrl)) return "not needed for a local server";
  if (provider.kind === "anthropic") return "sk-ant-…";
  if (/openrouter\.ai/.test(provider.baseUrl)) return "sk-or-v1-…";
  return "sk-…";
}

function isLocalUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

export function Settings() {
  const open = useUI((s) => s.settingsOpen);
  const setOpen = useUI((s) => s.setSettingsOpen);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  if (!open) return null;

  const patchProvider = (id: string, patch: Partial<ProviderConfig>) => {
    void updateSettings({
      providers: settings.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  };

  return (
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="modal__panel">
        <header className="modal__head">
          <h2 className="modal__title">Settings</h2>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setOpen(false)}
            aria-label="Close settings"
          >
            ✕
          </button>
        </header>

        <div className="modal__body">
          <section className="pane">
            <h3 className="pane__title">Provider</h3>
            <p className="pane__note pane__note--warn">
              Your API key is stored in this browser's IndexedDB. That is not
              secure against anything else running in this browser — an
              extension, or script on this page, can read it. ToonDao is a
              local-first personal tool, not a hardened one. Use a key you are
              willing to rotate.
            </p>

            <div className="field">
              <label className="field__label" htmlFor="active-provider">
                Active
              </label>
              <select
                id="active-provider"
                className="input"
                value={settings.activeProviderId ?? ""}
                onChange={(e) => void updateSettings({ activeProviderId: e.target.value })}
              >
                {settings.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} — {p.model}
                  </option>
                ))}
              </select>
            </div>

            {settings.providers.map((provider) => (
              <fieldset
                key={provider.id}
                className={`provider${
                  provider.id === settings.activeProviderId ? " provider--active" : ""
                }`}
              >
                <legend className="provider__legend">
                  {provider.label}
                  <span className="provider__kind">{provider.kind}</span>
                </legend>

                <div className="field">
                  <label className="field__label" htmlFor={`base-${provider.id}`}>
                    Base URL
                  </label>
                  <input
                    id={`base-${provider.id}`}
                    className="input input--mono"
                    value={provider.baseUrl}
                    spellCheck={false}
                    onChange={(e) => patchProvider(provider.id, { baseUrl: e.target.value })}
                  />
                  <p className="field__hint">
                    {provider.kind === "anthropic"
                      ? "/v1/messages is appended."
                      : provider.kind === "claude-code"
                        ? "Where the bridge listens. It runs your own Claude Code: start it with npm run bridge."
                        : "/chat/completions is appended. Works with OpenAI, Ollama, llama.cpp, vLLM, and relay (中转) endpoints."}
                  </p>
                </div>

                {provider.kind === "claude-code" ? (
                  <BridgeStatus baseUrl={provider.baseUrl} />
                ) : (
                <div className="field">
                  <label className="field__label" htmlFor={`key-${provider.id}`}>
                    API key
                  </label>
                  <div className="field__row">
                    <input
                      id={`key-${provider.id}`}
                      className="input input--mono"
                      type={revealed[provider.id] ? "text" : "password"}
                      value={provider.apiKey}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={keyPlaceholder(provider)}
                      onChange={(e) => patchProvider(provider.id, { apiKey: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() =>
                        setRevealed((r) => ({ ...r, [provider.id]: !r[provider.id] }))
                      }
                    >
                      {revealed[provider.id] ? "hide" : "show"}
                    </button>
                  </div>
                </div>
                )}

                <div className="field">
                  <label className="field__label" htmlFor={`model-${provider.id}`}>
                    Model
                  </label>
                  <input
                    id={`model-${provider.id}`}
                    className="input input--mono"
                    value={provider.model}
                    spellCheck={false}
                    list={`models-${provider.id}`}
                    onChange={(e) => patchProvider(provider.id, { model: e.target.value })}
                  />
                  <datalist id={`models-${provider.id}`}>
                    {provider.knownModels.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </div>
              </fieldset>
            ))}
          </section>

          <section className="pane">
            <h3 className="pane__title">Display</h3>
            <div className="field">
              <span className="field__label" id="text-size-label">Text size</span>
              <div className="segmented" role="radiogroup" aria-labelledby="text-size-label">
                {TEXT_SIZES.map((size) => {
                  const on = (settings.textSize ?? "default") === size.id;
                  return (
                    <button
                      key={size.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={`segmented__option${on ? " segmented__option--on" : ""}`}
                      style={{ fontSize: `${13 * size.scale}px` }}
                      onClick={() => void updateSettings({ textSize: size.id })}
                    >
                      {size.label}
                    </button>
                  );
                })}
              </div>
              <p className="field__hint">Changes the size of all text in ToonDao; the layout stays as it is.</p>
            </div>
          </section>

          <section className="pane">
            <h3 className="pane__title">Generation</h3>

            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.pacing}
                onChange={(e) => void updateSettings({ pacing: e.target.checked })}
              />
              <span>
                <span className="toggle__label">Pace answers in new conversations</span>
                <span className="toggle__hint">
                  Ask for one idea at a time, ending at a checkpoint, instead of
                  everything at once. This is the default a new conversation starts
                  with; switch it for one branch with "pace" under the message box,
                  and every question below it, asides included, follows. The wording
                  is the Pacing template below, in the system message.
                </span>
              </span>
            </label>

            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.chatTools}
                onChange={(e) => void updateSettings({ chatTools: e.target.checked })}
              />
              <span>
                <span className="toggle__label">Let replies look things up</span>
                <span className="toggle__hint">
                  Claude Code bridge only. This decides replies and quotes in the thread. In an
                  aside, the move that opened it decides: an Explain aside may search the web
                  throughout; Just this and Lost me here never do. Every lookup is listed with
                  the reply it went into.
                </span>
              </span>
            </label>

            <div className="field">
              <label className="field__label" htmlFor="system-prompt">
                System prompt
              </label>
              <textarea
                id="system-prompt"
                className="input input--area"
                rows={3}
                value={settings.systemPrompt}
                placeholder="Applied to every request, including isolated ones."
                onChange={(e) => void updateSettings({ systemPrompt: e.target.value })}
              />
            </div>

            <div className="field field--split">
              <div>
                <label className="field__label" htmlFor="temperature">
                  Temperature — {settings.temperature.toFixed(2)}
                </label>
                <input
                  id="temperature"
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={settings.temperature}
                  onChange={(e) => void updateSettings({ temperature: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="field__label" htmlFor="max-tokens">
                  Max output tokens
                </label>
                <input
                  id="max-tokens"
                  className="input input--mono"
                  type="number"
                  min={1}
                  value={settings.maxTokens ?? ""}
                  placeholder="provider default"
                  onChange={(e) =>
                    void updateSettings({
                      maxTokens: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                />
              </div>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="lens-turns">
                Concept lens default window — {settings.conceptLensTurns} turn
                {settings.conceptLensTurns === 1 ? "" : "s"}
              </label>
              <input
                id="lens-turns"
                type="range"
                min={1}
                max={5}
                step={1}
                value={settings.conceptLensTurns}
                onChange={(e) =>
                  void updateSettings({ conceptLensTurns: Number(e.target.value) })
                }
              />
              <p className="field__hint">
                Adjustable per use in the popover before sending.
              </p>
            </div>
          </section>

          <section className="pane">
            <h3 className="pane__title">Prompt templates</h3>
            <TemplateEditor />
          </section>

          <section className="pane">
            <h3 className="pane__title">Projects</h3>
            <ProjectsPane />
          </section>

          <section className="pane">
            <h3 className="pane__title">Your data</h3>
            <DataPane />
          </section>
        </div>
      </div>
    </div>
  );
}
