# Bench Map

This is a simple project that displays [bench](https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dbench) and [park](https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dpark) data from OpenStreetMap on a webmap.

This project was created with the help of GitHub Copilot.

## Hosted at [https://arielsartistry.com/benches/index.html](https://arielsartistry.com/benches/index.html)
The hosted version may use different data than what's generated locally. The `scripts/` and `/public` folders contain examples for local development.

## Project Setup

### Generate recent data (optional)

Install [tippecanoe](https://github.com/felt/tippecanoe), this is used to generate pmtiles.

Install the python few requirements.
```sh
pip install -r scripts/requirements.txt
```

run the script to download data from [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API)
```sh
python scripts/generate_osm_data.py
```

### For the web

Install node depedencies
```sh
npm install
```

Start development server
```sh
npm run dev
```

Type-Check, Compile and Minify for Production
```sh
npm run build
```