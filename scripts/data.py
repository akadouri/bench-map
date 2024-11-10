"""
Query local OpenStreetMap postgresql database.
"""

from os.path import abspath, join
import psycopg2
from json import dumps

BOUNDARY = "st_geomfromtext('Polygon ((-8266094.70446772 4938303.187610116, -8266094.70446772 4999890.688531854, -8204247.500130178 4999890.688531854, -8204247.500130178 4938303.187610116, -8266094.70446772 4938303.187610116))', 3857 )"
DATE_QUERY = (
    "select value from osm2pgsql_properties where property = 'import_timestamp'"
)
PARKS_QUERY = f"""
    with parks as (
        select name, osm_id, st_multi(st_collect(planet_osm_polygon.way)) as way
        from planet_osm_polygon
        where planet_osm_polygon.leisure = 'park'
        and st_within(planet_osm_polygon.way, {BOUNDARY})
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
        order by parks.name
    ) SELECT jsonb_build_object(
        'type',     'FeatureCollection',
        'features', jsonb_agg(feature),
        'importdate', ({DATE_QUERY})
    )
    FROM (
    SELECT jsonb_build_object(
        'type',       'Feature',
        'id',         osm_id,
        'geometry',   ST_AsGeoJSON(way, 5)::jsonb,
        'properties', to_jsonb(row) - 'gid' - 'way'
    ) AS feature
    FROM (SELECT * FROM query) row) features;
"""

BENCHES_QUERY = f"""
    with query as (
	select osm_id, way
    from planet_osm_point
    where amenity = 'bench'
    and st_intersects(planet_osm_point.way, {BOUNDARY})
    ) SELECT jsonb_build_object(
        'type',     'FeatureCollection',
        'features', jsonb_agg(feature),
        'importdate', ({DATE_QUERY})
    )
    FROM (
    SELECT jsonb_build_object(
        'type',       'Feature',
        'id',         osm_id,
        'geometry',   ST_AsGeoJSON(st_transform(way, 4326), 5)::jsonb,
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
