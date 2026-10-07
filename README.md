# Spirit Mountain

An interactive 3D map of Spirit Mountain in Duluth, Minnesota, built with three.js. It drapes aerial imagery over a USGS lidar terrain model and adds first-return surface, buildings, area overlays, annotations and an HDR sky.

Live site: https://lampagj.github.io/spiritmountain/

## Run locally

```sh
npm install
npx vite --port 5199
```

The Node version is pinned in `.nvmrc`. `npm run build` makes a root-relative build; `GITHUB_PAGES=1 npm run build` makes the `/spiritmountain/` build that the Pages workflow deploys.

## Ingest commands

Ingest output is committed under `data/`, so you only run these to rebuild it. Run them in this order:

```sh
npm run ingest:fetch
npm run ingest:terrain
npm run ingest:imagery
npm run ingest:buildings:fetch
npm run ingest:buildings
npm run ingest:context
npm run ingest:context-terrain
npm run ingest:areas
npm run ingest:annotations
npm run ingest:surface
npm run ingest:surface-terrain
npm run ingest:sky
npm run ingest:imagery-stats
```

`ingest:surface` reads the public 2021 LiDAR point cloud through [PDAL](https://pdal.io), so install it first (for example `brew install pdal`) and make sure `pdal` is on your `PATH`. Every other ingest command needs only Node: they fetch rasters, imagery and OpenStreetMap data over HTTPS.

## Data licences

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.
- Imagery and elevation: USGS 3DEP and NAIP, public domain.
- Sky: Poly Haven, CC0.
