/* ============================================================
   Export engine — GIS-ready outputs for the GIS specialist
   Formats: GeoJSON, KML, CSV, Shapefile (zip), full ZIP package
   Geometry: Point / LineString / Polygon
   ============================================================ */
const Exporter = (() => {

  function geometryOf(rec) {
    if (!rec.geometry) {
      if (rec.location) {
        const c = [rec.location.lng, rec.location.lat];
        if (rec.location.z != null) c.push(rec.location.z);
        return { type: 'Point', coordinates: c };
      }
      return null;
    }
    return rec.geometry;
  }

  /* ---------- media links ----------------------------------------------------------
     Photos/video are written into the package under media/ and every record carries a
     relative URL to them, so a GIS user opening the exported GeoJSON/SHP/CSV can click
     the field and the file opens (ArcGIS/QGIS hyperlink field). Names here MUST match
     the names buildZipPackage() writes.                                              */
  function mediaExt(m) {
    const mime = String(m.mime || '').toLowerCase();
    const named = String(m.name || '').includes('.') ? String(m.name).split('.').pop().toLowerCase() : '';
    const mimeExt = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/mpeg': 'mpeg' }[mime];
    if (mimeExt) return mimeExt;
    if (named && /^[a-z0-9]{1,8}$/.test(named)) return named;
    if (m.type === 'video') return 'webm';
    if (m.type === 'photo') return 'jpg';
    return 'bin';
  }
  function safeFilePart(value) { return String(value || 'item').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'item'; }
  function safeFeatureClass(value) {
    let name = safeFilePart(value || 'FEATURES').replace(/\.+/g, '_').slice(0, 40);
    if (!/^[A-Za-z]/.test(name)) name = 'FC_' + name;
    return name || 'FEATURES';
  }
  function sameXY(a, b) { return !!a && !!b && Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12; }
  function cleanXY(c) {
    if (!Array.isArray(c) || c.length < 2) return null;
    const x = Number(c[0]), y = Number(c[1]);
    if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) return null;
    // Carry Z through so exported GeoJSON/KML keep true 3D coordinates.
    // The shapefile writer only reads [0]/[1], so the extra element is harmless there.
    const z = c.length > 2 ? Number(c[2]) : NaN;
    return isFinite(z) ? [x, y, z] : [x, y];
  }
  function cleanPart(coords, closeRing) {
    const out = [];
    (coords || []).forEach((c) => { const p = cleanXY(c); if (p && !sameXY(p, out[out.length - 1])) out.push(p); });
    if (closeRing && out.length > 1 && sameXY(out[0], out[out.length - 1])) out.pop();
    if (out.length < (closeRing ? 3 : 2)) return null;
    if (closeRing) out.push(out[0].slice());
    return out;
  }
  function signedArea(ring) {
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    return area / 2;
  }
  function orientRing(ring, exterior) {
    const clockwise = signedArea(ring) < 0;
    if ((exterior && !clockwise) || (!exterior && clockwise)) {
      const open = ring.slice(0, -1).reverse(); open.push(open[0].slice()); return open;
    }
    return ring;
  }
  function normalizeGeometry(g) {
    if (!g || !g.type) return null;
    if (g.type === 'Point') { const p = cleanXY(g.coordinates); return p ? { type: 'Point', family: 'point', parts: [[p]], geojson: { type: 'Point', coordinates: p } } : null; }
    if (g.type === 'LineString' || g.type === 'MultiLineString') {
      const raw = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      const parts = (raw || []).map((p) => cleanPart(p, false)).filter(Boolean);
      if (!parts.length) return null;
      return { type: g.type, family: 'line', parts, geojson: parts.length === 1 ? { type: 'LineString', coordinates: parts[0] } : { type: 'MultiLineString', coordinates: parts } };
    }
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      const parts = [];
      (polygons || []).forEach((poly) => (poly || []).forEach((ring, i) => { const clean = cleanPart(ring, true); if (clean) parts.push(orientRing(clean, i === 0)); }));
      if (!parts.length) return null;
      return { type: g.type, family: 'polygon', parts, geojson: { type: 'Polygon', coordinates: parts } };
    }
    return null;
  }
  function buildExportRows(records) {
    const groups = new Map(), usedNames = new Set(), rows = [], skipped = [];
    (records || []).forEach((rec) => {
      const normalized = normalizeGeometry(geometryOf(rec));
      if (!normalized) { skipped.push({ source_id: rec.id, asset_type: rec.layerName || rec.formName || '', reason: 'Invalid or unsupported geometry' }); return; }
      const assetType = rec.layerName || rec.formName || 'FEATURES';
      const key = `${assetType}\u0000${normalized.family}`;
      if (!groups.has(key)) {
        const base = safeFeatureClass(assetType), familySuffix = normalized.family === 'point' ? 'PT' : normalized.family === 'line' ? 'LN' : 'PG';
        let name = base, n = 2;
        while (usedNames.has(name.toUpperCase())) { name = `${base.slice(0, 36)}_${familySuffix}${n++}`; }
        usedNames.add(name.toUpperCase());
        groups.set(key, { key, name, assetType, family: normalized.family, rows: [], nextFid: 0 });
      }
      const group = groups.get(key), fid = group.nextFid++;
      const row = { rec, normalized, group, fid, objectId: fid + 1 };
      group.rows.push(row); rows.push(row);
    });
    return { rows, groups: [...groups.values()], skipped };
  }
  function mediaFileName(row, m, i) {
    const kind = String(m.kind || m.type || 'MEDIA').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    return `${row.group.name}_OID_${String(row.objectId).padStart(6, '0')}_${kind}_${String(i + 1).padStart(2, '0')}.${safeFilePart(mediaExt(m))}`;
  }
  function mediaPaths(row, base, separator) {
    base = base == null ? 'media' : String(base).replace(/[\\/]+$/, '');
    separator = separator || '/';
    const out = { photo: [], video: [], all: [] };
    (row.rec.media || []).forEach((m, i) => {
      const path = [base, row.group.name, mediaFileName(row, m, i)].filter(Boolean).join(separator);
      out.all.push(path);
      if (m.type === 'photo') out.photo.push(path);
      else if (m.type === 'video') out.video.push(path);
    });
    return out;
  }

  function propsOf(row, options) {
    options = options || {};
    const rec = row.rec, mp = mediaPaths(row, options.mediaBase || 'media', options.separator || '/');
    const zValue = rec.location && rec.location.z != null ? rec.location.z : (rec.data || {}).Z_Elevation ?? (rec.data || {}).Z_ELEVATION ?? (rec.data || {}).z_elevation;
    const out = {
      OBJECTID: row.objectId,
      ASSET_TYPE: row.group.assetType,
      STATUS: rec.status || '', SURVEYOR: rec.surveyor || '', ROLE: rec.role || '',
      Z_ELEVATION: zValue == null || zValue === '' ? '' : Number(zValue),
      CREATED_AT: rec.createdAt || '', UPDATED_AT: rec.updatedAt || '',
      GPS_ACCURACY_M: rec.location && rec.location.accuracy != null ? Math.round(Number(rec.location.accuracy) * 100) / 100 : '',
      PHOTO_COUNT: (rec.media || []).filter((m) => m.type === 'photo').length,
      VIDEO_COUNT: (rec.media || []).filter((m) => m.type === 'video').length,
      PHOTO_URL: mp.photo[0] || '', VIDEO_URL: mp.video[0] || '',
    };
    Object.entries(rec.data || {}).forEach(([k, v]) => { if (!(String(k).toUpperCase() in out)) out[k] = v; });
    return out;
  }

  /* ---------- GeoJSON ---------- */
  function toGeoJSON(records) {
    const context = buildExportRows(records);
    return {
      type: 'FeatureCollection',
      features: context.rows.map((row) => ({ type: 'Feature', geometry: row.normalized.geojson, properties: propsOf(row) })),
    };
  }

  /* ---------- CSV (attribute table) ---------- */
  function toCSV(records) {
    const context = buildExportRows(records), cols = new Set(['OBJECTID', 'ASSET_TYPE', 'STATUS', 'SURVEYOR', 'ROLE', 'CREATED_AT', 'UPDATED_AT', 'GEOMETRY_TYPE', 'LONGITUDE', 'LATITUDE', 'Z_ELEVATION', 'GPS_ACCURACY_M', 'PHOTO_COUNT', 'VIDEO_COUNT', 'PHOTO_URL', 'VIDEO_URL']);
    context.rows.forEach((row) => Object.keys(row.rec.data || {}).forEach((k) => cols.add(k)));
    const arr = [...cols];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [arr.join(',')];
    context.rows.forEach((row) => {
      const r = row.rec, g = row.normalized.geojson;
      let lng = '', lat = '', gtype = '';
      if (g) {
        gtype = g.type;
        if (g.type === 'Point') { [lng, lat] = g.coordinates; }
        else if (g.type === 'LineString' && g.coordinates[0]) { [lng, lat] = g.coordinates[0]; }
        else if (g.type === 'Polygon' && g.coordinates[0] && g.coordinates[0][0]) { [lng, lat] = g.coordinates[0][0]; }
      }
      const base = propsOf(row);
      Object.assign(base, { GEOMETRY_TYPE: gtype, LONGITUDE: lng, LATITUDE: lat });
      lines.push(arr.map((c) => q(base[c] !== undefined ? base[c] : (r.data || {})[c])).join(','));
    });
    return lines.join('\n');
  }

  /* ---------- KML ---------- */
  function toKML(records, projectName) {
    const context = buildExportRows(records);
    const placemarks = context.rows.map((row) => {
      const r = row.rec, g = row.normalized.geojson;
      const p = propsOf(row);
      const kmp = mediaPaths(row);
      const imgs = kmp.photo.map((u) => `&lt;img src="${esc(u)}" width="320"/&gt;`).join('');
      const desc = Object.entries(p).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('<br/>') + (imgs ? '<br/>' + imgs : '');
      let geomKml = '';
      const alt = (c) => (c.length > 2 && isFinite(c[2]) ? c[2] : 0);
      if (g.type === 'Point') {
        geomKml = `<Point><coordinates>${g.coordinates[0]},${g.coordinates[1]},${alt(g.coordinates)}</coordinates></Point>`;
      } else if (g.type === 'LineString') {
        geomKml = `<LineString><coordinates>${g.coordinates.map((c) => `${c[0]},${c[1]},${alt(c)}`).join(' ')}</coordinates></LineString>`;
      } else if (g.type === 'Polygon') {
        geomKml = `<Polygon><outerBoundaryIs><LinearRing><coordinates>${g.coordinates[0].map((c) => `${c[0]},${c[1]},${alt(c)}`).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
      }
      const name = (r.data && (r.data.asset_id || r.data.line_id || r.data.name || r.data.work_order)) || `${row.group.name} ${row.objectId}`;
      return `<Placemark><name>${esc(name)}</name><description><![CDATA[${desc}]]></description>${geomKml}</Placemark>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(projectName)}</name>
${placemarks}
</Document></kml>`;
  }

  /* ---------- ArcMap-safe Shapefile writer ---------------------------------------
     Writes the binary geometry and dBASE table directly. This avoids the malformed
     polyline records produced by the former browser library and keeps row order,
     OBJECTID-derived media names and attachment relationships deterministic.             */
  function concatBytes(chunks) {
    const size = chunks.reduce((n, c) => n + c.byteLength, 0), out = new Uint8Array(size);
    let offset = 0; chunks.forEach((c) => { out.set(c, offset); offset += c.byteLength; });
    return out;
  }
  function bboxOfParts(parts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    (parts || []).forEach((part) => part.forEach((p) => {
      minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
    }));
    return isFinite(minX) ? [minX, minY, maxX, maxY] : [0, 0, 0, 0];
  }
  function shapeHeader(shapeType, byteLength, bbox) {
    const out = new Uint8Array(100), dv = new DataView(out.buffer);
    dv.setInt32(0, 9994, false); dv.setInt32(24, byteLength / 2, false);
    dv.setInt32(28, 1000, true); dv.setInt32(32, shapeType, true);
    for (let i = 0; i < 4; i++) dv.setFloat64(36 + i * 8, bbox[i], true);
    return out;
  }
  function shapeContent(row) {
    const family = row.normalized.family, parts = row.normalized.parts;
    if (family === 'point') {
      const out = new Uint8Array(20), dv = new DataView(out.buffer), p = parts[0][0];
      dv.setInt32(0, 1, true); dv.setFloat64(4, p[0], true); dv.setFloat64(12, p[1], true);
      return out;
    }
    const shapeType = family === 'line' ? 3 : 5;
    const points = parts.reduce((all, part) => all.concat(part), []);
    const out = new Uint8Array(44 + 4 * parts.length + 16 * points.length), dv = new DataView(out.buffer);
    const box = bboxOfParts(parts);
    dv.setInt32(0, shapeType, true);
    for (let i = 0; i < 4; i++) dv.setFloat64(4 + i * 8, box[i], true);
    dv.setInt32(36, parts.length, true); dv.setInt32(40, points.length, true);
    let pointOffset = 0;
    parts.forEach((part, i) => { dv.setInt32(44 + i * 4, pointOffset, true); pointOffset += part.length; });
    let offset = 44 + 4 * parts.length;
    points.forEach((p) => { dv.setFloat64(offset, p[0], true); dv.setFloat64(offset + 8, p[1], true); offset += 16; });
    return out;
  }
  function buildShapeSet(rows) {
    if (!rows.length) throw new Error('Cannot create an empty shapefile');
    const shapeType = rows[0].normalized.family === 'point' ? 1 : rows[0].normalized.family === 'line' ? 3 : 5;
    const contents = rows.map(shapeContent), parts = rows.flatMap((r) => r.normalized.parts), bbox = bboxOfParts(parts);
    let shpOffset = 100;
    const shpRecords = [], shxRecords = [];
    contents.forEach((content, i) => {
      const rh = new Uint8Array(8), rdv = new DataView(rh.buffer);
      rdv.setInt32(0, i + 1, false); rdv.setInt32(4, content.byteLength / 2, false);
      shpRecords.push(rh, content);
      const ix = new Uint8Array(8), idv = new DataView(ix.buffer);
      idv.setInt32(0, shpOffset / 2, false); idv.setInt32(4, content.byteLength / 2, false);
      shxRecords.push(ix); shpOffset += 8 + content.byteLength;
    });
    return {
      shp: concatBytes([shapeHeader(shapeType, shpOffset, bbox), ...shpRecords]),
      shx: concatBytes([shapeHeader(shapeType, 100 + rows.length * 8, bbox), ...shxRecords]),
      shapeType, bbox,
    };
  }

  const DBF_BASE_FIELDS = [
    { source: 'OBJECTID', name: 'OBJECTID', type: 'N', length: 10, decimals: 0 },
    { source: 'ASSET_TYPE', name: 'ASSET_TYPE', type: 'C', length: 60 },
    { source: 'STATUS', name: 'STATUS', type: 'C', length: 20 },
    { source: 'SURVEYOR', name: 'SURVEYOR', type: 'C', length: 60 },
    { source: 'ROLE', name: 'ROLE', type: 'C', length: 40 },
    { source: 'Z_ELEVATION', name: 'Z_ELEV', type: 'N', length: 18, decimals: 3 },
    { source: 'CREATED_AT', name: 'CREATED_AT', type: 'C', length: 30 },
    { source: 'UPDATED_AT', name: 'UPDATED_AT', type: 'C', length: 30 },
    { source: 'GPS_ACCURACY_M', name: 'GPS_ACC_M', type: 'N', length: 12, decimals: 2 },
    { source: 'PHOTO_COUNT', name: 'PHOTO_CNT', type: 'N', length: 6, decimals: 0 },
    { source: 'VIDEO_COUNT', name: 'VIDEO_CNT', type: 'N', length: 6, decimals: 0 },
    { source: 'PHOTO_URL', name: 'PHOTO_URL', type: 'C', length: 254 },
    { source: 'VIDEO_URL', name: 'VIDEO_URL', type: 'C', length: 254 },
  ];
  function dbfName(value, used) {
    const root = String(value || 'FIELD').toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+/, '').slice(0, 10) || 'FIELD';
    let name = /^[A-Z]/.test(root) ? root : 'F_' + root.slice(0, 8), n = 2;
    while (used.has(name)) { const tail = String(n++); name = root.slice(0, 10 - tail.length) + tail; }
    used.add(name); return name;
  }
  function dbfFields(rows) {
    const used = new Set(DBF_BASE_FIELDS.map((f) => f.name)), fields = DBF_BASE_FIELDS.map((f) => ({ ...f }));
    const custom = new Map();
    rows.forEach((row) => Object.entries(row.rec.data || {}).forEach(([key, value]) => {
      if (DBF_BASE_FIELDS.some((f) => f.source === key.toUpperCase())) return;
      if (!custom.has(key)) custom.set(key, { numeric: true, max: 1 });
      const info = custom.get(key);
      if (value != null && value !== '') {
        info.numeric = info.numeric && typeof value === 'number' && isFinite(value);
        info.max = Math.max(info.max, String(value).length);
      }
    }));
    for (const [source, info] of custom) {
      if (fields.reduce((n, f) => n + f.length, 1) > 3600) break;
      fields.push(info.numeric
        ? { source, name: dbfName(source, used), type: 'N', length: 18, decimals: 4 }
        : { source, name: dbfName(source, used), type: 'C', length: Math.min(254, Math.max(12, info.max)) });
    }
    return fields;
  }
  function bytesFitted(value, length) {
    const enc = new TextEncoder(); let text = String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' '), bytes = enc.encode(text);
    while (bytes.length > length && text.length) { text = text.slice(0, -1); bytes = enc.encode(text); }
    const out = new Uint8Array(length); out.fill(32); out.set(bytes, 0); return out;
  }
  function buildDbf(rows) {
    const fields = dbfFields(rows), headerLength = 32 + fields.length * 32 + 1;
    const recordLength = 1 + fields.reduce((n, f) => n + f.length, 0);
    const out = new Uint8Array(headerLength + recordLength * rows.length + 1); out.fill(0);
    const dv = new DataView(out.buffer), now = new Date();
    out[0] = 0x03; out[1] = now.getFullYear() - 1900; out[2] = now.getMonth() + 1; out[3] = now.getDate();
    dv.setUint32(4, rows.length, true); dv.setUint16(8, headerLength, true); dv.setUint16(10, recordLength, true); out[29] = 0x57;
    fields.forEach((field, i) => {
      const pos = 32 + i * 32, name = new TextEncoder().encode(field.name.slice(0, 10));
      out.set(name, pos); out[pos + 11] = field.type.charCodeAt(0); out[pos + 16] = field.length; out[pos + 17] = field.decimals || 0;
    });
    out[headerLength - 1] = 0x0d;
    rows.forEach((row, ri) => {
      const props = propsOf(row, { mediaBase: '.\\media', separator: '\\' });
      let pos = headerLength + ri * recordLength; out[pos++] = 0x20;
      fields.forEach((field) => {
        let value = props[field.source] !== undefined ? props[field.source] : (row.rec.data || {})[field.source];
        if (field.type === 'N') {
          value = value === '' || value == null || !isFinite(Number(value)) ? '' : Number(value).toFixed(field.decimals || 0);
          out.set(bytesFitted(String(value).padStart(field.length, ' '), field.length), pos);
        } else out.set(bytesFitted(value, field.length), pos);
        pos += field.length;
      });
    });
    out[out.length - 1] = 0x1a;
    return { bytes: out, fields };
  }

  function attachmentRows(context) {
    const out = []; let attachmentId = 1;
    context.rows.forEach((row) => (row.rec.media || []).forEach((m, i) => {
      out.push({
        ATTACHMENTID: attachmentId++, REL_OBJECTID: row.objectId,
        FEATURE_CLASS: row.group.name, ASSET_TYPE: row.group.assetType,
        ATT_NAME: mediaFileName(row, m, i), CONTENT_TYPE: m.mime || (m.type === 'photo' ? 'image/jpeg' : m.type === 'video' ? 'video/webm' : 'application/octet-stream'),
        DATA_SIZE: m.size || '', MEDIA_URL: mediaPaths(row).all[i], CAPTURED_AT: m.capturedAt || '',
        LATITUDE: m.lat == null ? '' : m.lat, LONGITUDE: m.lng == null ? '' : m.lng,
      });
    }));
    return out;
  }
  function objectsToCSV(rows) {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]), q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    return [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\r\n');
  }
  async function addMediaFiles(zip, recordsOrContext, folderName) {
    const context = recordsOrContext && recordsOrContext.rows ? recordsOrContext : buildExportRows(recordsOrContext);
    const root = String(folderName || 'media').replace(/[\\/]+$/, ''), manifest = [];
    for (const row of context.rows) {
      const media = row.rec.media || [];
      for (let i = 0; i < media.length; i++) {
        const m = media[i], file = `${root}/${row.group.name}/${mediaFileName(row, m, i)}`;
        let saved = false;
        if (m.dataUrl && m.dataUrl.includes(',')) { zip.file(file, m.dataUrl.split(',')[1], { base64: true }); saved = true; }
        else if (typeof Media !== 'undefined' && m.id) {
          const blob = await Media.blob(m.id); if (blob) { zip.file(file, blob); saved = true; }
        }
        if (saved) {
          manifest.push({
            ATTACHMENTID: manifest.length + 1, REL_OBJECTID: row.objectId,
            FEATURE_CLASS: row.group.name, ASSET_TYPE: row.group.assetType,
            ATT_NAME: mediaFileName(row, m, i), CONTENT_TYPE: m.mime || '', DATA_SIZE: m.size || '',
            MEDIA_URL: `${root}/${row.group.name}/${mediaFileName(row, m, i)}`, CAPTURED_AT: m.capturedAt || '',
            LATITUDE: m.lat == null ? '' : m.lat, LONGITUDE: m.lng == null ? '' : m.lng,
          });
        }
      }
    }
    zip.file(`${root}/manifest.json`, JSON.stringify(manifest, null, 2));
    zip.file(`${root}/attachments.csv`, objectsToCSV(manifest));
    return manifest;
  }
  function arcMapSetupScript() {
    return `# Run with ArcMap's Python window or Python 2.7 environment.\n# Sets the map's hyperlink base to this extracted folder.\nimport arcpy, os\nmxd = arcpy.mapping.MapDocument('CURRENT')\nroot = os.path.dirname(os.path.abspath(__file__))\nmxd.hyperlinkBase = root\nmxd.relativePaths = True\nmxd.save()\narcpy.AddMessage('Hyperlink Base set to: ' + root)\nprint('Hyperlink Base set to: ' + root)\n`;
  }
  async function toShapefileZip(records, projectName) {
    const context = buildExportRows(records);
    if (!context.rows.length) { const e = new Error('No valid point, line or polygon geometry to export'); e.code = 'nogeom'; throw e; }
    const zip = new JSZip(), classes = [];
    for (const group of context.groups) {
      const set = buildShapeSet(group.rows), dbf = buildDbf(group.rows), base = group.name;
      zip.file(base + '.shp', set.shp); zip.file(base + '.shx', set.shx); zip.file(base + '.dbf', dbf.bytes);
      zip.file(base + '.prj', WGS84_WKT); zip.file(base + '.cpg', 'UTF-8'); zip.file(base + '.qml', qgisStyleXml());
      zip.file(base + '_FIELDS.csv', objectsToCSV(dbf.fields.map((f) => ({ FIELD_NAME: f.name, SOURCE_FIELD: f.source, TYPE: f.type, LENGTH: f.length, DECIMALS: f.decimals || 0 }))));
      classes.push({ FEATURE_CLASS: base, ASSET_TYPE: group.assetType, GEOMETRY_TYPE: group.family, FEATURE_COUNT: group.rows.length, FIRST_OID: 1, LAST_OID: group.rows.length });
    }
    const manifest = await addMediaFiles(zip, context, 'media');
    zip.file('FEATURE_CLASSES.csv', objectsToCSV(classes));
    zip.file('ATTACHMENTS.csv', objectsToCSV(manifest));
    if (context.skipped.length) zip.file('SKIPPED_FEATURES.csv', objectsToCSV(context.skipped));
    zip.file('SET_ARCMAP_HYPERLINK_BASE.py', arcMapSetupScript());
    zip.file('README_ARCMAP.txt',
`ARCMAP-READY SHAPEFILE EXPORT — ${projectName}\n\nFEATURE CLASSES\nEach Asset Type is exported as its own feature class. Points, polylines and polygons are never mixed.\nArcMap creates its own internal FID automatically from DBF row order. OBJECTID is the stable one-based feature identifier used throughout this export.\nThe old application record_id is intentionally not used as a GIS identifier.\n\nMEDIA / ATTACHMENTS\nMedia names use the owning feature row, for example:\n  Water_Line_OID_000001_SITE_PHOTO_01.jpg\nATTACHMENTS.csv relates every file through REL_OBJECTID. Keep the media folder beside the shapefiles.\n\nENABLE CLICKABLE PHOTOS IN ARCMAP\n1. Extract this entire ZIP; do not open the shapefile inside the ZIP.\n2. Add the .shp to ArcMap.\n3. Open Layer Properties > Display (not HTML Popup).\n4. Check Support Hyperlinks using field; select PHOTO_URL; choose Document; click OK.\n5. Run SET_ARCMAP_HYPERLINK_BASE.py from ArcMap's Python window, or set File > Map Document Properties > Hyperlink Base to this extracted folder.\n6. Use the Hyperlink lightning-bolt tool and click a feature.\n\nThe HTML Popup tab shown in ArcMap is a different feature and does not enable field hyperlinks.\n\nVALIDATION\nGeometry records use the ESRI Shapefile binary specification, WGS 1984 (EPSG:4326), matched SHP/SHX offsets, closed polygon rings and ArcMap-safe DBF field widths.`);
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  /* ---------- PDF report (print window) ---------- */
  async function openPDFReport(records, project) {
    const win = window.open('', '_blank');
    if (!win) return false;
    const parts = [];
    for (const r of records) {
      const g = geometryOf(r);
      let loc = '';
      if (g && g.type === 'Point') loc = `${g.coordinates[1].toFixed(6)}, ${g.coordinates[0].toFixed(6)}`;
      else if (g) loc = `${g.type} (${g.coordinates.flat(2).length / 2} vertices)`;
      const photos = (r.media || []).filter((m) => m.type === 'photo').slice(0, 4);
      const photoUrls = [];
      for (const p of photos) {
        const u = (typeof Media !== 'undefined') ? await Media.dataUrlOf(p) : p.dataUrl;
        if (u) photoUrls.push(u);
      }
      parts.push(`
      <div class="rec">
        <div class="rh">${esc(r.layerName || r.formName || 'Record')} — ${esc((r.data && (r.data.asset_id || r.data.line_id || r.data.name)) || r.id)}</div>
        <div class="rm">Status: ${esc(r.status)} · Surveyor: ${esc(r.surveyor || '—')} · ${esc(fmtDate(r.updatedAt))}</div>
        <table>${Object.entries(r.data || {}).map(([k, v]) => `<tr><td class="k">${esc(k.replace(/_/g, ' '))}</td><td>${esc(v)}</td></tr>`).join('')}
          ${loc ? `<tr><td class="k">location</td><td>${esc(loc)}${r.location && r.location.accuracy != null ? ` (±${Math.round(r.location.accuracy)}m)` : ''}</td></tr>` : ''}
          ${r.location && r.location.z != null ? `<tr><td class="k">Z_Elevation</td><td>${(+r.location.z).toFixed(2)} m</td></tr>` : ''}</table>
        ${photoUrls.length ? `<div class="ph">${photoUrls.map((u) => `<img src="${u}" />`).join('')}</div>` : ''}
      </div>`);
    }
    const rows = parts.join('');
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(project.name)} — Field Report</title>
      <style>
        body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:28px;color:#141A1F;}
        h1{font-size:22px;margin:0 0 4px;} .sub{color:#55636D;font-size:12px;margin-bottom:22px;}
        .rec{border:1px solid #D5DBD9;border-radius:8px;padding:14px;margin-bottom:16px;page-break-inside:avoid;}
        .rh{font-weight:700;font-size:14px;} .rm{font-size:11px;color:#666;margin:3px 0 8px;}
        table{width:100%;border-collapse:collapse;font-size:12px;} td{padding:4px 3px;border-bottom:1px solid #eee;} td.k{color:#888;width:40%;text-transform:capitalize;}
        .ph{display:flex;gap:6px;margin-top:8px;} .ph img{width:90px;height:90px;object-fit:cover;border-radius:5px;}
      </style></head><body>
      <h1>${esc(project.name)}</h1>
      <div class="sub">Field data report · ${records.length} records · Generated ${esc(fmtDate(nowISO()))}</div>
      ${rows}
      <script>window.onload=function(){setTimeout(function(){window.print();},400);};<\/script>
      </body></html>`);
    win.document.close();
    return true;
  }

  /* ---------- Excel via SheetJS ---------- */
  function buildWorkbook(records) {
    if (typeof XLSX === 'undefined') return null;
    const context = buildExportRows(records);
    const cols = new Set(['OBJECTID', 'ASSET_TYPE', 'STATUS', 'SURVEYOR', 'ROLE', 'CREATED_AT', 'UPDATED_AT', 'GEOMETRY_TYPE', 'LONGITUDE', 'LATITUDE', 'Z_ELEVATION', 'GPS_ACCURACY_M', 'PHOTO_COUNT', 'VIDEO_COUNT', 'PHOTO_URL', 'VIDEO_URL']);
    context.rows.forEach((row) => Object.keys(row.rec.data || {}).forEach((k) => { if (![...cols].some((c) => c === k.toUpperCase())) cols.add(k); }));
    const arr = [...cols];
    const aoa = [arr];
    context.rows.forEach((row) => {
      const r = row.rec, g = row.normalized.geojson;
      let lng = '', lat = '', gtype = '';
      if (g) {
        gtype = g.type;
        const c = g.type === 'Point' ? g.coordinates : g.type === 'LineString' ? g.coordinates[0] : g.type === 'MultiLineString' ? g.coordinates[0][0] : g.coordinates[0][0];
        if (c) { lng = c[0]; lat = c[1]; }
      }
      const base = propsOf(row);
      Object.assign(base, { GEOMETRY_TYPE: gtype, LONGITUDE: lng, LATITUDE: lat });
      aoa.push(arr.map((c) => base[c] !== undefined ? base[c] : (r.data || {})[c] ?? ''));
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Store both an OOXML hyperlink relationship and a HYPERLINK formula. The dual form
    // survives Excel desktop, Excel web and LibreOffice more reliably than plain URL text.
    const linkCols = ['PHOTO_URL', 'VIDEO_URL'].map((c) => arr.indexOf(c)).filter((i) => i >= 0);
    linkCols.forEach((ci) => {
      for (let ri = 1; ri < aoa.length; ri++) {
        const v = aoa[ri][ci];
        if (!v) continue;
        const addr = XLSX.utils.encode_cell({ c: ci, r: ri });
        if (!ws[addr]) continue;
        ws[addr].l = { Target: v, Tooltip: 'Open ' + v };
        const fv = String(v).replace(/"/g, '""');
        ws[addr].f = `HYPERLINK("${fv}","Open media")`;
        ws[addr].v = 'Open media';
        ws[addr].t = 's';
        ws[addr].s = { font: { color: { rgb: '0563C1' }, underline: true } };
      }
    });
    ws['!autofilter'] = { ref: ws['!ref'] };
    ws['!cols'] = arr.map((name) => ({ wch: ['PHOTO_URL', 'VIDEO_URL', 'MEDIA_ALL'].includes(name) ? 22 : Math.max(12, Math.min(28, name.length + 3)) }));
    arr.forEach((_, ci) => { const cell = ws[XLSX.utils.encode_cell({ c: ci, r: 0 })]; if (cell) cell.s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1F4E78' } } }; });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Features');
    const attachments = attachmentRows(context), aws = XLSX.utils.json_to_sheet(attachments.length ? attachments : [{ ATTACHMENTID: '', REL_OBJECTID: '', FEATURE_CLASS: '', ATT_NAME: '', MEDIA_URL: '' }]);
    const attachmentHeaders = attachments.length ? Object.keys(attachments[0]) : ['ATTACHMENTID', 'REL_OBJECTID', 'FEATURE_CLASS', 'ATT_NAME', 'MEDIA_URL'];
    const urlCol = attachmentHeaders.indexOf('MEDIA_URL');
    if (urlCol >= 0 && attachments.length) attachments.forEach((item, ri) => {
      const addr = XLSX.utils.encode_cell({ c: urlCol, r: ri + 1 }), cell = aws[addr]; if (!cell || !item.MEDIA_URL) return;
      cell.l = { Target: item.MEDIA_URL, Tooltip: 'Open ' + item.ATT_NAME };
      cell.f = `HYPERLINK("${String(item.MEDIA_URL).replace(/"/g, '""')}","Open media")`; cell.v = 'Open media'; cell.t = 's';
      cell.s = { font: { color: { rgb: '0563C1' }, underline: true } };
    });
    aws['!autofilter'] = { ref: aws['!ref'] }; aws['!cols'] = attachmentHeaders.map((h) => ({ wch: ['ATT_NAME', 'MEDIA_URL'].includes(h) ? 28 : Math.max(12, h.length + 2) }));
    attachmentHeaders.forEach((_, ci) => { const cell = aws[XLSX.utils.encode_cell({ c: ci, r: 0 })]; if (cell) cell.s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1F4E78' } } }; });
    XLSX.utils.book_append_sheet(wb, aws, 'Attachments');
    return wb;
  }
  async function downloadExcel(records, projectName) {
    const wb = buildWorkbook(records);
    if (!wb) throw new Error('Excel export engine is not loaded');
    const safe = safeFilePart(projectName);
    const bytes = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
    const mediaCount = records.reduce((n, r) => n + (r.media || []).length, 0);
    if (!mediaCount) {
      downloadBlob(`${safe}_attributes.xlsx`, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return { bundled: false, filename: `${safe}_attributes.xlsx` };
    }
    const zip = new JSZip();
    zip.file('attributes.xlsx', bytes);
    const manifest = await addMediaFiles(zip, buildExportRows(records), 'media');
    zip.file('README.txt',
`EXCEL MEDIA BUNDLE

1. Extract this entire ZIP.
2. Keep attributes.xlsx and the media folder together.
3. Open attributes.xlsx. Use Features for GIS rows and Attachments for one media file per row.
4. Click a blue Open media cell. REL_OBJECTID identifies its owning feature.
5. In Excel Protected View, choose Enable Editing before clicking links.

This bundle contains ${manifest.length} media file(s). Relative links are portable and work offline.`);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    downloadBlob(`${safe}_Excel_Media.zip`, blob, 'application/zip');
    return { bundled: true, filename: `${safe}_Excel_Media.zip` };
  }

  /* QGIS reads a .qml sitting next to the layer file, so PHOTO_URL and VIDEO_URL
     open their external resources with no manual field-widget setup. */
  function qgisStyleXml() {
    const w = (f, doc) => `<field name="${f}"><editWidget type="ExternalResource"><config><Option type="Map">` +
      `<Option name="RelativeStorage" type="int" value="1"/>` +
      `<Option name="DocumentViewer" type="int" value="${doc}"/>` +
      `<Option name="DocumentViewerHeight" type="int" value="0"/>` +
      `<Option name="DocumentViewerWidth" type="int" value="0"/>` +
      `<Option name="FileWidget" type="bool" value="true"/>` +
      `<Option name="FileWidgetButton" type="bool" value="true"/>` +
      `<Option name="StorageMode" type="int" value="0"/>` +
      `</Option></config></editWidget></field>`;
    return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.28" styleCategories="Fields|Forms">
  <fieldConfiguration>
    ${w('PHOTO_URL', 1)}
    ${w('VIDEO_URL', 0)}
  </fieldConfiguration>
  <editable/>
</qgis>`;
  }

  const WGS84_WKT = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

  function buildGalleryHtml(records, project) {
    const context = buildExportRows(records);
    const rows = context.rows.map((row) => {
      const r = row.rec, mp = mediaPaths(row);
      if (!mp.all.length) return '';
      const g = row.normalized.geojson;
      const coord = g && g.type === 'Point' ? `${g.coordinates[1].toFixed(6)}, ${g.coordinates[0].toFixed(6)}` : (g ? g.type : '—');
      const media = (r.media || []).map((m, i) => {
        const u = `data/media/${row.group.name}/${mediaFileName(row, m, i)}`;
        if (m.type === 'photo') return `<a href="${u}" target="_blank"><img src="${u}" loading="lazy" alt="photo"/></a>`;
        if (m.type === 'video') return `<video src="${u}" controls preload="metadata"></video>`;
        return `<a class="doc" href="${u}" target="_blank">${esc(m.name || 'file')}</a>`;
      }).join('');
      return `<section><h2>${esc(row.group.assetType)} · FID ${row.fid} · OBJECTID ${row.objectId}</h2>
<p>${esc(r.surveyor || '')} · ${esc(r.updatedAt || '')} · ${esc(coord)}</p><div class="m">${media}</div></section>`;
    }).filter(Boolean).join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(project.name)} — media gallery</title>
<style>body{font-family:system-ui,Segoe UI,Arial;margin:24px auto;max-width:980px;padding:0 16px;color:#1b2530}
h1{font-size:22px}h2{font-size:15px;margin:0 0 2px}section{border:1px solid #dde3ea;border-radius:10px;padding:12px 14px;margin:12px 0}
p{margin:2px 0 8px;color:#5c6b7a;font-size:12.5px}.m{display:flex;flex-wrap:wrap;gap:10px}
img,video{height:180px;border-radius:8px;border:1px solid #dde3ea;object-fit:cover}.doc{align-self:center}</style></head>
<body><h1>${esc(project.name)} — media gallery</h1>
<p>Open this file from inside the extracted package. Click a photo to open it full size.</p>
${rows || '<p>No media in this export.</p>'}</body></html>`;
  }

  /* ---------- Full ZIP package ---------- */
  async function buildZipPackage(records, project, routeGeoJSON) {
    const zip = new JSZip();
    const safe = project.name.replace(/\s+/g, '_');
    const context = buildExportRows(records);

    zip.file('data/attributes.csv', toCSV(records));
    try {
      const wb = buildWorkbook(records);
      if (wb) zip.file('data/attributes.xlsx', XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
    } catch (e) { console.warn('xlsx skipped in package:', e.message); }
    zip.file('data/features.qml', qgisStyleXml());   // QGIS picks this up beside features.geojson
    zip.file('data/features.geojson', JSON.stringify(toGeoJSON(records), null, 2));
    zip.file('data/features.kml', toKML(records, project.name));
    zip.file('data/project.json', JSON.stringify({ project, records, fieldRoute: routeGeoJSON || null, exportedAt: nowISO() }, null, 2));
    if (routeGeoJSON) zip.file('data/field_route.geojson', JSON.stringify(routeGeoJSON, null, 2));

    // Shapefile (may legitimately fail — never let it kill the whole package)
    try {
      const shp = await toShapefileZip(records, project.name);
      if (shp) {
        const shpBuf = (shp.arrayBuffer ? await shp.arrayBuffer() : shp);   // ArrayBuffer: accepted by every JSZip build
        zip.file('data/shapefile.zip', shpBuf);          // replaced below by the repaired set when unpack succeeds
        // Also unpack the set into data/shapefile/ so the .dbf sits beside ../media —
        // open the .shp from there and the media folder is one level up, exactly where
        // the README's ArcMap/QGIS hyperlink steps expect it.
        try {
          const inner = await JSZip.loadAsync(shpBuf);
          const names = Object.keys(inner.files).filter((n) => !inner.files[n].dir);
          for (const n of names) zip.file('data/shapefile/' + n, await inner.files[n].async('uint8array'));
        } catch (e2) { console.warn('shapefile unpack skipped:', e2.message); }
      }
    } catch (e) { console.warn('shapefile skipped in package:', e.message); }

    // Media sits beside attributes.xlsx/GeoJSON. File names and relationships are
    // derived from the owning feature OBJECTID, exactly as in the shapefile bundle.
    const mediaManifest = await addMediaFiles(zip, context, 'data/media');

    // Photo gallery — a plain HTML page at the package root: click any record, the photo
    // opens. Works offline in any browser, independent of GIS/Excel hyperlink quirks.
    zip.file('gallery.html', buildGalleryHtml(records, project));

    zip.file('README.txt',
`${project.name} — Smart Maidani export
Generated: ${nowISO()}
Records: ${records.length}

CONTENTS
  data/features.geojson  GeoJSON (points, lines, polygons) — primary GIS format
  data/features.kml      KML for Google Earth / viewers
  data/attributes.csv    Attribute table (flat, one row per record)
  data/shapefile.zip     ArcMap-ready Shapefiles (one feature class per Asset Type)
  data/project.json      Complete structured backup (re-importable)
  data/attributes.xlsx   Attribute table with CLICKABLE photo/video hyperlinks
  data/field_route.geojson  Automatically saved field route with time/distance summary
  data/media/            Geotagged photos/video named from feature OBJECTID
  data/media/attachments.csv  Esri-style media relation table (REL_OBJECTID)

MEDIA LINKS — how to make the photo open on click
  Every record carries relative links to its media:
    PHOTO_URL   first photo    e.g. media/Water_Line/Water_Line_OID_000001_SITE_PHOTO_01.jpg
    VIDEO_URL   first video
    MEDIA_ALL   all files, separated by ';'
  FIRST: extract this whole ZIP — links cannot resolve from inside an unextracted archive.
  Keep the folder structure as-is.

  Fastest (no GIS software): open  gallery.html  at the package root — every record's
  photos and videos, clickable, fully offline.

  EXCEL (data/attributes.xlsx)
    1. Extract the package, open data/attributes.xlsx from the extracted folder.
    2. If Excel shows PROTECTED VIEW, click "Enable Editing" — links are blocked until then.
    3. Click a blue PHOTO_URL or Attachments.MEDIA_URL cell — the file opens. (Links are relative: the xlsx must
       stay inside data/ next to the media folder. CSV is plain text and cannot hold
       clickable links — that is a limit of the CSV format itself, use the xlsx.)

  ARCMAP (data/shapefile/)
    ArcMap never opens files by clicking a table cell — hyperlinks must be enabled once:
    1. Add the .shp from data/shapefile/ to your map.
    2. Layer Properties > Display (NOT HTML Popup) > check "Support Hyperlinks using field"
       > choose PHOTO_URL > option "Document" > OK.
    3. Run SET_ARCMAP_HYPERLINK_BASE.py included with the shapefiles, or set Map Document
       Properties > Hyperlink Base to the extracted shapefile folder.
    4. Use the Hyperlink tool (lightning bolt on the Tools toolbar) and click the feature —
       the photo opens.
    ArcGIS Pro: same idea via popups — or simply use data/features.geojson.

   QGIS (data/features.geojson)
    Just add features.geojson — the bundled features.qml configures PHOTO_URL/VIDEO_URL
    automatically. Open a feature's form and click the file entry to view the photo.

COORDINATE SYSTEM
  WGS84 (EPSG:4326). Longitude, latitude in decimal degrees.

NOTES FOR GIS
  - OBJECTID is the stable one-based feature identifier across all formats.
  - Join media with REL_OBJECTID + FEATURE_CLASS.
  - Asset classification is exported in ASSET_TYPE and defines the feature-class name.
  - field_route.geojson includes the complete GPS track and route statistics.
  - CSV includes longitude/latitude for point features; use GeoJSON/Shapefile for lines and polygons.
`);

    return await zip.generateAsync({ type: 'blob' });
  }

  return { toGeoJSON, toCSV, toKML, toShapefileZip, openPDFReport, downloadExcel, buildZipPackage, geometryOf, mediaPaths, buildWorkbook, buildExportRows, normalizeGeometry, buildShapeSet, buildDbf, attachmentRows };
})();

/* ---------- shared download helper ---------- */
function downloadBlob(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
