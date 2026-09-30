// Bundles the reader (reader/src/main.tsx) into <out>/reader.js + reader.css, and copies index.html.

import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;

export async function bundleReader(out: string): Promise<void> {
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [join(root, "reader/src/main.tsx")],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    sourcemap: true,
    jsx: "automatic",
    jsxImportSource: "preact",
    outfile: join(out, "reader.js"),
    logLevel: "warning",
  });
  await build({
    entryPoints: [join(root, "reader/src/styles.css")],
    bundle: true,
    minify: true,
    outfile: join(out, "reader.css"),
    logLevel: "warning",
  });
  copyFileSync(join(root, "reader/index.html"), join(out, "index.html"));
}
