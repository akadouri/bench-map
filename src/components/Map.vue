<script lang="ts">
import {
  Map,
  NavigationControl,
  AttributionControl,
  LngLat,
} from "maplibre-gl";
import { inject } from "vue";
import benches_geojson from "@/assets/benches.json";
import parks_geojson from "@/assets/parks.json";
import type { ParkItem } from "@/components/types";

export default {
  setup() {
    const emitter = inject("emitter") as any;
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
      zoom: 14,
      maxBounds: [
        [-74.367903, 40.417915],
        [-73.665787, 40.961384],
      ],
    });
    map.on("load", function () {
      map.addSource("benches-source", {
        type: "geojson",
        data: benches_geojson,
      });
      map.addControl(new AttributionControl(), "top-left");
      var nav = new NavigationControl({});
      map.addControl(nav, "top-right");
      map.addLayer({
        id: "benches",
        source: "benches-source",
        type: "circle",
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
      map.addSource("parks-source", {
        type: "geojson",
        data: parks_geojson,
      });
      map.addLayer({
        id: "parks",
        source: "parks-source",
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
    });
    this.emitter.on("park", (e: ParkItem) => {
      map.removeFeatureState({
        source: "parks-source",
      });
      map.setFeatureState(
        {
          source: "parks-source",
          id: e.osm_id,
        },
        {
          clicked: true,
        }
      );
      const found = parks_geojson.features.find(
        (item) => item.properties.osm_id == e.osm_id
      );
      if (found !== undefined) {
        const coords = new LngLat(
          found.geometry.coordinates[0][0][0][0],
          found.geometry.coordinates[0][0][0][1]
        );
        map.flyTo({ center: coords, zoom: 15 });
      }
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
