// Bundle the reader and give each script, style sheet, and source map a content hash in its name.
// The HTML file refers to these exact assets.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { writeOutputFile } from "./output";

const sourceRoot = new URL("..", import.meta.url);

/** Each asset name includes a hash of its bytes. The HTML file points to those exact assets. */
export async function bundleReader(out: string, rootUrl = sourceRoot): Promise<{ fingerprint: string }> {
  const root = fileURLToPath(rootUrl);
  mkdirSync(out, { recursive: true });
  const scripts = await build({
    entryPoints: [join(root, "reader/src/main.tsx")],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    sourcemap: "linked",
    jsx: "automatic",
    jsxImportSource: "preact",
    outfile: join(out, "reader.js"),
    write: false,
    logLevel: "warning",
  });
  const styles = await build({
    entryPoints: [join(root, "reader/src/styles.css")],
    bundle: true,
    minify: true,
    outfile: join(out, "reader.css"),
    write: false,
    logLevel: "warning",
  });
  const hash = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");
  const map = scripts.outputFiles.find((file) => file.path.endsWith(".js.map"));
  const script = scripts.outputFiles.find((file) => file.path.endsWith(".js"));
  const style = styles.outputFiles.find((file) => file.path.endsWith(".css"));
  if (!map || !script || !style) throw new Error("Reader bundler did not return all expected assets");
  const mapName = `reader-${hash(map.contents)}.js.map`;
  const scriptText = script.text.replace(/\/\/# sourceMappingURL=reader\.js\.map\s*$/, `//# sourceMappingURL=${mapName}\n`);
  const scriptName = `reader-${hash(scriptText)}.js`;
  const styleName = `reader-${hash(style.contents)}.css`;
  writeOutputFile(out, mapName, map.contents);
  writeOutputFile(out, scriptName, scriptText);
  writeOutputFile(out, styleName, style.contents);
  const html = readFileSync(join(root, "reader/index.html"), "utf8")
    .replace('href="reader.css"', `href="${styleName}"`)
    .replace('src="reader.js"', `src="${scriptName}"`);
  if (!html.includes(scriptName) || !html.includes(styleName)) throw new Error("index.html: reader.js/reader.css references not found");
  writeOutputFile(out, "index.html", html);
  return { fingerprint: hash(`${scriptName}\n${styleName}\n${mapName}\n${html}`) };
}
