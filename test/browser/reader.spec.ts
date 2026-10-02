import { expect, test } from "@playwright/test";
import type { Archive } from "../../shared/publication";
import { BoundedCache } from "../../reader/src/cache";
import { archive, dataFiles, deferred, message, month, searchRow, serveData, users } from "./fixtures";

for (const status of [200, 503]) {
  test(`navigation ignores an obsolete month response with HTTP ${status}`, async ({ page }) => {
    const started = deferred();
    const release = deferred();
    const finished = deferred();
    const files = dataFiles();
    files["c/22/2026-09.json"] = month("22", [message(2, "Beta content")]);
    await serveData(page, files, async (path, route) => {
      if (path !== "c/11/2026-09.json") return false;
      started.resolve();
      await release.promise;
      await route.fulfill({ status, json: month("11", [message(1, "Alpha content")]) }).catch(() => {});
      finished.resolve();
      return true;
    });
    await page.goto("/#/c/11");
    await started.promise;
    await page.getByRole("link", { name: "# Channel 22 1", exact: true }).click();
    await expect(page.getByText("Beta content")).toBeVisible();
    release.resolve();
    await finished.promise;
    await expect(page.locator(".channel-title")).toHaveText("Channel 22");
    await expect(page.locator(".message .md")).toHaveText("Beta content");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".message-header a")).toHaveAttribute("href", `#/c/22/2026-09/${message(2).id}`);
  });
}

