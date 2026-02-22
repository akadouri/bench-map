<script lang="ts">
import { inject } from "vue";
import type { ParkItem, Metadata } from "@/components/types";
import { asyncBufferFromUrl, parquetReadObjects } from "hyparquet";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";

export default {
  components: {
    RecycleScroller,
  },
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
      columns: ["osm_id", "name", "count", "envelope", "city", "state"],
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
      searchQuery: "",
      highlightIndex: 0,
      resultsOpen: false,
      searchLimit: 2000,
    };
  },
  computed: {
    topParks(): ParkItem[] {
      if (!this.parkData) return [];
      return [...this.parkData]
        .sort((a, b) => Number(b.count) - Number(a.count))
        .slice(0, 10);
    },
    filteredParks(): ParkItem[] {
      if (!this.parkData) return [];
      const q = this.searchQuery.trim().toLowerCase();
      const matches = q
        ? this.parkData.filter((park) => {
            const name = String(park.name ?? "");
            const city = String(park.city ?? "");
            const state = String(park.state ?? "");
            const haystack = `${name} ${city} ${state}`.toLowerCase();
            return haystack.includes(q);
          })
        : this.parkData;
      return matches.slice(0, this.searchLimit);
    },
    highlightedPark(): ParkItem | null {
      if (!this.filteredParks.length) return null;
      const index = Math.min(
        Math.max(this.highlightIndex, 0),
        this.filteredParks.length - 1
      );
      return this.filteredParks[index] ?? null;
    },
  },
  watch: {
    searchQuery() {
      this.highlightIndex = 0;
    },
    parkData() {
      this.highlightIndex = 0;
    },
  },
  methods: {
    selectPark(park: ParkItem) {
      this.selected = park;
      this.pickItem(park);
    },
    commitSelection(park: ParkItem | null) {
      if (!park) return;
      this.selected = park;
      this.pickItem(park);
      this.resultsOpen = false;
    },
    openResults() {
      this.resultsOpen = true;
    },
    closeResultsSoon() {
      setTimeout(() => {
        this.resultsOpen = false;
      }, 150);
    },
    setHighlight(index: number) {
      this.highlightIndex = index;
    },
    onSearchKeydown(event: KeyboardEvent) {
      if (!this.filteredParks.length) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.highlightIndex = Math.min(
          this.highlightIndex + 1,
          this.filteredParks.length - 1
        );
        this.scrollToHighlight();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        this.highlightIndex = Math.max(this.highlightIndex - 1, 0);
        this.scrollToHighlight();
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.commitSelection(this.highlightedPark);
      } else if (event.key === "Escape") {
        this.resultsOpen = false;
      }
    },
    scrollToHighlight() {
      const scroller = this.$refs.resultsScroller as {
        scrollToItem?: (index: number) => void;
      } | null;
      scroller?.scrollToItem?.(this.highlightIndex);
    },
    formatLocation(park: ParkItem): string {
      const city = String(park.city ?? "").trim();
      const state = String(park.state ?? "").trim();
      if (city && state) return ` (${city}, ${state})`;
      if (city) return ` (${city})`;
      if (state) return ` (${state})`;
      return "";
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
        <div class="park-select">
          <input
            v-model="searchQuery"
            class="park-search-input"
            type="text"
            placeholder="Search parks by name or city"
            @focus="openResults"
            @blur="closeResultsSoon"
            @keydown="onSearchKeydown"
          />
          <div v-if="resultsOpen" class="park-results">
            <RecycleScroller
              v-if="filteredParks.length"
              ref="resultsScroller"
              class="park-results-list"
              :items="filteredParks"
              :item-size="32"
              key-field="osm_id"
            >
              <template #default="{ item, index }">
                <div
                  class="park-result"
                  :class="{ active: index === highlightIndex }"
                  @mouseenter="setHighlight(index)"
                  @mousedown.prevent="commitSelection(item)"
                >
                  {{ item.name }}{{ formatLocation(item) }}
                </div>
              </template>
            </RecycleScroller>
            <div v-else class="park-results-empty">No matches.</div>
          </div>
        </div>
        <h3>Top 10 Parks by Bench Count</h3>
        <ol class="top-parks-list">
          <li v-for="park in topParks" :key="park.osm_id" @click="selectPark(park)"
            :class="{ active: selected?.osm_id === park.osm_id }">
            <span class="park-name">{{ park.name }}{{ formatLocation(park) }}</span>
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

.park-select {
  position: relative;
  max-width: 520px;
}

.park-search-input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid #cfcfcf;
  border-radius: 4px;
}

.park-results {
  position: absolute;
  z-index: 2;
  width: 100%;
  max-height: 240px;
  overflow: hidden;
  border: 1px solid #ddd;
  border-top: none;
  background: #fff;
}

.park-results-list {
  max-height: 240px;
}

.park-result {
  padding: 6px 8px;
  cursor: pointer;
}

.park-result:hover,
.park-result.active {
  background: #f2f2f2;
}

.park-results-empty {
  padding: 8px;
  color: #666;
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
