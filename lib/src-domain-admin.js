// Global user-only SRC domain data control plane.
// It deliberately registers commands, not model tools, so it is available for
// cold/history sessions even when the src-hunter preset is not currently mounted.
import { registerDecisionCommands } from "./src/decision/service-commands.js";
import { SrcStore, closeProofServersOfSession, appendSessionToolEvent } from "./src.js";
import { registerDomainDataCommands } from "./src/domain-data.js";
import { dshHomeDir } from "./src/telemetry/events.js";

const name = "src-domain-admin";
const inject = ["commands", "storageDomain"];

function apply(ctx) {
  ctx.inject(["commands"], registerDecisionCommands);
  const store = new SrcStore(ctx);
  ctx.inject(["commands"], (commandCtx) => registerDomainDataCommands(commandCtx, store, {
    homeOf: dshHomeDir,
    closeProofServers: closeProofServersOfSession,
    rootCtx: ctx,
    resetProjection: async (sessionId, target) => {
      const session = ctx.get?.("sessions")?.get(sessionId);
      if (session) appendSessionToolEvent(session, "src_domain_data_deleted", { target });
    }
  }));
}

export default { name, inject, apply };
export { name, inject, apply };
