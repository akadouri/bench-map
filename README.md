# Bench Map

This is a simple project that displays [bench](https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dbench) and park geometry from a local postgresql database setup with [osm2pgsql](https://osm2pgsql.org/). The steps for preparing data are no longer in this repository.

This project was created with the help of Co-Pilot.

## Hosted at [https://arielsartistry.com/benches/index.html](https://arielsartistry.com/benches/index.html)
The hosted version may use data that is not the same as the data prepared in `scripts/` and in `/public`. The example in those folder are intended for local devleopment.

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