import { describe, expect, it } from "vitest";
import {
  assembleContext,
  asProse,
  contextStart,
  lineageChain,
  policyLabel,
} from "@/lib/assembleContext";
import { DEFAULT_TEMPLATES, RETIRED_TEMPLATES, currentTemplate } from "@/lib/templates";
import { draftNode, planSubmission } from "@/lib/draft";
import { TEMPLATES_UNDER_TEST, TreeFixture } from "./helpers";
import type { TemplateSet } from "@/types";

const T: TemplateSet = DEFAULT_TEMPLATES;

describe("full-ancestry", () => {
  it("walks parentId to root and reverses", () => {
    const t = new TreeFixture();
    t.linear(3);
    const leaf = t.all().at(-1)!;
    const next = t.add("user", "question turn 4", leaf.id);

    const msgs = assembleContext(next, t, T);
    expect(msgs.map((m) => m.role)).toEqual([
      "user", "assistant", "user", "assistant", "user", "assistant", "user",
    ]);
    expect(msgs.at(0)!.content).toBe("question turn 1");
    expect(msgs.at(-1)!.content).toBe("question turn 4");
  });

  it("prepends the global system prompt when one is set", () => {
    const t = new TreeFixture();
    const u = t.add("user", "hi", null);
    const msgs = assembleContext(u, t, T, { systemPrompt: "  be terse  " });
    expect(msgs[0]).toEqual({ role: "system", content: "be terse" });
    expect(msgs).toHaveLength(2);
  });

  it("omits the system message when the prompt is blank", () => {
    const t = new TreeFixture();
    const u = t.add("user", "hi", null);
    expect(assembleContext(u, t, T, { systemPrompt: "   " })).toHaveLength(1);
  });

  describe("pacing", () => {
    it("puts the pacing template in the system message when it is on", () => {
      const t = new TreeFixture();
      const u = t.add("user", "hi", null);
      const msgs = assembleContext(u, t, T, { pacing: true });
      expect(msgs[0]).toEqual({ role: "system", content: T.pacing.trim() });
      expect(msgs).toHaveLength(2);
    });

    it("comes after the user's own system prompt, in one system message", () => {
      const t = new TreeFixture();
      const u = t.add("user", "hi", null);
      const msgs = assembleContext(u, t, T, { systemPrompt: "be terse", pacing: true });
      expect(msgs.filter((m) => m.role === "system")).toHaveLength(1);
      expect(msgs[0].content).toBe(`be terse\n\n${T.pacing.trim()}`);
    });

    it("is absent when off, and absent by default", () => {
      const t = new TreeFixture();
      const u = t.add("user", "hi", null);
      expect(assembleContext(u, t, T, { pacing: false })).toHaveLength(1);
      expect(assembleContext(u, t, T)).toHaveLength(1);
    });

    it("reaches every policy the same way, isolation included", () => {
      const t = new TreeFixture();
      t.linear(3);
      const leaf = t.all().at(-1)!;
      const iso = t.add("user", "", leaf.id, { kind: "isolated", payload: "x" }, "isolated-selection");
      const lens = t.add(
        "user", "term", leaf.id,
        { kind: "windowed", turns: 1, upToNodeId: leaf.id }, "concept-lens",
      );
      for (const node of [iso, lens]) {
        const msgs = assembleContext(node, t, T, { pacing: true });
        expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
        expect(msgs[0].content).toBe(T.pacing.trim());
      }
    });

    it("uses the edited template, never a hardcoded copy", () => {
      const t = new TreeFixture();
      const u = t.add("user", "hi", null);
      const edited = { ...T, pacing: "one thing at a time" };
      expect(assembleContext(u, t, edited, { pacing: true })[0].content).toBe(
        "one thing at a time",
      );
    });

    it("sends no empty system message when the template is blanked", () => {
      const t = new TreeFixture();
      const u = t.add("user", "hi", null);
      expect(assembleContext(u, t, { ...T, pacing: "  " }, { pacing: true })).toHaveLength(1);
    });
  });

  it("follows only the node's own branch, not sibling branches", () => {
    const t = new TreeFixture();
    const u1 = t.add("user", "q1", null);
    const a1 = t.add("assistant", "a1", u1.id);
    const branchA = t.add("user", "branch A", a1.id);
    t.add("assistant", "reply A", branchA.id);
    const branchB = t.add("user", "branch B", a1.id);

    const msgs = assembleContext(branchB, t, T);
    expect(msgs.map((m) => m.content)).toEqual(["q1", "a1", "branch B"]);
    expect(JSON.stringify(msgs)).not.toContain("branch A");
  });

  it("resolves an assistant node to the payload that produced it", () => {
    const t = new TreeFixture();
    const u1 = t.add("user", "q1", null);
    const a1 = t.add("assistant", "a1", u1.id);

    // The payload sent to generate a1 was everything up to and including u1.
    expect(assembleContext(a1, t, T)).toEqual(assembleContext(u1, t, T));
    expect(assembleContext(a1, t, T).map((m) => m.content)).toEqual(["q1"]);
  });

  it("does not hang on a cyclic parent chain", () => {
    const t = new TreeFixture();
    const a = t.add("user", "a", null);
    const b = t.add("assistant", "b", a.id);
    a.parentId = b.id; // corrupt on purpose
    expect(assembleContext(a, t, T).length).toBeLessThanOrEqual(2);
  });
});

