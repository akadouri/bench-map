# Bench Map

This is a simple project that pulls [bench](https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dbench) and park geometry from a local postgresql database setup with [osm2pgsql](https://osm2pgsql.org/). I use a [dockerized configuration](https://github.com/akadouri/osm2pgsql-docker-quickstart) with an extract of New York. This isn't the most efficent way to process data for a map like this, but I use the database for other things and already have it setup locally.

## Hosted at [https://arielsartistry.com/benches/index.html](https://arielsartistry.com/benches/index.html)

This may or may not be up to date.

## Project Setup

```sh
npm install
```

### Compile and Hot-Reload for Development

```sh
npm run dev
```

### Type-Check, Compile and Minify for Production

```sh
npm run build
```

### Lint with [ESLint](https://eslint.org/)

```sh
npm run lint
```

### Dependencies

Not an exhaustive list

- [mitt](https://github.com/developit/mitt) to pass events between compontents.
- [maplibre](https://github.com/maplibre/maplibre-gl-js) for the map.
