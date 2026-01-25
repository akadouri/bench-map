#!/usr/bin/env python3
"""
Generate PMTiles and parquet files from OpenStreetMap data via Overpass API.

This script fetches parks and benches data for NYC from OpenStreetMap,
processes it to match the osm2pgsql schema, and generates:
1. data.pmtiles - Vector tiles with parks and benches layers
2. park_stats.parquet - Statistics about benches in each park
3. metadata.json - Metadata about the generated files
"""

import argparse
import json
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Tuple

import geopandas as gpd
import pandas as pd
import requests
from shapely.geometry import MultiPolygon, Point
from shapely.ops import unary_union


# NYC bounding box (minx, miny, maxx, maxy)
NYC_BBOX = (-74.085445,40.634929,-73.738346,40.807053)

# Overpass API endpoint
OVERPASS_URL = "https://overpass-api.de/api/interpreter"


def fetch_overpass_data(query: str, timeout: int = 180) -> dict:
    """
    Fetch data from Overpass API with the given query.
    
    Args:
        query: Overpass QL query string
        timeout: Query timeout in seconds
        
    Returns:
        JSON response from Overpass API
    """
    print(f"Querying Overpass API...")
    response = requests.post(
        OVERPASS_URL,
        data={"data": query},
        timeout=timeout + 30,  # Add buffer to request timeout
    )
    response.raise_for_status()
    return response.json()


def fetch_benches(bbox: Tuple[float, float, float, float]) -> gpd.GeoDataFrame:
    """
    Fetch bench data from OpenStreetMap via Overpass API.
    
    Args:
        bbox: Bounding box (minx, miny, maxx, maxy) in EPSG:4326
        
    Returns:
        GeoDataFrame with benches in EPSG:3857
    """
    minx, miny, maxx, maxy = bbox
    
    # Overpass uses (south, west, north, east) order
    query = f"""
    [out:json][timeout:180];
    (
      node["amenity"="bench"]({miny},{minx},{maxy},{maxx});
    );
    out body;
    """
    
    data = fetch_overpass_data(query)
    
    benches = []
    for element in data.get("elements", []):
        if element["type"] == "node":
            osm_id = element["id"]
            lat = element["lat"]
            lon = element["lon"]
            tags = element.get("tags", {})
            
            # Extract capacity, default to 1
            capacity_str = tags.get("capacity")
            if capacity_str:
                try:
                    capacity = int(capacity_str)
                except (ValueError, TypeError):
                    capacity = 1
            else:
                capacity = 1
            
            benches.append({
                "osm_id": osm_id,
                "name": tags.get("name"),
                "capacity": capacity,
                "geometry": Point(lon, lat),
            })
    
    print(f"Fetched {len(benches)} benches")
    
    gdf = gpd.GeoDataFrame(benches, crs="EPSG:4326")
    # Reproject to EPSG:3857 (Web Mercator) to match osm2pgsql schema
    gdf = gdf.to_crs("EPSG:3857")
    
    return gdf


def fetch_parks(bbox: Tuple[float, float, float, float]) -> gpd.GeoDataFrame:
    """
    Fetch park data from OpenStreetMap via Overpass API.
    
    Args:
        bbox: Bounding box (minx, miny, maxx, maxy) in EPSG:4326
        
    Returns:
        GeoDataFrame with parks in EPSG:3857
    """
    minx, miny, maxx, maxy = bbox
    
    # Overpass uses (south, west, north, east) order
    # Fetch both ways and relations with leisure=park
    query = f"""
    [out:json][timeout:180];
    (
      way["leisure"="park"]({miny},{minx},{maxy},{maxx});
      relation["leisure"="park"]({miny},{minx},{maxy},{maxx});
    );
    out geom;
    """
    
    data = fetch_overpass_data(query)
    
    parks = []
    for element in data.get("elements", []):
        tags = element.get("tags", {})
        osm_id = element["id"]
        name = tags.get("name")
        
        # Extract geometry based on element type
        geometry = None
        
        if element["type"] == "way":
            # Build polygon from nodes
            coords = [(node["lon"], node["lat"]) for node in element.get("geometry", [])]
            if len(coords) >= 3:
                from shapely.geometry import Polygon
                # Close the polygon if not already closed
                if coords[0] != coords[-1]:
                    coords.append(coords[0])
                geometry = Polygon(coords)
        
        elif element["type"] == "relation":
            # Build multipolygon from members
            polygons = []
            for member in element.get("members", []):
                if member["type"] == "way" and member["role"] in ["outer", ""]:
                    coords = [(node["lon"], node["lat"]) for node in member.get("geometry", [])]
                    if len(coords) >= 3:
                        from shapely.geometry import Polygon
                        if coords[0] != coords[-1]:
                            coords.append(coords[0])
                        try:
                            polygons.append(Polygon(coords))
                        except Exception:
                            continue
            
            if polygons:
                if len(polygons) == 1:
                    geometry = polygons[0]
                else:
                    geometry = MultiPolygon(polygons)
        
        if geometry and geometry.is_valid:
            parks.append({
                "osm_id": osm_id,
                "name": name,
                "geometry": geometry,
            })
    
    print(f"Fetched {len(parks)} park features")
    
    gdf = gpd.GeoDataFrame(parks, crs="EPSG:4326")
    # Reproject to EPSG:3857 (Web Mercator)
    gdf = gdf.to_crs("EPSG:3857")
    
    return gdf


