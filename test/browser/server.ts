import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleReader } from "../../tools/bundle";

const output = await mkdtemp(join(tmpdir(), "rejgau-browser-"));
await bundleReader(output);
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const file = path === "/" ? "index.html" : path.slice(1);
  if (!/^[A-Za-z0-9.-]+$/.test(file)) { response.writeHead(404).end(); return; }
  try {
    const content = await readFile(join(output, file));
    response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
server.listen(Number(process.env.BROWSER_TEST_PORT ?? 4173), "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => server.close(() => { void rm(output, { recursive: true, force: true }); }));
}
