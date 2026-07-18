# Smart Maidani V7

## Streaming Capture — new project type
A third project type alongside Standard (from scratch / import): **Streaming Capture**.
A dedicated project where coordinates are recorded automatically from the live GPS
watch while the surveyor walks or drives. Configured at project creation:

- **Feature class name** — user-defined (e.g. Road_Centerline)
- **Geometry type** — Point / Line / Polygon
  - **Point**: choose a tolerance (1 m, 2 m, 5 m, 10 m or custom). A new point record
    is saved silently every time the device moves that distance.
  - **Line**: a vertex is added automatically every 10 m and wherever the direction
    changes by more than 20°. Tap **Stop & Save** to store the line.
  - **Polygon**: same auto-vertex logic; returning within 5 m of the start point
    closes the polygon automatically, saves it, notifies the surveyor and starts
    the next polygon immediately.
- **Accuracy filter**: fixes worse than 15 m are ignored so bad GPS never creates
  garbage features.
- **Control bar**: Start / Pause / Resume / Stop with live status (recording dot,
  count, vertices, distance) plus a **Fields** sheet for the optional attributes.

### Streaming schema (every captured feature)
| Field | Source |
|---|---|
| OBJECTID | Automatic |
| FEATURECLASS | User-defined at setup |
| Z_VALUE | Auto (elevation, also in 3D geometry) |
| LONGITUDE / LATITUDE | Auto |
| SPEED_MPS + SPEED_KMH | Auto (both units) |
| DIRECTION | Auto — N, NE, E, SE, S, SW, W, NW |
| CAP_DATE / CAP_TIME | Auto |
| ROADNAME, ROADID, COMMUNITY, DISTRICT | Optional user input — stamped onto every capture; update them as you enter a new road |

Lines/polygons carry the user fields plus START/END date-time, VERTEX_CNT and
LENGTH_M; per-vertex Z lives in the 3D geometry, as agreed.

## Export column cleanup (all formats)
- **Removed**: FID (OBJECTID is the single stable identifier), FEATURE_CLASS
  (redundant with ASSET_TYPE), MEDIA_ALL. Attachments now relate via REL_OBJECTID.
- **Media files renamed** from FID-based to OBJECTID-based, e.g.
  `Water_Line_OID_000001_PHOTO_01.jpg`.
- **Z_ELEVATION added** to CSV and Excel (previously missing there while present in
  GeoJSON/KML/DBF).
- Retained: OBJECTID, ASSET_TYPE, STATUS, SURVEYOR, ROLE, GEOMETRY_TYPE,
  LONGITUDE, LATITUDE, Z_ELEVATION, GPS_ACCURACY_M, CREATED_AT, UPDATED_AT,
  PHOTO/VIDEO counts and URLs, plus all user-defined layer fields.

## Email the package with the ZIP attached
The Export sheet's **Email** button now builds the full ZIP package and hands it to
the device share sheet — choosing Gmail/Outlook there opens a new email from the
registered account with the ZIP **already attached**; the surveyor just presses
Send. On desktop or unsupported browsers it downloads the ZIP and opens a
pre-filled email as fallback. (Browsers do not permit silently attaching files to
email without the share sheet — this is the closest supported flow.)

## Safety
All existing flows (standard projects, manual GPS capture, import, editing,
route tracking, every export format) are untouched and re-verified: 22 export
engine checks, 21 standard runtime checks and 21 new streaming checks — all pass.
Service worker cache bumped to v16.
