/**
 * Naming a conversation (P-34): one small request built from the thread, and
 * the model's reply cleaned into a title.
 */
import { describe, expect, it } from "vitest";
import { assembleTitle, TITLE_BUDGET } from "@/lib/assembleContext";
import { DEFAULT_TEMPLATES } from "@/lib/templates";
import { cleanTitle, TITLE_MAX } from "@/lib/title";
import { TreeFixture } from "./helpers";

const T = DEFAULT_TEMPLATES;

describe("assembleTitle", () => {
  it("sends one message: the template with the asks and the answer's opening, nothing else", () => {
    const t = new TreeFixture();
    const u = t.add("user", "为什么相机连上热点之后 Mac 就断网了？", null);
    t.add("assistant", "因为 AP 模式下 Mac 的 Wi-Fi 网卡只能连一个网络。".repeat(40), u.id);
    const msgs = assembleTitle(t.all(), T);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content).toContain("- 为什么相机连上热点之后 Mac 就断网了？");
    expect(msgs[0]?.content).toContain("Write a title for this conversation");
    // The answer is clipped to its opening, whatever its length.
    const answer = msgs[0]!.content.split("How the latest answer begins:\n")[1] ?? "";
    expect(answer.length).toBeLessThanOrEqual(TITLE_BUDGET.answerChars);
  });

  it("stays small however long the thread grows: the first ask and the latest few", () => {
    const t = new TreeFixture();
    const nodes = t.linear(20);
    const msgs = assembleTitle(nodes, T);
    const asks = msgs[0]!.content.match(/^- question turn \d+$/gm) ?? [];
    expect(asks).toEqual([
      "- question turn 1",
      "- question turn 17",
      "- question turn 18",
      "- question turn 19",
      "- question turn 20",
    ]);
    expect(msgs[0]!.content).toContain("answer turn 20");
    expect(msgs[0]!.content.length).toBeLessThan(2000);
  });

  it("clips a long ask", () => {
    const t = new TreeFixture();
    t.add("user", "x".repeat(2000), null);
    const line = assembleTitle(t.all(), T)[0]!.content.split("\n").find((l) => l.startsWith("- ")) ?? "";
    expect(line.length).toBeLessThanOrEqual(TITLE_BUDGET.askChars + 2);
  });
});

describe("cleanTitle", () => {
  it("keeps the first line, without the label, quotes and full stop a model adds", () => {
    expect(cleanTitle('Title: "Camera AP mode and the Mac\'s Wi-Fi."\nMore text')).toBe(
      "Camera AP mode and the Mac's Wi-Fi",
    );
    expect(cleanTitle("标题：「相机热点模式与 Mac 断网」。")).toBe("相机热点模式与 Mac 断网");
    expect(cleanTitle("\n\n**BLE pairing basics**\n")).toBe("BLE pairing basics");
  });

  it("is empty for an empty reply, and never longer than the sidebar can hold", () => {
    expect(cleanTitle("   \n ")).toBe("");
    expect(cleanTitle("a".repeat(200)).length).toBe(TITLE_MAX);
  });
});
