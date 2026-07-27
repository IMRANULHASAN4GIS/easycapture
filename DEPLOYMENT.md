# EasyCapture 1.1.0 deployment

## GitHub Pages

1. Publish the repository from the `main` branch and repository root.
2. Keep `index.html`, `sw.js`, `manifest.webmanifest`, `js/`, `css/`, `icons/`, and `vendor/` together at the root.
3. Wait for the GitHub Pages workflow to finish.
4. Open the site online and refresh once so the `easycapture-v1.1.0` service worker takes control.
5. Open **Menu → Offline readiness** and confirm that the application shell, local dependency bundle, map engine, projection engine, package engine, and storage checks pass.
6. Test the required survey area in airplane mode before field deployment.

Existing IndexedDB projects and records are retained because the application continues to use its legacy database identifier. Create a verified complete backup before every production upgrade.

Mobile operating systems may retain an old installed PWA icon. If that happens, remove the installed shortcut and install EasyCapture again after the deployment.

## Release validation

Before merging a release into `main`, run:

```text
node --check js/version.js
node --check js/safety.js
node --check js/db.js
node --check js/geo.js
node --check js/export.js
node --check js/app.js
node --check sw.js
node tests/safety.test.js
```