test("search retains partial hits and retries the failed month", async ({ page }) => {
  const files = dataFiles();
  (files["archive.json"] as Archive).search_months = ["2026-09", "2026-08"];
  files["search/2026-09.json"] = [searchRow(1, "needle newest")];
  files["search/2026-08.json"] = [searchRow(2, "needle older")];
  let failed = false;
  const requests = await serveData(page, files, async (path, route) => {
    if (path !== "search/2026-08.json" || failed) return false;
    failed = true;
    await route.fulfill({ status: 503, body: "Unavailable" });
    return true;
  });
  await page.goto("/#/search?q=needle");
  await expect(page.getByText("needle newest", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("1 result · Incomplete");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status")).toHaveText("2 results");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".hit")).toHaveCount(2);
  expect(requests.filter((path) => path === "search/2026-09.json")).toHaveLength(1);
  expect(requests.filter((path) => path === "search/2026-08.json")).toHaveLength(2);
});

test("search ignores failures from an obsolete query", async ({ page }) => {
  const files = dataFiles();
  (files["archive.json"] as Archive).search_months = ["2026-09", "2026-08"];
  files["search/2026-09.json"] = [searchRow(1, "new query")];
  const started = deferred();
  const release = deferred();
  const finished = deferred();
  await serveData(page, files, async (path, route) => {
    if (path !== "search/2026-08.json") return false;
    started.resolve();
    await release.promise;
    await route.fulfill({ status: 503, body: "Unavailable" }).catch(() => {});
    finished.resolve();
    return true;
  });
  await page.goto("/#/search?q=old");
  await started.promise;
  await page.getByRole("searchbox").fill("new during:2026-09-15");
  await page.getByRole("searchbox").press("Enter");
  release.resolve();
  await finished.promise;
  await expect(page.getByRole("status")).toHaveText("0 results");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("mobile menu supports keyboard navigation and closes after selection", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serveData(page, dataFiles());
  await page.goto("/#/c/11");
  const toggle = page.getByRole("button", { name: "Channels", exact: true });
  await expect(page.getByRole("navigation", { name: "Channels", exact: true })).toBeHidden();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#channel-menu a").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#channel-menu a").first()).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/c\/22$/);
  await expect(page.locator(".channel-title")).toHaveText("Channel 22");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("navigation", { name: "Channels", exact: true })).toBeHidden();
});

test("changed webhook identities receive separate sender headers", async ({ page }) => {
  const files = dataFiles();
  const file = month("11", [
    { ...message(1, "Alice body"), webhook_id: "7" },
    { ...message(2, "Bob body"), webhook_id: "7", author: "7.1" },
    { ...message(3, "Another Bob body"), webhook_id: "7", author: "7.1" },
  ]);
  file.users["7.1"] = { id: "7", username: "Bob" };
  files["c/11/2026-09.json"] = file;
  await serveData(page, files);
  await page.goto("/#/c/11");
  await expect(page.locator(".message-header .name")).toHaveText(["Alice", "Bob"]);
  await expect(page.locator(".message.grouped")).toHaveCount(1);
});

test("missing months offer adjacent months without starting a request", async ({ page }) => {
  const requests = await serveData(page, dataFiles());
  await page.goto("/#/c/22/2026-08");
  await expect(page.getByRole("status")).toHaveText("This month is not in the archive. Select another month above.");
  await page.getByRole("navigation", { name: "Archive months" }).getByRole("link", { name: "2026-09 →" }).click();
  await expect(page.getByText("Message 2", { exact: true })).toBeVisible();
  expect(requests).not.toContain("c/22/2026-08.json");
});

test("large months render bounded pages and message links select the target page", async ({ page }) => {
  const files = dataFiles();
  const messages = Array.from({ length: 650 }, (_, index) => message(index + 1));
  (files["archive.json"] as Archive).channels["11"].months["2026-09"] = messages.length;
  files["c/11/2026-09.json"] = month("11", messages);
  await serveData(page, files);
  await page.goto("/#/c/11");
  await expect(page.locator(".message")).toHaveCount(50);
  await expect(page.getByText("Messages 601–650 of 650", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous messages" }).click();
  await expect(page.locator(".message")).toHaveCount(200);
  await page.evaluate((id) => { location.hash = `#/c/11/2026-09/${id}`; }, messages[250].id);
  await expect(page.locator(".message.highlight")).toHaveAttribute("id", `m${messages[250].id}`);
  await expect(page.locator(".message.highlight")).toBeInViewport();
  await expect(page.getByText("Messages 201–400 of 650", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous messages" }).click();
  await expect(page.getByText("Messages 1–200 of 650", { exact: true })).toBeVisible();
  await expect(page.locator(".message")).toHaveCount(200);
});

test("search resumes within a large index without duplicate hits", async ({ page }) => {
  const files = dataFiles();
  files["search/2026-09.json"] = Array.from({ length: 405 }, (_, index) => searchRow(index + 1, `needle ${index + 1}`));
  const requests = await serveData(page, files);
  await page.goto("/#/search?q=needle");
  await expect(page.locator(".hit")).toHaveCount(200);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.locator(".hit")).toHaveCount(400);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.locator(".hit")).toHaveCount(405);
  await expect(page.getByRole("status")).toHaveText("405 results");
  expect(requests.filter((path) => path === "search/2026-09.json")).toHaveLength(1);
});

test("poll answer tooltips name known voters", async ({ page }) => {
  const files = dataFiles();
  files["c/11/2026-09.json"] = month("11", [{ ...message(1), poll: { question: { text: "Choice?" }, answers: [{ answer_id: 1, poll_media: { text: "Yes" } }] }, votes: { "1": { count: 2, users: ["8", "9"] } } }]);
  await serveData(page, files);
  await page.goto("/#/c/11");
  await expect(page.locator(".poll-answer")).toHaveAttribute("title", "Known voters: Bob, User 9");
});

test("malformed message data produces an error without crashing the page", async ({ page }) => {
  const files = dataFiles();
  files["c/11/2026-09.json"] = { ...month("11"), messages: [{ ...message(1), attachments: "invalid" }] };
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await serveData(page, files);
  await page.goto("/#/c/11");
  await expect(page.getByRole("alert")).toContainText("attachments must be an array");
  expect(pageErrors).toEqual([]);
});

test("unsupported archive versions fail before dependent files load", async ({ page }) => {
  const files = dataFiles();
  files["archive.json"] = { ...archive(), format: 2 };
  const requests = await serveData(page, files);
  await page.goto("/#/c/11");
  await expect(page.getByRole("alert")).toContainText("supported format 1");
  expect(requests).toEqual(["archive.json"]);
});

test("generation files never fall back to legacy paths", async ({ page }) => {
  const files = dataFiles();
  const generation = "a".repeat(64);
  files["archive.json"] = { ...archive(), generation, data_root: `generations/${generation}/` };
  files[`generations/${generation}/users.json`] = users;
  const requests = await serveData(page, files);
  await page.goto("/#/c/11");
  await expect(page.getByRole("alert")).toContainText("The archive changed");
  await expect(page.getByRole("button", { name: "Reload archive" })).toBeVisible();
  expect(requests).toContain(`generations/${generation}/c/11/2026-09.json`);
  expect(requests).not.toContain("c/11/2026-09.json");
});

test("the month cache evicts old files after twelve entries", async ({ page }) => {
  const channels = Array.from({ length: 13 }, (_, index) => String(index + 11));
  const files: Record<string, unknown> = { "archive.json": archive(channels), "users.json": users };
  for (const channel of channels) files[`c/${channel}/2026-09.json`] = month(channel, [message(Number(channel), `Channel body ${channel}`)]);
  const requests = await serveData(page, files);
  await page.goto("/#/c/11");
  for (const channel of channels) {
    await page.locator(`a.channel[href="#/c/${channel}"]`).click();
    await expect(page.getByText(`Channel body ${channel}`, { exact: true })).toBeVisible();
  }
  await page.locator('a.channel[href="#/c/11"]').click();
  await expect(page.getByText("Channel body 11", { exact: true })).toBeVisible();
  expect(requests.filter((path) => path === "c/11/2026-09.json")).toHaveLength(2);
});

test("data files above the response limit report a clear error", async ({ page }) => {
  const files = dataFiles();
  await serveData(page, files, async (path, route) => {
    if (path !== "c/11/2026-09.json") return false;
    await route.fulfill({ contentType: "application/json", body: '"' + "x".repeat(32 * 1024 * 1024) + '"' });
    return true;
  });
  await page.goto("/#/c/11");
  await expect(page.getByRole("alert")).toContainText("exceeds the 32 MiB reader limit");
});

test("cache respects byte limits and refreshes recent entries", () => {
  const cache = new BoundedCache<string>(3, 8);
  cache.set("a", "A", 3);
  cache.set("b", "B", 3);
  expect(cache.get("a")).toBe("A");
  cache.set("c", "C", 3);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe("A");
  cache.set("oversized", "large", 9);
  expect(cache.get("oversized")).toBeUndefined();
  expect(cache.get("a")).toBe("A");
});


test("empty channels finish without a month request", async ({ page }) => {
  const files = dataFiles();
  (files["archive.json"] as Archive).channels["11"].months = {};
  const requests = await serveData(page, files);
  await page.goto("/#/c/11");
  await expect(page.getByText("No archived messages in this channel yet.", { exact: true })).toBeVisible();
  await expect(page.getByText("Loading messages…", { exact: true })).toHaveCount(0);
  expect(requests.filter((path) => path.startsWith("c/"))).toEqual([]);
});


test("search stops at its supported result limit", async ({ page }) => {
  const files = dataFiles();
  files["search/2026-09.json"] = Array.from({ length: 1405 }, (_, index) => searchRow(index + 1, `needle ${index + 1}`));
  await serveData(page, files);
  await page.goto("/#/search?q=needle");
  for (let count = 200; count < 1000; count += 200) {
    await expect(page.locator(".hit")).toHaveCount(count);
    await page.getByRole("button", { name: "Load more" }).click();
  }
  await expect(page.locator(".hit")).toHaveCount(1000);
  await expect(page.getByText("Search stopped after 1,000 matches. Refine the query to search further.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("1000 results · Incomplete");
  await page.getByRole("searchbox").fill("needle 1405");
  await page.getByRole("searchbox").press("Enter");
  await expect(page.locator(".hit")).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText("1 result");
  await expect(page.locator(".search-limit")).toHaveCount(0);
});
