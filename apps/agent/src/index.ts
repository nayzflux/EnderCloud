import { Logger } from "@endercloud/runtime/logger";
import { startAgent } from "./bootstrap.ts";
const logger = new Logger("error", {service: "agent", version: "0.1.0", component: "bootstrap"});
const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort("SIGINT"));
process.once("SIGTERM", () => shutdown.abort("SIGTERM"));
function fatal(error: unknown) {
  logger.error("agent.process.failed", "Fatal process failure", {error});
  process.exitCode = 1; shutdown.abort(error);
}
process.once("uncaughtException", fatal);
process.once("unhandledRejection", fatal);
try { await startAgent(undefined, undefined, shutdown.signal); } catch (error) { fatal(error); }
