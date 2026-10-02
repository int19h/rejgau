import { handleAdmin } from "./admin";
import type { Env } from "./env";

export { GatewaySession } from "./gateway";
export { GuildArchive } from "./archive";

export default {
  fetch: handleAdmin,
  async scheduled(_controller, env): Promise<void> {
    await env.GATEWAY.get(env.GATEWAY.idFromName("main")).ensureRunning();
  },
} satisfies ExportedHandler<Env>;
