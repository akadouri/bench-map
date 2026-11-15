import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, type PropType } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Parks from "@/components/Parks.vue";
import { clearShardCache } from "@/services/parkSearch";
import type { ParkSearchResult } from "@/types/generated";
import { SCHEMA_VERSIONS } from "@/types/generated";

const metadataUrl = "http://search-fixture.test/bucket1/bench_map/metadata.json";
const manifestUrl =
  "http://search-fixture.test/bucket1/bench_map/park_search/response-test/manifest.json";
const topParksUrl =
  "http://search-fixture.test/bucket1/bench_map/park_search/response-test/top_parks.json";
const shardUrl =
  "http://search-fixture.test/bucket1/bench_map/park_search/response-test/prefixes/p/prospect.json";
const shardPath = "prefixes/p/prospect.json";
const englishAliasPath = "prefixes/v/volunteers.json";
const englishAliasUrl =
  "http://search-fixture.test/bucket1/bench_map/park_search/response-test/prefixes/v/volunteers.json";

const topPark = {
  id: 20,
  type: "way",
  name: "Golden Gate Park",
  city: "San Francisco",
  state: "CA",
  bench_count: 10,
  bbox: [-122.51, 37.75, -122.35, 37.83],
  centroid: [-122.43, 37.79],
};

const prospectPark = {
  id: 1,
  type: "way",
  name: "Próspect Park",
  name_en: "Volunteers Park",
  city: "Brooklyn",
  state: "NY",
  bench_count: 25,
  bbox: [-73.98, 40.65, -73.97, 40.66],
  centroid: [-73.975, 40.655],
};

const metadata = {
  name: "bench_map",
  created_at: "2026-11-08T00:00:00Z",
  bbox: null,
  artifacts: {
    park_search: {
      schema_version: SCHEMA_VERSIONS.ParkSearchResult,
      manifest_url: "park_search/response-test/manifest.json",
      top_parks_url: "park_search/response-test/top_parks.json",
    },
  },
};

const manifest = {
  schemaVersion: SCHEMA_VERSIONS.ParkSearchResult,
  normalizationVersion: "2",
  buildId: "response-test",
  generatedAt: "2026-11-08T00:00:00Z",
  minPrefixLength: 2,
  maxRecordsPerShard: 10_000,
  maxEstimatedCompressedBytesPerShard: 2_097_152,
  sizeMetric: "gzip-json-bytes",
  nodes: {
    pr: { shards: [shardPath] },
    vo: { shards: [englishAliasPath] },
  },
  leaves: {
    pr: [shardPath],
    vo: [englishAliasPath],
  },
};

const RecycleScrollerStub = defineComponent({
  props: {
    items: {
      type: Array as PropType<{ key: string; park: ParkSearchResult }[]>,
      required: true,
    },
  },
  setup(props, { slots }) {
    return () =>
      h(
        "div",
        { class: "recycle-scroller-stub" },
        props.items.flatMap((item, index) => slots.default?.({ item, index }) ?? []),
      );
  },
});

type RequestMeasurement = {
  url: string;
  elapsedMs: number;
  responseBodyBytes: number;
};

let requestMeasurements: RequestMeasurement[];
let wrapper: ReturnType<typeof mount> | undefined;

function installFixtureFetch(options: { delayShardMs?: number; failShard?: boolean } = {}) {
  const fixtureByUrl = new Map<string, unknown>([
    [metadataUrl, metadata],
    [manifestUrl, manifest],
    [topParksUrl, [topPark]],
    [shardUrl, [prospectPark]],
    [englishAliasUrl, [prospectPark]],
  ]);

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const payload = fixtureByUrl.get(url);
    if (payload === undefined || (options.failShard && url === shardUrl)) {
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: "fixture response unavailable" }),
      } as Response;
    }

    const startedAt = performance.now();
    if (url === shardUrl && options.delayShardMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayShardMs));
    }
    const serialized = JSON.stringify(payload);
    requestMeasurements.push({
      url,
      elapsedMs: performance.now() - startedAt,
      responseBodyBytes: new TextEncoder().encode(serialized).byteLength,
    });
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response;
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mountParks() {
  wrapper = mount(Parks, {
    global: {
      provide: {
        emitter: {
          emit: vi.fn(),
          on: vi.fn(),
        },
      },
      stubs: {
        RecycleScroller: RecycleScrollerStub,
      },
    },
  });
  return wrapper;
}

async function waitForSearchResult(name: string) {
  await vi.waitFor(() => {
    const resultText = wrapper?.findAll(".park-result").map((result) => result.text());
    expect(resultText).toContain(name);
  });
}

describe("Parks search response behavior", () => {
  beforeEach(() => {
    requestMeasurements = [];
    clearShardCache();
    vi.stubEnv("VITE_METADATA_URL", metadataUrl);
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    clearShardCache();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders a shard response and measures simulated response delay", async () => {
    const fetchMock = installFixtureFetch({ delayShardMs: 40 });
    const parks = mountParks();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(metadataUrl);
    expect(fetchMock).toHaveBeenCalledWith(manifestUrl);
    expect(fetchMock).toHaveBeenCalledWith(topParksUrl);
    expect(parks.findAll(".park-result")).toHaveLength(0);

    const input = parks.get<HTMLInputElement>(".park-search-input");
    await input.trigger("focus");
    const queryStartedAt = performance.now();
    await input.setValue("prospect");
    await waitForSearchResult("Próspect Park (Brooklyn, NY)");

    const queryElapsedMs = performance.now() - queryStartedAt;
    const shardMeasurement = requestMeasurements.find(
      (measurement) => measurement.url === shardUrl,
    );

    expect(queryElapsedMs).toBeGreaterThanOrEqual(250);
    expect(shardMeasurement).toBeDefined();
    expect(shardMeasurement?.elapsedMs).toBeGreaterThanOrEqual(35);
    expect(shardMeasurement?.responseBodyBytes).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(shardUrl);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(requestMeasurements.some(({ url }) => url.endsWith("park_stats.parquet"))).toBe(false);
  });

  it("matches an English alias but keeps the primary park name visible", async () => {
    const fetchMock = installFixtureFetch();
    const parks = mountParks();
    await flushPromises();

    const input = parks.get<HTMLInputElement>(".park-search-input");
    await input.trigger("focus");
    await input.setValue("volunteers");
    await waitForSearchResult("Próspect Park (Brooklyn, NY)");

    expect(fetchMock).toHaveBeenCalledWith(englishAliasUrl);
    expect(parks.text()).not.toContain("Volunteers Park");
  });

  it("shows a search error when a shard response fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = installFixtureFetch({ failShard: true });
    const parks = mountParks();
    await flushPromises();

    const input = parks.get<HTMLInputElement>(".park-search-input");
    await input.trigger("focus");
    await input.setValue("prospect");

    await vi.waitFor(() => {
      expect(parks.get('[role="alert"]').text()).toContain("Search failed");
    });
    expect(fetchMock).toHaveBeenCalledWith(shardUrl);
    expect(consoleError).toHaveBeenCalledWith(
      "Park search failed",
      expect.any(Error),
    );
  });
});
