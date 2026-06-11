import type { MinecraftRuntimeStatus, ServerSummary } from "../types";

export function statusFromRuntime(
  current: ServerSummary["status"],
  runtime: MinecraftRuntimeStatus,
): ServerSummary["status"] {
  if (current === "deleting") return "deleting";
  if (current === "error") return "error";
  if (current === "stopping")
    return runtime.process === "running" ? "stopping" : "stopped";
  if (
    !runtime.containerRunning &&
    (current === "running" || current === "starting")
  ) {
    return "stopped";
  }
  if (current === "starting" && runtime.process !== "exited")
    return runtime.process === "running" && runtime.rconHealthy
      ? "running"
      : "starting";
  if (
    current === "running" &&
    runtime.process === "running" &&
    runtime.rconHealthy
  )
    return "running";
  if (
    (current === "running" || current === "starting") &&
    runtime.process === "exited"
  )
    return "error";
  if (current === "running" && runtime.process === "missing")
    return "stopped";
  return current;
}
