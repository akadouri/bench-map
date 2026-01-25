<script lang="ts">
import {
  Map,
  NavigationControl,
  AttributionControl,
  type LngLatBoundsLike,
  type LngLatLike,
} from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { inject } from "vue";
import type { ParkItem } from "@/components/types";
import { Protocol } from "pmtiles";

export default {
  setup() {
    const emitter = inject("emitter") as any;
    let protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);
    return {
      emitter,
    };
  },
  mounted() {
    var map = new Map({
      container: "map",
      style:
        "https://api.maptiler.com/maps/basic-v2/style.json?key=" +
        import.meta.env.VITE_MAPTILER_KEY,
      center: [-73.968881, 40.672749],
      zoom: 10,
      maxZoom: 17,
      maxBounds: [
        [-74.338989, 40.482471],
        [-73.54248, 41.068998],
      ],
    });
    map.on("load", function () {
      const pmtilesUrl = import.meta.env.VITE_PMTILES_URL || "pmtiles://data.pmtiles";
      map.addSource("pmtiles-source", {
        type: "vector",
        url: pmtilesUrl,
      });
      map.addLayer({
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
            0.25,
            10,
            2,
            14,
            3,
            16,
            3,
          ],
        },
      });
      map.addControl(new AttributionControl(), "top-left");
      var nav = new NavigationControl({});
      map.addControl(nav, "top-right");
      map.addLayer({
        id: "parks",
        source: "pmtiles-source",
        "source-layer": "parks",
        type: "fill",
        paint: {
          "fill-color": [
            "case",
            ["boolean", ["feature-state", "clicked"], "true"],
            "#ff0000",
            "#9bdeaa",
          ],
          "fill-opacity": 0.25,
        },
      });
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
    });
    this.emitter.on("park", (park: ParkItem) => {
      const bounds = new maplibregl.LngLatBounds();
      park.envelope.coordinates[0].forEach(
        (coord: LngLatLike | LngLatBoundsLike) => {
          bounds.extend(coord);
        }
      );
      map.fitBounds(bounds, {
        padding: 20,
      });
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
