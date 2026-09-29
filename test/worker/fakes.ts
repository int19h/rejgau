// In-memory fakes of the GitHub and Discord HTTP APIs, installed by replacing globalThis.fetch.
// They implement just enough semantics to catch real bugs: fast-forward-only ref updates, an empty
// repo that the Git Data API refuses, release/asset bookkeeping, and Discord's `after` paging.

type Tree = Map<string, string>;

interface Commit {
  tree: string;
  parents: string[];
  message: string;
}

let counter = 0;
const newSha = () => (++counter).toString(16).padStart(40, "0");

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export class FakeRepo {
  trees = new Map<string, Tree>();
  commits = new Map<string, Commit>();
  refs = new Map<string, string>();
  blobs = new Map<string, string>();
  releases: { id: number; tag_name: string; assets: { id: number; name: string; size: number; content_type: string; state: string }[] }[] = [];
  requests: string[] = [];
  /** Number of upcoming uploads to reject with a secondary rate limit. */
  rateLimitUploads = 0;
  /** Called before a ref update; lets a test move the branch underneath the bot. */
  beforeRefUpdate: (() => void) | null = null;

  get empty(): boolean {
    return this.refs.size === 0;
  }

  /** Commits a whole tree directly (as the admin would with a force-push). */
  forcePush(branch: string, files: Record<string, string>, parent: string | null = null): string {
    const tree = newSha();
    this.trees.set(tree, new Map(Object.entries(files)));
    const sha = newSha();
    this.commits.set(sha, { tree, parents: parent ? [parent] : [], message: "admin" });
    this.refs.set(`heads/${branch}`, sha);
    return sha;
  }

  files(branch: string): Record<string, string> {
    const head = this.refs.get(`heads/${branch}`);
    if (!head) return {};
    return Object.fromEntries(this.trees.get(this.commits.get(head)!.tree)!);
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Normalize /repos/o/<name>/… to /repos/o/r/… so the routes below stay readable.
    const path = url.pathname.replace(/^\/repos\/o\/[^/]+/, "/repos/o/r");
    this.requests.push(`${req.method} ${path}`);
    const body = req.method === "GET" || req.method === "DELETE" ? null : req.headers.get("content-type")?.includes("json") ? await req.json<any>() : await req.arrayBuffer();

    if (url.hostname === "uploads.github.com") {
      const m = /\/releases\/(\d+)\/assets$/.exec(path)!;
      const rel = this.releases.find((r) => r.id === Number(m[1]))!;
      const name = url.searchParams.get("name")!;
      if (this.rateLimitUploads > 0) {
        this.rateLimitUploads--;
        return json({ message: "You have exceeded a secondary rate limit." }, 403);
      }
      if (rel.assets.some((a) => a.name === name)) return json({ errors: [{ code: "already_exists" }] }, 422);
      const asset = { id: newAssetId(), name, size: (body as ArrayBuffer).byteLength, content_type: req.headers.get("content-type")!, state: "uploaded" };
      rel.assets.push(asset);
      return json({ ...asset, browser_download_url: `https://github.com/o/r/releases/download/${rel.tag_name}/${name}` }, 201);
    }

    let m: RegExpExecArray | null;
    if (path === "/repos/o/r/installation") return json({ id: 1 });
    if (path === "/app/installations/1/access_tokens") return json({ token: "t", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    if (path === "/repos/o/r/commits") return this.empty ? json({ message: "Git Repository is empty." }, 409) : json([{}]);
    if (path === "/repos/o/r/contents/README.md" && req.method === "PUT") {
      this.forcePush("main", { "README.md": atob((body as any).content) });
      return json({}, 201);
    }
    if ((m = /^\/repos\/o\/r\/contents\/(.+)$/.exec(path))) {
      const commit = this.commits.get(url.searchParams.get("ref")!);
      const content = commit && this.trees.get(commit.tree)!.get(decodeURIComponent(m[1]));
      if (content === undefined) return json({ message: "Not Found" }, 404);
      // Like GitHub: raw content only with the raw media type; otherwise a JSON envelope.
      if (req.headers.get("accept") !== "application/vnd.github.raw+json") return json({ type: "file", encoding: "base64", content: btoa(content) });
      return new Response(content);
    }
    if ((m = /^\/repos\/o\/r\/git\/ref\/(.+)$/.exec(path))) {
      if (this.empty) return json({ message: "Git Repository is empty." }, 409);
      const sha = this.refs.get(decodeURIComponent(m[1]));
      return sha ? json({ object: { sha } }) : json({ message: "Not Found" }, 404);
    }
    if ((m = /^\/repos\/o\/r\/git\/commits\/(\w+)$/.exec(path))) return json({ tree: { sha: this.commits.get(m[1])!.tree } });
    if (this.empty && path.startsWith("/repos/o/r/git/")) return json({ message: "Git Repository is empty." }, 409);
    if (path === "/repos/o/r/git/blobs") {
      const sha = newSha();
      this.blobs.set(sha, (body as any).content);
      return json({ sha }, 201);
    }
    if (path === "/repos/o/r/git/trees") {
      const b = body as any;
      const tree: Tree = new Map(b.base_tree ? this.trees.get(b.base_tree) : []);
      for (const e of b.tree) tree.set(e.path, e.content ?? this.blobs.get(e.sha)!);
      const sha = newSha();
      this.trees.set(sha, tree);
      return json({ sha }, 201);
    }
    if (path === "/repos/o/r/git/commits") {
      const b = body as any;
      const sha = newSha();
      this.commits.set(sha, { tree: b.tree, parents: b.parents, message: b.message });
      return json({ sha }, 201);
    }
    if (path === "/repos/o/r/git/refs" && req.method === "POST") {
      const b = body as any;
      const ref = b.ref.replace(/^refs\//, "");
      if (this.refs.has(ref)) return json({ message: "Reference already exists" }, 422);
      this.refs.set(ref, b.sha);
      return json({}, 201);
    }
    if ((m = /^\/repos\/o\/r\/git\/refs\/(.+)$/.exec(path)) && req.method === "PATCH") {
      this.beforeRefUpdate?.();
      this.beforeRefUpdate = null;
      const ref = decodeURIComponent(m[1]);
      const b = body as any;
      const current = this.refs.get(ref);
      if (!b.force && !this.commits.get(b.sha)!.parents.includes(current!)) return json({ message: "Update is not a fast forward" }, 422);
      this.refs.set(ref, b.sha);
      return json({});
    }
    if ((m = /^\/repos\/o\/r\/releases\/tags\/(.+)$/.exec(path))) {
      const rel = this.releases.find((r) => r.tag_name === decodeURIComponent(m![1]));
      return rel ? json(rel) : json({ message: "Not Found" }, 404);
    }
    if (path === "/repos/o/r/releases" && req.method === "POST") {
      const b = body as any;
      if (!this.refs.has(`tags/${b.tag_name}`)) this.refs.set(`tags/${b.tag_name}`, b.target_commitish);
      const rel = { id: this.releases.length + 1, tag_name: b.tag_name, assets: [] };
      this.releases.push(rel);
      return json(rel, 201);
    }
    if ((m = /^\/repos\/o\/r\/releases\/(\d+)\/assets$/.exec(path))) {
      const rel = this.releases.find((r) => r.id === Number(m![1]))!;
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      return json(rel.assets.slice((page - 1) * perPage, page * perPage));
    }
    return json({ message: `fake GitHub: unhandled ${req.method} ${path}` }, 500);
  }
}

export class FakeGitHub {
  repos = new Map<string, FakeRepo>();

  repo(name: string): FakeRepo {
    if (!this.repos.has(name)) this.repos.set(name, new FakeRepo());
    return this.repos.get(name)!;
  }

  handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/app/installations/")) {
      return Promise.resolve(json({ token: "t", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201));
    }
    const m = /^\/repos\/o\/([^/]+)\//.exec(url.pathname);
    if (!m) return Promise.resolve(json({ message: `fake GitHub: no repo in ${url.pathname}` }, 500));
    return this.repo(m[1]).handle(req);
  }
}

let assetIds = 0;
const newAssetId = () => ++assetIds;

export class FakeDiscord {
  /** channel ID → messages (any order). */
  messages = new Map<string, Record<string, any>[]>();
  channels = new Map<string, Record<string, any>>();
  /** guild ID → GUILD_CREATE-shaped object, served by the /guilds REST endpoints. */
  guilds = new Map<string, Record<string, any>>();
  requests: string[] = [];

  handle(req: Request): Response {
    const url = new URL(req.url);
    this.requests.push(`${url.pathname}${url.search}`);
    if (url.hostname === "cdn.discordapp.com") {
      const bytes = new Uint8Array(10);
      if (url.pathname.includes("nolength")) {
        // Streamed without a Content-Length.
        return new Response(new ReadableStream({ start: (c) => (c.enqueue(bytes), c.close()) }), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.includes("gzipped")) {
        // Content-Length counts encoded bytes; the body we see is decoded (longer).
        return new Response(bytes, { headers: { "content-type": "image/png", "content-encoding": "gzip", "content-length": "3" } });
      }
      return new Response(bytes, { headers: { "content-type": "image/png", "content-length": "10" } });
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/v10\/channels\/(\d+)\/messages$/.exec(url.pathname))) {
      const after = BigInt(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const newer = (this.messages.get(m[1]) ?? []).filter((msg) => BigInt(msg.id) > after).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      // Discord returns the `limit` messages right after `after`, newest first.
      return json(newer.slice(0, limit).reverse());
    }
    if ((m = /^\/api\/v10\/guilds\/(\d+)(\/channels|\/threads\/active)?$/.exec(url.pathname))) {
      const g = this.guilds.get(m[1]);
      if (!g) return json({ message: "Unknown Guild" }, 404);
      if (m[2] === "/channels") return json(g.channels);
      if (m[2] === "/threads/active") return json({ threads: g.threads ?? [], members: [] });
      return json({ ...g, channels: undefined, threads: undefined });
    }
    if ((m = /^\/api\/v10\/channels\/(\d+)$/.exec(url.pathname))) {
      const ch = this.channels.get(m[1]);
      return ch ? json(ch) : json({ message: "Unknown Channel", code: 10003 }, 404);
    }
    return json({ message: `fake Discord: unhandled ${url.pathname}` }, 500);
  }
}

/** A scripted Discord Gateway: HELLO, then READY + `dispatches` on IDENTIFY, RESUMED on RESUME. */
export class FakeGateway {
  identifies: any[] = [];
  resumes: any[] = [];
  urls: string[] = [];
  dispatches: [string, unknown][] = [];
  server: WebSocket | null = null;
  private seq = 0;

  handle(req: Request): Response {
    this.urls.push(req.url);
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    this.server = server;
    const send = (op: number, d: unknown, t: string | null = null) =>
      server.send(JSON.stringify({ op, d, t, s: op === 0 ? ++this.seq : null }));
    server.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.op === 1) send(11, null);
      if (msg.op === 2) {
        this.identifies.push(msg.d);
        this.seq = 0;
        send(0, { session_id: "sess-1", resume_gateway_url: "wss://gateway-resume.discord.gg", guilds: [] }, "READY");
        for (const [t, d] of this.dispatches) send(0, d, t);
      }
      if (msg.op === 6) {
        this.resumes.push(msg.d);
        send(0, {}, "RESUMED");
      }
    });
    setTimeout(() => send(10, { heartbeat_interval: 41250 }), 0);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}

export function installFakes(): { github: FakeGitHub; discord: FakeDiscord; gateway: FakeGateway; restore: () => void } {
  const github = new FakeGitHub();
  const discord = new FakeDiscord();
  const gateway = new FakeGateway();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const host = new URL(req.url).hostname;
    if (host === "api.github.com" || host === "uploads.github.com") return github.handle(req);
    if (host === "discord.com" || host === "cdn.discordapp.com") return discord.handle(req);
    if (host.startsWith("gateway") && host.endsWith(".discord.gg")) return gateway.handle(req);
    throw new Error(`unexpected fetch to ${req.url}`);
  }) as typeof fetch;
  return { github, discord, gateway, restore: () => (globalThis.fetch = original) };
}
