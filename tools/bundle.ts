// Bundles the reader (reader/src/main.tsx) into <out>/reader.js + reader.css, and writes index.html
// referring to them by content hash (?v=…), so browsers never pair a cached old bundle with new data.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const hash = (file: string) => createHash("sha256").update(readFileSync(join(out, file))).digest("hex").slice(0, 12);
  const html = readFileSync(join(root, "reader/index.html"), "utf8")
    .replace('href="reader.css"', `href="reader.css?v=${hash("reader.css")}"`)
    .replace('src="reader.js"', `src="reader.js?v=${hash("reader.js")}"`);
  if (!html.includes("reader.js?v=") || !html.includes("reader.css?v=")) throw new Error("index.html: reader.js/reader.css references not found");
  writeFileSync(join(out, "index.html"), html);
}
