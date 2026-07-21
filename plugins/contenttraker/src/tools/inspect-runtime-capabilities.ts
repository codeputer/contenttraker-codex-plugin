import { inspectRuntimeCapabilities } from "../runtime-capabilities.js";
import type { RuntimeCapabilitiesResult } from "../types.js";

export function inspectContentTrakerRuntimeCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeCapabilitiesResult {
  return inspectRuntimeCapabilities(env);
}
