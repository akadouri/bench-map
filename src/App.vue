<script setup lang="ts">
import Map from "./components/Map.vue";
import Parks from "./components/Parks.vue";
</script>

<template>
  <div id="container">
    <Map />
    <Parks />
  </div>
</template>

<style>
@import "https://unpkg.com/maplibre-gl@2.4.0/dist/maplibre-gl.css";
@import "https://unpkg.com/vue-select@4.0.0-beta.6/dist/vue-select.css";

#container {
  display: grid;
  grid-template-columns: 60% 30%;
}

@media only screen and (max-width: 600px) {
  #container {
    display: grid;
    grid-template-columns: initial;
    grid-template-rows: 60vh 30vh;
  }
}
</style>
