import vectors from "../fixtures/park_search_normalization_v2.json";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearShardCache,
  loadShardRecords,
  matchesSearchTokenGroups,
  normalizeSearchText,
  normalizeSearchTokenGroups,
  parkKey,
  parseSearchResult,
  rankSearchResults,
  resolveShardPaths,
  validateManifest,
} from "@/services/parkSearch";
import type { ParkSearchManifest, SearchNode } from "@/services/parkSearch";
import { SCHEMA_VERSIONS } from "@/types/generated";


function manifest(
  nodes: Record<string, SearchNode>,
  leaves: Record<string, string[]>,
): ParkSearchManifest {
  return {
    schemaVersion: SCHEMA_VERSIONS.ParkSearchResult,
    normalizationVersion: "2",
    buildId: "test-build",
    generatedAt: "2026-11-08T00:00:00Z",
    minPrefixLength: 2,
    maxRecordsPerShard: 10_000,
    maxEstimatedCompressedBytesPerShard: 2_097_152,
    sizeMetric: "gzip-json-bytes",
    nodes,
    leaves,
  };
}

describe("park search v2 normalization and routing", () => {
  afterEach(() => {
    clearShardCache();
    vi.unstubAllGlobals();
  });

  it("matches the shared producer normalization vectors", () => {
    expect(vectors.normalizationVersion).toBe("2");
    for (const vector of vectors.vectors) {
      expect(normalizeSearchText(vector.input)).toBe(vector.nativeText);
      expect(normalizeSearchTokenGroups(vector.input)).toEqual(vector.tokenForms);
    }
  });

  it("rejects incompatible schema versions and unsupported normalization versions", () => {
    expect(() => validateManifest({
      schemaVersion: "9.0.0",
      normalizationVersion: "2",
    })).toThrow("Unsupported park search manifest");
    expect(() => validateManifest({
      schemaVersion: SCHEMA_VERSIONS.ParkSearchResult,
      normalizationVersion: "1",
    })).toThrow("Unsupported park search manifest");
  });

  it("routes native and Latin-folded forms using only manifest shard paths", () => {
    const nativePath = "prefixes/_/x-c3a963.json";
    const foldedPath = "prefixes/e/ec.json";
    const searchManifest = manifest(
      {
        "éc": { shards: [nativePath] },
        ec: { shards: [foldedPath] },
      },
      {
        "éc": [nativePath],
        ec: [foldedPath],
      },
    );

    expect(resolveShardPaths(searchManifest, "éclair")).toEqual([
      nativePath,
      foldedPath,
    ]);
    expect(resolveShardPaths(searchManifest, "eclair")).toEqual([foldedPath]);
  });

  it("loads and combines the shards for a query, resolving paths against the manifest URL", async () => {
    const record = (id: number, name: string) => ({
      id, type: "way", name, bbox: [0, 0, 1, 1], centroid: null,
    });
    const nativePath = "prefixes/_/x-c3a963.json";
    const foldedPath = "prefixes/e/ec.json";
    const searchManifest = manifest(
      { "éc": { shards: [nativePath] }, ec: { shards: [foldedPath] } },
      { "éc": [nativePath], ec: [foldedPath] },
    );
    const shards: Record<string, unknown[]> = {
      "http://search.test/bucket/park_search/b1/prefixes/_/x-c3a963.json": [record(1, "Éclair Park")],
      "http://search.test/bucket/park_search/b1/prefixes/e/ec.json": [record(2, "Eclair Square")],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const body = shards[String(input)];
      return { ok: Boolean(body), status: body ? 200 : 404, json: async () => body };
    });
    vi.stubGlobal("fetch", fetchMock);

    const records = await loadShardRecords(
      searchManifest,
      "http://search.test/bucket/park_search/b1/manifest.json",
      "éclair",
    );

    expect(records.map((item) => item.id)).toEqual([1, 2]);
    await loadShardRecords(
      searchManifest,
      "http://search.test/bucket/park_search/b1/manifest.json",
      "éclair",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2); // second call served from the shard cache
  });

  it("returns no records, without fetching, when no shard matches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await loadShardRecords(manifest({}, {}), "http://search.test/manifest.json", "zz")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts supplementary characters as code points for prefix routing", () => {
    const firstTwoCodePoints = "𠀀𠀁";
    const shardPath = "prefixes/_/x-f0a08080f0a08081.json";
    const searchManifest = manifest(
      { [firstTwoCodePoints]: { shards: [shardPath] } },
      { [firstTwoCodePoints]: [shardPath] },
    );

    expect(Array.from(firstTwoCodePoints)).toHaveLength(2);
    expect(resolveShardPaths(searchManifest, "𠀀")).toEqual([]);
    expect(resolveShardPaths(searchManifest, "𠀀𠀁公園")).toEqual([shardPath]);
  });

  it("matches name_en as an alias without changing the primary display name", () => {
    const park = parseSearchResult({
      id: 42,
      type: "way",
      name: "Parc des Pins",
      name_en: "Pine Park",
      city: "Montréal",
      bbox: [-73.6, 45.4, -73.5, 45.5],
      centroid: [-73.55, 45.45],
    });
    const query = normalizeSearchTokenGroups("pine");

    expect(matchesSearchTokenGroups(park, query)).toBe(true);
    expect(rankSearchResults([park], query)).toEqual([park]);
    expect(park.name).toBe("Parc des Pins");
    expect(park.name_en).toBe("Pine Park");
  });

  it("keeps parks that share an OSM id but differ in element type", () => {
    const record = (type: string) => parseSearchResult({
      id: 20086809,
      type,
      name: "Riverside Park",
      bench_count: 5,
      bbox: [-74, 40.8, -73.9, 40.9],
    });
    const way = record("way");
    const relation = record("relation");
    const query = normalizeSearchTokenGroups("riverside");

    expect(parkKey(way)).not.toBe(parkKey(relation));
    expect(rankSearchResults([way, relation, way], query)).toEqual([relation, way]);
  });

  it("keeps absent English names null and preserves significant script marks", () => {
    const park = parseSearchResult({
      id: 43,
      type: "way",
      name: "क़िला",
      bbox: [70, 20, 70.1, 20.1],
    });

    expect(park.name_en).toBeNull();
    expect(normalizeSearchTokenGroups(park.name)).toEqual([["क़िला"]]);
  });
});
