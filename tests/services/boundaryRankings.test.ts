import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadBoundaryRankings,
  parseActiveBoundaryFeature,
  resolveBoundaryDisplayName,
} from "@/services/boundaryRankings";
import type { BoundaryRankingsArtifactMetadataSchema } from "@/types/generated";
import { SCHEMA_VERSIONS } from "@/types/generated";

const metadataUrl = "http://search-fixture.test/bucket1/bench_map/metadata.json";
const manifestUrl =
  "http://search-fixture.test/bucket1/bench_map/boundary_rankings/build-2/manifest.json";
const recordsUrl =
  "http://search-fixture.test/bucket1/bench_map/boundary_rankings/build-2/admin_2_top_parks.json";

const pointers: BoundaryRankingsArtifactMetadataSchema = {
  schema_version: SCHEMA_VERSIONS.Admin2BoundaryParkRanking,
  build_id: "build-2",
  manifest_url: "boundary_rankings/build-2/manifest.json",
  admin_2_top_parks_url: "boundary_rankings/build-2/admin_2_top_parks.json",
};

const manifest = {
  schemaVersion: SCHEMA_VERSIONS.Admin2BoundaryParkRanking,
  buildId: "build-2",
  generatedAt: "2026-11-08T00:00:00Z",
  admin2TopParksUrl: "boundary_rankings/build-2/admin_2_top_parks.json",
};

describe("boundary English-name responses", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses optional English names from ranking artifacts", async () => {
    const artifact = [
      {
        boundary_type: "relation",
        boundary_id: 1,
        boundary_name: "Лондон",
        boundary_name_en: "London",
        parks: [{
          type: "way",
          id: 10,
          name: "公園",
          name_en: "Park",
          bench_count: 4,
        }],
      },
      {
        boundary_type: "relation",
        boundary_id: 2,
        boundary_name: "Локальное название",
        parks: [],
      },
    ];
    const responses = new Map<string, unknown>([
      [manifestUrl, manifest],
      [recordsUrl, artifact],
    ]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const body = responses.get(String(input));
      return {
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        json: async () => body,
      } as Response;
    }));

    const records = await loadBoundaryRankings(metadataUrl, pointers);

    expect(records[0].boundary_name_en).toBe("London");
    expect(records[1].boundary_name_en).toBeNull();
    expect(records[0].parks[0]).toMatchObject({
      type: "way",
      id: 10,
      name: "公園",
      name_en: "Park",
    });
  });

  it("prefers a nonblank English label and falls back to localized names", () => {
    const ranking = {
      boundary_type: "relation",
      boundary_id: 12,
      boundary_name: "Local ranking name",
      boundary_name_en: "English ranking name",
      parks: [],
    };
    const active = {
      boundary_type: "relation",
      boundary_id: 12,
      boundary_name: "Local map name",
      boundary_name_en: "English map name",
    };

    expect(resolveBoundaryDisplayName(ranking, active)).toBe("English ranking name");
    expect(resolveBoundaryDisplayName(
      { ...ranking, boundary_name_en: "  " },
      active,
    )).toBe("English map name");
    expect(resolveBoundaryDisplayName(
      { ...ranking, boundary_name_en: null },
      { ...active, boundary_name_en: null },
    )).toBe("Local ranking name");
    expect(resolveBoundaryDisplayName(
      { ...ranking, boundary_name: "  ", boundary_name_en: null },
      { ...active, boundary_name: "  ", boundary_name_en: null },
    )).toBe("active boundary");
  });

  it("reads optional English feature names while retaining the local name", () => {
    expect(parseActiveBoundaryFeature({
      id: "12",
      type: "relation",
      boundary: "administrative",
      admin_level: "2",
      name: "日本",
      name_en: "Japan",
    })).toEqual({
      boundary_type: "relation",
      boundary_id: 12,
      boundary_name: "日本",
      boundary_name_en: "Japan",
    });

    expect(parseActiveBoundaryFeature({
      id: 12,
      type: "relation",
      boundary: "administrative",
      admin_level: "2",
      name: "日本",
    })?.boundary_name_en).toBeNull();
  });
});
