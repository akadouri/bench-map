<script lang="ts">
import { inject } from "vue";
import type { ParkItem } from "@/components/types";
import { asyncBufferFromUrl, parquetReadObjects } from "hyparquet";

export default {
  setup() {
    const emitter = inject("emitter") as any;
    const pickItem = (item: ParkItem) => {
      emitter.emit("park", item);
    };
    return { pickItem };
  },
  async mounted() {
    this.loading = true;
    const url = "/park_stats.parquet";
    const file = await asyncBufferFromUrl({ url }); // wrap url for async fetching
    const data = await parquetReadObjects({
      file,
      columns: ["osm_id", "name", "count", "envelope"],
    });
    this.metadata = data;
    this.metadata.import_timestamp = "12/13/2025";
    this.loading = false;
  },
  data() {
    return {
      metadata: null as any,
      selected: null as ParkItem | null,
      loading: true,
    };
  },
  methods: {
    // selects a park (left for future use if items are returned)
    selectPark(item: ParkItem) {
      this.selected = item;
      (this as any).pickItem(item);
    },
  },
};
</script>

<template>
  <div id="parks-container">
    <h1>Bench Map!</h1>
    <p>
      This is a map of benches pulled from
      <a href="https://www.openstreetmap.org/">OpenStreetMap</a>.
    </p>
    <br />
    <h2>Parks</h2>
    <div v-if="loading">Loading metadata…</div>
    <div v-else>
      <div v-if="metadata">
        <p v-if="metadata.import_timestamp">
          <strong>Imported:</strong> {{ metadata.import_timestamp }}
        </p>
        <p v-if="selected">
          There are {{ selected.count }} benches in {{ selected.name }}
        </p>
        <v-select
          v-model="selected"
          :options="metadata"
          :getOptionKey="(metadata : any) => metadata.osm_id"
          label="name"
          @option:selected="pickItem"
        />
      </div>
      <div v-if="!metadata">No metadata available.</div>
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
