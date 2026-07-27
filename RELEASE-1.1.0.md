# EasyCapture 1.1.0 — Field Safety Release

This backend-free release focuses on preventing data loss and improving dependable field delivery.

## Included

- Third-party GIS libraries are bundled locally for deterministic first startup.
- One release identifier (`1.1.0`) is used for application assets and the service-worker cache.
- Complete backups are reopened with CRC checking, attachment presence checks and item-count verification before being marked verified.
- The backup screen records the date and counts from the last verified backup and warns when it is older than seven days.
- Offline readiness now verifies the local dependency bundle in addition to the application shell, engines, quota and persistent storage.
- Project QA/QC checks incomplete records, required attributes, WGS 84 geometry, domains, duplicate IDs, GPS accuracy over 15 m and missing attachment blobs.
- Complete export packages include `data/qaqc_report.json` and are reopened before download to verify required contents.
- Captured photos are resized to a maximum 2048-pixel edge and encoded as JPEG at 88% quality.
- Pure QA and backup-count helpers have Node regression tests.

## Browser limitations

- Browsers cannot silently save backup files to arbitrary external storage. A verified backup is still on the same device until the user saves or shares the downloaded ZIP elsewhere.
- Basemap tiles remain subject to provider terms and browser quota. Only previously cached areas are available offline.
- Uploaded files and videos are not recompressed in this release.

## Validation

Run:

```text
node --check js/app.js
node --check js/db.js
node --check js/geo.js
node --check js/export.js
node --check js/safety.js
node tests/safety.test.js
```
