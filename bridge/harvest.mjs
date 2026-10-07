// Entry point for `npm run harvest`. Plain JavaScript for the same reason as
// index.mjs: it has to tell an old Node, clearly, that it needs a newer one.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(
    `The ToonDao harvest needs Node 22.18 or newer (it runs TypeScript directly). This is Node ${process.version}.`,
  );
  process.exit(1);
}
const { main } = await import("./harvest.ts");
process.exitCode = await main(process.argv.slice(2));
