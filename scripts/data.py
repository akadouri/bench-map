"""
Query local OpenStreetMap postgresql database.
"""
from os.path import abspath, join
import psycopg2
from json import dumps

PARKS_QUERY = """
    with parks as (
        select name, osm_id, st_multi(st_collect(planet_osm_polygon.way)) as way
        from planet_osm_polygon, nycd
        where planet_osm_polygon.leisure = 'park'
        and st_within(planet_osm_polygon.way, nycd.geom)
        group by name, osm_id
    ), query as (
        select parks.osm_id, parks.name, 
               count(planet_osm_point.way), 
               sum((planet_osm_point.tags->'capacity')::int), 
               st_transform(parks.way, 4326) as way
        from planet_osm_point, parks
        where planet_osm_point.amenity ='bench' 
        and st_within(planet_osm_point.way, parks.way)
        group by parks.osm_id, parks.name, parks.way
    ) SELECT jsonb_build_object(
        'type',     'FeatureCollection',
        'features', jsonb_agg(feature),
        'importdate', (select importdate from planet_osm_replication_status)
    )
    FROM (
    SELECT jsonb_build_object(
        'type',       'Feature',
        'id',         osm_id,
        'geometry',   ST_AsGeoJSON(way)::jsonb,
        'properties', to_jsonb(row) - 'gid' - 'way'
    ) AS feature
    FROM (SELECT * FROM query) row) features;
"""

BENCHES_QUERY = """
    with query as (
	select osm_id, way
    from planet_osm_point, nycd
    where amenity = 'bench'
    and st_intersects(planet_osm_point.way, nycd.geom)
    ) SELECT jsonb_build_object(
        'type',     'FeatureCollection',
        'features', jsonb_agg(feature),
        'importdate', (select importdate from planet_osm_replication_status)
    )
    FROM (
    SELECT jsonb_build_object(
        'type',       'Feature',
        'id',         osm_id,
        'geometry',   ST_AsGeoJSON(st_transform(way, 4326))::jsonb,
        'properties', to_jsonb(row) - 'osm_id' - 'way'
    ) AS feature
    FROM (SELECT * FROM query) row) features;
"""


def fetch(cur, query, file):
    cur.execute(query)
    records = cur.fetchone()
    print(f"writing file {file}")
    with open(
        abspath(join(__file__, f"../../src/assets/{file}.json")),
        "w+",
    ) as file:
        file.write(dumps(records[0]))


def main():
    conn = psycopg2.connect("postgresql://docker:docker@localhost:5432/docker")
    cur = conn.cursor()
    fetch(cur, PARKS_QUERY, "parks")
    fetch(cur, BENCHES_QUERY, "benches")


main()
