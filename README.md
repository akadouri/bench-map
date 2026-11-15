# Bench Map

This is a simple project that displays [bench](https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dbench) and [park](https://wiki.openstreetmap.org/wiki/Tag:leisure%3Dpark) data from OpenStreetMap on a webmap.

## Hosted at [https://arielsartistry.com/benches/index.html](https://arielsartistry.com/benches/index.html)

The hosted version may use different data than what's generated locally. The data producing repository is not shared publicly, so this repo includes a script that builds a small demo dataset for local development (see [Demo data](#demo-data)).

## Quick start

Install the Node dependencies:

```sh
npm install
```

Create `.env.local` with a MapTiler key:

```dotenv
VITE_MAPTILER_KEY=your_maptiler_key
```

Restart Vite after changing this file. Vite only exposes variables prefixed with `VITE_` to browser code.

Start the development server in demo mode, which renders the map from the sample data checked in under `public/`:

```sh
npm run dev -- --mode demo
```

Demo mode loads `.env.demo`, which leaves `VITE_PMTILES_URL` and `VITE_METADATA_URL` empty so the app falls back to `public/` instead of hosted storage. To use other data, set those two variables in `.env.development` and run `npm run dev` without the flag. `VITE_PMTILES_URL` takes a `pmtiles://` URL, for example `pmtiles://https://example.com/bench_map/data.pmtiles`.

Other commands:

```sh
npm run build   # check generated types, type-check, and build for production
npm test        # unit tests
npm run lint    # eslint, with auto-fix
```

## Demo data

`scripts/layercake/bench_park_datasets.py` builds a small, self-contained dataset from the public OSM US [Layercake](https://layercake.openstreetmap.us/) GeoParquet files, in the format the app loads.

Install [tippecanoe](https://github.com/felt/tippecanoe) (used for the PMTiles step) and the script's Python dependencies:

```sh
python -m pip install duckdb geopandas pyarrow
```

Run it with the default bounding box (Prospect Park and the surrounding area), or give a different WGS84 bbox in `min_lon min_lat max_lon max_lat` order:

```sh
python scripts/layercake/bench_park_datasets.py
python scripts/layercake/bench_park_datasets.py \
  --bbox -73.994594 40.641084 -73.939619 40.677579 \
  --output-dir public
```

Output goes to `public/` by default, which is what `npm run dev -- --mode demo` serves. Running with the default overwrites the generated files listed below and replaces `public/park_search/`. Pass `--output-dir` to write somewhere else, or `--skip-pmtiles` to skip the tippecanoe step.

Keep the bbox small and inside one country. The search index holds every park in a single shard, and the script refuses areas with more parks than one shard can hold. DuckDB loads its `httpfs` extension to read the public Layercake files, so the first run needs network access.

### What it writes

- `data.pmtiles`: vector tiles with `parks` and `benches` layers.
- `parks.parquet`, `benches.parquet`: the queried features (GeoParquet). The app does not load these, and they are git-ignored.
- `park_stats.parquet`: parks with at least one bench, with `bench_count` and `area_m2`. Also not loaded by the app, and git-ignored.
- `park_search/<build-id>/`: the static park search index (`manifest.json`, `prefixes/all.json`, `top_parks.json`).
- `metadata.json`: the dataset manifest the app loads.

### What it does

- Queries named `leisure=park` geometries and joins address city by OSM `type` and `id`.
- Queries `amenity=bench` POIs. Layercake has no bench backrest or capacity, so those columns are null.
- Pushes a bbox overlap predicate into each Layercake scan. Geometries are not clipped, and complete OSM features are kept.
- Counts benches strictly `within` each park. Points on a park boundary do not count.
- Calculates park area after projecting to EPSG:6933 (square metres).

### Limitations

The script is a starting point for local demos, not a planet-scale producer. It does not clip geometries, apply the production locality heuristics, or publish to S3. It also does not produce boundary layers, state and country locality, or boundary rankings, so the app shows those as unavailable in demo mode.

## Updating data schemas

Schemas are stored in `src/schemas/` and generated into `src/types/generated.ts`.

When the producer repository changes its schemas:

1. Set `BENCH_DATA_REPO` to the producer repository and run `npm run schemas:sync`.
2. Review the generated types and update application call sites as needed.
3. Run `npm run type-check` and `npm run build`.
4. Commit both the schema files and `src/types/generated.ts`.

`npm run check:types-generated` verifies that `src/types/generated.ts` is up to date with the schemas in `src/schemas/`. `schemas:sync` only updates the schemas already in that folder; copy a new schema in by hand to start using it.

### Schema versions

Every schema has a [semantic](https://semver.org) `schemaVersion`, and published datasets record the versions they were written with (`schema_version` in `metadata.json` and in the search manifest). The client accepts data whose version is compatible with the one in `src/schemas/`: the same major version from `1.0.0` on, and the same minor version while the major version is `0`. If the data is incompatible, the affected feature shows as unavailable.

## How things work

Bench map is designed to be hosted with static S3-compatible storage. The map tiles come from a single PMTiles file, and everything else is static JSON, so there is no server-side API.

### Park search index

To power the search box, the parks are split into a sharded prefix index. The app first loads a manifest that says which shard files hold the parks whose names start with a given prefix, then fetches only the shards that match what was typed. A small `top_parks.json` file provides the list shown before anything is typed.

### Park locality

Park, park-stats, and park-search records include the nullable fields `city_source`, `country`, `country_code`, and `state_code`. `city_source: "addr:city"` identifies an address city; values beginning with `boundary:` are boundary-derived locality candidates and are shown as “Boundary locality” rather than as verified address cities. `state` is boundary-derived in enrichment modes and may be null. Country and code fields are display context only and are not used for the park search.

### Country boundaries and rankings

The "Top Parks by Bench Count" panel ranks parks within the country currently in view. "Country" here follows OpenStreetMap's classification: boundaries tagged [`boundary=administrative`](https://wiki.openstreetmap.org/wiki/Tag:boundary%3Dadministrative) carry an [`admin_level`](https://wiki.openstreetmap.org/wiki/Key:admin_level) from 2 (the most general) to 11, and `admin_level=2` is a country in most of the world. The code and schema names use "admin 2" for this (`Admin2BoundaryParkRanking`, `admin_2_top_parks`, `admin2-boundary-hit-test`). Only level 2 is used because OSM defines the levels below it differently from country to country.

The map picks the active country by sampling a grid of points across the view and choosing the `admin_level=2` boundary that covers the most points (the one under the center breaks ties). The rankings come from a precomputed file listed in `metadata.json` under `artifacts.boundary_rankings`. Datasets without a `boundaries` tile layer or a rankings artifact, such as the demo data, show the panel as unavailable.

## AI Disclaimer

Portions of this project were created with the help of AI coding tools.