def aggregate_parks(parks_gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """
    Aggregate parks by name and osm_id, creating multipolygons.
    
    Replicates the SQL:
    select name, osm_id, st_setsrid(st_multi(st_collect(way)), 3857) as way
    from planet_osm_polygon
    where leisure = 'park'
    group by name, osm_id
    
    Args:
        parks_gdf: GeoDataFrame with individual park features
        
    Returns:
        GeoDataFrame with aggregated parks as multipolygons
    """
    # Group by name and osm_id
    grouped = parks_gdf.groupby(["name", "osm_id"])
    
    aggregated = []
    for (name, osm_id), group in grouped:
        # Collect all geometries and create multipolygon
        geometries = group.geometry.tolist()
        
        if len(geometries) == 1:
            geom = geometries[0]
            # Ensure it's a MultiPolygon
            if geom.geom_type == "Polygon":
                geom = MultiPolygon([geom])
        else:
            # Use unary_union to merge geometries, then convert to MultiPolygon
            merged = unary_union(geometries)
            if merged.geom_type == "Polygon":
                geom = MultiPolygon([merged])
            elif merged.geom_type == "MultiPolygon":
                geom = merged
            else:
                continue
        
        aggregated.append({
            "name": name,
            "osm_id": osm_id,
            "geometry": geom,
        })
    
    print(f"Aggregated to {len(aggregated)} unique parks")
    
    return gpd.GeoDataFrame(aggregated, crs="EPSG:3857")


def calculate_park_stats(
    parks_gdf: gpd.GeoDataFrame,
    benches_gdf: gpd.GeoDataFrame,
) -> pd.DataFrame:
    """
    Calculate statistics about benches in each park.
    
    Replicates the SQL:
    select parks.osm_id, parks.name, 
           count(benches.way) as count, 
           sum(benches.capacity) as capacity, 
           st_envelope(parks.way) as envelope,
           st_area(parks.way) as st_area
    from parks
    left join benches on st_within(benches.way, parks.way)
    group by parks.osm_id, parks.name, parks.way
    
    Args:
        parks_gdf: GeoDataFrame with parks
        benches_gdf: GeoDataFrame with benches
        
    Returns:
        DataFrame with park statistics including geometry
    """
    # Spatial join: find which benches are within which parks
    joined = gpd.sjoin(
        benches_gdf[["osm_id", "capacity", "geometry"]],
        parks_gdf[["osm_id", "name", "geometry"]],
        how="right",
        predicate="within",
    )
    
    # Rename columns to avoid conflicts
    joined = joined.rename(columns={
        "osm_id_left": "bench_osm_id",
        "osm_id_right": "park_osm_id",
    })
    
    # Group by park and calculate statistics
    stats = joined.groupby(["park_osm_id", "name"]).agg({
        "bench_osm_id": "count",  # count of benches
        "capacity": "sum",  # sum of capacities
    }).reset_index()
    
    stats = stats.rename(columns={
        "park_osm_id": "osm_id",
        "bench_osm_id": "count",
    })
    
    # Fill NaN capacities with 0 (parks with no benches)
    stats["capacity"] = stats["capacity"].fillna(0).astype(int)
    
    # Merge back with parks to get geometry
    stats = stats.merge(
        parks_gdf[["osm_id", "geometry"]],
        on="osm_id",
        how="left",
    )
    
    # Calculate envelope (bounding box) and area
    stats_gdf = gpd.GeoDataFrame(stats, geometry="geometry", crs="EPSG:3857")
    stats_gdf["envelope"] = stats_gdf.geometry.envelope
    stats_gdf["st_area"] = stats_gdf.geometry.area
    
    # Keep only the needed columns
    result = stats_gdf[["osm_id", "name", "count", "capacity", "envelope", "st_area"]]
    
    # Set geometry to envelope for the parquet file
    result = result.set_geometry("envelope")
    
    print(f"Calculated statistics for {len(result)} parks")
    
    return result


def generate_pmtiles(
    parks_gdf: gpd.GeoDataFrame,
    benches_gdf: gpd.GeoDataFrame,
    output_path: Path,
) -> None:
    """
    Generate PMTiles file using tippecanoe.
    
    Args:
        parks_gdf: GeoDataFrame with parks in EPSG:3857
        benches_gdf: GeoDataFrame with benches in EPSG:3857
        output_path: Path to output PMTiles file
    """
    # Convert back to EPSG:4326 for GeoJSON/tippecanoe
    parks_4326 = parks_gdf.to_crs("EPSG:4326")
    benches_4326 = benches_gdf.to_crs("EPSG:4326")
    
    # Create temporary GeoJSON files
    with tempfile.NamedTemporaryFile(mode="w", suffix=".geojson", delete=False) as parks_file:
        parks_path = Path(parks_file.name)
        parks_4326.to_file(parks_path, driver="GeoJSON")
    
    with tempfile.NamedTemporaryFile(mode="w", suffix=".geojson", delete=False) as benches_file:
        benches_path = Path(benches_file.name)
        benches_4326.to_file(benches_path, driver="GeoJSON")
    
    try:
        # Run tippecanoe
        cmd = [
            "tippecanoe",
            "-o", str(output_path),
            "--force",  # Overwrite existing file
            "--maximum-zoom=17",
            "--minimum-zoom=1",
            "-L", f"parks:{parks_path}",
            "-L", f"benches:{benches_path}",
        ]
        
        print(f"Running tippecanoe: {' '.join(cmd)}")
        subprocess.run(cmd, check=True)
        print(f"Generated PMTiles: {output_path}")
        
    finally:
        # Clean up temporary files
        parks_path.unlink()
        benches_path.unlink()


def generate_metadata(
    output_dir: Path,
    bbox: Tuple[float, float, float, float],
) -> None:
    """
    Generate metadata.json file.
    
    Args:
        output_dir: Directory containing output files
        bbox: Bounding box used for data generation
    """
    metadata = {
        "created_at": datetime.now().isoformat(),
        "files": {
            "pmtiles": "data.pmtiles",
            "park_stats": "park_stats.parquet",
        },
        "bbox": bbox,
    }
    
    metadata_path = output_dir / "metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2))
    print(f"Generated metadata: {metadata_path}")


def main():
    """Main function to orchestrate data generation."""
    parser = argparse.ArgumentParser(
        description="Generate PMTiles and parquet files from OpenStreetMap data"
    )
    parser.add_argument(
        "--bbox",
        nargs=4,
        type=float,
        default=NYC_BBOX,
        metavar=("MINX", "MINY", "MAXX", "MAXY"),
        help="Bounding box for data extraction (default: NYC bbox)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).parent.parent / "public",
        help="Output directory for generated files (default: ../public)",
    )
    
    args = parser.parse_args()
    bbox = tuple(args.bbox)
    output_dir = args.output_dir
    
    # Create output directory if it doesn't exist
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Generating data for bbox: {bbox}")
    print(f"Output directory: {output_dir}")
    
    # Fetch data from Overpass
    benches_gdf = fetch_benches(bbox)
    parks_gdf = fetch_parks(bbox)
    
    # Aggregate parks by name and osm_id
    parks_agg = aggregate_parks(parks_gdf)
    
    # Calculate park statistics
    park_stats = calculate_park_stats(parks_agg, benches_gdf)
    
    # Save park statistics to parquet
    parquet_path = output_dir / "park_stats.parquet"
    park_stats.to_parquet(parquet_path)
    print(f"Generated parquet: {parquet_path}")
    
    # Generate PMTiles
    pmtiles_path = output_dir / "data.pmtiles"
    generate_pmtiles(parks_agg, benches_gdf, pmtiles_path)
    
    # Generate metadata
    generate_metadata(output_dir, bbox)
    
    print("\n✓ Data generation complete!")


if __name__ == "__main__":
    main()
