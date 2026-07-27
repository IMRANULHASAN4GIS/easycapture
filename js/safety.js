/* Pure safety/QA helpers. Kept separate so they can be regression-tested in Node. */
(function (root) {
  function geometryIssues(geometry) {
    if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) return ['Missing geometry'];
    const out = [];
    const walk = (v) => {
      if (Array.isArray(v) && typeof v[0] === 'number') {
        if (!Number.isFinite(v[0]) || !Number.isFinite(v[1]) || v[0] < -180 || v[0] > 180 || v[1] < -90 || v[1] > 90) out.push('Coordinate outside WGS 84 range');
      } else if (Array.isArray(v)) v.forEach(walk);
    };
    walk(geometry.coordinates);
    if (geometry.type === 'LineString' && geometry.coordinates.length < 2) out.push('Line needs at least two vertices');
    if (geometry.type === 'Polygon') {
      const ring = geometry.coordinates[0] || [];
      if (ring.length < 4) out.push('Polygon needs at least three vertices');
      else if (JSON.stringify(ring[0]) !== JSON.stringify(ring[ring.length - 1])) out.push('Polygon ring is not closed');
    }
    return [...new Set(out)];
  }
  function audit(records, layers, options) {
    options = options || {};
    const poorAccuracy = Number(options.poorAccuracy || 15);
    const layerMap = new Map((layers || []).map((l) => [l.id, l]));
    const seen = new Set(), issues = [];
    const counts = { total: 0, complete: 0, incomplete: 0, invalidGeometry: 0, missingRequired: 0, domainViolations: 0, poorAccuracy: 0, missingMedia: 0, duplicateIds: 0 };
    (records || []).forEach((r) => {
      counts.total++;
      const row = { recordId: r.id || '', layer: r.layerName || '', issues: [] };
      if (seen.has(r.id)) { row.issues.push('Duplicate record ID'); counts.duplicateIds++; } else seen.add(r.id);
      const gi = geometryIssues(r.geometry);
      if (gi.length) { row.issues.push(...gi); counts.invalidGeometry++; }
      const layer = layerMap.get(r.layerId), data = r.data || {};
      const missing = (layer && layer.fields || []).filter((f) => f.required && (data[f.key] === '' || data[f.key] == null));
      if (missing.length) { row.issues.push(`Missing required: ${missing.map((f) => f.label || f.key).join(', ')}`); counts.missingRequired++; }
      const invalidDomains = (layer && layer.fields || []).filter((f) => {
        const domain = f.domain && options.domains && options.domains[f.domain];
        if (!domain || data[f.key] == null || data[f.key] === '') return false;
        return !(domain.values || []).some((v) => String(Array.isArray(v) ? v[0] : v) === String(data[f.key]));
      });
      if (invalidDomains.length) { row.issues.push(`Domain violation: ${invalidDomains.map((f) => f.label || f.key).join(', ')}`); counts.domainViolations++; }
      if (r.location && Number.isFinite(+r.location.accuracy) && +r.location.accuracy > poorAccuracy) { row.issues.push(`GPS accuracy ±${Math.round(+r.location.accuracy)} m`); counts.poorAccuracy++; }
      const missingMedia = (r.media || []).filter((m) => !m.dataUrl && options.mediaIds && !options.mediaIds.has(m.id));
      if (missingMedia.length) { row.issues.push(`${missingMedia.length} missing attachment(s)`); counts.missingMedia += missingMedia.length; }
      if (r.status === 'needs_attributes' || missing.length) counts.incomplete++; else counts.complete++;
      if (row.issues.length) issues.push(row);
    });
    return { generatedAt: new Date().toISOString(), counts, issues, passed: !issues.length };
  }
  function backupCounts(snapshot) {
    return { projects: (snapshot.projects || []).length, layers: (snapshot.layers || []).length, records: (snapshot.records || []).length, media: (snapshot.media || []).length, settings: (snapshot.settings || []).length };
  }
  const api = { geometryIssues, audit, backupCounts };
  root.EasyCaptureSafety = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
