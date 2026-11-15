#!/usr/bin/env python3
"""Build a small-area bench-map demo dataset from OSM US Layercake.

This standalone script produces what the bench-map web app loads, so the app
can run without access to the private producer repository:

* ``data.pmtiles``: vector tiles with ``parks`` and ``benches`` layers (built
  with tippecanoe).
* ``park_stats.parquet``: parks with at least one bench, plus bench counts and
  area.
* ``park_search/<build-id>/``: the static park search index (``park_search_result``
  schema, normalization 2). The area is assumed to be small, so every record lives in
  one shard that all prefixes point to.
* ``metadata.json``: dataset manifest pointing at all of the above.

Column sets follow ``src/schemas/*.schema.json`` and ``src/types/generated.ts``;
re-check them when ``npm run schemas:sync`` pulls in new schemas. Schema versions
are read from those files. The area should lie within a single country: boundary layers,
state/country locality, boundary statistics and boundary rankings are not
produced, and the app treats them as unavailable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast
from urllib.request import Request, urlopen

import duckdb
import geopandas as gpd
import pandas as pd

LAYERCAKE_URL = "https://data.openstreetmap.us/layercake"
WGS84 = "EPSG:4326"
AREA_CRS = "EPSG:6933"
DEFAULT_BBOX = (-73.994594, 40.641084, -73.939619, 40.677579)

SCHEMAS_DIR = Path(__file__).resolve().parents[2] / "src" / "schemas"


def schema_version(name: str) -> str:
    """Return the `schemaVersion` of src/schemas/<name>.schema.json."""
    return json.loads((SCHEMAS_DIR / f"{name}.schema.json").read_text())[
        "schemaVersion"
    ]


# Contract versions, read from the schemas the web app is built against.
MANIFEST_SCHEMA_VERSION = schema_version("dataset_manifest")
SEARCH_SCHEMA_VERSION = schema_version("park_search_result")
SEARCH_NORMALIZATION_VERSION = "2"
SEARCH_MIN_PREFIX_LENGTH = 2
SEARCH_MAX_RECORDS_PER_SHARD = 10_000
SEARCH_MAX_BYTES_PER_SHARD = 2 * 1024 * 1024
TOP_PARKS_COUNT = 20

# Column order follows each schema's field list (SCHEMA_FIELDS in
# src/types/generated.ts). Geometry is appended.
PARK_COLUMNS = [
    "id",
    "name",
    "name_en",
    "type",
    "city",
    "city_source",
    "state",
    "country",
    "country_code",
    "state_code",
]
PARK_STATS_COLUMNS = [
    *PARK_COLUMNS,
    "bench_count",
    "total_bench_capacity",
    "area_m2",
]
BENCH_COLUMNS = ["id", "name", "amenity", "backrest", "capacity"]

PARKS_QUERY = f"""
    SELECT
        p.id,
        p.type,
        p.name[1] AS name,
        p.names['en'][1] AS name_en,
        a."addr:city" AS city,
        a."addr:state" AS state,
        p.geometry
    FROM read_parquet('{LAYERCAKE_URL}/parks.parquet') AS p
    LEFT JOIN read_parquet('{LAYERCAKE_URL}/addresses.parquet') AS a
        ON p.type = a.type AND p.id = a.id
    WHERE p.leisure = 'park'
      AND (p.name[1] IS NOT NULL OR p.names['en'][1] IS NOT NULL)
      AND p.geometry IS NOT NULL
      AND p.bbox.xmax >= ? AND p.bbox.xmin <= ?
      AND p.bbox.ymax >= ? AND p.bbox.ymin <= ?
"""

# Layercake does not expose bench backrest or capacity, so the columns are
# present (the bench schema defines them) but null.
BENCHES_QUERY = f"""
    SELECT
        id,
        amenity,
        name[1] AS name,
        CAST(NULL AS VARCHAR) AS backrest,
        CAST(NULL AS BIGINT) AS capacity,
        geometry
    FROM read_parquet('{LAYERCAKE_URL}/pois.parquet') AS pois
    WHERE amenity = 'bench'
      AND geometry IS NOT NULL
      AND pois.bbox.xmax >= ? AND pois.bbox.xmin <= ?
      AND pois.bbox.ymax >= ? AND pois.bbox.ymin <= ?
