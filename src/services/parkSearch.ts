import { SCHEMA_VERSIONS } from "@/types/generated";
import type { ParkSearchResult } from "@/types/generated";
import { fetchJson, isRecord } from "@/services/json";
import type { BBox } from "@/types/metadata";
import { isCompatibleSchemaVersion } from "@/types/validate";

export type { ParkSearchResult } from "@/types/generated";

export interface SearchNode {
  shards?: string[];
  children?: string[];
}

/**
 * `manifest.json` of a park search build. It has no shared schema, so this type
 * mirrors what the producer writes; `validateManifest` checks it at runtime.
 */
export interface ParkSearchManifest {
  schemaVersion: string;
  normalizationVersion: "2";
  buildId: string;
  generatedAt: string;
  minPrefixLength: number;
  maxRecordsPerShard: number;
  maxEstimatedCompressedBytesPerShard: number;
  sizeMetric: "gzip-json-bytes";
  nodes: Record<string, SearchNode>;
  leaves: Record<string, string[]>;
}

/** Most results shown for a search, and most parks shown before anything is typed. */
export const MAX_RESULTS = 50;

export type SearchTokenGroup = string[];
export type SearchTokenGroups = SearchTokenGroup[];

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isLetter = /\p{L}/u;
const isLetterOrNumber = /[\p{L}\p{N}]/u;
const isCombiningMark = /\p{M}/u;
const isLatinScript = /\p{Script=Latin}/u;

