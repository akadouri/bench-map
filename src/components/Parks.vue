<script lang="ts">
import { inject } from "vue";
import type { ParkItem, Metadata } from "@/components/types";
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

    // Fetch metadata.json for created_at date
    const metadataUrl = import.meta.env.VITE_METADATA_URL ||  import.meta.env.BASE_URL + "metadata.json";
    const metadataResponse = await fetch(metadataUrl);
    const metadataJson: Metadata = await metadataResponse.json();
    this.createdAt = new Date(metadataJson.created_at).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const url = import.meta.env.VITE_PARK_STATS_URL || import.meta.env.BASE_URL + "park_stats.parquet";
    const file = await asyncBufferFromUrl({ url }); // wrap url for async fetching
    const data = await parquetReadObjects({
      file,
      columns: ["osm_id", "name", "count", "envelope"],
    });
    this.parkData = data as ParkItem[];
    this.loading = false;
  },
  data() {
    return {
      parkData: null as ParkItem[] | null,
      selected: null as ParkItem | null,
      loading: true,
      createdAt: null as string | null,
    };
  },
  computed: {
    topParks(): ParkItem[] {
      if (!this.parkData) return [];
      return [...this.parkData]
        .sort((a, b) => Number(b.count) - Number(a.count))
        .slice(0, 10);
    },
  },
  methods: {
    selectPark(park: ParkItem) {
      this.selected = park;
      this.pickItem(park);
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
      <div v-if="parkData">
        <p v-if="createdAt">
          <strong>Data created:</strong> {{ createdAt }}
        </p>
        <p v-if="selected">
          There are {{ selected.count }} benches in {{ selected.name }}
        </p>
        <h3>Select a park:</h3>
        <v-select v-model="selected" :options="parkData" :getOptionKey="(park: ParkItem) => park.osm_id" label="name"
          @option:selected="pickItem" />
        <h3>Top 10 Parks by Bench Count</h3>
        <ol class="top-parks-list">
          <li v-for="park in topParks" :key="park.osm_id" @click="selectPark(park)"
            :class="{ active: selected?.osm_id === park.osm_id }">
            <span class="park-name">{{ park.name }}</span>
            <span class="park-count">{{ park.count }} benches</span>
          </li>
        </ol>
      </div>
      <div v-if="!parkData">No metadata available.</div>
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

.top-parks-list {
  padding-left: 1.5em;
  margin-top: 0.5em;
}

.top-parks-list li {
  list-style-type: decimal;
  padding: 8px 12px;
  margin: 4px 0;
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  transition: background-color 0.2s;
}

.top-parks-list li:hover {
  background-color: #f0f0f0;
}

.top-parks-list li.active {
  background-color: #e3f2fd;
}

.park-name {
  font-weight: 500;
  flex: 1;
  margin-right: 10px;
}

.park-count {
  color: #666;
  font-size: 0.9em;
  white-space: nowrap;
}
</style>
