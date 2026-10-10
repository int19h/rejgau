/** A request deadline covers both response headers and body consumption. */
export const REQUEST_TIMEOUT_MS = 30_000;

export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`HTTP operation exceeded its ${timeoutMs} ms deadline`);
    this.name = "RequestTimeoutError";
  }
}

class Deadline {
  readonly controller = new AbortController();
  readonly expired: Promise<never>;
  private reject!: (reason: unknown) => void;
  private timer: ReturnType<typeof setTimeout>;
  private detach: (() => void) | undefined;

  constructor(timeoutMs: number, parent?: AbortSignal | null) {
    this.expired = new Promise<never>((_, reject) => { this.reject = reject; });
    // A response can wait between consumption steps without a pending race.
    void this.expired.catch(() => {});
    this.timer = setTimeout(() => this.abort(new RequestTimeoutError(timeoutMs)), timeoutMs);
    if (parent) {
      const abort = () => this.abort(parent.reason);
      parent.addEventListener("abort", abort, { once: true });
      this.detach = () => parent.removeEventListener("abort", abort);
      if (parent.aborted) abort();
    }
  }

  race<T>(operation: Promise<T>): Promise<T> { return Promise.race([operation, this.expired]); }
  abort(reason: unknown): void {
    this.controller.abort(reason);
    this.reject(reason);
    this.close();
  }
  close(): void {
    clearTimeout(this.timer);
    this.detach?.();
  }
}

/** The callback must pass the signal to each request and consume its response. */
export async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const deadline = new Deadline(timeoutMs);
  try { return await deadline.race(Promise.resolve().then(() => operation(deadline.controller.signal))); }
  finally { deadline.abort(new DOMException("HTTP operation finished", "AbortError")); }
}

/** Cancel or consume the returned body to release the timer and connection. */
export async function fetchWithDeadline(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const deadline = new Deadline(timeoutMs, init.signal);
  try {
    const response = await deadline.race(fetch(input, { ...init, signal: deadline.controller.signal }));
    if (!response.body) {
      deadline.close();
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await deadline.race(reader.read());
          if (next.done) {
            deadline.close();
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          deadline.close();
          void reader.cancel(error).catch(() => {});
          controller.error(error);
        }
      },
      cancel(reason) {
        deadline.close();
        void reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    deadline.close();
    throw error;
  }
}

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response exceeds the ${maxBytes} byte read budget`);
  }
}

export async function readTextBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new BodyTooLargeError(maxBytes);
    }
    parts.push(decoder.decode(next.value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}