describe("windowed (§5.1 concept lens)", () => {
  it("ACCEPTANCE 1: keeps exactly turns 5-6 of a 6-turn conversation", () => {
    const t = new TreeFixture();
    t.linear(6);
    const turn6Assistant = t.all().at(-1)!;

    const lens = t.add(
      "user",
      "monotonicity",
      turn6Assistant.id,
      { kind: "windowed", turns: 2, upToNodeId: turn6Assistant.id },
      "concept-lens",
    );

    const msgs = assembleContext(lens, t, T);
    expect(msgs).toHaveLength(1);
    const body = msgs[0].content;

    expect(body).toContain("User: question turn 5");
    expect(body).toContain("Assistant: answer turn 5");
    expect(body).toContain("User: question turn 6");
    expect(body).toContain("Assistant: answer turn 6");

    // The whole point: turn 1 is gone.
    expect(body).not.toContain("turn 1");
    expect(body).not.toContain("turn 2");
    expect(body).not.toContain("turn 3");
    expect(body).not.toContain("turn 4");

    expect(body).toContain("This is the passage I'm asking about");
    expect(body).toContain("monotonicity");
  });

  it("honours turn counts across the 1-5 configurable range", () => {
    const t = new TreeFixture();
    t.linear(6);
    const src = t.all().at(-1)!;

    for (const turns of [1, 2, 3, 4, 5]) {
      const lens = t.add(
        "user",
        "concept",
        src.id,
        { kind: "windowed", turns, upToNodeId: src.id },
        "concept-lens",
      );
      const body = assembleContext(lens, t, T)[0].content;
      const included = [1, 2, 3, 4, 5, 6].filter((n) =>
        body.includes(`question turn ${n}`),
      );
      expect(included).toEqual(
        [1, 2, 3, 4, 5, 6].slice(6 - turns),
      );
    }
  });

  it("clamps to the available history without producing an orphan turn", () => {
    const t = new TreeFixture();
    t.linear(1);
    const src = t.all().at(-1)!;
    const lens = t.add(
      "user",
      "concept",
      src.id,
      { kind: "windowed", turns: 5, upToNodeId: src.id },
      "concept-lens",
    );
    const body = assembleContext(lens, t, T)[0].content;
    expect(body).toContain("User: question turn 1");
    expect(body).toContain("Assistant: answer turn 1");
  });

  it("never opens the window on an orphan assistant message", () => {
    const t = new TreeFixture();
    t.linear(3);
    const src = t.all().at(-1)!;
    // turns=1 over a chain ending ...user6,assistant6 gives a clean pair;
    // force the odd case by windowing to a user node instead.
    const userNode = t.all().at(-2)!;
    const lens = t.add(
      "user",
      "concept",
      userNode.id,
      { kind: "windowed", turns: 1, upToNodeId: userNode.id },
      "concept-lens",
    );
    const body = assembleContext(lens, t, T)[0].content;
    const firstLine = body
      .split("\n")
      .find((l) => l.startsWith("User:") || l.startsWith("Assistant:"));
    expect(firstLine!.startsWith("User:")).toBe(true);
    expect(src.id).toBeTruthy();
  });

  it("P-27: a follow-up in an Explain aside carries the aside's opening, not the thread", () => {
    const t = new TreeFixture();
    t.linear(6);
    const src = t.all().at(-1)!;
    const lens = t.add(
      "user",
      "monotonicity",
      src.id,
      { kind: "windowed", turns: 2, upToNodeId: src.id },
      "concept-lens",
    );
    const lensReply = t.add("assistant", "about monotonicity", lens.id);
    const followUp = t.add("user", "and now?", lensReply.id);

    const opening = assembleContext(lens, t, T)[0].content;
    const msgs = assembleContext(followUp, t, T);
    // The opening prompt stands in for everything above the aside, word for word.
    expect(msgs.map((m) => m.content)).toEqual([opening, "about monotonicity", "and now?"]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // Only the window's two turns came along; the four before it stay out.
    const body = JSON.stringify(msgs);
    expect(body).toContain("question turn 5");
    for (const i of [1, 2, 3, 4]) expect(body).not.toContain(`question turn ${i}`);
  });

  it("P-27: an aside inside an aside is carved from the aside, not the thread", () => {
    const t = new TreeFixture();
    t.linear(4);
    const src = t.all().at(-1)!;
    const outer = t.add(
      "user",
      "monotonicity",
      src.id,
      { kind: "windowed", turns: 1, upToNodeId: src.id },
      "concept-lens",
    );
    const outerReply = t.add("assistant", "monotone means order-preserving", outer.id);
    const inner = t.add(
      "user",
      "order-preserving",
      outerReply.id,
      { kind: "windowed", turns: 1, upToNodeId: outerReply.id },
      "concept-lens",
    );

    const body = assembleContext(inner, t, T)[0].content;
    // Its window is the outer aside's one turn, which itself carried turn 4 only.
    expect(body).toContain("monotone means order-preserving");
    expect(body).toContain("answer turn 4");
    for (const i of [1, 2, 3]) expect(body).not.toContain(`question turn ${i}`);
  });
});

describe("truncated (§5.2 structural crop)", () => {
  const FIVE_PARAS = [
    "Paragraph one sets up the problem.",
    "Paragraph two introduces the lemma.",
    "Paragraph three is where it goes wrong.",
    "Paragraph four compounds the error.",
    "Paragraph five concludes wrongly.",
  ].join("\n\n");

  it("ACCEPTANCE 2: payload holds paragraphs 1-2 and zero tokens from 3-5", () => {
    const t = new TreeFixture();
    const u1 = t.add("user", "explain the proof", null);
    const a1 = t.add("assistant", FIVE_PARAS, u1.id);

    const cutAfterPara2 = FIVE_PARAS.indexOf("Paragraph three");
    const crop = t.add(
      "user",
      "",
      a1.id,
      { kind: "truncated", upToNodeId: a1.id, charOffset: cutAfterPara2 },
      "structural-crop",
    );

    const msgs = assembleContext(crop, t, T);
    expect(msgs).toHaveLength(1);
    const body = msgs[0].content;

    expect(body).toContain("Paragraph one sets up the problem.");
    expect(body).toContain("Paragraph two introduces the lemma.");
    expect(body).not.toContain("Paragraph three");
    expect(body).not.toContain("Paragraph four");
    expect(body).not.toContain("Paragraph five");
    expect(body).toContain("I stopped reading right here.");
  });

  it("never mutates the source node's content", () => {
    const t = new TreeFixture();
    const u1 = t.add("user", "explain", null);
    const a1 = t.add("assistant", FIVE_PARAS, u1.id);
    const crop = t.add(
      "user",
      "",
      a1.id,
      { kind: "truncated", upToNodeId: a1.id, charOffset: 30 },
      "structural-crop",
    );
    assembleContext(crop, t, T);
    expect(t.get(a1.id)!.content).toBe(FIVE_PARAS);
  });

  it("keeps ancestry above the cropped message but excludes the message itself", () => {
    const t = new TreeFixture();
    t.linear(2);
    const a2 = t.all().at(-1)!;
    const crop = t.add(
      "user",
      "",
      a2.id,
      { kind: "truncated", upToNodeId: a2.id, charOffset: 6 },
      "structural-crop",
    );
    const body = assembleContext(crop, t, T)[0].content;
    expect(body).toContain("User: question turn 1");
    expect(body).toContain("Assistant: answer turn 1");
    expect(body).toContain("User: question turn 2");
    expect(body).toContain("Assistant: answer"); // sliced to 6 chars
    expect(body).not.toContain("answer turn 2");
  });

  it("clamps an out-of-range offset instead of throwing", () => {
    const t = new TreeFixture();
    const u1 = t.add("user", "q", null);
    const a1 = t.add("assistant", "short", u1.id);
    for (const charOffset of [-10, 0, 9999, Number.NaN]) {
      const crop = t.add(
        "user",
        "",
        a1.id,
        { kind: "truncated", upToNodeId: a1.id, charOffset },
        "structural-crop",
      );
      expect(() => assembleContext(crop, t, T)).not.toThrow();
    }
  });

  it("appends the user's own note when they typed one", () => {
    const t = new TreeFixture();
    const u1 = t.add("user", "q", null);
    const a1 = t.add("assistant", FIVE_PARAS, u1.id);
    const crop = t.add(
      "user",
      "specifically the lemma step",
      a1.id,
      { kind: "truncated", upToNodeId: a1.id, charOffset: 40 },
      "structural-crop",
    );
    expect(assembleContext(crop, t, T)[0].content).toContain(
      "specifically the lemma step",
    );
  });

  it("P-27: keeps the tail out of every later turn in the aside", () => {
    const t = new TreeFixture();
    const u1 = t.add("user", "explain the proof", null);
    const a1 = t.add("assistant", FIVE_PARAS, u1.id);
    const cut = FIVE_PARAS.indexOf("Paragraph three");
    const crop = t.add(
      "user",
      "",
      a1.id,
      { kind: "truncated", upToNodeId: a1.id, charOffset: cut },
      "structural-crop",
    );
    const cropReply = t.add("assistant", "Up to the lemma, then.", crop.id);
    const followUp = t.add("user", "so what is the lemma for?", cropReply.id);

    const msgs = assembleContext(followUp, t, T);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].content).toBe(assembleContext(crop, t, T)[0].content);
    const body = JSON.stringify(msgs);
    expect(body).toContain("Paragraph two introduces the lemma.");
    expect(body).not.toContain("Paragraph three");
    expect(body).not.toContain("Paragraph five");
  });
});

