/**
 * A tiny OpenAI-compatible SSE server, so the app can be run and tested end to
 * end without a provider key.
 *
 *   node dev/mock-llm.mjs        # or: npm run dev:mock
 *
 * Then in Settings pick the "Local / relay (中转)" provider and set its base URL
 * to http://localhost:8787/v1.
 *
 * It speaks the real wire format — POST /chat/completions with `stream: true`,
 * `data:` frames, a `[DONE]` sentinel — so it exercises the actual adapter
 * rather than a mock inside the app. Every request body is appended to
 * dev/requests.jsonl, which is what makes it possible to check that the payload
 * the context inspector claims is the payload that actually went over the wire.
 *
 * The reply is deliberately multi-block (paragraphs, a fenced code block, a
 * list) so the §5.2 crop rail has real block boundaries to snap to, and every
 * reply is numbered so a payload dump is unambiguous about which node a given
 * passage came from.
 */
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 8787);
const LOG = new URL("./requests.jsonl", import.meta.url).pathname;
writeFileSync(LOG, "");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REPLY = `Reply #N paragraph one: a structured answer, so the crop rail has blocks to snap to.

Reply #N paragraph two: the **first** consideration is that a \`ContextPolicy\` is per-node.

Reply #N paragraph three: the Reingold Tilford layout places the tree.

\`\`\`ts
function assembleContext(node) {
  return walk(node);
}
\`\`\`

- Reply #N list item four about the model
- Reply #N list item five about the model

Reply #N paragraph six mentions the model one last time and then stops.`;

let counter = 0;

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    appendFileSync(
      LOG,
      `${JSON.stringify({ url: req.url, at: Date.now(), body: safeParse(body) })}\n`,
    );

    res.writeHead(200, {
      ...CORS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const reply = REPLY.replaceAll("#N", String(++counter));
    const tokens = reply.match(/\s*\S+/g) ?? [];
    let i = 0;
    const timer = setInterval(() => {
      if (i >= tokens.length) {
        clearInterval(timer);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: tokens[i++] } }] })}\n\n`,
      );
    }, 12);
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    // Almost always a previous instance of this script still running. A stack
    // trace tells you nothing useful about that, so don't print one.
    console.error(
      [
        `Port ${PORT} is already in use.`,
        "",
        "Most likely another mock-llm is still running. Either use it as-is, or:",
        `  lsof -nP -iTCP:${PORT} -sTCP:LISTEN     # see what holds it`,
        "  pkill -f mock-llm.mjs                # stop it",
        "",
        `Or pick a different port:  PORT=8788 npm run dev:mock`,
        "(then update the provider base URL in Settings to match)",
      ].join("\n"),
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`mock llm listening on http://localhost:${PORT}`);
  console.log(`request log: ${LOG}`);
});

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
