import { SCHEMA_VERSIONS } from "@/types/generated";
import type { Metadata } from "@/types/metadata";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Whether data written with schema version `actual` can be read by code built
 * for `expected` (both `MAJOR.MINOR.PATCH`).
 *
 * From 1.0.0 on, versions are compatible when the major version matches: a newer
 * minor version only adds optional fields, and an older one may lack fields that
 * are then treated as null. While the major version is 0 the schema is still in
 * development, so the minor version must match too.
 */
export function isCompatibleSchemaVersion(actual: unknown, expected: string): boolean {
  const actualParts = typeof actual === "string" ? SEMVER.exec(actual) : null;
  const expectedParts = SEMVER.exec(expected);
  if (!actualParts || !expectedParts) return false;
  const [, actualMajor, actualMinor] = actualParts;
  const [, expectedMajor, expectedMinor] = expectedParts;
  if (actualMajor !== expectedMajor) return false;
  return actualMajor !== "0" || actualMinor === expectedMinor;
}

/** In development, warn when a layer's schema version differs from the generated types. */
export function warnForSchemaVersionDrift(metadata: Metadata): void {
  if (!import.meta.env.DEV || !metadata.layers) return;
  for (const layerName in metadata.layers) {
    const layer = metadata.layers[layerName];
    const expected = layer.schema_name
      ? SCHEMA_VERSIONS[layer.schema_name as keyof typeof SCHEMA_VERSIONS]
      : undefined;
    if (expected && !isCompatibleSchemaVersion(layer.schema_version, expected)) {
      console.warn(`Schema version mismatch for ${layer.name}: expected ${expected}, received ${layer.schema_version}`);
    }
  }
}
