import { expect, it } from "vitest";
import { ArchiveLifecycle } from "../../src/archive-lifecycle";

it("holds later ingress and work until an exclusive reset completes", async () => {
  const lifecycle = new ArchiveLifecycle();
  const calls: string[] = [];
  let release!: () => void;
  const active = lifecycle.work(async () => {
    calls.push("active");
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await Promise.resolve();
  await Promise.resolve();
  const reset = lifecycle.exclusive(async () => { calls.push("reset"); });
  const ingress = lifecycle.ingest(async () => { calls.push("ingress"); });
  const work = lifecycle.work(async () => { calls.push("work"); });
  expect(calls).toEqual(["active"]);
  release();
  await Promise.all([active, reset, ingress, work]);
  expect(calls[1]).toBe("reset");
  expect(calls.slice(2).sort()).toEqual(["ingress", "work"]);
});

it("keeps the queue usable after an operation fails", async () => {
  const lifecycle = new ArchiveLifecycle();
  await expect(lifecycle.work(async () => { throw new Error("failed"); })).rejects.toThrow("failed");
  expect(await lifecycle.work(async () => "next")).toBe("next");
});
