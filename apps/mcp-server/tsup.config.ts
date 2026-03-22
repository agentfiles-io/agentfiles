import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/http.ts"],
  format: ["esm"],
  dts: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  clean: true,
  // Bundle @attach/shared into the output so the published package is self-contained
  noExternal: ["@attach/shared"],
});
