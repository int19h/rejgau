import { expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../src/config";

const raw = (guild: Record<string, unknown> = {}, root: Record<string, unknown> = {}) => JSON.stringify({ guilds: { "107": { repo: "o/r", channels: "all", ...guild } }, ...root });

it.each(["backfill", "pages", "privateThreads"])("rejects non-boolean %s values", (name) => {
  for (const value of ["false", 0, 1, null, {}, []]) expect(() => parseConfig(raw({ [name]: value }))).toThrow(ConfigError);
  expect(parseConfig(raw({ [name]: false })).guilds.get("107")![name as "backfill"]).toBe(false);
});

it("rejects coerced paths and arrays in place of objects", () => {
  for (const path of [null, {}, [], 42]) expect(() => parseConfig(raw({ path }))).toThrow(/path/);
  expect(() => parseConfig('{"guilds":[]}')).toThrow(ConfigError);
  expect(() => parseConfig(raw({}, { guilds: { "1": [] } }))).toThrow(ConfigError);
});

it.each(["flushIdleSeconds", "flushMaxSeconds", "maxMediaMegabytes", "mediaUploadSpacingSeconds"])("bounds %s before unit conversion", (name) => {
  expect(() => parseConfig(`{"guilds":{},"${name}":1e400}`)).toThrow(/finite/);
  expect(() => parseConfig(raw({}, { [name]: Number.MAX_VALUE }))).toThrow(/finite/);
  expect(() => parseConfig(raw({}, { [name]: -1 }))).toThrow(/finite/);
  expect(() => parseConfig(raw({}, { [name]: 0 }))).not.toThrow();
});
