import { exportedNames } from "./cases";

export interface Registered {
  types: string[];
  consts: string[];
}

export interface Exempt {
  types: string[];
  values: string[];
}

/**
 * What stops a protocol source from being fully covered: an exported wire type or `as const` list
 * with neither fixture cases nor an exemption, a fixture for something no longer exported, and an
 * exemption that no longer matches an export (or that now has fixtures anyway). Empty when covered.
 * `sourceText` is read as syntax only, so it doesn't depend on how the fixtures were generated.
 */
export function findGaps(sourceText: string, registered: Registered, exempt: Exempt): string[] {
  const exported = exportedNames(sourceText);
  const typeNames = new Set(exported.types);
  const valueNames = new Set(exported.values);
  const gaps: string[] = [];

  for (const name of exported.types) {
    if (!registered.types.includes(name) && !exempt.types.includes(name)) gaps.push(`type ${name} is exported but has no fixture case and no exemption`);
  }
  for (const name of exported.values) {
    if (!registered.consts.includes(name) && !exempt.values.includes(name)) gaps.push(`${name} is exported but has no fixture and no exemption`);
  }
  for (const name of registered.types) if (!typeNames.has(name)) gaps.push(`fixture for ${name}, which protocol.ts no longer exports as a type`);
  for (const name of registered.consts) if (!valueNames.has(name)) gaps.push(`fixture for ${name}, which protocol.ts no longer exports`);
  for (const name of exempt.types) {
    if (!typeNames.has(name)) gaps.push(`stale exemption: type ${name} is no longer exported`);
    else if (registered.types.includes(name)) gaps.push(`stale exemption: type ${name} has fixtures now`);
  }
  for (const name of exempt.values) {
    if (!valueNames.has(name)) gaps.push(`stale exemption: ${name} is no longer exported`);
    else if (registered.consts.includes(name)) gaps.push(`stale exemption: ${name} has a fixture now`);
  }
  return gaps;
}
