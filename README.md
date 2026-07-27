# EasyCapture

**Field GIS data collection — build your own layers, capture anywhere, export for GIS.**

EasyCapture is an offline-first Progressive Web App (PWA) modeled on the Esri Field Maps experience. The map fills the whole screen; forms and lists slide over it. Surveyors register once, create their own **Asset Types**, define the attributes for each, then collect points, lines and polygons that all flow into the correct feature class. Every feature gets an auto-filled **Z-Elevation**, coordinates in the **coordinate system you choose**, geotagged photos and video, and one-tap export to GeoJSON, KML, Shapefile, CSV, Excel, PDF or a full ZIP.

No build step. No framework. No backend required. Static files you host on GitHub Pages.

---

## What makes it a real GIS tool

- **You define the Asset Types.** No fixed templates. Name the asset type, pick its geometry (point/line/polygon), and add fields (text, number, dropdown, yes/no, date, time). Every captured asset becomes a feature in that type's feature class.
- **ArcMap-style editing.** Arrow select, rectangle select, double-click vertex editing, vertex insert/move/delete, move, rotate, reshape, split, cut, merge, undo/redo and an explicit snapping ON/OFF toggle.
- **Portable media links.** Direct Excel and Shapefile downloads are self-contained ZIP bundles with their referenced `media/` folder, real spreadsheet hyperlinks and GIS setup files.
- **Default field route.** GPS travel is saved per project and exported as time-aware GeoJSON with distance, duration and speed statistics.
- **Full geometry editing.** Move a point, redraw a line or polygon, or delete — after capture.
- **Load existing data.** Import a GeoJSON into a layer and edit its features on the map.
- **Per-layer symbology.** Set color, point size, line thickness, fill and opacity for each layer; the map updates live.
- **Coordinate systems (proj4).** Choose per project: WGS 84 (GCS), a UTM zone (auto-detected from your location), or any EPSG code. Data is stored in WGS 84 and re-projected for display and export, so it stays correct.
- **Auto Z-Elevation.** Every feature gets a `Z_Elevation` field, filled automatically from an online elevation service (Open-Meteo, with Open-Elevation fallback) and written into the 3D coordinate. Editable; falls back gracefully offline.
- **Register once, auto-fill everywhere.** On first launch you enter your name and role; they attach to every record you collect.
- **Geotagged camera.** Photos and video are tagged to the current location and linked to the specific asset record.

## Interface

- Full-screen map with three basemaps — Satellite (default), Streets, Topographic
- Floating zoom, locate-me and layers controls; live GPS with accuracy ring
- One big **Collect** button; Records and Export a tap away
- Forms slide up as a sheet on phones, dock as a panel on laptops/tablets — automatically
- Clean Esri-blue / white styling

## Export — everything GIS needs

| Format | File | Notes |
|--------|------|-------|
| GeoJSON | `.geojson` | Re-projected to your project CRS; 3D coordinates with Z |
| KML | `.kml` | WGS 84, for Google Earth |
| Shapefile | `.zip` | ArcMap-ready feature classes by Asset Type; native `FID` + `OBJECTID` |
| CSV | `.csv` | Flat attribute table incl. Z_Elevation |
| Excel | `.xlsx` | Standard `Features` and `Attachments` tables with clickable media |
| PDF | `.pdf` | Field report with photos |
| ZIP package | `.zip` | All formats + FID-named media + `REL_FID`/`REL_OBJECTID` relationship table |

---

## Deploy to GitHub Pages

1. Put these files in a repo (keep the folder structure), push to GitHub.
2. **Settings → Pages → Deploy from a branch → `main` / root**, Save.
3. Live at `https://<you>.github.io/<repo>/` in about a minute.

HTTPS (which Pages provides) is required for GPS, camera, install, and the elevation service. To try locally: run `python3 -m http.server 8000` in the folder and open `http://localhost:8000` — do not open `index.html` directly with `file://`.

## Install on a device

- **Android / Chrome:** menu → Install app
- **iPhone / Safari:** Share → Add to Home Screen
- **Desktop:** install icon in the address bar

## Project structure

```
easycapture/
├── index.html
├── manifest.webmanifest
├── sw.js
├── css/app.css
├── js/
│   ├── icons.js     Icon set + EasyCapture logo
│   ├── db.js        IndexedDB (user, projects, layers, records, media)
│   ├── geo.js       Coordinate systems (proj4) + elevation service
│   ├── export.js    GeoJSON / KML / CSV / Shapefile / ZIP engine
│   └── app.js       App controller
└── icons/
```

## Libraries (bundled for offline startup)

Pinned copies of Leaflet (maps), proj4js (coordinate systems), JSZip (packaging), SheetJS (Excel), Turf and import helpers are stored in `vendor/` and cached with the application. The ArcMap-safe Shapefile writer is built into the application.

## Field safety

Version 1.1.0 adds verified complete backups, backup-age status, local dependency checks, storage readiness, photo size reduction, pre-export QA/QC and verified complete export packages. See `RELEASE-1.1.0.md`.

## Note on elevation accuracy

Auto Z-values come from online terrain (DEM) services — ground-surface elevation at your coordinates, typically accurate to a few meters. This suits most survey contexts but is not survey-grade and is not the height of an object above/below ground. For engineering-grade Z, use an RTK GPS and edit the value. Requires a connection at capture time; offline captures backfill Z when you're next online.

## License

MIT — see [LICENSE](LICENSE). Bundled dependency acknowledgements are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

EasyCapture — built for the field.
