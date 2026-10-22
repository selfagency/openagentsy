import { defineConfig } from "tsdown"

/**
 * The plugin is loaded from the OpenCode config directory, where bare
 * imports do not resolve. The bundle has to stand on its own, so zod and the
 * core package are inlined and the output has no external dependency.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: false,
  clean: true,
  noExternal: ["zod", "@openagentsy/core"],
  outputOptions: {
    minify: false,
  },
})