"""

# (schema_name, schema_version) per dataset layer, as recorded in metadata.json.
LAYER_SCHEMAS = {
    "parks": ("ParkProperties", schema_version("park")),
    "benches": ("BenchProperties", schema_version("bench")),
    "park_stats": ("ParkStatsProperties", schema_version("park_stats")),
}


def bbox_parameters(bbox: tuple[float, float, float, float]) -> list[float]:
    """Return bbox overlap parameters in min-x, max-x, min-y, max-y order."""
    min_x, min_y, max_x, max_y = bbox
    if min_x >= max_x or min_y >= max_y:
        raise ValueError("bbox must be (min_lon, min_lat, max_lon, max_lat)")
    return [min_x, max_x, min_y, max_y]


def _as_wkb(value: object) -> bytes | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, memoryview):
        return value.tobytes()
    raise TypeError(f"Unexpected Layercake geometry value: {type(value).__name__}")


def _optional(value: object) -> Any:
    """Return a JSON-safe scalar, mapping None/NaN/NA to None."""
    if value is None or bool(pd.isna(cast(Any, value))):
        return None
    item = getattr(value, "item", None)
    return item() if callable(item) else value


def query_geodataframe(
    connection: duckdb.DuckDBPyConnection,
    query: str,
    bbox: tuple[float, float, float, float],
) -> gpd.GeoDataFrame:
    """Run a Layercake query and decode its WKB geometry as WGS84."""
    frame = connection.execute(query, bbox_parameters(bbox)).fetchdf()
    wkb = frame.pop("geometry").map(_as_wkb)
    geometry = gpd.GeoSeries.from_wkb(wkb, index=frame.index, crs=WGS84)
    return gpd.GeoDataFrame(frame, geometry=geometry)


def select_columns(frame: gpd.GeoDataFrame, columns: list[str]) -> gpd.GeoDataFrame:
    """Return ``columns`` in schema order (adding nulls) plus geometry."""
    result = frame.copy()
    for column in columns:
        if column not in result.columns:
            result[column] = None
    return cast(gpd.GeoDataFrame, result[[*columns, "geometry"]])


# ---------------------------------------------------------------------------
# Park locality and statistics
# ---------------------------------------------------------------------------


def add_locality(parks: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Keep the address-derived city; state and country stay null.

    ``city_source`` is ``"addr:city"`` when the Layercake addresses join found a
    non-blank city.
    """
    result = parks.reset_index(drop=True).copy()
    result["city_source"] = result["city"].map(
        lambda value: "addr:city" if isinstance(value, str) and value.strip() else None
    )
    for column in ("country", "country_code", "state", "state_code"):
        result[column] = None
    return result


def create_park_stats(
    parks: gpd.GeoDataFrame, benches: gpd.GeoDataFrame
) -> gpd.GeoDataFrame:
    """Count benches strictly within each park and calculate area in m².

    Parks without benches are omitted, matching the analytics dataset produced
    by the full workflow. ``total_bench_capacity`` is null because Layercake
    does not provide bench capacity.
    """
    result = parks.reset_index(drop=True).copy()
    if result.empty:
        result["bench_count"] = pd.Series(dtype="int64")
        result["area_m2"] = pd.Series(dtype="float64")
    else:
        park_shapes = result[["geometry"]].copy()
        park_shapes["park_row"] = result.index
        bench_shapes = benches[["geometry"]]
        hits = gpd.sjoin(bench_shapes, park_shapes, how="inner", predicate="within")
        counts = hits.groupby("park_row").size().to_dict()
        result["bench_count"] = pd.Series(
            [int(counts.get(row, 0)) for row in range(len(result))],
            index=result.index,
            dtype="int64",
        )
        result = result.loc[result["bench_count"].gt(0)].copy()
        # EPSG:6933 is a global equal-area CRS, so area is in square metres
        # without choosing a region-specific UTM zone.
        result["area_m2"] = result.to_crs(AREA_CRS).geometry.area
    result["total_bench_capacity"] = pd.array([pd.NA] * len(result), dtype="Int64")
    return select_columns(result, PARK_STATS_COLUMNS)