describe("isolated (§5.3)", () => {
  it("ACCEPTANCE 3: after 10 turns the payload is exactly one user message", () => {
    const t = new TreeFixture();
    t.linear(10);
    const turn10 = t.all().at(-1)!;

    const iso = t.add(
      "user",
      "",
      turn10.id,
      { kind: "isolated", payload: "the map is not the territory" },
      "isolated-selection",
    );

    const msgs = assembleContext(iso, t, T);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toContain("the map is not the territory");
    expect(msgs[0].content).toContain("Treat the text above as the entire context.");
    for (let i = 1; i <= 10; i++) {
      expect(msgs[0].content).not.toContain(`question turn ${i}`);
      expect(msgs[0].content).not.toContain(`answer turn ${i}`);
    }
  });

  it("is still lineage-attached in Graph A while inheriting nothing in Graph B", () => {
    const t = new TreeFixture();
    t.linear(10);
    const turn10 = t.all().at(-1)!;
    const iso = t.add(
      "user",
      "",
      turn10.id,
      { kind: "isolated", payload: "one sentence" },
      "isolated-selection",
    );
    // Graph A: a child of turn 10.
    expect(iso.parentId).toBe(turn10.id);
    expect(t.get(turn10.id)!.childrenIds).toContain(iso.id);
    // Graph B: nothing.
    expect(assembleContext(iso, t, T)).toHaveLength(1);
  });

  it("keeps the global system prompt but inherits no other framing", () => {
    const t = new TreeFixture();
    t.linear(4);
    const leaf = t.all().at(-1)!;
    const iso = t.add(
      "user",
      "",
      leaf.id,
      { kind: "isolated", payload: "sentence" },
      "isolated-selection",
    );
    const msgs = assembleContext(iso, t, T, { systemPrompt: "you are curt" });
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("acts as a context root: descendants do not re-inherit the excluded ancestry", () => {
    const t = new TreeFixture();
    t.linear(10);
    const leaf = t.all().at(-1)!;
    const iso = t.add(
      "user",
      "",
      leaf.id,
      { kind: "isolated", payload: "the map is not the territory" },
      "isolated-selection",
    );
    const isoReply = t.add("assistant", "It means models are lossy.", iso.id);
    const followUp = t.add("user", "why does that matter?", isoReply.id);

    const msgs = assembleContext(followUp, t, T);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].content).toContain("the map is not the territory");
    expect(msgs[1].content).toBe("It means models are lossy.");
    expect(msgs[2].content).toBe("why does that matter?");
    expect(JSON.stringify(msgs)).not.toContain("question turn 1");
  });

  it("lineageChain still reports the true Graph A lineage above a context root", () => {
    const t = new TreeFixture();
    t.linear(3);
    const leaf = t.all().at(-1)!;
    const iso = t.add(
      "user",
      "",
      leaf.id,
      { kind: "isolated", payload: "x" },
      "isolated-selection",
    );
    // Graph B walk stops at the context root...
    expect(lineageChain(iso, t, { inclusive: true })).toHaveLength(1);
    // ...but the parent pointer is intact, which is what the tree draws.
    expect(iso.parentId).toBe(leaf.id);
  });
});

