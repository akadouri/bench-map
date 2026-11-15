<script lang="ts">
import { inject } from "vue";
import {
  boundaryRankingKey,
  indexBoundaryRankings,
  loadBoundaryRankings,
  resolveBoundaryDisplayName,
  type ActiveBoundary,
} from "@/services/boundaryRankings";
import {
  SCHEMA_VERSIONS,
  type Admin2BoundaryParkRanking,
  type Admin2RankedPark,
  type BoundaryRankingsArtifactMetadataSchema,
} from "@/types/generated";
import {
  MAX_RESULTS,
  clearShardCache,
  codePointLength,
  loadShardRecords,
  parkKey,
  parseSearchResult,
  rankSearchResults,
  normalizeSearchTokenGroups,
  validateManifest,
  type ParkSearchManifest,
  type ParkSearchResult,
} from "@/services/parkSearch";
import { fetchJson } from "@/services/json";
import type { Metadata } from "@/types/metadata";
import {
  isCompatibleSchemaVersion,
  warnForSchemaVersionDrift,
} from "@/types/validate";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";

interface Emitter {
  emit(event: "park", value: ParkSearchResult): void;
  on(
    event: "active-boundary",
    listener: (boundary: ActiveBoundary | null) => void
  ): void;
}

function resolveUrl(value: string, base: string): string {
  return new URL(value, base).toString();
}

