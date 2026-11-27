import { build } from "esbuild";
await build({
  entryPoints: [new URL("../src/agents/hostMain.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: new URL("../dist/agent-host.cjs", import.meta.url).pathname,
});