describe("quoted (§5.4)", () => {
  it("prepends the quote as a blockquote above the user's own words", () => {
    const t = new TreeFixture();
    t.linear(2);
    const leaf = t.all().at(-1)!;
    const q = t.add(
      "user",
      "this contradicts what you said earlier",
      leaf.id,
      { kind: "quoted", quote: "gradients vanish here", base: "full-ancestry" },
      "quote-reply",
    );
    const msgs = assembleContext(q, t, T);
    expect(msgs.map((m) => m.role)).toEqual([
      "user", "assistant", "user", "assistant", "user",
    ]);
    expect(msgs.at(-1)!.content).toBe(
      "> gradients vanish here\n\nthis contradicts what you said earlier",
    );
  });

  it("quotes multi-line selections with a marker on every line", () => {
    const t = new TreeFixture();
    const u = t.add("user", "q", null);
    const a = t.add("assistant", "a", u.id);
    const q = t.add(
      "user",
      "why?",
      a.id,
      { kind: "quoted", quote: "line one\n\nline two", base: "full-ancestry" },
      "quote-reply",
    );
    expect(assembleContext(q, t, T).at(-1)!.content).toBe(
      "> line one\n>\n> line two\n\nwhy?",
    );
  });

  it("supports a windowed base", () => {
    const t = new TreeFixture();
    t.linear(6);
    const leaf = t.all().at(-1)!;
    const q = t.add(
      "user",
      "why?",
      leaf.id,
      { kind: "quoted", quote: "that step", base: "windowed", turns: 1 },
      "quote-reply",
    );
    const msgs = assembleContext(q, t, T);
    expect(msgs.map((m) => m.content)).toEqual([
      "question turn 6",
      "answer turn 6",
      "> that step\n\nwhy?",
    ]);
  });

  it("keeps the quote visible to descendants", () => {
    const t = new TreeFixture();
    const u = t.add("user", "q", null);
    const a = t.add("assistant", "a", u.id);
    const q = t.add(
      "user",
      "why?",
      a.id,
      { kind: "quoted", quote: "that step", base: "full-ancestry" },
      "quote-reply",
    );
    const r = t.add("assistant", "because", q.id);
    const next = t.add("user", "ok", r.id);
    expect(assembleContext(next, t, T).map((m) => m.content)).toEqual([
      "q", "a", "> that step\n\nwhy?", "because", "ok",
    ]);
  });
});

