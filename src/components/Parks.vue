<script lang="ts">
import { inject } from "vue";
import parks_geojson from "@/assets/parks.json";
import type { ParkItem } from "@/components/types";

export default {
  setup() {
    const emitter = inject("emitter") as any;
    const pickItem = (item: ParkItem) => {
      emitter.emit("park", item);
    };
    return { pickItem };
  },
  mounted() {},
  data() {
    let names: any[] = [];
    parks_geojson.features.forEach((item) => {
      if (item.properties.name !== null) {
        names.push({
          label: item.properties.name,
          osm_id: item.properties.osm_id,
          count: item.properties.count,
        });
      }
    });
    return {
      importdate: parks_geojson.importdate.split("+")[0],
      items: parks_geojson.features,
      names: names,
      selected: { label: "", count: "" },
    };
  },
};
</script>

<template>
  <div id="parks-container">
    <h1>Bench Map!</h1>
    <p>
      This is a map of benches pulled from
      <a href="https://www.openstreetmap.org/">OpenStreetMap</a> on
      {{ importdate }}.
    </p>
    <br />
    <h2>Search by Park</h2>
    <v-select v-model="selected" :options="names" @option:selected="pickItem" />
    <div v-if="selected && selected.label">
      {{ selected.label }} has {{ selected.count }} benches.
    </div>
  </div>
</template>

<style>
#parks-container {
  position: relative;
  padding-left: 20px;
  width: 100%;
  height: calc(100vh - 77px);
}

@media only screen and (max-width: 600px) {
  #parks-container {
    height: 100%;
  }
}

#park {
  position: absolute;
  height: 100px;
  width: 100%;
}

li {
  list-style-type: none;
}
</style>
