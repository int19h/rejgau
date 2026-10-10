// Minimal GitHub REST client for a GitHub App installed on the archive repo.

import { log } from "./util";
import { fetchWithDeadline, readTextBounded, REQUEST_TIMEOUT_MS, withDeadline } from "./http";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
    /** Set when GitHub says to back off (primary or secondary rate limit): wait this long. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(`GitHub ${what} failed: ${status} ${body.slice(0, 300)}`);
  }
}

function authError(e: GitHubError): GitHubError {
  if (e.retryAfterMs !== null || e.status >= 500) return e;
  const auth = new GitHubAuthError(e.status, e.body, "", null);
  auth.message = e.message;
  return auth;
}

/** Builds a GitHubError from a failed response, recognizing rate-limit responses. */
async function failure(res: Response, what: string): Promise<GitHubError> {
  const body = await res.text();
  let retryAfterMs: number | null = null;
  if (res.status === 403 || res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const reset = res.headers.get("x-ratelimit-reset");
    if (retryAfter) retryAfterMs = Number(retryAfter) * 1000;
    else if (res.headers.get("x-ratelimit-remaining") === "0" && reset) retryAfterMs = Math.max(0, Number(reset) * 1000 - Date.now());
    else if (/rate limit/i.test(body)) retryAfterMs = 60_000; // secondary limit without headers: GitHub asks for at least a minute
  }
  return new GitHubError(res.status, body, what, retryAfterMs);
}

/** The App can't act on the repo at all (not installed, wrong App ID or key): a setup problem. */
export class GitHubAuthError extends GitHubError {}

/** The branch moved (or appeared) between reading it and updating it. */
export class ConflictError extends Error {}

export interface FileChange {
  path: string;
  content: string;
}

export interface Release {
  id: number;
  tag_name: string;
}

export interface Asset {
  id: number;
  name: string;
  size: number;
  content_type: string;
  state: string;
  browser_download_url: string;
}

// --- App authentication -------------------------------------------------------------------------

function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | out.length, ...out];
}

function der(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const len = derLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

/**
 * DER bytes of a PKCS#8 private key from a PEM. GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"),
 * which WebCrypto can't import, so it gets wrapped into PKCS#8 here.
 */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const m = /-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]+?)-----END \1-----/.exec(pem.replace(/\\n/g, "\n"));
  if (!m) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  const body = Uint8Array.from(atob(m[2].replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  if (m[1] === "PRIVATE KEY") return body;
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  // SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
  const algorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  return der(0x30, concat(version, algorithm, der(0x04, body)));
}

async function appJwt(appId: string, privateKeyPem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  )}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

// Installation tokens are cached per isolate, keyed by repo.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

// --- Client -------------------------------------------------------------------------------------

export class GitHub {
  readonly owner: string;
  readonly name: string;

  constructor(
    private readonly appId: string,
    private readonly privateKey: string,
    readonly repo: string,
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    [this.owner, this.name] = repo.split("/");
  }

  private async token(): Promise<string> {
    const cached = tokenCache.get(this.repo);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const jwt = await appJwt(this.appId, this.privateKey);
    const inst = await this.raw("GET", `/repos/${this.repo}/installation`, undefined, `Bearer ${jwt}`);
    if (!inst.ok) throw authError(await failure(inst, `installation lookup (is the GitHub App installed on ${this.repo}, and do GITHUB_APP_ID and the key match?)`));
    const { id } = (await inst.json()) as { id: number };
    const res = await this.raw(
      "POST",
      `/app/installations/${id}/access_tokens`,
      { repositories: [this.name], permissions: { contents: "write", metadata: "read" } },
      `Bearer ${jwt}`,
    );
    if (!res.ok) throw authError(await failure(res, "installation token"));
    const t = (await res.json()) as { token: string; expires_at: string };
    tokenCache.set(this.repo, { token: t.token, expiresAt: Date.parse(t.expires_at) });
    return t.token;
  }