# ---------------------------------------------------------------------------
# Static park search index
#
# The browser normalizes queries and resolves shards with
# src/services/parkSearch.ts; the token rules here must match it.
# ---------------------------------------------------------------------------


def _json_bytes(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def _native_search_tokens(value: object) -> list[str]:
    if not isinstance(value, str) or not value.strip():
        return []
    normalized = unicodedata.normalize("NFC", value)
    normalized = unicodedata.normalize("NFC", normalized.lower())
    tokens: list[str] = []
    current: list[str] = []
    for character in normalized:
        category = unicodedata.category(character)
        if category[0] in {"L", "N"} or (category[0] == "M" and current):
            current.append(character)
        elif current:
            tokens.append("".join(current))
            current = []
    if current:
        tokens.append("".join(current))
    return tokens


def _fold_latin_marks(token: str) -> str:
    """Remove combining marks only when attached to a Latin-script base."""
    folded: list[str] = []
    latin_base = False
    for character in unicodedata.normalize("NFD", token):
        category = unicodedata.category(character)
        if category[0] == "M":
            if not latin_base:
                folded.append(character)
            continue
        folded.append(character)
        latin_base = category[0] == "L" and unicodedata.name(character, "").startswith(
            "LATIN "
        )
    return unicodedata.normalize("NFC", "".join(folded))


def search_tokens(value: object) -> set[str]:
    """Return each native token and its Latin-accent-folded alias."""
    tokens: set[str] = set()
    for native in _native_search_tokens(value):
        tokens.add(native)
        tokens.add(_fold_latin_marks(native))
    return tokens


def park_search_records(stats: gpd.GeoDataFrame) -> list[dict[str, Any]]:
    """Convert park stats into sorted, geometry-free ParkSearchResult records."""
    records: list[dict[str, Any]] = []
    for row in stats.sort_values("id", kind="stable").itertuples(index=False):
        min_x, min_y, max_x, max_y = row.geometry.bounds
        centroid = row.geometry.centroid
        records.append(
            {
                "id": int(row.id),
                "name": _optional(row.name),
                "name_en": _optional(row.name_en),
                "type": _optional(row.type),
                "city": _optional(row.city),
                "city_source": _optional(row.city_source),
                "state": _optional(row.state),
                "country": _optional(row.country),
                "country_code": _optional(row.country_code),
                "state_code": _optional(row.state_code),
                "bench_count": _optional(row.bench_count),
                "total_bench_capacity": _optional(row.total_bench_capacity),
                "area_m2": _optional(row.area_m2),
                "bbox": [float(min_x), float(min_y), float(max_x), float(max_y)],
                "centroid": [float(centroid.x), float(centroid.y)],
            }
        )
    return records


def write_park_search_artifacts(
    stats: gpd.GeoDataFrame, output_dir: Path, generated_at: datetime
) -> dict[str, str]:
    """Write a single-shard search index and return its metadata pointers.

    The client looks up a query's longest token in ``manifest.nodes`` and
    fetches the shards the matching leaf lists. Every two-character token prefix
    points at the same shard, which the client fetches once and filters locally.
    """
    records = park_search_records(stats)
    shard_bytes = _json_bytes(records)
    if len(records) > SEARCH_MAX_RECORDS_PER_SHARD:
        raise ValueError(
            f"{len(records):,} parks exceed the {SEARCH_MAX_RECORDS_PER_SHARD:,} "
            "records one shard may hold; use a smaller --bbox"
        )

    digest = hashlib.sha256(shard_bytes).hexdigest()[:12]
    build_id = f"{generated_at.strftime('%Y%m%dT%H%M%S%f')}-{digest}"
    build_dir = output_dir / "park_search" / build_id
    shard_url = "prefixes/all.json"
    (build_dir / "prefixes").mkdir(parents=True)
    (build_dir / shard_url).write_bytes(shard_bytes)

    prefixes = sorted(
        {
            token[:SEARCH_MIN_PREFIX_LENGTH]
            for record in records
            for field in ("name", "name_en", "city", "state")
            for token in search_tokens(record[field])
            if len(token) >= SEARCH_MIN_PREFIX_LENGTH
        }
    )
    top_parks = sorted(
        records,
        key=lambda record: (
            record["bench_count"] is None,
            -(record["bench_count"] or 0),
            record["id"],
        ),
    )[:TOP_PARKS_COUNT]
    manifest = {
        "schemaVersion": SEARCH_SCHEMA_VERSION,
        "normalizationVersion": SEARCH_NORMALIZATION_VERSION,
        "buildId": build_id,
        "generatedAt": generated_at.isoformat(),
        "minPrefixLength": SEARCH_MIN_PREFIX_LENGTH,
        "maxRecordsPerShard": SEARCH_MAX_RECORDS_PER_SHARD,
        "maxEstimatedCompressedBytesPerShard": SEARCH_MAX_BYTES_PER_SHARD,
        "sizeMetric": "gzip-json-bytes",
        "nodes": {prefix: {"shards": [shard_url]} for prefix in prefixes},
        "leaves": {prefix: [shard_url] for prefix in prefixes},
    }
    (build_dir / "top_parks.json").write_bytes(_json_bytes(top_parks))
    (build_dir / "manifest.json").write_bytes(_json_bytes(manifest))
    return {
        "schema_version": SEARCH_SCHEMA_VERSION,
        "manifest_url": f"park_search/{build_id}/manifest.json",
        "top_parks_url": f"park_search/{build_id}/top_parks.json",
    }


# ---------------------------------------------------------------------------
# PMTiles and dataset metadata
# ---------------------------------------------------------------------------


def create_pmtiles(layers: list[tuple[str, gpd.GeoDataFrame]], path: Path) -> None:
    """Write one multi-layer PMTiles archive with tippecanoe.

    The app styles the ``parks`` and ``benches`` source layers. Tippecanoe omits
    null properties, so all-null columns are dropped before export to avoid
    type-inference problems in the intermediate FlatGeobuf.
    """
    tippecanoe = shutil.which("tippecanoe")
    if tippecanoe is None:
        raise SystemExit(
            "tippecanoe is required to create PMTiles "
            "(https://github.com/felt/tippecanoe). "
            "Install it or pass --skip-pmtiles."
        )
    with tempfile.TemporaryDirectory() as tmp:
        command = [
            tippecanoe,
            "-o",
            str(path),
            "--force",
            "-Z0",
            "-zg",
            "--no-feature-limit",
            "--no-tile-size-limit",
            "--extend-zooms-if-still-dropping",
        ]
        for name, frame in layers:
            if frame.empty:
                continue
            source = Path(tmp) / f"{name}.fgb"
            frame.dropna(axis=1, how="all").to_file(source, driver="FlatGeobuf")
            command.append(f"--named-layer={name}:{source}")
        _ = subprocess.run(command, check=True)


def layercake_source_updated_at() -> str | None:
    """Return Layercake's published source timestamp, or None if unavailable."""
    # Layercake's host rejects urllib's default User-Agent with HTTP 403.
    request = Request(
        f"{LAYERCAKE_URL}/metadata.json",
        headers={"Accept": "application/json", "User-Agent": "bench-map-example"},
    )
    try:
        with urlopen(request, timeout=30) as response:
            timestamp = json.load(response).get("timestamp")
        parsed = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
    except (OSError, ValueError, AttributeError):
        print("Warning: could not read Layercake's source timestamp")
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def write_metadata(
    output_dir: Path,
    *,
    bbox: tuple[float, float, float, float],
    created_at: datetime,
    row_counts: dict[str, int],
    queries: dict[str, str],
    park_search: dict[str, str],
    tile_layers: list[str],
) -> None:
    """Write the dataset manifest the web app loads at startup."""
    bbox_list = list(bbox)
    layers: dict[str, Any] = {}
    for name, row_count in row_counts.items():
        schema_name, schema_version = LAYER_SCHEMAS[name]
        layers[name] = {
            "name": name,
            "created_at": created_at.isoformat(),
            "query": queries[name],
            "srid": 4326,
            "bbox": bbox_list,
            "row_count": row_count,
            "minzoom": None,
            "maxzoom": None,
            "schema_name": schema_name,
            "schema_version": schema_version,
        }
    composites: dict[str, Any] = {}
    if tile_layers:
        composites["bench_map"] = {
            "name": "bench_map",
            "created_at": created_at.isoformat(),
            "layer_names": tile_layers,
            "bbox": bbox_list,
        }
    manifest = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "name": "bench_map",
        "created_at": created_at.isoformat(),
        "source_updated_at": layercake_source_updated_at(),
        "bbox": bbox_list,
        "layers": layers,
        "composites": composites,
        "artifacts": {"park_search": park_search},
    }
    (output_dir / "metadata.json").write_text(json.dumps(manifest, indent=2))


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def run(
    bbox: tuple[float, float, float, float],
    output_dir: Path,
    create_tiles: bool = True,
) -> None:
    generated_at = datetime.now(timezone.utc)
    output_dir.mkdir(parents=True, exist_ok=True)
    # Search builds are immutable and timestamped; clear earlier ones so the
    # output directory only holds the build metadata.json points to.
    shutil.rmtree(output_dir / "park_search", ignore_errors=True)

    connection = duckdb.connect()
    try:
        # httpfs lets DuckDB scan the public remote GeoParquet files directly.
        _ = connection.execute("INSTALL httpfs")
        _ = connection.execute("LOAD httpfs")
        parks = query_geodataframe(connection, PARKS_QUERY, bbox)
        benches = query_geodataframe(connection, BENCHES_QUERY, bbox)
    finally:
        connection.close()

    parks = parks.drop_duplicates(["type", "id"])
    parks = select_columns(add_locality(parks), PARK_COLUMNS)
    benches["capacity"] = pd.to_numeric(benches["capacity"]).astype("Int64")
    benches = select_columns(benches, BENCH_COLUMNS)
    stats = create_park_stats(parks, benches)

    parks.to_parquet(output_dir / "parks.parquet", index=False)
    benches.to_parquet(output_dir / "benches.parquet", index=False)
    stats.to_parquet(output_dir / "park_stats.parquet", index=False)
    park_search = write_park_search_artifacts(stats, output_dir, generated_at)

    row_counts = {"park_stats": len(stats)}
    queries = {"park_stats": "client-side sjoin(parks, benches, predicate='within')"}
    tile_layers: list[str] = []
    if create_tiles:
        create_pmtiles(
            [("parks", parks), ("benches", benches)], output_dir / "data.pmtiles"
        )
        tile_layers = ["parks", "benches"]
        row_counts = {"parks": len(parks), "benches": len(benches), **row_counts}
        queries["parks"] = " ".join(PARKS_QUERY.split())
        queries["benches"] = " ".join(BENCHES_QUERY.split())

    write_metadata(
        output_dir,
        bbox=bbox,
        created_at=generated_at,
        row_counts=row_counts,
        queries=queries,
        park_search=park_search,
        tile_layers=tile_layers,
    )

    print(f"Wrote datasets to {output_dir}")
    print(f"  parks: {len(parks):,}")
    print(f"  benches: {len(benches):,}")
    print(f"  park_stats (parks with benches): {len(stats):,}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    _ = parser.add_argument(
        "--bbox",
        nargs=4,
        type=float,
        metavar=("MIN_LON", "MIN_LAT", "MAX_LON", "MAX_LAT"),
        default=DEFAULT_BBOX,
        help="WGS84 area of interest; keep it small and within one country",
    )
    _ = parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "public",
        help="Where to write the dataset (default: the app's public/ directory, "
        "which `npm run dev -- --mode demo` serves)",
    )
    _ = parser.add_argument(
        "--skip-pmtiles",
        action="store_true",
        help="Skip data.pmtiles (and the tippecanoe requirement)",
    )
    options = parser.parse_args()
    bbox = cast(
        tuple[float, float, float, float], tuple(cast(list[float], options.bbox))
    )
    _ = bbox_parameters(bbox)
    run(
        bbox,
        cast(Path, options.output_dir),
        create_tiles=not cast(bool, options.skip_pmtiles),
    )


if __name__ == "__main__":
    main()
