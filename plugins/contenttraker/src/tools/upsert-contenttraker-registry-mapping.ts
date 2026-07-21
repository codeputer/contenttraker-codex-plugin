import { upsertRegistryMapping } from "../workspace-registry.js";
import type { RegistryUpsertResult, UpsertRegistryMappingInput } from "../types.js";

export function upsertContentTrakerRegistryMapping(
  input: UpsertRegistryMappingInput,
): RegistryUpsertResult {
  return upsertRegistryMapping(input);
}
