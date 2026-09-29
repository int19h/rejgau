import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway GitHub App key in the PKCS#1 form GitHub issues, for the fake GitHub in worker tests.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

export const TEST_GUILDS = ["101", "102", "103", "104", "105", "106", "107"];

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                DISCORD_TOKEN: "discord-token",
                GITHUB_APP_ID: "1",
                GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }) as string,
                ADMIN_KEY: "admin-key",
                REJGAU_CONFIG: JSON.stringify({
                  guilds: Object.fromEntries(
                    TEST_GUILDS.map((g) => [g, { repo: `o/r${g}`, channels: ["10"], exclude: ["13"], backfill: g !== "101" }]),
                  ),
                  flushIdleSeconds: 0.001,
                  flushMaxSeconds: 0.001,
                }),
              },
            },
          }),
        ],
        test: { name: "worker", include: ["test/worker/**/*.test.ts"] },
      },
    ],
  },
});