  private async raw(method: string, pathOrUrl: string, body?: unknown, auth?: string, accept = "application/vnd.github+json"): Promise<Response> {
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : API + pathOrUrl;
    for (let attempt = 0; ; attempt++) {
      const res = await fetchWithDeadline(url, {
        method,
        headers: {
          Accept: accept,
          Authorization: auth ?? `Bearer ${await this.token()}`,
          "User-Agent": "rejgau",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }, this.requestTimeoutMs);
      if (res.status >= 500 && attempt < 2) {
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      return res;
    }
  }

  private async json<T>(method: string, path: string, body: unknown, what: string): Promise<T> {
    const res = await this.raw(method, path, body);
    if (!res.ok) throw await failure(res, what);
    return (await res.json()) as T;
  }

  private repoPath(p: string): string {
    return `/repos/${this.repo}${p}`;
  }

  /** Head commit SHA of a branch, or null if the branch doesn't exist. */
  async branchHead(branch: string): Promise<string | null> {
    const res = await this.raw("GET", this.repoPath(`/git/ref/heads/${encodeURIComponent(branch)}`));
    if (res.status === 404 || res.status === 409) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw await failure(res, `read branch ${branch}`);
    return ((await res.json()) as { object: { sha: string } }).object.sha;
  }

  /** Text of a file at a commit, or null if absent. */
  async readFile(path: string, ref: string, maxBytes = 8 * 1024 * 1024): Promise<string | null> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const res = await this.raw("GET", this.repoPath(`/contents/${encoded}?ref=${ref}`), undefined, undefined, "application/vnd.github.raw+json");
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw await failure(res, `read ${path}`);
    return await readTextBounded(res, maxBytes);
  }

  /**
   * Commits `files` on top of `parent` (null = create the branch as an orphan) and moves the branch
   * there without forcing. Throws ConflictError if the branch moved meanwhile.
   */
  async commit(branch: string, parent: string | null, files: FileChange[], message: string): Promise<string> {
    await this.ensureNotEmpty();
    const baseTree = parent
      ? (await this.json<{ tree: { sha: string } }>("GET", this.repoPath(`/git/commits/${parent}`), undefined, "read commit")).tree.sha
      : undefined;
    const tree = [];
    for (const f of files) {
      if (f.content.length > 512 * 1024) {
        // Keep the tree request small; large files go through the blobs endpoint.
        const blob = await this.json<{ sha: string }>("POST", this.repoPath("/git/blobs"), { content: f.content, encoding: "utf-8" }, "create blob");
        tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
      } else {
        tree.push({ path: f.path, mode: "100644", type: "blob", content: f.content });
      }
    }
    const newTree = await this.json<{ sha: string }>("POST", this.repoPath("/git/trees"), { base_tree: baseTree, tree }, "create tree");
    const commit = await this.json<{ sha: string }>(
      "POST",
      this.repoPath("/git/commits"),
      { message, tree: newTree.sha, parents: parent ? [parent] : [] },
      "create commit",
    );
    const res = parent
      ? await this.raw("PATCH", this.repoPath(`/git/refs/heads/${encodeURIComponent(branch)}`), { sha: commit.sha, force: false })
      : await this.raw("POST", this.repoPath("/git/refs"), { ref: `refs/heads/${branch}`, sha: commit.sha });
    if (res.status === 422 || res.status === 409) throw new ConflictError(`branch ${branch} moved: ${await res.text()}`);
    if (!res.ok) throw await failure(res, "update branch");
    await res.body?.cancel();
    return commit.sha;
  }

  private notEmpty = false;

  /** The Git Data API doesn't work on a repo with no commits at all; seed one via the Contents API. */
  private async ensureNotEmpty(): Promise<void> {
    if (this.notEmpty) return;
    const res = await this.raw("GET", this.repoPath("/commits?per_page=1"));
    if (res.status === 409) {
      await res.body?.cancel();
      log("github_seed_empty_repo", { repo: this.repo });
      await this.json("PUT", this.repoPath("/contents/README.md"), {
        message: "Initialize archive repository",
        content: btoa("# Discord archive\n\nWritten by [rejgau](https://github.com/int19h/rejgau). Logs are on the `archive` branch.\n"),
      }, "seed empty repo");
    } else if (!res.ok) {
      throw await failure(res, "check repo");
    } else {
      await res.body?.cancel();
    }
    this.notEmpty = true;
  }

  /** Triggers `repository_dispatch` workflows (needs contents: write). */
  async dispatch(eventType: string): Promise<void> {
    const res = await this.raw("POST", this.repoPath("/dispatches"), { event_type: eventType });
    if (!res.ok) throw await failure(res, "repository_dispatch");
    await res.body?.cancel();
  }

  /** SHA of the parentless commit that media release tags point at; created on first use. */
  async mediaRoot(retried = false): Promise<string> {
    const res = await this.raw("GET", this.repoPath("/git/ref/tags/media-root"));
    if (res.ok) return ((await res.json()) as { object: { sha: string } }).object.sha;
    // 409 = empty repository; anything but that or 404 is a real error.
    if (res.status !== 404 && res.status !== 409) throw await failure(res, "read media-root tag");
    await res.body?.cancel();
    await this.ensureNotEmpty();
    const tree = await this.json<{ sha: string }>(
      "POST",
      this.repoPath("/git/trees"),
      {
        tree: [
          {
            path: "README.md",
            mode: "100644",
            type: "blob",
            content:
              "# Media root\n\nThis parentless commit anchors the `media-*` release tags that hold archived Discord media.\n" +
              "It is kept outside the `archive` branch so that rewriting archive history never touches release tags.\n",
          },
        ],
      },
      "create media-root tree",
    );
    const commit = await this.json<{ sha: string }>("POST", this.repoPath("/git/commits"), { message: "Media root", tree: tree.sha, parents: [] }, "create media-root commit");
    const ref = await this.raw("POST", this.repoPath("/git/refs"), { ref: "refs/tags/media-root", sha: commit.sha });
    if (ref.status === 422 && !retried) {
      await ref.body?.cancel();
      return this.mediaRoot(true); // created concurrently
    }
    if (!ref.ok) throw await failure(ref, "create media-root tag");
    await ref.body?.cancel();
    return commit.sha;
  }

  /** Creates a lightweight tag; a no-op if it already exists. */
  async ensureTag(tag: string, sha: string): Promise<void> {
    const res = await this.raw("POST", this.repoPath("/git/refs"), { ref: `refs/tags/${tag}`, sha });
    if (!res.ok && res.status !== 422) throw await failure(res, `create tag ${tag}`);
    await res.body?.cancel();
  }

  async releaseByTag(tag: string): Promise<Release | null> {
    const res = await this.raw("GET", this.repoPath(`/releases/tags/${encodeURIComponent(tag)}`));
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw await failure(res, `read release ${tag}`);
    return (await res.json()) as Release;
  }

  async createRelease(tag: string, target: string, body: string): Promise<Release> {
    return this.json<Release>(
      "POST",
      this.repoPath("/releases"),
      { tag_name: tag, target_commitish: target, name: tag, body, make_latest: "false" },
      `create release ${tag}`,
    );
  }

  async listAssets(releaseId: number): Promise<Asset[]> {
    const all: Asset[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.json<Asset[]>("GET", this.repoPath(`/releases/${releaseId}/assets?per_page=100&page=${page}`), undefined, "list assets");
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }

  async deleteAsset(assetId: number): Promise<void> {
    const res = await this.raw("DELETE", this.repoPath(`/releases/assets/${assetId}`));
    if (!res.ok && res.status !== 404) throw await failure(res, "delete asset");
    await res.body?.cancel();
  }

  /** Uploads a release asset. Returns null if an asset with that name already exists. */
  async uploadAsset(releaseId: number, name: string, contentType: string, length: number, body: ReadableStream | ArrayBuffer): Promise<Asset | null> {
    return withDeadline(async (signal) => {
      let payload: ReadableStream | ArrayBuffer = body;
      let cancelSource: (() => void) | undefined;
      if (body instanceof ReadableStream) {
        // GitHub requires Content-Length; a FixedLengthStream makes fetch send it instead of chunking.
        const fixed = new FixedLengthStream(length);
        const reader = body.getReader();
        cancelSource = () => {
          void reader.cancel(signal.reason).catch(() => {});
          // An early server response can leave the outgoing body unread.
          void fixed.readable.cancel(signal.reason).catch(() => {});
        };
        signal.addEventListener("abort", cancelSource, { once: true });
        const source = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          cancel: cancelSource,
        });
        // Cancel the original reader even if the fixed stream waits for a consumer.
        void source.pipeTo(fixed.writable, { signal }).finally(() => {
          signal.removeEventListener("abort", cancelSource!);
        }).catch(() => {});
        payload = fixed.readable;
      }
      try {
        const res = await fetch(`${UPLOADS}/repos/${this.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
          method: "POST",
          signal,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${await this.token()}`,
            "User-Agent": "rejgau",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": contentType,
          },
          body: payload,
        });
        if (res.status === 422) {
          const text = await res.text();
          if (text.includes("already_exists")) return null;
          throw new GitHubError(422, text, `upload ${name}`);
        }
        if (!res.ok) throw await failure(res, `upload ${name}`);
        return (await res.json()) as Asset;
      } finally { cancelSource?.(); }
    }, this.requestTimeoutMs);
  }
}