describe("asProse", () => {
  it("renders plain unadorned User:/Assistant: lines", () => {
    expect(
      asProse([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]),
    ).toBe("User: hello\n\nAssistant: hi");
  });

  it("does not JSON-encode or XML-wrap content", () => {
    const out = asProse([{ role: "user", content: 'say "hi" <b>' }]);
    expect(out).toBe('User: say "hi" <b>');
  });
});

describe("ACCEPTANCE 4: quote extends, the other three fork", () => {
  it("gives one source node four differently-typed children", () => {
    const t = new TreeFixture();
    t.linear(6);
    const src = t.all().at(-1)!;

    const quote = t.add(
      "user", "why?", src.id,
      { kind: "quoted", quote: "that step", base: "full-ancestry" },
      "quote-reply",
    );
    const lens = t.add(
      "user", "monotonicity", src.id,
      { kind: "windowed", turns: 2, upToNodeId: src.id },
      "concept-lens",
    );
    const crop = t.add(
      "user", "", src.id,
      { kind: "truncated", upToNodeId: src.id, charOffset: 6 },
      "structural-crop",
    );
    const iso = t.add(
      "user", "", src.id,
      { kind: "isolated", payload: "a sentence" },
      "isolated-selection",
    );

    expect(t.get(src.id)!.childrenIds).toEqual([quote.id, lens.id, crop.id, iso.id]);
    expect(
      [quote, lens, crop, iso].map((n) => n.origin!.kind),
    ).toEqual(["quote-reply", "concept-lens", "structural-crop", "isolated-selection"]);

    // Quote-reply carries the whole path; the other three each carry less.
    expect(assembleContext(quote, t, T)).toHaveLength(13);
    expect(assembleContext(lens, t, T)).toHaveLength(1);
    expect(assembleContext(crop, t, T)).toHaveLength(1);
    expect(assembleContext(iso, t, T)).toHaveLength(1);
  });
});

