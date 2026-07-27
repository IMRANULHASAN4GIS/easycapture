const assert = require('node:assert/strict');
const Safety = require('../js/safety.js');

assert.deepEqual(Safety.geometryIssues({ type: 'Point', coordinates: [55.2, 25.1] }), []);
assert.ok(Safety.geometryIssues({ type: 'Point', coordinates: [200, 25.1] }).length);
assert.ok(Safety.geometryIssues({ type: 'LineString', coordinates: [[55, 25]] }).length);
assert.ok(Safety.geometryIssues({ type: 'Polygon', coordinates: [[[55, 25], [56, 25], [56, 26], [55, 25]]] }).length === 0);

const report = Safety.audit([
  { id: 'a', layerId: 'l', layerName: 'Assets', status: 'needs_attributes', data: {}, geometry: { type: 'Point', coordinates: [55, 25] }, location: { accuracy: 30 }, media: [{ id: 'missing' }] },
], [{ id: 'l', fields: [{ key: 'name', label: 'Name', required: true }] }], { mediaIds: new Set(), poorAccuracy: 15 });
assert.equal(report.counts.total, 1);
assert.equal(report.counts.missingRequired, 1);
assert.equal(report.counts.poorAccuracy, 1);
assert.equal(report.counts.missingMedia, 1);
assert.equal(report.passed, false);

assert.deepEqual(Safety.backupCounts({ projects: [{}], layers: [], records: [{}, {}], media: [{}], settings: [] }), { projects: 1, layers: 0, records: 2, media: 1, settings: 0 });
console.log('EasyCapture safety tests passed');
