<script lang="ts">
import {
  Map as MapLibreMap,
  NavigationControl,
  AttributionControl,
  addProtocol,
  setWorkerUrl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { inject } from "vue";
import {
  boundaryRankingKey,
  parseActiveBoundaryFeature,
  type ActiveBoundary,
} from "@/services/boundaryRankings";
import type { ParkSearchResult } from "@/services/parkSearch";
import type { BBox } from "@/types/metadata";
import { Protocol } from "pmtiles";

setWorkerUrl(workerUrl);

interface Emitter {
  on(event: "park", listener: (park: ParkSearchResult) => void): void;
  emit(event: "active-boundary", boundary: ActiveBoundary | null): void;
}

// "admin2" is OpenStreetMap's `admin_level=2`, which is a country in most of the
// world. This invisible layer lets queryRenderedFeatures find the country in view.
const BOUNDARY_HIT_TEST_LAYER = "admin2-boundary-hit-test";
const BOUNDARY_SAMPLE_GRID_SIZE = 7;

interface BoundarySample {
  boundary: ActiveBoundary;
  samples: number;
  includesCenter: boolean;
}


export default {
  setup() {
    const emitter = inject("emitter") as Emitter;
    let protocol = new Protocol();
    addProtocol("pmtiles", protocol.tile);
    return {
      emitter,
    };
  },
  mounted() {
    const map = new MapLibreMap({
      container: "map",
      style:
        "https://api.maptiler.com/maps/basic-v2/style.json?key=" +
        import.meta.env.VITE_MAPTILER_KEY,
      center: [-73.968881, 40.672749],
      zoom: 10,
      maxZoom: 17,
    });
    let lastBoundaryKey: string | null | undefined;
    const updateActiveBoundary = () => {
      if (!map.getLayer(BOUNDARY_HIT_TEST_LAYER)) return;

      const { clientWidth: width, clientHeight: height } = map.getCanvas();
      const samples = new globalThis.Map<string, BoundarySample>();
      const centerIndex = Math.floor(BOUNDARY_SAMPLE_GRID_SIZE / 2);

      for (let row = 0; row < BOUNDARY_SAMPLE_GRID_SIZE; row += 1) {
        for (let column = 0; column < BOUNDARY_SAMPLE_GRID_SIZE; column += 1) {
          const point: [number, number] = [
            ((column + 0.5) / BOUNDARY_SAMPLE_GRID_SIZE) * width,
            ((row + 0.5) / BOUNDARY_SAMPLE_GRID_SIZE) * height,
          ];
          const boundariesAtPoint = new globalThis.Set<string>();
          const isCenter = row === centerIndex && column === centerIndex;

          for (const feature of map.queryRenderedFeatures(point, {
            layers: [BOUNDARY_HIT_TEST_LAYER],
          })) {
            const boundary = parseActiveBoundaryFeature(feature.properties);
            if (!boundary) continue;
            const key = boundaryRankingKey(boundary.boundary_type, boundary.boundary_id);
            if (boundariesAtPoint.has(key)) continue;
            boundariesAtPoint.add(key);

            const existing = samples.get(key);
            if (existing) {
              existing.samples += 1;
              existing.includesCenter ||= isCenter;
              if (!existing.boundary.boundary_name?.trim() && boundary.boundary_name?.trim()) {
                existing.boundary.boundary_name = boundary.boundary_name;
              }
              if (!existing.boundary.boundary_name_en?.trim() && boundary.boundary_name_en?.trim()) {
                existing.boundary.boundary_name_en = boundary.boundary_name_en;
              }
            } else {
              samples.set(key, {
                boundary,
                samples: 1,
                includesCenter: isCenter,
              });
            }
          }
        }
      }

      const winner = [...samples.entries()].sort(([keyA, a], [keyB, b]) =>
        b.samples - a.samples || Number(b.includesCenter) - Number(a.includesCenter) ||
        keyA.localeCompare(keyB)
      )[0]?.[1]?.boundary ?? null;
      const nextKey = winner
        ? boundaryRankingKey(winner.boundary_type, winner.boundary_id)
        : null;
      if (nextKey === lastBoundaryKey) return;
      lastBoundaryKey = nextKey;
      this.emitter.emit("active-boundary", winner);
    };

    map.on("idle", updateActiveBoundary);
    map.on("load", function () {
      const pmtilesUrl =
        import.meta.env.VITE_PMTILES_URL || "pmtiles://data.pmtiles";
      map.addSource("pmtiles-source", {
        type: "vector",
        url: pmtilesUrl,
      });
      // Basemap labels are symbol layers. Insert our data below the first one
      // so place and road names stay readable on top of parks and benches.
      const firstBasemapLabelId = map
        .getStyle()
        .layers.find((layer) => layer.type === "symbol")?.id;
      map.addLayer(
        {
          id: BOUNDARY_HIT_TEST_LAYER,
          source: "pmtiles-source",
          "source-layer": "boundaries",
          type: "fill",
          filter: [
            "all",
            ["==", ["get", "boundary"], "administrative"],
            ["==", ["get", "admin_level"], "2"],
          ],
          paint: {
            "fill-color": "#000000",
            "fill-opacity": 0.01,
          },
        },
        firstBasemapLabelId
      );
      // Parks are added before benches so the bench points draw on top.
      map.addLayer(
        {
          id: "parks",
          source: "pmtiles-source",
          "source-layer": "parks",
          type: "fill",
          minzoom: 9,
          paint: {
            "fill-opacity": 0.25,
          },
        },
        firstBasemapLabelId
      );
      map.addLayer(
        {
          id: "my-pmtiles-layer",
          type: "circle",
          source: "pmtiles-source",
          "source-layer": "benches",
          paint: {
            "circle-radius": [
              "interpolate",
              ["linear"],
              ["zoom"],
              1,
              2,
              10,
              2,
              14,
              3,
              16,
              3,
            ],
          },
        },
        firstBasemapLabelId
      );
      // No beforeId: park names go on top of everything, basemap labels included.
      map.addLayer({
        id: "parks-label",
        source: "pmtiles-source",
        "source-layer": "parks",
        type: "symbol",
        minzoom: 12,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Open Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 10, 11, 16, 15],
          "text-variable-anchor": ["bottom", "center"],
          "text-radial-offset": 0.5,
        },
        paint: {
          "text-halo-color": "#ffffff",
          "text-halo-width": 2,
        },
      });
      map.addControl(new AttributionControl(), "top-left");
      var nav = new NavigationControl({});
      map.addControl(nav, "top-right");
    });
    this.emitter.on("park", (park: ParkSearchResult) => {
      const bbox = park.bbox as BBox;
      map.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ],
        { padding: 20 }
      );
    });
  },
};
</script>

<template>
  <div id="map-container">
    <div id="map"></div>
  </div>
</template>

<style>
#map-container {
  position: relative;
  width: 100%;
  height: 100%;
}

#map {
  position: absolute;
  height: 100%;
  width: 100%;
}
</style>