describe("regenerate siblings", () => {
  it("two retries of the same prompt assemble identical payloads", () => {
    const t = new TreeFixture();
    t.linear(2);
    const leaf = t.all().at(-1)!;
    const u = t.add("user", "final question", leaf.id);
    const a1 = t.add("assistant", "first attempt", u.id);
    const a2 = t.add("assistant", "second attempt", u.id, { kind: "full-ancestry" }, "regenerate");

    expect(assembleContext(a1, t, T)).toEqual(assembleContext(a2, t, T));
    expect(assembleContext(a1, t, T).at(-1)!.content).toBe("final question");
  });
});

describe("determinism and purity", () => {
  it("returns an identical array on repeated calls", () => {
    const t = new TreeFixture();
    t.linear(4);
    const leaf = t.all().at(-1)!;
    const n = t.add("user", "again", leaf.id);
    expect(assembleContext(n, t, T)).toEqual(assembleContext(n, t, T));
  });

  it("does not mutate any node", () => {
    const t = new TreeFixture();
    t.linear(4);
    const leaf = t.all().at(-1)!;
    const target = t.add("user", "again", leaf.id);
    const before = JSON.stringify(t.all());
    assembleContext(target, t, T);
    expect(JSON.stringify(t.all())).toBe(before);
  });

  it("survives a dangling parentId", () => {
    const t = new TreeFixture();
    const orphan = t.add("user", "hello", "does-not-exist");
    expect(assembleContext(orphan, t, T).map((m) => m.content)).toEqual(["hello"]);
  });
});

describe("contextStart (P-27)", () => {
  it("names the aside a later turn is under, and nothing on the thread or at a root", () => {
    const t = new TreeFixture();
    t.linear(3);
    const src = t.all().at(-1)!;
    const lens = t.add(
      "user",
      "monotonicity",
      src.id,
      { kind: "windowed", turns: 2, upToNodeId: src.id },
      "concept-lens",
    );
    const lensReply = t.add("assistant", "about monotonicity", lens.id);
    const followUp = t.add("user", "and now?", lensReply.id);
    const followReply = t.add("assistant", "now this", followUp.id);

    expect(contextStart(src, t)).toBeNull();
    expect(contextStart(lens, t)).toBeNull();
    expect(contextStart(lensReply, t)).toBeNull();
    expect(contextStart(followUp, t)?.id).toBe(lens.id);
    expect(contextStart(followReply, t)?.id).toBe(lens.id);

    expect(policyLabel(followUp.contextPolicy)).toBe("full ancestry");
    expect(policyLabel(followUp.contextPolicy, lens.contextPolicy)).toBe("this aside");
  });
});

