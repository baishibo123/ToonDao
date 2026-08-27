import { useState } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import type { ProviderConfig } from "@/types";

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
                      : "/chat/completions is appended. Works with OpenAI, Ollama, llama.cpp, vLLM, and relay (中转) endpoints."}
                  </p>
                </div>

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
                      placeholder={provider.kind === "anthropic" ? "sk-ant-…" : "sk-… (blank for local)"}
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
            <h3 className="pane__title">Generation</h3>

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
        </div>
      </div>
    </div>
  );
}
