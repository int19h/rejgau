import type { Page, Route } from "@playwright/test";
import type { Archive, MonthFile, PublishedMessage, SearchRow, UsersFile } from "../../shared/publication";

export function message(index: number, content = `Message ${index}`): PublishedMessage {
  const time = Date.UTC(2026, 8, 1, 12) + index * 1000;
  return { id: (((BigInt(time) - 1420070400000n) << 22n) + BigInt(index)).toString(), ts: new Date(time).toISOString(), type: 0, author: "7.0", content };
}

export function month(channel: string, messages = [message(1)]): MonthFile {
  return { channel, month: "2026-09", messages, media: {}, users: { "7.0": { id: "7", username: "Alice" } } };
}

export function archive(channels = ["11", "22"]): Archive {
  return {
    format: 1, built_at: "2026-10-01T00:00:00Z",
    guild: { id: "1", name: "Test archive", icon_url: null, roles: [], emojis: [], stickers: [] },
    channels: Object.fromEntries(channels.map((id, index) => [id, { id, name: `Channel ${id}`, type: 0, parent_id: null, position: index, months: { "2026-09": 1 } }])),
    search_months: ["2026-09"],
  };
}

export const users: UsersFile = { users: { "7": { id: "7", username: "Alice" }, "8": { id: "8", username: "Bob" } }, media: {} };
export function searchRow(index: number, text = `message ${index}`): SearchRow {
  const m = message(index);
  return { id: m.id, c: "11", ts: m.ts, a: "7", text, x: text, at: "user" };
}
export function dataFiles(): Record<string, unknown> {
  return { "archive.json": archive(), "users.json": users, "c/11/2026-09.json": month("11"), "c/22/2026-09.json": month("22", [message(2)]) };
}

export async function serveData(page: Page, files: Record<string, unknown>, intercept?: (path: string, route: Route) => Promise<boolean>): Promise<string[]> {
  const requests: string[] = [];
  await page.route("**/data/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice("/data/".length);
    requests.push(path);
    if (await intercept?.(path, route)) return;
    if (!Object.hasOwn(files, path)) { await route.fulfill({ status: 404, body: "Missing fixture" }); return; }
    await route.fulfill({ json: files[path] });
  });
  return requests;
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
