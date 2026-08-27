import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeProviders } from "@/db/db";
import type { ProviderConfig } from "@/types";

/**
 * Provider seeding has to survive across versions. The shallow
 * `{...DEFAULT_SETTINGS, ...stored}` spread replaces the whole `providers`
 * array with the stored one, which means a preset added in a later version can
 * never reach a profile that already exists — the failure mode is silent, and
 * it looks to the user like a missing feature rather than a stale database.
 */

const preset = (id: string) => DEFAULT_SETTINGS.providers.find((p) => p.id === id)!;

describe("mergeProviders", () => {
  it("seeds all presets into an empty profile", () => {
    expect(mergeProviders([]).map((p) => p.id)).toEqual(
      DEFAULT_SETTINGS.providers.map((p) => p.id),
    );
  });

  it("adds a newly shipped preset to a profile that predates it", () => {
    // A profile from before the mock preset existed.
    const old: ProviderConfig[] = [preset("openai"), preset("anthropic"), preset("local")];
    const merged = mergeProviders(old);
    expect(merged.map((p) => p.id)).toContain("mock");
    expect(merged.find((p) => p.id === "mock")!.baseUrl).toBe("http://localhost:8787/v1");
  });

  it("never overwrites an edited base URL, key or model", () => {
    const edited: ProviderConfig[] = [
      {
        ...preset("openai"),
        baseUrl: "https://my-relay.example/v1",
        apiKey: "sk-mine",
        model: "some-other-model",
      },
    ];
    const merged = mergeProviders(edited);
    const openai = merged.find((p) => p.id === "openai")!;
    expect(openai.baseUrl).toBe("https://my-relay.example/v1");
    expect(openai.apiKey).toBe("sk-mine");
    expect(openai.model).toBe("some-other-model");
  });

  it("adopts new knownModels only when the user has none of their own", () => {
    const withNone = mergeProviders([{ ...preset("openai"), knownModels: [] }]);
    expect(withNone.find((p) => p.id === "openai")!.knownModels).toEqual(
      preset("openai").knownModels,
    );

    const withOwn = mergeProviders([{ ...preset("openai"), knownModels: ["only-mine"] }]);
    expect(withOwn.find((p) => p.id === "openai")!.knownModels).toEqual(["only-mine"]);
  });

  it("keeps a provider the user added themselves, at the end", () => {
    const custom: ProviderConfig = {
      id: "my-own",
      kind: "openai-compatible",
      label: "My relay",
      baseUrl: "https://relay.example/v1",
      apiKey: "sk-x",
      model: "m",
      knownModels: [],
    };
    const merged = mergeProviders([custom]);
    expect(merged.at(-1)!.id).toBe("my-own");
    expect(merged).toHaveLength(DEFAULT_SETTINGS.providers.length + 1);
  });

  it("preserves the default ordering so the list does not reshuffle", () => {
    const shuffled = [preset("local"), preset("openai"), preset("anthropic")];
    expect(mergeProviders(shuffled).map((p) => p.id).slice(0, 3)).toEqual([
      "openai",
      "anthropic",
      "local",
    ]);
  });

  it("is idempotent", () => {
    const once = mergeProviders([]);
    expect(mergeProviders(once)).toEqual(once);
  });
});

describe("the mock preset matches the server this repo ships", () => {
  it("points at the port dev/mock-llm.mjs defaults to", () => {
    // dev/mock-llm.mjs: PORT = Number(process.env.PORT ?? 8787)
    expect(preset("mock").baseUrl).toBe("http://localhost:8787/v1");
    expect(preset("mock").apiKey).toBe("");
    expect(preset("mock").kind).toBe("openai-compatible");
  });
});
