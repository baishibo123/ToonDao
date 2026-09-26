// Entry point for `npm run bridge`. Plain JavaScript on purpose: it has to run
// on any Node to tell an old one, clearly, that the bridge needs a newer one —
// the bridge itself is TypeScript, run directly by Node 22.18+.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(
    `The ToonDao bridge needs Node 22.18 or newer (it runs TypeScript directly). This is Node ${process.version}.`,
  );
  process.exit(1);
}
const { main } = await import("./claude-code.ts");
await main();