describe("P-47 what this chat draws", () => {
  it("joins the system message after the person's own prompt and before pacing, on every policy", () => {
    const t = new TreeFixture();
    const u = t.add("user", "draw me a cache", null);
    const msgs = assembleContext(u, t, T, { systemPrompt: "Mine.", rendering: true, pacing: true });
    expect(msgs[0]).toEqual({ role: "system", content: `Mine.\n\n${T.rendering}\n\n${T.files}\n\n${T.pacing}` });
    expect(T.rendering).toContain("svg");
    // P-53: how a block is named to be saved, right after what this chat draws.
    expect(T.files).toContain("```python scripts/fetch.py");

    const isolated = t.add("user", "", u.id, { kind: "isolated", payload: "x" }, "isolated-selection");
    expect(assembleContext(isolated, t, T, { rendering: true })[0]).toEqual({ role: "system", content: `${T.rendering}\n\n${T.files}` });
  });

  it("is left out when its template is emptied, or not asked for", () => {
    const t = new TreeFixture();
    const u = t.add("user", "hi", null);
    expect(assembleContext(u, t, { ...T, rendering: "  ", files: "" }, { rendering: true })).toEqual([{ role: "user", content: "hi" }]);
    expect(assembleContext(u, t, { ...T, files: "" }, { rendering: true })[0]).toEqual({ role: "system", content: T.rendering });
    expect(assembleContext(u, t, T)).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("Explain carries its passage and its question (P-59)", () => {
  const passage = "SGD with warm restarts";
  function explain(t: TreeFixture, typed: string) {
    t.linear(3);
    const src = t.all().at(-1)!;
    const plan = planSubmission({
      text: typed,
      pending: { kind: "concept", sourceNodeId: src.id, anchor: { start: 0, end: 4, text: passage }, turns: 2 },
      activeLeafId: src.id,
    });
    return draftNode(plan, t.conversationId);
  }

  it("sends the passage when a question is typed, and the question after it", () => {
    const t = new TreeFixture();
    const body = assembleContext(explain(t, "why restart at all?"), t, T)[0].content;
    expect(body).toContain(passage);
    expect(body.indexOf(passage)).toBeLessThan(body.indexOf("why restart at all?"));
    expect(body.trimEnd().endsWith("why restart at all?")).toBe(true);
  });

  it("sends the passage once, and no empty question, when nothing is typed", () => {
    const t = new TreeFixture();
    const body = assembleContext(explain(t, ""), t, T)[0].content;
    expect(body.split(passage)).toHaveLength(2);
    expect(body).toBe(body.trimEnd());
    expect(body).not.toContain("{{");
  });

  it("assembles a node made before P-59 exactly as it was sent then", () => {
    const t = new TreeFixture();
    t.linear(3);
    const src = t.all().at(-1)!;
    const old = t.add("user", "monotonicity", src.id, { kind: "windowed", turns: 2, upToNodeId: src.id }, "concept-lens");
    const legacy = TEMPLATES_UNDER_TEST.concept_lens;
    const then = legacy
      .replace("{{context_turns}}", "User: question turn 2\n\nAssistant: answer turn 2\n\nUser: question turn 3\n\nAssistant: answer turn 3")
      .replace("{{concept}}", "monotonicity");
    expect(assembleContext(old, t, { ...T, concept_lens: legacy })[0].content).toBe(then);
  });

  it("keeps the question under a template that has no slot for it (A-9)", () => {
    const t = new TreeFixture();
    const node = explain(t, "why restart at all?");
    const body = assembleContext(node, t, { ...T, concept_lens: TEMPLATES_UNDER_TEST.concept_lens })[0].content;
    expect(body).toContain(passage);
    expect(body.endsWith("\n\nwhy restart at all?")).toBe(true);
  });
});

describe("currentTemplate (P-59)", () => {
  it("reads an unedited earlier default as today's, and an edited one as it is", () => {
    const retired = RETIRED_TEMPLATES.concept_lens![0];
    expect(currentTemplate("concept_lens", retired)).toBe(DEFAULT_TEMPLATES.concept_lens);
    expect(currentTemplate("concept_lens", `${retired} Be brief.`)).toBe(`${retired} Be brief.`);
    expect(currentTemplate("pacing", DEFAULT_TEMPLATES.pacing)).toBe(DEFAULT_TEMPLATES.pacing);
  });
});
