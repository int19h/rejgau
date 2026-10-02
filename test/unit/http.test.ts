import { afterEach, describe, expect, it, vi } from "vitest";
import { BodyTooLargeError, fetchWithDeadline, readTextBounded, RequestTimeoutError, withDeadline } from "../../src/http";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP deadlines", () => {
  it("aborts a request that never returns headers", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_input: unknown, init: RequestInit) => {
      signal = init.signal!;
      return new Promise(() => {});
    });
    await expect(fetchWithDeadline("https://example.test", {}, 15)).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(signal?.aborted).toBe(true);
  });

  it("keeps the deadline active while a response body stalls", async () => {
    let canceled = false;
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([65])); },
      cancel() { canceled = true; },
    })));
    const response = await fetchWithDeadline("https://example.test", {}, 15);
    await expect(response.text()).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(canceled).toBe(true);
  });

  it("releases the deadline after normal consumption", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) => {
      signal = init.signal!;
      return new Response("done");
    });
    expect(await (await fetchWithDeadline("https://example.test", {}, 10)).text()).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal?.aborted).toBe(false);
  });

  it("bounds a full operation even when a mock ignores its abort signal", async () => {
    await expect(withDeadline(() => new Promise(() => {}), 15)).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it("counts UTF-8 bytes and cancels an oversized stream", async () => {
    let canceled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("😀😀")); },
      cancel() { canceled = true; },
    }));
    await expect(readTextBounded(response, 7)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(canceled).toBe(true);
  });
});