export default {
  components: {
    RecycleScroller,
  },
  setup() {
    const emitter = inject("emitter") as Emitter;
    const pickItem = (item: ParkSearchResult) => {
      emitter.emit("park", item);
    };
    return { emitter, pickItem };
  },
  async mounted() {
    this.emitter.on("active-boundary", (boundary) => {
      const previousKey = this.activeBoundary
        ? boundaryRankingKey(
            this.activeBoundary.boundary_type,
            this.activeBoundary.boundary_id
          )
        : null;
      const nextKey = boundary
        ? boundaryRankingKey(boundary.boundary_type, boundary.boundary_id)
        : null;
      if (previousKey !== nextKey) this.boundaryParkError = "";
      this.activeBoundary = boundary;
    });
    try {
      const metadataUrl =
        import.meta.env.VITE_METADATA_URL ||
        new URL("metadata.json", window.location.href).toString();
      const metadataJson = await fetchJson<Metadata>(metadataUrl);
      warnForSchemaVersionDrift(metadataJson);
      this.createdAt = new Date(metadataJson.created_at).toLocaleDateString(
        "en-US",
        {
          year: "numeric",
          month: "long",
          day: "numeric",
        }
      );
      void this.loadBoundaryRankings(
        metadataUrl,
        metadataJson.artifacts?.boundary_rankings ?? null
      );
      const pointers = metadataJson.artifacts?.park_search;
      if (
        !pointers ||
        !isCompatibleSchemaVersion(
          pointers.schema_version,
          SCHEMA_VERSIONS.ParkSearchResult
        )
      ) {
        throw new Error("Static park search is unavailable");
      }
      const manifestUrl = resolveUrl(pointers.manifest_url, metadataUrl);
      const topParksUrl = resolveUrl(pointers.top_parks_url, metadataUrl);
      this.loadingMessage = "Loading park search index…";
      const [manifestValue, topValue] = await Promise.all([
        fetchJson<unknown>(manifestUrl),
        fetchJson<unknown>(topParksUrl),
      ]);
      const manifest = validateManifest(manifestValue);
      if (this.manifestUrl && this.manifestUrl !== manifestUrl)
        clearShardCache();
      this.manifestUrl = manifestUrl;
      this.manifest = manifest;
      if (!Array.isArray(topValue)) throw new Error("Malformed top parks list");
      this.topParksData = topValue.map(parseSearchResult).slice(0, MAX_RESULTS);
      this.parkData = this.topParksData;
      this.loading = false;
      this.status = "ready";
    } catch (error) {
      console.error("Static park search unavailable", error);
      this.errorMessage = "Park search is currently unavailable. Please retry.";
      if (this.boundaryRankingsStatus === "loading")
        this.boundaryRankingsStatus = "error";
      this.loading = false;
      this.status = "error";
    }
  },
  data() {
    return {
      parkData: null as ParkSearchResult[] | null,
      topParksData: [] as ParkSearchResult[],
      selected: null as ParkSearchResult | null,
      manifest: null as ParkSearchManifest | null,
      manifestUrl: null as string | null,
      loading: true,
      loadingMessage: "Loading metadata…",
      createdAt: null as string | null,
      searchQuery: "",
      highlightIndex: 0,
      resultsOpen: false,
      status: "initializing" as
        | "initializing"
        | "ready"
        | "searching"
        | "error",
      errorMessage: "",
      searchTimer: null as ReturnType<typeof setTimeout> | null,
      searchGeneration: 0,
      activeBoundary: null as ActiveBoundary | null,
      boundaryRankingsByKey: {} as Record<string, Admin2BoundaryParkRanking>,
      boundaryRankingsStatus: "loading" as
        | "loading"
        | "ready"
        | "unavailable"
        | "error",
      boundaryParkLoadingKey: null as string | null,
      boundaryParkError: "",
    };
  },
  computed: {
    topParks(): ParkSearchResult[] {
      return this.topParksData;
    },
    filteredParks(): ParkSearchResult[] {
      return this.parkData ?? [];
    },
    // RecycleScroller needs a unique key property on each item; OSM ids alone
    // are not unique across element types.
    resultRows(): { key: string; park: ParkSearchResult }[] {
      return this.filteredParks.map((park) => ({ key: parkKey(park), park }));
    },
    highlightedPark(): ParkSearchResult | null {
      if (!this.filteredParks.length) return null;
      const index = Math.min(
        Math.max(this.highlightIndex, 0),
        this.filteredParks.length - 1
      );
      return this.filteredParks[index] ?? null;
    },
    isDemoMode(): boolean {
      return import.meta.env.MODE === "demo";
    },
    activeBoundaryRanking(): Admin2BoundaryParkRanking | null {
      if (!this.activeBoundary) return null;
      const key = boundaryRankingKey(
        this.activeBoundary.boundary_type,
        this.activeBoundary.boundary_id
      );
      return this.boundaryRankingsByKey[key] ?? null;
    },
    activeBoundaryLabel(): string {
      return resolveBoundaryDisplayName(
        this.activeBoundaryRanking,
        this.activeBoundary
      );
    },
  },
  watch: {
    searchQuery() {
      this.highlightIndex = 0;
      if (this.searchTimer) clearTimeout(this.searchTimer);
      const tokenGroups = normalizeSearchTokenGroups(this.searchQuery);
      const generation = ++this.searchGeneration;
      const longestTokenLength = tokenGroups.reduce(
        (longest, group) => Math.max(longest, ...group.map(codePointLength)),
        0
      );
      if (
        !this.manifest ||
        !tokenGroups.length ||
        longestTokenLength < this.manifest.minPrefixLength
      ) {
        this.parkData = this.topParksData;
        this.status = "ready";
        return;
      }
      this.status = "searching";
      this.searchTimer = setTimeout(async () => {
        try {
          const records = await loadShardRecords(
            this.manifest!,
            this.manifestUrl!,
            this.searchQuery
          );
          if (generation !== this.searchGeneration) return;
          this.parkData = rankSearchResults(records, tokenGroups);
          this.status = "ready";
        } catch (error) {
          if (generation !== this.searchGeneration) return;
          console.error("Park search failed", error);
          this.errorMessage = "Search failed. Please try again.";
          this.status = "error";
        }
      }, 250);
    },
    parkData() {
      this.highlightIndex = 0;
    },
  },
  methods: {
    canSelectBoundaryPark(park: Admin2RankedPark): boolean {
      return (
        Boolean(
          park.name?.trim() && normalizeSearchTokenGroups(park.name).length
        ) ||
        this.topParksData.some(
          (candidate) =>
            candidate.id === park.id && candidate.type === park.type
        )
      );
    },
    isBoundaryParkLoading(park: Admin2RankedPark): boolean {
      return (
        this.boundaryParkLoadingKey === boundaryRankingKey(park.type, park.id)
      );
    },
    async selectBoundaryPark(park: Admin2RankedPark) {
      const key = boundaryRankingKey(park.type, park.id);
      if (!this.canSelectBoundaryPark(park) || this.boundaryParkLoadingKey)
        return;

      this.boundaryParkLoadingKey = key;
      this.boundaryParkError = "";
      try {
        let result =
          this.topParksData.find(
            (candidate) =>
              candidate.id === park.id && candidate.type === park.type
          ) ?? null;
        if (!result && park.name && this.manifest && this.manifestUrl) {
          const records = await loadShardRecords(
            this.manifest,
            this.manifestUrl,
            park.name
          );
          result =
            records.find(
              (candidate) =>
                candidate.id === park.id && candidate.type === park.type
            ) ?? null;
        }
        if (!result) {
          throw new Error(
            `No searchable park record found for ${park.type}/${park.id}`
          );
        }
        this.selected = result;
        this.pickItem(result);
      } catch (error) {
        console.error("Could not locate boundary-ranked park", error);
        this.boundaryParkError = `Could not locate ${
          park.name ?? "this park"
        } on the map.`;
      } finally {
        if (this.boundaryParkLoadingKey === key)
          this.boundaryParkLoadingKey = null;
      }
    },
    async loadBoundaryRankings(
      metadataUrl: string,
      pointers: BoundaryRankingsArtifactMetadataSchema | null
    ) {
      if (!pointers) {
        this.boundaryRankingsStatus = "unavailable";
        return;
      }
      this.boundaryRankingsStatus = "loading";
      try {
        const rankings = await loadBoundaryRankings(metadataUrl, pointers);
        this.boundaryRankingsByKey = indexBoundaryRankings(rankings);
        this.boundaryRankingsStatus = "ready";
      } catch (error) {
        console.error("Boundary rankings unavailable", error);
        this.boundaryRankingsStatus = "error";
      }
    },

    selectPark(park: ParkSearchResult) {
      this.selected = park;
      this.pickItem(park);
    },
    commitSelection(park: ParkSearchResult | null) {
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
    displayParkName(park: {
      name?: string | null;
      name_en?: string | null;
    }): string {
      const name = park.name ?? "Unnamed park";
      const englishName = park.name_en?.trim();
      return englishName && englishName !== name
        ? `${name} (${englishName})`
        : name;
    },
    formatLocation(park: ParkSearchResult): string {
      const city = typeof park.city === "string" ? park.city.trim() : "";
      const state = typeof park.state === "string" ? park.state.trim() : "";
      const countryCode =
        typeof park.country_code === "string" ? park.country_code.trim() : "";
      const parts = [city, state, countryCode].filter(Boolean);
      return parts.length ? ` (${parts.join(", ")})` : "";
    },
    localityLabel(park: ParkSearchResult): string {
      if (!park.city) return "Unresolved city";
      if (park.city_source?.startsWith("boundary:")) return "Boundary locality";
      return "Address city";
    },
    localityAriaLabel(park: ParkSearchResult): string {
      return `${park.name ?? "Unnamed park"}; ${this.localityLabel(park)}`;
    },
    retrySearch() {
      window.location.reload();
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

    <div v-if="loading" class="parks-loading" role="status" aria-live="polite">
      <span>{{ loadingMessage }}</span>
      <span
        class="parks-loading-bar"
        role="progressbar"
        aria-label="Loading park data"
      ></span>
    </div>
    <div v-else>
      <div v-if="status === 'error'" class="park-results-empty" role="alert">
        {{ errorMessage }}
        <button type="button" @click="retrySearch">Retry</button>
      </div>
      <div v-else-if="parkData">
        <p v-if="createdAt"><strong>Data created:</strong> {{ createdAt }}</p>
        <p v-if="selected">
          There are {{ selected.bench_count ?? 0 }} benches in
          {{ selected.name }}
          <span v-if="selected.total_bench_capacity != null">
            (capacity {{ selected.total_bench_capacity }})
          </span>
          <span v-if="selected.area_m2 != null">
            — {{ Math.round(selected.area_m2).toLocaleString() }} m²
          </span>
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
              :items="resultRows"
              :item-size="32"
              key-field="key"
            >
              <template #default="{ item, index }">
                <div
                  class="park-result"
                  :class="{ active: index === highlightIndex }"
                  @mouseenter="setHighlight(index)"
                  @mousedown.prevent="commitSelection(item.park)"
                >
                  <span :aria-label="localityAriaLabel(item.park)">
                    {{ item.park.name }}{{ formatLocation(item.park) }}
                  </span>
                </div>
              </template>
            </RecycleScroller>
            <div v-else class="park-results-empty">
              {{
                status === "searching"
                  ? "Searching…"
                  : searchQuery
                  ? "No matches."
                  : "No parks available."
              }}
            </div>
          </div>
        </div>
        <section class="stats-section boundary-ranking" aria-live="polite">
          <h3>Top Parks by Bench Count in {{ activeBoundaryLabel }}</h3>
          <p v-if="boundaryRankingsStatus === 'unavailable' && isDemoMode">
            Boundary rankings don't work in demo mode: the demo data is
            generated without them (see
            <code>scripts/layercake/bench_park_datasets.py</code>).
          </p>
          <p v-else-if="boundaryRankingsStatus === 'unavailable'">
            Boundary rankings are not available for this dataset.
          </p>
          <p v-else-if="!activeBoundary">
            Pan or zoom the map to choose a boundary.
          </p>
          <p v-else-if="boundaryRankingsStatus === 'loading'">
            Loading boundary rankings…
          </p>
          <p v-else-if="boundaryRankingsStatus === 'error'" role="alert">
            Boundary rankings could not be loaded.
          </p>
          <p v-else-if="!activeBoundaryRanking">
            No ranking is available for this boundary.
          </p>
          <p v-else-if="!activeBoundaryRanking.parks.length">
            No parks with benches were found in this boundary.
          </p>
          <p v-if="boundaryParkError" role="alert">{{ boundaryParkError }}</p>
          <ol v-if="activeBoundaryRanking?.parks.length" class="stats-list">
            <li
              v-for="park in activeBoundaryRanking.parks"
              :key="`${park.type}/${park.id}`"
            >
              <button
                type="button"
                class="stats-row"
                :disabled="
                  boundaryParkLoadingKey !== null ||
                  !canSelectBoundaryPark(park)
                "
                :title="
                  canSelectBoundaryPark(park)
                    ? 'Zoom to this park'
                    : 'This park cannot be located by name'
                "
                :aria-label="`Zoom to ${displayParkName(park)}`"
                @click="selectBoundaryPark(park)"
              >
                <span class="park-name">
                  {{ displayParkName(park) }}
                  <span v-if="isBoundaryParkLoading(park)">— locating…</span>
                </span>
                <span class="park-count"
                  >{{ park.bench_count.toLocaleString() }} benches</span
                >
              </button>
            </li>
          </ol>
        </section>
        <section class="stats-section">
          <h3>Top Parks by Bench Count Globally</h3>
          <ol class="stats-list">
            <li v-for="park in topParks" :key="`${park.type}/${park.id}`">
              <button
                type="button"
                class="stats-row"
                :class="{
                  selected:
                    selected?.id === park.id && selected?.type === park.type,
                }"
                :aria-label="`Zoom to ${displayParkName(park)}${formatLocation(
                  park
                )}`"
                @click="selectPark(park)"
              >
                <span class="park-name"
                  >{{ displayParkName(park) }}{{ formatLocation(park) }}</span
                >
                <span class="park-count"
                  >{{ (park.bench_count ?? 0).toLocaleString() }} benches</span
                >
              </button>
            </li>
          </ol>
        </section>
      </div>
      <div v-if="!parkData && status !== 'error'">
        No search data available.
      </div>
    </div>
  </div>
</template>

<style>
#parks-container {
  position: relative;
  padding-left: 20px;
  width: 100%;
  height: calc(100vh - 77px);
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 12px;
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

.parks-loading {
  display: grid;
  gap: 8px;
  max-width: 520px;
  margin: 12px 0;
}

.parks-loading-bar {
  display: block;
  width: 100%;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: #e0e0e0;
}

.parks-loading-bar::after {
  display: block;
  width: 40%;
  height: 100%;
  border-radius: inherit;
  background: #1976d2;
  content: "";
  animation: parks-loading 1.2s ease-in-out infinite;
}

@keyframes parks-loading {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(250%);
  }
}

.stats-section {
  margin: 16px 0;
}

.stats-section h3 {
  margin-bottom: 4px;
}

.stats-list {
  padding-left: 1.5em;
  margin-top: 0.5em;
}

.stats-list li {
  margin: 4px 0;
  list-style-type: decimal;
}

.stats-row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 12px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.2s;
}

.stats-row:hover:not(:disabled) {
  background-color: #f0f0f0;
}

.stats-row.selected {
  background-color: #e3f2fd;
}

.stats-row:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.park-select {
  position: relative;
  max-width: 520px;
}

.park-search-input {
  box-sizing: border-box;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid #cfcfcf;
  border-radius: 4px;
}

.park-results {
  position: absolute;
  z-index: 2;
  box-sizing: border-box;
  width: 100%;
  max-height: 240px;
  overflow: hidden;
  border: 1px solid #ddd;
  border-top: none;
  background: #fff;
}

.park-results-list {
  width: 100%;
  max-height: 240px;
}

.park-result {
  box-sizing: border-box;
  width: 100%;
  padding: 6px 8px;
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.park-result > span {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
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

.boundary-ranking {
  margin: 12px 0 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid #ddd;
}
</style>