function tokenizeNativeText(value: unknown): string[] {
  if (value == null) return [];

  const normalized = String(value).normalize("NFC").toLowerCase().normalize("NFC");
  const tokens: string[] = [];
  let current = "";
  for (const character of normalized) {
    if (isLetterOrNumber.test(character) || (current && isCombiningMark.test(character))) {
      current += character;
    } else if (current) {
      tokens.push(current);
      current = "";
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function foldLatinMarks(token: string): string {
  const folded: string[] = [];
  let previousBaseWasLatin = false;
  for (const character of token.normalize("NFD")) {
    if (isCombiningMark.test(character)) {
      if (!previousBaseWasLatin) folded.push(character);
      continue;
    }

    folded.push(character);
    previousBaseWasLatin = isLetter.test(character) && isLatinScript.test(character);
  }
  return folded.join("").normalize("NFC");
}

/**
 * Return one native token and, when different, its Latin-accent-folded alias.
 * The case transform is Unicode default lowercase, matching Python str.lower().
 */
export function normalizeSearchTokenGroups(value: unknown): SearchTokenGroups {
  return tokenizeNativeText(value).map((native) => {
    const folded = foldLatinMarks(native);
    return folded === native ? [native] : [native, folded];
  });
}

/** Return the normalized native spelling, useful for deterministic sorting. */
export function normalizeSearchText(value: unknown): string {
  return normalizeSearchTokenGroups(value).map((group) => group[0]).join(" ");
}

/** Return native tokens; callers that need matching aliases use token groups. */
export function searchTokens(query: unknown): string[] {
  return normalizeSearchTokenGroups(query).map((group) => group[0]);
}

/**
 * Identify a park by OSM element type and id. OSM ids are only unique within a
 * type, so a way and a relation can share an id.
 */
export function parkKey(park: Pick<ParkSearchResult, "type" | "id">): string {
  return `${park.type ?? ""}/${park.id}`;
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

function validBBox(value: unknown): value is BBox {
  return Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber) &&
    value[0] <= value[2] && value[1] <= value[3] &&
    value[0] >= -180 && value[2] <= 180 && value[1] >= -90 && value[3] <= 90;
}

export function parseSearchResult(value: unknown): ParkSearchResult {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || !validBBox(value.bbox)) {
    throw new Error("Park search record has invalid id or bbox");
  }
  if (value.name_en != null && typeof value.name_en !== "string") {
    throw new Error("Park search record has invalid name_en");
  }
  const centroid = value.centroid == null ? null : value.centroid;
  if (centroid !== null && (!Array.isArray(centroid) || centroid.length !== 2 ||
    !isFiniteNumber(centroid[0]) || !isFiniteNumber(centroid[1]))) {
    throw new Error("Park search record has invalid centroid");
  }
  return {
    id: value.id as number,
    type: typeof value.type === "string" ? value.type : null,
    name: typeof value.name === "string" ? value.name : null,
    name_en: typeof value.name_en === "string" ? value.name_en : null,
    city: typeof value.city === "string" ? value.city : null,
    city_source: typeof value.city_source === "string" ? value.city_source : null,
    state: typeof value.state === "string" ? value.state : null,
    country: typeof value.country === "string" ? value.country : null,
    country_code: typeof value.country_code === "string" ? value.country_code : null,
    state_code: typeof value.state_code === "string" ? value.state_code : null,
    bench_count: value.bench_count == null ? null : Number(value.bench_count),
    total_bench_capacity: value.total_bench_capacity == null
      ? null
      : Number(value.total_bench_capacity),
    area_m2: value.area_m2 == null ? null : Number(value.area_m2),
    bbox: value.bbox,
    centroid: centroid as [number, number] | null,
  };
}

export function validateManifest(value: unknown): ParkSearchManifest {
  if (!isRecord(value)) throw new Error("Malformed park search manifest");
  if (!isCompatibleSchemaVersion(value.schemaVersion, SCHEMA_VERSIONS.ParkSearchResult) ||
    value.normalizationVersion !== "2" ||
    typeof value.buildId !== "string" || typeof value.generatedAt !== "string" ||
    !Number.isSafeInteger(value.minPrefixLength) || (value.minPrefixLength as number) < 1 ||
    !Number.isSafeInteger(value.maxRecordsPerShard) ||
    !Number.isSafeInteger(value.maxEstimatedCompressedBytesPerShard) ||
    value.sizeMetric !== "gzip-json-bytes" || !isRecord(value.nodes) ||
    !isRecord(value.leaves)) {
    throw new Error(
      `Unsupported park search manifest; expected schema ${SCHEMA_VERSIONS.ParkSearchResult} / normalization 2`,
    );
  }
  const leaves = value.leaves as Record<string, unknown>;
  for (const key of Object.keys(leaves)) {
    const shardPaths = leaves[key];
    if (!Array.isArray(shardPaths) || !shardPaths.every((path) => typeof path === "string")) {
      throw new Error("Malformed park search manifest leaves");
    }
  }
  return value as unknown as ParkSearchManifest;
}

function descendantShardPaths(manifest: ParkSearchManifest, prefix: string): string[] {
  const matchingLeaves = Object.keys(manifest.leaves)
    .filter((leaf) => leaf.startsWith(prefix))
    .sort((left, right) => left.localeCompare(right));
  const paths: string[] = [];
  for (const leaf of matchingLeaves) paths.push(...manifest.leaves[leaf]);
  return paths;
}

function resolveTokenShardPaths(
  manifest: ParkSearchManifest,
  token: string,
): string[] {
  if (codePointLength(token) < manifest.minPrefixLength) return [];

  const prefixes = Object.keys(manifest.nodes).filter((prefix) => token.startsWith(prefix));
  if (!prefixes.length) return [];
  const start = prefixes.sort((left, right) =>
    codePointLength(right) - codePointLength(left) || left.localeCompare(right),
  )[0];
  const paths: string[] = [];
  const visit = (prefix: string): void => {
    const leafShards = manifest.leaves[prefix];
    if (leafShards) {
      paths.push(...leafShards);
      return;
    }

    const node = manifest.nodes[prefix];
    if (!node) return;
    if (node.shards) {
      paths.push(...node.shards);
      return;
    }

    const matchingChildren = (node.children ?? []).filter((child) => token.startsWith(child));
    if (matchingChildren.length) {
      matchingChildren.sort().forEach(visit);
    } else if (token === prefix) {
      paths.push(...descendantShardPaths(manifest, prefix));
    }
  };
  visit(start);
  return paths;
}

export function resolveShardPaths(
  manifest: ParkSearchManifest,
  query: string,
): string[] {
  const tokenGroups = normalizeSearchTokenGroups(query);
  if (!tokenGroups.length) return [];
  const longestGroup = [...tokenGroups].sort((left, right) =>
    codePointLength(right[0]) - codePointLength(left[0]) ||
    right[0].localeCompare(left[0]),
  )[0];
  const paths: string[] = [];
  for (const token of longestGroup) {
    paths.push(...resolveTokenShardPaths(manifest, token));
  }
  return Array.from(new Set(paths));
}

function tokenGroupMatches(
  queryGroup: SearchTokenGroup,
  recordGroups: SearchTokenGroups,
  exact = false,
): boolean {
  return queryGroup.some((queryToken) =>
    recordGroups.some((recordGroup) =>
      recordGroup.some((recordToken) =>
        exact ? recordToken === queryToken : recordToken.startsWith(queryToken),
      ),
    ),
  );
}

export function matchesSearchTokenGroups(
  record: ParkSearchResult,
  queryGroups: SearchTokenGroups,
): boolean {
  const searchableFields = [record.name, record.name_en, record.city, record.state];
  const recordGroups = searchableFields.map(normalizeSearchTokenGroups);
  return queryGroups.every((queryGroup) =>
    recordGroups.some((fieldGroups) => tokenGroupMatches(queryGroup, fieldGroups)),
  );
}

export function rankSearchResults(
  records: ParkSearchResult[],
  queryGroups: SearchTokenGroups,
): ParkSearchResult[] {
  const unique = [...new Map(records.map((record) => [parkKey(record), record])).values()]
    .filter((record) => matchesSearchTokenGroups(record, queryGroups));
  const primaryNameGroups = (record: ParkSearchResult) =>
    normalizeSearchTokenGroups(record.name);
  const score = (record: ParkSearchResult): number => {
    const nameGroups = primaryNameGroups(record);
    if (queryGroups.every((group) => tokenGroupMatches(group, nameGroups, true))) return 3;
    if (queryGroups.every((group) => tokenGroupMatches(group, nameGroups))) return 2;
    return 1;
  };
  return unique.sort((left, right) =>
    score(right) - score(left) ||
    (right.bench_count == null ? -1 : left.bench_count == null ? 1 : right.bench_count - left.bench_count) ||
    normalizeSearchText(left.name).localeCompare(normalizeSearchText(right.name)) ||
    left.id - right.id ||
    parkKey(left).localeCompare(parkKey(right)),
  ).slice(0, MAX_RESULTS);
}

const shardCache = new Map<string, Promise<ParkSearchResult[]>>();

export function clearShardCache(): void {
  shardCache.clear();
}

export function fetchShard(url: string): Promise<ParkSearchResult[]> {
  const existing = shardCache.get(url);
  if (existing) return existing;
  const request = fetchJson<unknown>(url).then((value) => {
    if (!Array.isArray(value)) throw new Error(`Malformed search shard: ${url}`);
    return value.map(parseSearchResult);
  }).catch((error) => {
    shardCache.delete(url);
    throw error;
  });
  shardCache.set(url, request);
  return request;
}

/** Fetch every shard that could contain parks matching `query`, as one list. */
export async function loadShardRecords(
  manifest: ParkSearchManifest,
  manifestUrl: string,
  query: string,
): Promise<ParkSearchResult[]> {
  const base = new URL(manifestUrl);
  const shards = await Promise.all(
    resolveShardPaths(manifest, query).map((path) => fetchShard(new URL(path, base).toString())),
  );
  return ([] as ParkSearchResult[]).concat(...shards);
}
