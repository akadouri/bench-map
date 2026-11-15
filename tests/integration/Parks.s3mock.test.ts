import { request as httpRequest } from "node:http";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h, type PropType } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import Parks from "@/components/Parks.vue";
import { clearShardCache, searchTokens } from "@/services/parkSearch";
import type { ParkSearchResult } from "@/types/generated";
import { SCHEMA_VERSIONS } from "@/types/generated";

const metadataUrl = process.env.BENCHMAP_S3MOCK_METADATA_URL;
const test = metadataUrl ? it : it.skip;

interface HttpJsonResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

interface HttpMeasurement {
  url: string;
  status: number;
  elapsedMs: number;
  bodyBytes: number;
}

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

function httpJson(url: string): Promise<{ response: HttpJsonResponse; bodyBytes: number }> {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => {
        const data = Buffer.concat(chunks);
        const status = response.statusCode ?? 0;
        const text = data.toString("utf8");
        resolve({
          response: {
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(text) as unknown,
          },
          bodyBytes: data.byteLength,
        });
      });
    });
    req.on("error", reject);
    req.end();
  }).then(({ response, bodyBytes }) => {
    measurements.push({
      url,
      status: response.status,
      elapsedMs: performance.now() - startedAt,
      bodyBytes,
    });
    return { response, bodyBytes };
  });
}

let measurements: HttpMeasurement[] = [];
let wrapper: ReturnType<typeof mount> | undefined;

const nodeFetch: typeof fetch = async (input) => {
  const { response } = await httpJson(String(input));
  return response as Response;
};

const tests = metadataUrl ? describe : describe.skip;
tests("Parks search against local S3Mock", () => {
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    clearShardCache();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("loads local assets and renders a real shard response", async () => {
    measurements = [];
    vi.stubEnv("VITE_METADATA_URL", metadataUrl!);
    vi.stubGlobal("fetch", nodeFetch);

    const metadataResponse = await httpJson(metadataUrl!);
    expect(metadataResponse.response.ok).toBe(true);
    const datasetMetadata = await metadataResponse.response.json() as {
      artifacts: {
        park_search: {
          schema_version: string;
          manifest_url: string;
          top_parks_url: string;
        };
      };
    };
    const searchPointer = datasetMetadata.artifacts.park_search;
    expect(searchPointer.schema_version).toBe(SCHEMA_VERSIONS.ParkSearchResult);
    const topUrl = new URL(searchPointer.top_parks_url, metadataUrl!).toString();
    const topResponse = await httpJson(topUrl);
    expect(topResponse.response.ok).toBe(true);
    const topParks = await topResponse.response.json() as ParkSearchResult[];
    const park = topParks.find((candidate) => typeof candidate.name === "string" &&
      searchTokens(candidate.name).some((token) => Array.from(token).length >= 2));
    expect(park).toBeDefined();

    wrapper = mount(Parks, {
      global: {
        provide: {
          emitter: { emit: vi.fn(), on: vi.fn() },
        },
        stubs: { RecycleScroller: RecycleScrollerStub },
      },
    });
    await flushPromises();
    await vi.waitFor(() => {
      expect(wrapper!.find(".park-search-input").exists()).toBe(true);
    }, { timeout: 5_000 });
    const input = wrapper.get<HTMLInputElement>(".park-search-input");
    await input.trigger("focus");
    const queryToken = searchTokens(park!.name)
      .sort((left, right) => Array.from(right).length - Array.from(left).length)[0];
    const requestsBeforeQuery = measurements.length;
    await input.setValue(queryToken);

    await vi.waitFor(() => {
      expect(measurements.slice(requestsBeforeQuery).some(({ url }) =>
        url.includes("/prefixes/"),
      )).toBe(true);
    }, { timeout: 5_000 });
    await vi.waitFor(() => {
      expect(wrapper!.findAll(".park-result").some((result) =>
        result.text().includes(park!.name!),
      )).toBe(true);
    }, { timeout: 5_000 });

    const requests = measurements.filter(({ url }) => url !== metadataUrl && url !== topUrl);
    expect(requests.some(({ url }) => url.endsWith("/manifest.json"))).toBe(true);
    expect(requests.some(({ url }) => url.includes("/prefixes/"))).toBe(true);
    expect(requests.every(({ status }) => status === 200)).toBe(true);
    expect(requests.every(({ bodyBytes }) => bodyBytes > 0)).toBe(true);
    expect(requests.some(({ url }) => url.endsWith("park_stats.parquet"))).toBe(false);
  });
});
