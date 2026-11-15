import type {
  Admin2BoundaryParkRanking,
  Admin2RankedPark,
  BoundaryRankingsArtifactMetadataSchema,
} from "@/types/generated";
import { fetchJson, isRecord } from "@/services/json";
import { SCHEMA_VERSIONS } from "@/types/generated";
import { isCompatibleSchemaVersion } from "@/types/validate";

/** A normalized subset of `BoundaryProperties` for the active admin-level-2 boundary. */
export interface ActiveBoundary {
  boundary_type: string;
  boundary_id: number;
  boundary_name: string | null;
  boundary_name_en: string | null;
}

/**
 * `manifest.json` of a boundary rankings build. It has no shared schema, so this
 * type mirrors what the producer writes; `parseRankingsManifest` checks it.
 */
interface BoundaryRankingsManifest {
  schemaVersion: string;
  buildId: string;
  generatedAt: string;
  admin2TopParksUrl: string;
}

function parseRankedPark(value: unknown): Admin2RankedPark {
  if (!isRecord(value) || typeof value.type !== "string" ||
    !Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.bench_count) ||
    (value.bench_count as number) < 0 ||
    (value.name != null && typeof value.name !== "string") ||
    (value.name_en != null && typeof value.name_en !== "string")) {
    throw new Error("Malformed admin level 2 ranked park");
  }

  return {
    type: value.type,
    id: value.id as number,
    name: typeof value.name === "string" ? value.name : null,
    name_en: typeof value.name_en === "string" ? value.name_en : null,
    bench_count: value.bench_count as number,
  };
}

function parseBoundaryRanking(value: unknown): Admin2BoundaryParkRanking {
  if (!isRecord(value) || typeof value.boundary_type !== "string" ||
    !Number.isSafeInteger(value.boundary_id) || !Array.isArray(value.parks) ||
    (value.boundary_name != null && typeof value.boundary_name !== "string") ||
    (value.boundary_name_en != null && typeof value.boundary_name_en !== "string")) {
    throw new Error("Malformed admin level 2 boundary ranking");
  }

  return {
    boundary_type: value.boundary_type,
    boundary_id: value.boundary_id as number,
    boundary_name: typeof value.boundary_name === "string" ? value.boundary_name : null,
    boundary_name_en: typeof value.boundary_name_en === "string"
      ? value.boundary_name_en
      : null,
    parks: value.parks.map(parseRankedPark),
  };
}

function parseRankingsManifest(value: unknown): BoundaryRankingsManifest {
  if (!isRecord(value) ||
    !isCompatibleSchemaVersion(value.schemaVersion, SCHEMA_VERSIONS.Admin2BoundaryParkRanking) ||
    typeof value.buildId !== "string" || typeof value.generatedAt !== "string" ||
    typeof value.admin2TopParksUrl !== "string") {
    throw new Error("Unsupported boundary rankings manifest");
  }

  return {
    schemaVersion: value.schemaVersion as string,
    buildId: value.buildId,
    generatedAt: value.generatedAt,
    admin2TopParksUrl: value.admin2TopParksUrl,
  };
}

export function parseActiveBoundaryFeature(
  properties: Record<string, unknown> | null,
): ActiveBoundary | null {
  if (!properties || properties.boundary !== "administrative" ||
    String(properties.admin_level) !== "2" || typeof properties.type !== "string") {
    return null;
  }
  const id = Number(properties.id);
  if (!Number.isSafeInteger(id)) return null;

  return {
    boundary_type: properties.type,
    boundary_id: id,
    boundary_name: typeof properties.name === "string" ? properties.name : null,
    boundary_name_en: typeof properties.name_en === "string" ? properties.name_en : null,
  };
}

export function boundaryRankingKey(type: string, id: number | string): string {
  return `${type}/${id}`;
}

export function indexBoundaryRankings(
  rankings: Admin2BoundaryParkRanking[],
): Record<string, Admin2BoundaryParkRanking> {
  const indexed: Record<string, Admin2BoundaryParkRanking> = {};
  for (const ranking of rankings) {
    indexed[boundaryRankingKey(ranking.boundary_type, ranking.boundary_id)] = ranking;
  }
  return indexed;
}

export function resolveBoundaryDisplayName(
  ranking: Admin2BoundaryParkRanking | null,
  activeBoundary: ActiveBoundary | null,
): string {
  const names = [
    ranking?.boundary_name_en,
    activeBoundary?.boundary_name_en,
    ranking?.boundary_name,
    activeBoundary?.boundary_name,
  ];
  return names.find((name) => typeof name === "string" && name.trim())?.trim() ??
    "active boundary";
}

export async function loadBoundaryRankings(
  metadataUrl: string,
  pointers: BoundaryRankingsArtifactMetadataSchema,
): Promise<Admin2BoundaryParkRanking[]> {
  if (!isCompatibleSchemaVersion(pointers.schema_version, SCHEMA_VERSIONS.Admin2BoundaryParkRanking)) {
    throw new Error(`Unsupported boundary rankings schema version: ${pointers.schema_version}`);
  }

  const manifestUrl = new URL(pointers.manifest_url, metadataUrl).toString();
  const manifest = parseRankingsManifest(await fetchJson<unknown>(manifestUrl));
  if (manifest.buildId !== pointers.build_id) {
    throw new Error("Boundary rankings build ID does not match dataset metadata");
  }

  const artifactUrl = new URL(pointers.admin_2_top_parks_url, metadataUrl).toString();
  const manifestArtifactUrl = new URL(manifest.admin2TopParksUrl, metadataUrl).toString();
  if (artifactUrl !== manifestArtifactUrl) {
    throw new Error("Boundary rankings URL does not match dataset metadata");
  }

  const value = await fetchJson<unknown>(manifestArtifactUrl);
  if (!Array.isArray(value)) {
    throw new Error("Admin level 2 top parks artifact must be an array");
  }
  return value.map(parseBoundaryRanking);
}
