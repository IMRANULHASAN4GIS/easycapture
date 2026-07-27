/* ============================================================
   EasyCapture — field GIS data collection
   Feature-class model · user-defined layers & attributes
   Symbology · coordinate systems (proj4) · auto Z-elevation
   ============================================================ */
const App = {
  state: {
    user: null,                 // { name, role }
    projects: [], layers: [], records: [],
    project: null, activeLayer: null,
    map: null, basemaps: null, activeBasemap: 'satellite',
    layerGroups: {},            // layerId -> L.layerGroup
    gpsLayer: null, lastFix: null, watchId: null,
    draft: null, placing: null, draw: null,
    editGeom: null,             // { record, layer } when editing geometry on map
    selectedRecord: null,       // primary selection (editing requires one feature)
    selectedRecords: [],        // box selection may contain several features
    activeTool: 'select',       // pan | select | box | create | vertices | move | split
    editingSession: false,
    sessionUndo: [], sessionRedo: [],
    snapping: true,
    snapVertices: true,
    snapEdges: true,
    snapTolerance: 14,
    snapLayerIds: null,
    route: { points: [], distanceM: 0, paused: false },
  },

  async init() {
    this.state.user = await DB.get('user', 'profile');
    this.state.projects = await DB.all('projects');
    this.state.layers = await DB.all('layers');
    this.state.records = await DB.all('records');
    this.buildMap();
    this.wireChrome();
    this.wireNet();
    if (!this.state.user) { this.showWelcome(); return; }
    const lastId = localStorage.getItem('sm_project');
    const last = this.state.projects.find((p) => p.id === lastId);
    if (last) this.setProject(last); else this.rootNav(this.openProjectPicker);
  },

  /* ============================================================
     First-run welcome + registration
     ============================================================ */
  showWelcome() {
    const body = `
      <div style="text-align:center;padding:8px 4px 4px">
        <div class="brand-logo-lg">${LOGO(96)}</div>
        <h1 class="welcome-title">EasyCapture</h1>
        <p class="welcome-sub">Field GIS data collection — build your own layers, capture anywhere, export for GIS.</p>
      </div>
      <div class="field"><label class="lbl">Your name <span class="req">*</span></label><input class="inp" id="regName" placeholder="Enter Your Name" /></div>
      <div class="field"><label class="lbl">Your role <span class="req">*</span></label>
        <select class="sel" id="regRole">
          <option value="">Select role…</option>
          <option>Surveyor</option><option>Field Technician</option><option>GIS Specialist</option>
          <option>Engineer</option><option>Inspector</option><option>Team Lead</option><option>Other</option>
        </select></div>
      <div class="field" id="regOtherWrap" style="display:none"><label class="lbl">Specify role</label><input class="inp" id="regOther" placeholder="Your role" /></div>`;
    this.openSheet('Welcome', body, `<button class="btn btn-primary btn-block btn-lg" id="regSave">${icon('check', 17)} Get started</button>`, true);
    document.getElementById('regRole').onchange = (e) => { document.getElementById('regOtherWrap').style.display = e.target.value === 'Other' ? 'block' : 'none'; };
    document.getElementById('regSave').onclick = async () => {
      const name = document.getElementById('regName').value.trim();
      let role = document.getElementById('regRole').value;
      if (role === 'Other') role = document.getElementById('regOther').value.trim() || 'Other';
      if (!name) { this.toast('Enter your name', 'err'); return; }
      if (!role) { this.toast('Select your role', 'err'); return; }
      this.state.user = { key: 'profile', name, role, registeredAt: nowISO() };
      await DB.put('user', this.state.user);
      this.toast(`Welcome, ${name}`, 'ok');
      this.rootNav(this.openProjectPicker);
    };
    setTimeout(() => { const el = document.getElementById('regName'); if (el) el.focus(); }, 300);
  },

  /* ============================================================
     Map
     ============================================================ */
  buildMap() {
    if (typeof L === 'undefined') {
      document.getElementById('map').innerHTML = `<div class="map-msg"><div><div class="t">Map library is not available</div><div class="d">Connect once to initialize the application. Offline basemaps include only areas and zoom levels already cached on this device.</div></div></div>`;
      return;
    }
    const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([24.4539, 54.3773], 12);
    map.attributionControl.setPrefix(false);
    const esriSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri' });
    const esriLabels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 });
    const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenTopoMap' });
    this.state.basemaps = { satellite: L.layerGroup([esriSat, esriLabels]), streets: L.layerGroup([streets]), topographic: L.layerGroup([topo]) };
    this.state.activeBasemap = localStorage.getItem('sm_basemap') || 'satellite';
    if (!this.state.basemaps[this.state.activeBasemap]) this.state.activeBasemap = 'satellite';
    this.state.basemaps[this.state.activeBasemap].addTo(map);
    this.state.map = map;
    this.state.gpsLayer = L.layerGroup().addTo(map);
    map.on('click', (e) => this.onMapClick(e));
    map.on('mousedown', (e) => this.onBoxSelectStart(e));
    map.on('mousemove', (e) => this.onBoxSelectMove(e));
    map.on('mouseup', (e) => this.onBoxSelectEnd(e));
    map.on('dragstart', () => { if (this.state.follow) { this.state.follow = false; this.updateLocateBtn(); } });
    map.on('dblclick', () => {
      if (this.state.draw) {
        const c = this.state.draw.coords; if (c.length > 1) { const a = c[c.length - 1], b = c[c.length - 2]; if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 1e-8) c.pop(); }
        this.confirmDraw();
      } else if (this.state.editGeom && this.state.editGeom.mode !== 'point') this.confirmEditGeom();
    });
    this.locate(true);
  },

  wireChrome() {
    const $ = (id) => document.getElementById(id);
    $('zoomIn').onclick = () => this.state.map && this.state.map.zoomIn();
    $('zoomOut').onclick = () => this.state.map && this.state.map.zoomOut();
    $('menuBtn').onclick = () => this.rootNav(this.openMenu);
    $('layersBtn').onclick = (e) => { e.stopPropagation(); this.toggleLayersPanel(); };
    document.getElementById('lpManage').onclick = () => { document.getElementById('layersPanel').classList.remove('show'); this.rootNav(this.openLayers); };
    document.addEventListener('click', (e) => { const p = $('layersPanel'), btn = $('layersBtn'); if (p.classList.contains('show') && !p.contains(e.target) && !btn.contains(e.target)) p.classList.remove('show'); });
    $('locateBtn').onclick = () => this.locate(false);
    $('collectBtn').onclick = () => this.rootNav(this.startCollect);
    $('toolCreate').onclick = () => this.rootNav(this.startCollect);
    $('toolSelect').onclick = () => this.beginFeatureSelection();
    $('toolPan').onclick = () => this.setActiveTool('pan');
    $('toolBoxSelect').onclick = () => this.beginBoxSelection();
    $('toolModify').onclick = () => this.modifySelectedFeature();
    $('toolMove').onclick = () => this.moveSelectedFeature();
    $('toolSplit').onclick = () => this.beginSplitSelectedLine();
    $('toolDelete').onclick = () => this.deleteSelectedFeature();
    $('toolRotate').onclick = () => this.openRotateTool();
    $('toolReshape').onclick = () => this.beginReshapeFeature();
    $('toolCutPolygon').onclick = () => this.beginCutPolygon();
    $('toolMerge').onclick = () => this.mergeSelectedFeatures();
    $('toolAttributes').onclick = () => this.openSelectedAttributes();
    $('toolSketchProps').onclick = () => this.openSketchProperties();
    $('toolUndo').onclick = () => this.undoEdit();
    $('toolRedo').onclick = () => this.redoEdit();
    $('toolSaveEdits').onclick = () => this.saveEditSession();
    $('toolSnapping').onclick = () => { this.state.snapping = !this.state.snapping; this.updateEditToolbar(); this.toast(`Snapping ${this.state.snapping ? 'on' : 'off'}`, 'ok'); };
    $('editorMenuBtn').onclick = (e) => { e.stopPropagation(); $('editorMenu').classList.toggle('show'); };
    $('editorStart').onclick = () => this.startEditing();
    $('editorSnapSettings').onclick = () => this.openSnappingSettings();
    $('editorSave').onclick = () => this.saveEditSession();
    $('editorStop').onclick = () => this.stopEditing();
    document.addEventListener('click', (e) => { const p = $('editorMenu'), b = $('editorMenuBtn'); if (p.classList.contains('show') && !p.contains(e.target) && !b.contains(e.target)) p.classList.remove('show'); });
    $('navList').onclick = () => this.rootNav(this.openRecords);
    $('navExport').onclick = () => this.rootNav(this.openExport);
    $('basemapBtn').onclick = (e) => { e.stopPropagation(); this.toggleBasemapPanel(); };
    document.querySelectorAll('.bm-opt').forEach((b) => b.onclick = () => this.setBasemap(b.dataset.bm));
    document.addEventListener('click', (e) => { const p = $('basemapPanel'), btn = $('basemapBtn'); if (p.classList.contains('show') && !p.contains(e.target) && !btn.contains(e.target)) p.classList.remove('show'); });
    $('tapHintCancel').onclick = () => { if (this.state.editGeom) this.cancelEditGeom(); else this.cancelPlacing(); };
    $('skCancel').onclick = () => { if (this.state.editGeom) this.cancelEditGeom(); else { const operation = this.state.draw && this.state.draw.operation; this.endDraw(); if (!operation) this.backToForm(); } };
    $('skUndo').onclick = () => { const eg = this.state.editGeom; if (eg && eg.vertexEdit) this.geomUndo(); else this.undoSketchPoint(); };
    $('skRedo').onclick = () => this.geomRedo();
    $('skDeleteVertex').onclick = () => this.deleteActiveVertex();
    $('skFinish').onclick = () => { if (this.state.editGeom) this.confirmEditGeom(); else this.confirmDraw(); };
    $('sheetClose').onclick = () => this.closeSheetByUser();
    $('sheetBack').onclick = () => this.goBackByUser();
    $('scrim').onclick = () => this.closeSheetByUser();
    this.wireCameraControls();
    this.wireImagery();
    document.addEventListener('keydown', (e) => {
      if (/INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || '')) return;
      const key = e.key.toLowerCase();
      if (key === 'h') this.setActiveTool('pan');
      else if (key === 'v') this.beginFeatureSelection();
      else if (key === 'b') this.beginBoxSelection();
      else if (key === 'e' && !document.getElementById('toolModify').disabled) this.modifySelectedFeature();
      else if (key === 'm' && !document.getElementById('toolMove').disabled) this.moveSelectedFeature();
      else if (key === 'x' && !document.getElementById('toolSplit').disabled) this.beginSplitSelectedLine();
      else if (e.key === 'Delete' && this.state.editGeom && this.state.editGeom.vertexEdit && this.state.editGeom.activeVertex != null) this.deleteActiveVertex();
      else if (e.key === 'Delete' && !document.getElementById('toolDelete').disabled) this.deleteSelectedFeature();
      else if (e.key === 'Escape') { if (this.state.editGeom) this.cancelEditGeom(); else if (this.state.draw) this.endDraw(); else if ((this.state.selectedRecords || []).length) this.clearSelection(); else this.beginFeatureSelection(); }
    });
    this.updateEditToolbar();
  },

  wireNet() {
    const upd = () => { const on = navigator.onLine; const el = document.getElementById('net'); el.className = 'net ' + (on ? 'online' : 'offline'); document.getElementById('netTxt').textContent = on ? 'Online' : 'Offline'; };
    window.addEventListener('online', () => { upd(); this.backfillMissingZ(); });
    window.addEventListener('offline', upd);
    upd();
    // Records captured offline are missing Z — fill them as soon as we're online.
    if (navigator.onLine) setTimeout(() => this.backfillMissingZ(), 4000);
  },

  // Backfill Z_Elevation for every stored record that has coordinates but no Z yet
  // (i.e. it was captured offline). Sequential + capped so a big backlog can't hammer
  // the elevation service; runs again on the next online event for any remainder.
  async backfillMissingZ() {
    if (this._backfillingZ || !navigator.onLine) return;
    const pending = this.state.records.filter((r) => r.location && r.location.lat != null && r.location.z == null);
    if (!pending.length) return;
    this._backfillingZ = true;
    let filled = 0;
    try {
      for (const rec of pending.slice(0, 40)) {
        if (!navigator.onLine) break;
        const before = rec.location.z;
        await this.backfillZ(rec);
        if (before == null && rec.location.z != null) filled++;
        await new Promise((res) => setTimeout(res, 350));
      }
    } finally { this._backfillingZ = false; }
    if (filled) { this.toast(`Z elevation filled for ${filled} offline record${filled === 1 ? '' : 's'}`, 'ok'); this.renderAllLayers(); }
  },

  /* ---------- persistent header editing workspace ---------- */
  updateEditToolbar() {
    const selected = this.state.selectedRecord;
    const selectedRecords = this.state.selectedRecords || (selected ? [selected] : []);
    const count = selectedRecords.length;
    const hasProject = !!this.state.project;
    const editing = hasProject && this.state.editingSession;
    const create = document.getElementById('toolCreate');
    const select = document.getElementById('toolSelect');
    const modify = document.getElementById('toolModify');
    const move = document.getElementById('toolMove');
    const split = document.getElementById('toolSplit');
    const del = document.getElementById('toolDelete');
    if (!create) return;
    document.getElementById('toolPan').disabled = !hasProject;
    ['toolCreate', 'toolSelect', 'toolBoxSelect'].forEach((id) => { document.getElementById(id).disabled = !editing; });
    modify.disabled = !editing || count !== 1;
    move.disabled = !editing || count !== 1;
    document.getElementById('toolRotate').disabled = !editing || count !== 1 || !selected || selected.geomType === 'point';
    document.getElementById('toolReshape').disabled = !editing || count !== 1 || !selected || !['line', 'polygon'].includes(selected.geomType);
    document.getElementById('toolCutPolygon').disabled = !editing || count !== 1 || !selected || selected.geomType !== 'polygon';
    split.disabled = !editing || count !== 1 || !selected || selected.geomType !== 'line';
    const mergeOK = count >= 2 && selectedRecords.every((r) => r.layerId === selectedRecords[0].layerId && r.geomType === selectedRecords[0].geomType);
    document.getElementById('toolMerge').disabled = !editing || !mergeOK;
    del.disabled = !editing || count === 0;
    const attrOK = count >= 1 && selectedRecords.every((r) => r.layerId === selectedRecords[0].layerId);
    document.getElementById('toolAttributes').disabled = !editing || !attrOK;
    document.getElementById('toolSketchProps').disabled = !editing || !(this.state.editGeom && this.state.editGeom.vertexEdit);
    document.getElementById('toolUndo').disabled = !((this.state.editGeom && this.state.editGeom._undo && this.state.editGeom._undo.length) || this.state.sessionUndo.length);
    document.getElementById('toolRedo').disabled = !((this.state.editGeom && this.state.editGeom._redo && this.state.editGeom._redo.length) || this.state.sessionRedo.length);
    document.getElementById('toolSaveEdits').disabled = !editing;
    document.getElementById('toolSnapping').disabled = !editing;
    document.getElementById('editorStart').disabled = !hasProject || editing;
    document.getElementById('editorSave').disabled = !editing;
    document.getElementById('editorStop').disabled = !editing;
    document.getElementById('editorMenuBtn').classList.toggle('active', editing);
    const activeId = { pan: 'toolPan', select: 'toolSelect', box: 'toolBoxSelect', create: 'toolCreate', vertices: 'toolModify', move: 'toolMove', split: 'toolSplit', reshape: 'toolReshape', cut: 'toolCutPolygon' }[this.state.activeTool];
    document.querySelectorAll('.edit-tool').forEach((b) => { const on = b.id === activeId; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    document.getElementById('toolSnapping').classList.toggle('on', editing && this.state.snapping);
    document.getElementById('toolSnapping').setAttribute('aria-pressed', editing && this.state.snapping ? 'true' : 'false');
    document.querySelector('#toolSnapping span').textContent = `Snap ${this.state.snapping ? 'ON' : 'OFF'}`;
    document.getElementById('toolSnapping').title = `Snapping ${this.state.snapping ? 'ON' : 'OFF'} — vertices and edges`;
    const context = document.getElementById('editContext');
    if (!hasProject) context.textContent = 'Open a project';
    else if (!editing) context.textContent = 'Editor ▸ Start Editing';
    else if (count > 1) context.textContent = `${count} features selected`;
    else if (selected) context.textContent = `${selected.layerName || 'Feature'} selected · ${selected.geomType}`;
    else context.textContent = this.state.activeTool === 'box' ? 'Drag a box across the map' : 'Arrow-select or double-click a feature';
  },
  startEditing(silent) {
    if (!this.state.project) { this.toast('Open a project first', 'err'); return; }
    this.state.editingSession = true;
    this.state.sessionUndo = []; this.state.sessionRedo = [];
    this._pendingMediaDeletes = [];
    this._editSessionBaseline = JSON.parse(JSON.stringify(this.state.records.filter((r) => r.projectId === this.state.project.id)));
    document.getElementById('editorMenu').classList.remove('show');
    this.setActiveTool('select'); this.updateEditToolbar();
    if (!silent) this.toast('Edit session started', 'ok');
  },
  async flushPendingMediaDeletes() {
    const ids = [...new Set(this._pendingMediaDeletes || [])];
    for (const id of ids) await Media.remove(id);
    this._pendingMediaDeletes = [];
  },
  queueMediaDelete(id) {
    if (!id) return;
    if (this.state.editingSession) {
      this._pendingMediaDeletes = this._pendingMediaDeletes || [];
      if (!this._pendingMediaDeletes.includes(id)) this._pendingMediaDeletes.push(id);
    } else Media.remove(id);
  },
  async saveEditSession() {
    if (!this.state.editingSession) return;
    await this.flushPendingMediaDeletes();
    this._editSessionBaseline = JSON.parse(JSON.stringify(this.state.records.filter((r) => r.projectId === this.state.project.id)));
    this.state.sessionUndo = []; this.state.sessionRedo = [];
    document.getElementById('editorMenu').classList.remove('show');
    this.updateEditToolbar(); this.toast('Edits saved', 'ok');
  },
  stopEditing() {
    if (!this.state.editingSession) return;
    document.getElementById('editorMenu').classList.remove('show');
    this.openSheet('Stop Editing', '<div class="note">Choose whether to save or discard all changes made since the edit session started.</div>', `<button class="btn btn-primary flex" id="stopSave">Save and stop</button><button class="btn btn-danger flex" id="stopDiscard">Discard</button><button class="btn btn-ghost" id="stopCancel">Cancel</button>`);
    document.getElementById('stopSave').onclick = () => this.finishStopEditing(true);
    document.getElementById('stopDiscard').onclick = () => this.finishStopEditing(false);
    document.getElementById('stopCancel').onclick = () => this.closeSheet();
  },
  async finishStopEditing(save) {
    if (!save && this._editSessionBaseline) {
      const pid = this.state.project.id;
      for (const r of this.state.records.filter((x) => x.projectId === pid)) await DB.del('records', r.id);
      for (const r of this._editSessionBaseline) await DB.put('records', r);
      this.state.records = this.state.records.filter((x) => x.projectId !== pid).concat(JSON.parse(JSON.stringify(this._editSessionBaseline)));
    }
    if (save) await this.flushPendingMediaDeletes();
    else this._pendingMediaDeletes = [];
    if (this.state.editGeom) this.cancelEditGeom();
    this.state.editingSession = false; this.state.selectedRecord = null; this.state.selectedRecords = [];
    this.closeSheet(); document.getElementById('editorMenu').classList.remove('show');
    this.setActiveTool('pan'); this.renderAllLayers(); this.refreshBarSub(); this.updateEditToolbar();
    this.toast(save ? 'Edits saved · editing stopped' : 'Edits discarded · editing stopped', 'ok');
  },
  captureSessionUndo() {
    if (!this.state.editingSession || !this.state.project) return;
    this.state.sessionUndo.push(JSON.stringify(this.state.records.filter((r) => r.projectId === this.state.project.id)));
    if (this.state.sessionUndo.length > 50) this.state.sessionUndo.shift();
    this.state.sessionRedo = []; this.updateEditToolbar();
  },
  async restoreSessionSnapshot(json) {
    const pid = this.state.project.id, snapshot = JSON.parse(json);
    for (const r of this.state.records.filter((x) => x.projectId === pid)) await DB.del('records', r.id);
    for (const r of snapshot) await DB.put('records', r);
    this.state.records = this.state.records.filter((x) => x.projectId !== pid).concat(snapshot);
    this.state.selectedRecord = null; this.state.selectedRecords = [];
    this.renderAllLayers(); this.refreshBarSub(); this.updateEditToolbar();
  },
  async undoEdit() {
    if (this.state.editGeom && this.state.editGeom._undo && this.state.editGeom._undo.length) { this.geomUndo(); return; }
    if (!this.state.sessionUndo.length) return;
    this.state.sessionRedo.push(JSON.stringify(this.state.records.filter((r) => r.projectId === this.state.project.id)));
    await this.restoreSessionSnapshot(this.state.sessionUndo.pop()); this.toast('Edit undone', 'ok');
  },
  async redoEdit() {
    if (this.state.editGeom && this.state.editGeom._redo && this.state.editGeom._redo.length) { this.geomRedo(); return; }
    if (!this.state.sessionRedo.length) return;
    this.state.sessionUndo.push(JSON.stringify(this.state.records.filter((r) => r.projectId === this.state.project.id)));
    await this.restoreSessionSnapshot(this.state.sessionRedo.pop()); this.toast('Edit redone', 'ok');
  },
  setActiveTool(tool) {
    if (!this.state.map) return;
    this.state.activeTool = tool;
    this.state.selectingFeature = tool === 'select';
    this.state.splittingLine = tool === 'split';
    const mapEl = document.getElementById('map');
    mapEl.classList.remove('tool-pan', 'tool-select', 'tool-box', 'tool-create', 'tool-vertices', 'tool-move', 'tool-split', 'tool-reshape', 'tool-cut');
    mapEl.classList.add(`tool-${tool}`);
    if (tool === 'pan') this.state.map.dragging.enable();
    else this.state.map.dragging.disable();
    this.updateEditToolbar();
  },
  beginFeatureSelection() {
    if (!this.state.project) return;
    this.setActiveTool('select');
    this.closeSheet();
    this.guide('Arrow select', 'Click a feature once to select it, or double-click it to edit vertices.', 'Box select', () => this.beginBoxSelection());
  },
  openSnappingSettings() {
    const layers = this.state.layers.filter((l) => this.state.project && l.projectId === this.state.project.id);
    const selected = this.state.snapLayerIds ? new Set(this.state.snapLayerIds) : null;
    const body = `<div class="note">Choose valid snap targets. Snapping is evaluated in screen pixels so the tolerance remains usable at different map scales.</div>
      <label class="fld-req"><input type="checkbox" id="snapVertex" ${this.state.snapVertices ? 'checked' : ''} /> vertices and endpoints</label>
      <label class="fld-req"><input type="checkbox" id="snapEdge" ${this.state.snapEdges ? 'checked' : ''} /> feature edges</label>
      <div class="field"><label class="lbl">Tolerance</label><select class="sel" id="snapTolerance">${[6,10,14,18,24,30].map((n) => `<option value="${n}" ${n === this.state.snapTolerance ? 'selected' : ''}>${n} pixels</option>`).join('')}</select></div>
      <div class="card"><div class="card-lbl">Target layers</div>
        <label class="fld-req"><input type="checkbox" id="snapAll" ${selected ? '' : 'checked'} /> all visible layers</label>
        <div id="snapLayerList">${layers.map((l) => `<label class="fld-req"><input type="checkbox" data-snap-layer="${l.id}" ${!selected || selected.has(l.id) ? 'checked' : ''} /> ${esc(l.name)}</label>`).join('')}</div>
      </div>`;
    this.openSheet('Snapping settings', body, `<button class="btn btn-primary btn-block" id="saveSnapSettings">${icon('check', 16)} Apply snapping settings</button>`);
    const all = document.getElementById('snapAll');
    all.onchange = () => document.querySelectorAll('[data-snap-layer]').forEach((c) => { c.disabled = all.checked; if (all.checked) c.checked = true; });
    all.onchange();
    document.getElementById('saveSnapSettings').onclick = () => {
      const vertices = document.getElementById('snapVertex').checked, edges = document.getElementById('snapEdge').checked;
      if (!vertices && !edges) { this.toast('Enable at least one snap type', 'err'); return; }
      this.state.snapVertices = vertices; this.state.snapEdges = edges;
      this.state.snapTolerance = +document.getElementById('snapTolerance').value || 14;
      this.state.snapLayerIds = all.checked ? null : [...document.querySelectorAll('[data-snap-layer]:checked')].map((c) => c.dataset.snapLayer);
      this.closeSheet(); this.toast('Snapping settings applied', 'ok');
    };
  },
  beginBoxSelection() {
    if (!this.state.project) return;
    this.setActiveTool('box');
    this.closeSheet();
    this.guide('Box selection', 'Press and drag a virtual rectangle across the features to select.', 'Arrow', () => this.beginFeatureSelection());
  },
  clearSelection() {
    this.state.selectedRecord = null; this.state.selectedRecords = [];
    this.renderAllLayers(); this.updateEditToolbar();
  },
  modifySelectedFeature() {
    const r = this.state.selectedRecord; if (!r) { this.beginFeatureSelection(); return; }
    const l = this.state.layers.find((x) => x.id === r.layerId);
    this.setActiveTool('vertices');
    this.startEditGeom(r, l);
  },
  geometryBounds(record) {
    const g = Exporter.geometryOf(record); if (!g) return null;
    const points = [];
    const walk = (value) => {
      if (!Array.isArray(value)) return;
      if (typeof value[0] === 'number') points.push([value[1], value[0]]);
      else value.forEach(walk);
    };
    walk(g.coordinates);
    return points.length ? L.latLngBounds(points) : null;
  },
  validateGeometry(geometry) {
    const errors = [];
    if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) return ['Geometry is missing'];
    const ring = geometry.type === 'Point' ? [geometry.coordinates] : geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates;
    if (!Array.isArray(ring)) return ['Geometry coordinates are invalid'];
    for (const c of ring) {
      if (!Array.isArray(c) || !Number.isFinite(+c[0]) || !Number.isFinite(+c[1])) { errors.push('Geometry contains an invalid coordinate'); break; }
      if (+c[0] < -180 || +c[0] > 180 || +c[1] < -90 || +c[1] > 90) { errors.push('Geometry contains a coordinate outside WGS 84 bounds'); break; }
    }
    if (geometry.type === 'LineString' && ring.length < 2) errors.push('A line requires at least two vertices');
    if (geometry.type === 'Polygon') {
      if (ring.length < 4) errors.push('A polygon requires at least three vertices and a closed ring');
      else if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) errors.push('Polygon ring is not closed');
    }
    for (let i = 1; i < ring.length; i++) {
      if (ring[i][0] === ring[i - 1][0] && ring[i][1] === ring[i - 1][1]) { errors.push('Geometry contains a zero-length segment'); break; }
    }
    const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const intersects = (a, b, c, d) => {
      const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
      return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
    };
    if (geometry.type !== 'Point') {
      for (let i = 0; i < ring.length - 1; i++) {
        for (let j = i + 2; j < ring.length - 1; j++) {
          if (geometry.type === 'Polygon' && i === 0 && j === ring.length - 2) continue;
          if (intersects(ring[i], ring[i + 1], ring[j], ring[j + 1])) { errors.push('Geometry self-intersects'); i = ring.length; break; }
        }
      }
    }
    return [...new Set(errors)];
  },
  requireValidGeometry(geometry) {
    const errors = this.validateGeometry(geometry);
    if (errors.length) { this.toast(errors[0], 'err'); return false; }
    return true;
  },
  geometryIntersectsBounds(record, bounds) {
    const g = Exporter.geometryOf(record); if (!g) return false;
    const west = bounds.getWest(), east = bounds.getEast(), south = bounds.getSouth(), north = bounds.getNorth();
    const inside = (p) => p[0] >= west && p[0] <= east && p[1] >= south && p[1] <= north;
    if (g.type === 'Point') return inside(g.coordinates);
    const ring = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates;
    if (ring.some(inside)) return true;
    const orient = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    const hit = (a, b, c, d) => orient(a, b, c) !== orient(a, b, d) && orient(c, d, a) !== orient(c, d, b);
    const edges = [[[west, south], [east, south]], [[east, south], [east, north]], [[east, north], [west, north]], [[west, north], [west, south]]];
    for (let i = 0; i < ring.length - 1; i++) if (edges.some((e) => hit(ring[i], ring[i + 1], e[0], e[1]))) return true;
    if (g.type === 'Polygon') {
      const pointInPolygon = (p) => {
        let c = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i], b = ring[j];
          if (((a[1] > p[1]) !== (b[1] > p[1])) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
        }
        return c;
      };
      if ([[west, south], [east, south], [east, north], [west, north]].some(pointInPolygon)) return true;
    }
    return false;
  },
  onBoxSelectStart(e) {
    if (this.state.activeTool !== 'box' || this.state.draw || this.state.editGeom) return;
    if (e.originalEvent && e.originalEvent.button != null && e.originalEvent.button !== 0) return;
    this._boxStart = e.latlng;
    if (this._boxLayer) this.state.map.removeLayer(this._boxLayer);
    this._boxLayer = L.rectangle(L.latLngBounds(e.latlng, e.latlng), { className: 'selection-rectangle', color: '#007AC2', weight: 2, fillColor: '#4CAEE5', fillOpacity: 0.16, dashArray: '7 5', interactive: false }).addTo(this.state.map);
  },
  onBoxSelectMove(e) {
    if (!this._boxStart || !this._boxLayer) return;
    this._boxLayer.setBounds(L.latLngBounds(this._boxStart, e.latlng));
  },
  onBoxSelectEnd(e) {
    if (!this._boxStart) return;
    const bounds = L.latLngBounds(this._boxStart, e.latlng);
    this._boxStart = null;
    this._boxJustFinished = true; setTimeout(() => { this._boxJustFinished = false; }, 50);
    if (this._boxLayer) { this.state.map.removeLayer(this._boxLayer); this._boxLayer = null; }
    const selected = this.state.records.filter((r) => {
      if (!this.state.project || r.projectId !== this.state.project.id) return false;
      const layer = this.state.layers.find((l) => l.id === r.layerId);
      if (layer && layer.hidden) return false;
      return this.geometryIntersectsBounds(r, bounds);
    });
    this.state.selectedRecords = selected;
    this.state.selectedRecord = selected[0] || null;
    this.renderAllLayers(); this.updateEditToolbar();
    this.toast(selected.length ? `${selected.length} feature${selected.length === 1 ? '' : 's'} selected` : 'No features inside the box', selected.length ? 'ok' : '');
  },
  moveSelectedFeature() {
    const r = this.state.selectedRecord; if (!r || (this.state.selectedRecords || []).length !== 1) return;
    const l = this.state.layers.find((x) => x.id === r.layerId);
    const g = Exporter.geometryOf(r); if (!g) return;
    if (g.type === 'Point') { this.setActiveTool('move'); this.startEditGeom(r, l); return; }
    this.closeSheet(); this.hideCollectBar(); this.setActiveTool('move');
    const bounds = this.geometryBounds(r), center = bounds.getCenter();
    const eg = this.state.editGeom = { record: r, layer: l, mode: r.geomType, moveMode: true, originalGeometry: JSON.parse(JSON.stringify(g)), _reLayer: L.layerGroup().addTo(this.state.map) };
    this.updateEditToolbar();
    eg._moveOrigin = center;
    eg._moveMarker = L.marker(center, { draggable: true, zIndexOffset: 950, icon: L.divIcon({ className: 'geometry-move-handle', html: '<span></span>', iconSize: [34, 34], iconAnchor: [17, 17] }) }).addTo(this.state.map);
    eg._moveMarker.on('drag', (ev) => {
      const p = ev.target.getLatLng();
      eg.previewGeometry = this.translateGeometry(eg.originalGeometry, p.lng - center.lng, p.lat - center.lat);
      this.drawGeometryPreview(eg.previewGeometry, eg._reLayer);
    });
    eg._moveMarker.on('dragend', async (ev) => {
      const p = ev.target.getLatLng();
      this.captureSessionUndo();
      r.geometry = this.translateGeometry(eg.originalGeometry, p.lng - center.lng, p.lat - center.lat);
      const c = r.geometry.type === 'LineString' ? r.geometry.coordinates[0] : r.geometry.coordinates[0][0];
      r.location = Object.assign(r.location || {}, { lng: c[0], lat: c[1] });
      await this.finishEditGeom(r);
    });
    document.getElementById('tapHintText').textContent = 'Drag the blue diamond to move the entire geometry';
    document.getElementById('tapHint').classList.add('show');
  },
  translateGeometry(geometry, dx, dy) {
    const copy = JSON.parse(JSON.stringify(geometry));
    const walk = (value) => {
      if (typeof value[0] === 'number') { value[0] += dx; value[1] += dy; return; }
      value.forEach(walk);
    };
    walk(copy.coordinates); return copy;
  },
  drawGeometryPreview(geometry, target) {
    target.clearLayers();
    if (geometry.type === 'LineString') L.polyline(geometry.coordinates.map((c) => [c[1], c[0]]), { color: '#007AC2', weight: 5, dashArray: '8 5' }).addTo(target);
    else L.polygon(geometry.coordinates[0].map((c) => [c[1], c[0]]), { color: '#007AC2', weight: 3, fillColor: '#4CAEE5', fillOpacity: .22, dashArray: '8 5' }).addTo(target);
  },
  beginSplitSelectedLine() {
    const r = this.state.selectedRecord;
    if (!r || r.geomType !== 'line' || (this.state.selectedRecords || []).length !== 1) return;
    this.setActiveTool('split'); this.closeSheet();
    this.guide('Split line', 'Click anywhere along the selected line. The nearest position becomes the split point.', 'Cancel', () => this.beginFeatureSelection());
  },
  async splitSelectedLineAt(latlng) {
    const r = this.state.selectedRecord, g = r && Exporter.geometryOf(r);
    if (!r || !g || g.type !== 'LineString' || g.coordinates.length < 2) return;
    const target = this.state.map.latLngToLayerPoint(latlng);
    let best = null;
    for (let i = 0; i < g.coordinates.length - 1; i++) {
      const a = this.state.map.latLngToLayerPoint([g.coordinates[i][1], g.coordinates[i][0]]);
      const b = this.state.map.latLngToLayerPoint([g.coordinates[i + 1][1], g.coordinates[i + 1][0]]);
      const vx = b.x - a.x, vy = b.y - a.y, len2 = vx * vx + vy * vy;
      const t = len2 ? Math.max(0, Math.min(1, ((target.x - a.x) * vx + (target.y - a.y) * vy) / len2)) : 0;
      const x = a.x + t * vx, y = a.y + t * vy, d2 = (target.x - x) ** 2 + (target.y - y) ** 2;
      if (!best || d2 < best.d2) best = { i, t, d2, point: this.state.map.layerPointToLatLng([x, y]) };
    }
    if (!best || best.d2 > 900) { this.toast('Click closer to the selected line', 'err'); return; }
    if ((best.i === 0 && best.t < .01) || (best.i === g.coordinates.length - 2 && best.t > .99)) { this.toast('Split point cannot be at a line endpoint', 'err'); return; }
    const ca = g.coordinates[best.i], cb = g.coordinates[best.i + 1];
    const z = ca.length > 2 && cb.length > 2 ? ca[2] + (cb[2] - ca[2]) * best.t : undefined;
    const split = z == null ? [best.point.lng, best.point.lat] : [best.point.lng, best.point.lat, z];
    const first = g.coordinates.slice(0, best.i + 1).concat([split]);
    const secondCoords = [split].concat(g.coordinates.slice(best.i + 1));
    const second = JSON.parse(JSON.stringify(r));
    second.id = uid('rec'); second.geometry = { type: 'LineString', coordinates: secondCoords }; second.media = []; second.createdAt = nowISO(); second.updatedAt = nowISO();
    second.location = Object.assign({}, second.location || {}, { lng: secondCoords[0][0], lat: secondCoords[0][1] });
    this.captureSessionUndo();
    r.geometry = { type: 'LineString', coordinates: first }; r.updatedAt = nowISO();
    await DB.put('records', r); await DB.put('records', second);
    this.state.records.push(second);
    this.state.selectedRecord = null; this.state.selectedRecords = [];
    this.setActiveTool('select'); this.renderAllLayers(); this.refreshBarSub();
    this.toast('Line split into two editable features', 'ok');
  },
  openSelectedAttributes() {
    const selected = this.state.selectedRecords || [];
    if (selected.length > 1) { this.openBulkAttributes(selected); return; }
    const r = this.state.selectedRecord; if (!r) return;
    this.rootNav(this.startCollect, [r]);
  },
  openBulkAttributes(records) {
    const layer = records.length && this.state.layers.find((l) => l.id === records[0].layerId);
    if (!layer || !layer.fields.length) { this.toast('This layer has no editable attributes', 'err'); return; }
    const options = layer.fields.map((f) => `<option value="${esc(f.key)}">${esc(f.label)}</option>`).join('');
    const body = `<div class="note">Apply one value to ${records.length} selected ${esc(layer.name)} features. Geometry, IDs and system tracking fields are unchanged.</div>
      <div class="field"><label class="lbl">Field</label><select class="sel" id="bulkField">${options}</select></div>
      <div class="field"><label class="lbl">Value</label><div id="bulkValueHost"></div></div>`;
    this.openSheet('Bulk attribute update', body, `<button class="btn btn-primary btn-block" id="bulkApply">${icon('check', 16)} Apply to ${records.length} records</button>`);
    const render = () => {
      const f = layer.fields.find((x) => x.key === document.getElementById('bulkField').value);
      const dom = f && f.domain && this.state.project.domains && this.state.project.domains[f.domain];
      const host = document.getElementById('bulkValueHost');
      if (dom) host.innerHTML = `<select class="sel" id="bulkValue"><option value="">Select…</option>${dom.values.map(([c,n]) => `<option value="${esc(c)}">${esc(n)}</option>`).join('')}</select>`;
      else if (f && f.type === 'select') host.innerHTML = `<select class="sel" id="bulkValue"><option value="">Select…</option>${(f.options || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`;
      else host.innerHTML = `<input class="inp" id="bulkValue" type="${f && ['number','integer'].includes(f.type) ? 'number' : f && f.type === 'date' ? 'date' : 'text'}" />`;
    };
    document.getElementById('bulkField').onchange = render; render();
    document.getElementById('bulkApply').onclick = async () => {
      const key = document.getElementById('bulkField').value, value = document.getElementById('bulkValue').value;
      this.captureSessionUndo();
      for (const r of records) {
        r.data = r.data || {}; r.data[key] = value; r.updatedAt = nowISO();
        r.status = this.captureStatus(r.data, layer);
        await DB.put('records', r);
      }
      this.closeSheet(); this.renderAllLayers(); this.updateEditToolbar(); this.toast(`${records.length} records updated`, 'ok');
    };
  },
  openRotateTool() {
    const r = this.state.selectedRecord; if (!r) return;
    const body = `<div class="note" style="margin-bottom:12px">Rotate the selected ${r.geomType} around its center.</div><div class="field"><label class="lbl">Rotation angle (degrees)</label><input class="inp" id="rotateAngle" type="number" min="-360" max="360" step="1" value="0" /></div>`;
    this.openSheet('Rotate Feature', body, `<button class="btn btn-primary btn-block" id="applyRotate">Apply rotation</button>`);
    document.getElementById('applyRotate').onclick = async () => {
      const angle = +document.getElementById('rotateAngle').value;
      if (!Number.isFinite(angle)) return;
      this.captureSessionUndo();
      const bounds = this.geometryBounds(r), center = bounds.getCenter();
      r.geometry = this.rotateGeometry(Exporter.geometryOf(r), angle, center); r.updatedAt = nowISO();
      await DB.put('records', r); this.renderAllLayers(); this.closeSheet(); this.toast(`Rotated ${angle}°`, 'ok');
    };
  },
  rotateGeometry(geometry, degrees, center) {
    const copy = JSON.parse(JSON.stringify(geometry)), rad = degrees * Math.PI / 180;
    const cs = Math.cos(rad), sn = Math.sin(rad), scale = Math.cos(center.lat * Math.PI / 180) || 1;
    const walk = (value) => {
      if (typeof value[0] === 'number') {
        const x = (value[0] - center.lng) * scale, y = value[1] - center.lat;
        value[0] = center.lng + (x * cs - y * sn) / scale; value[1] = center.lat + x * sn + y * cs; return;
      }
      value.forEach(walk);
    };
    walk(copy.coordinates); return copy;
  },
  openSketchProperties() {
    const dr = this.state.editGeom; if (!dr || !dr.vertexEdit) return;
    const rows = dr.coords.map((c, i) => `<tr><td>${i + 1}</td><td><input class="inp sk-prop" data-i="${i}" data-axis="0" type="number" step="0.000001" value="${c[0]}" /></td><td><input class="inp sk-prop" data-i="${i}" data-axis="1" type="number" step="0.000001" value="${c[1]}" /></td><td><input class="inp sk-prop" data-i="${i}" data-axis="2" type="number" step="0.01" value="${c[2] == null ? '' : c[2]}" /></td></tr>`).join('');
    this.openSheet('Edit Sketch Properties', `<div class="note" style="margin-bottom:10px">ArcMap-style vertex coordinate table. Edit X, Y, or Z directly.</div><div style="overflow:auto"><table class="attr sketch-props"><thead><tr><th>#</th><th>X / Longitude</th><th>Y / Latitude</th><th>Z</th></tr></thead><tbody>${rows}</tbody></table></div>`, `<button class="btn btn-primary btn-block" id="applySketchProps">Apply coordinates</button>`);
    document.getElementById('applySketchProps').onclick = () => {
      this.pushGeomUndo(dr);
      document.querySelectorAll('.sk-prop').forEach((input) => { const i = +input.dataset.i, a = +input.dataset.axis, v = input.value === '' ? null : +input.value; if (a < 2 && Number.isFinite(v)) dr.coords[i][a] = v; else if (a === 2 && v != null && Number.isFinite(v)) dr.coords[i][2] = v; });
      dr.activeVertex = null; this.redrawSketch(dr); this.updateSketchCount(); this.closeSheet(); this.toast('Sketch coordinates updated', 'ok');
    };
  },
  beginReshapeFeature() { this.beginGeometryOperation('reshape'); },
  beginCutPolygon() { this.beginGeometryOperation('cut'); },
  beginGeometryOperation(operation) {
    const r = this.state.selectedRecord; if (!r || !this.state.map) return;
    this.closeSheet(); this.hideCollectBar(); this.state.map.doubleClickZoom.disable();
    this.state.draw = { mode: 'line', operation, record: r, coords: [], layer: L.layerGroup().addTo(this.state.map) };
    this.setActiveTool(operation); document.getElementById('sketchBar').classList.add('show');
    document.getElementById('skHint').textContent = operation === 'cut' ? 'draw a line completely across the polygon' : 'draw the replacement path between two locations on the feature';
    this.updateSketchCount();
  },
  closestPathLocation(coords, point) {
    let best = null;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1], vx = b[0] - a[0], vy = b[1] - a[1], len2 = vx * vx + vy * vy;
      const t = len2 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * vx + (point[1] - a[1]) * vy) / len2)) : 0;
      const p = [a[0] + t * vx, a[1] + t * vy], d2 = (point[0] - p[0]) ** 2 + (point[1] - p[1]) ** 2;
      if (!best || d2 < best.d2) best = { index: i, t, point: p, d2 };
    }
    return best;
  },
  polygonArea(ring) {
    let area = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]; return area / 2;
  },
  ensureGeometryZ(geometry, z) {
    if (z == null) return geometry;
    const walk = (value) => { if (typeof value[0] === 'number') { if (value.length < 3) value.push(z); return; } value.forEach(walk); };
    walk(geometry.coordinates); return geometry;
  },
  reshapeGeometry(record, sketch) {
    const g = Exporter.geometryOf(record), base = g.type === 'Polygon' ? g.coordinates[0].slice(0, -1) : g.coordinates.slice();
    const work = g.type === 'Polygon' ? base.concat([base[0]]) : base;
    let a = this.closestPathLocation(work, sketch[0]), b = this.closestPathLocation(work, sketch[sketch.length - 1]);
    if (!a || !b) return null;
    if (g.type === 'LineString') {
      if (a.index > b.index) { const t = a; a = b; b = t; sketch = sketch.slice().reverse(); }
      return { type: 'LineString', coordinates: base.slice(0, a.index + 1).concat([a.point], sketch.slice(1, -1), [b.point], base.slice(b.index + 1)) };
    }
    const ring = base.slice(); const n = ring.length;
    const forward = (from, to) => { const out = []; let i = (from + 1) % n; while (i !== (to + 1) % n) { out.push(ring[i]); i = (i + 1) % n; } return out; };
    const c1 = [a.point].concat(forward(a.index, b.index), sketch.slice(0, -1).reverse(), [a.point]);
    const c2 = [b.point].concat(forward(b.index, a.index), sketch.slice(0, -1), [b.point]);
    const chosen = Math.abs(this.polygonArea(c1)) >= Math.abs(this.polygonArea(c2)) ? c1 : c2;
    return chosen.length >= 4 ? { type: 'Polygon', coordinates: [chosen] } : null;
  },
  clipPolygonHalfPlane(points, a, b, keepPositive) {
    const side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const inside = (p) => keepPositive ? side(p) >= 0 : side(p) <= 0;
    const intersect = (s, e) => { const ds = side(s), de = side(e), t = ds / (ds - de); return [s[0] + t * (e[0] - s[0]), s[1] + t * (e[1] - s[1])]; };
    const output = [];
    for (let i = 0; i < points.length; i++) { const s = points[i], e = points[(i + 1) % points.length], si = inside(s), ei = inside(e); if (si && ei) output.push(e); else if (si && !ei) output.push(intersect(s, e)); else if (!si && ei) output.push(intersect(s, e), e); }
    return output;
  },
  async finishGeometryOperation(dr) {
    const r = dr.record, g = Exporter.geometryOf(r);
    if (dr.operation === 'reshape') {
      const reshaped = this.reshapeGeometry(r, dr.coords); if (!reshaped) { this.toast('Reshape path is invalid', 'err'); return; }
      this.captureSessionUndo();
      r.geometry = this.ensureGeometryZ(reshaped, r.location && r.location.z); r.updatedAt = nowISO(); await DB.put('records', r); this.endDraw(); this.renderAllLayers(); this.toast('Feature reshaped', 'ok'); return;
    }
    const ring = g.coordinates[0].slice(0, -1), a = dr.coords[0], b = dr.coords[dr.coords.length - 1];
    const left = this.clipPolygonHalfPlane(ring, a, b, true), right = this.clipPolygonHalfPlane(ring, a, b, false);
    if (left.length < 3 || right.length < 3) { this.toast('The cut line must cross the polygon completely', 'err'); return; }
    this.captureSessionUndo(); left.push(left[0]); right.push(right[0]);
    r.geometry = this.ensureGeometryZ({ type: 'Polygon', coordinates: [left] }, r.location && r.location.z); r.updatedAt = nowISO();
    const second = JSON.parse(JSON.stringify(r)); second.id = uid('rec'); second.geometry = this.ensureGeometryZ({ type: 'Polygon', coordinates: [right] }, r.location && r.location.z); second.media = []; second.createdAt = nowISO();
    await DB.put('records', r); await DB.put('records', second); this.state.records.push(second);
    this.state.selectedRecord = null; this.state.selectedRecords = []; this.endDraw(); this.renderAllLayers(); this.refreshBarSub(); this.toast('Polygon cut into two features', 'ok');
  },
  async mergeSelectedFeatures() {
    const selected = this.state.selectedRecords || []; if (selected.length < 2) return;
    const target = selected[0], type = target.geomType;
    if (type === 'point') { this.toast('Point features cannot form a single geometry in this data model', 'err'); return; }
    let geometry;
    if (type === 'line') {
      let coords = Exporter.geometryOf(target).coordinates.slice();
      for (const r of selected.slice(1)) {
        let next = Exporter.geometryOf(r).coordinates.slice();
        const pairs = [[coords[coords.length - 1], next[0], 0], [coords[coords.length - 1], next[next.length - 1], 1], [coords[0], next[next.length - 1], 2], [coords[0], next[0], 3]];
        const d = (p) => this.state.map.distance([p[0][1], p[0][0]], [p[1][1], p[1][0]]); pairs.sort((x, y) => d(x) - d(y));
        if (d(pairs[0]) > 5) { this.toast('Lines must share endpoints within 5 metres to merge', 'err'); return; }
        const mode = pairs[0][2]; if (mode === 1 || mode === 3) next.reverse(); if (mode < 2) coords = coords.concat(next.slice(1)); else coords = next.slice(0, -1).concat(coords);
      }
      geometry = { type: 'LineString', coordinates: coords };
    } else {
      if (typeof turf === 'undefined' || !turf.union) { this.toast('Polygon merge engine is still loading', 'err'); return; }
      let merged = turf.polygon(Exporter.geometryOf(target).coordinates);
      try { for (const r of selected.slice(1)) merged = turf.union(merged, turf.polygon(Exporter.geometryOf(r).coordinates)); } catch { this.toast('Selected polygons could not be merged', 'err'); return; }
      if (!merged || merged.geometry.type !== 'Polygon') { this.toast('Polygons must touch or overlap to create one feature', 'err'); return; }
      geometry = merged.geometry;
    }
    this.captureSessionUndo(); target.geometry = geometry; target.updatedAt = nowISO(); await DB.put('records', target);
    const remove = selected.slice(1);
    for (const r of remove) {
      for (const m of (r.media || [])) if (!m.dataUrl) this.queueMediaDelete(m.id);
      await DB.del('records', r.id);
    }
    const ids = new Set(remove.map((r) => r.id)); this.state.records = this.state.records.filter((r) => !ids.has(r.id));
    this.state.selectedRecord = target; this.state.selectedRecords = [target]; this.renderAllLayers(); this.refreshBarSub(); this.updateEditToolbar(); this.toast(`${selected.length} features merged`, 'ok');
  },
  async deleteSelectedFeature() {
    const selected = this.state.selectedRecords || []; if (!selected.length) return;
    if (!confirm(`Delete ${selected.length} selected feature${selected.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    this.captureSessionUndo();
    for (const r of selected) {
      for (const m of (r.media || [])) if (!m.dataUrl) this.queueMediaDelete(m.id);
      await DB.del('records', r.id);
    }
    const ids = new Set(selected.map((r) => r.id));
    this.state.records = this.state.records.filter((x) => !ids.has(x.id));
    this.state.selectedRecord = null;
    this.state.selectedRecords = [];
    this.renderAllLayers(); this.refreshBarSub(); this.updateEditToolbar();
    this.toast(`${selected.length} feature${selected.length === 1 ? '' : 's'} deleted`, 'ok');
  },

  toggleBasemapPanel() { const p = document.getElementById('basemapPanel'); p.classList.toggle('show'); document.querySelectorAll('.bm-opt').forEach((b) => b.classList.toggle('on', b.dataset.bm === this.state.activeBasemap)); },
  setBasemap(key) {
    localStorage.setItem('sm_basemap', key);
    document.querySelectorAll('.bm-opt').forEach((b) => b.classList.toggle('on', b.dataset.bm === key));
    if (this.state.map && this.state.basemaps) { this.state.map.removeLayer(this.state.basemaps[this.state.activeBasemap]); this.state.basemaps[key].addTo(this.state.map); this.bringLayersFront(); }
    this.state.activeBasemap = key;
    document.getElementById('basemapPanel').classList.remove('show');
  },
  bringLayersFront() {
    Object.values(this.state.layerGroups).forEach((g) => { if (g.eachLayer) g.eachLayer((f) => { if (f.bringToFront) f.bringToFront(); }); });
    if (this.state.gpsLayer && this.state.gpsLayer.eachLayer) this.state.gpsLayer.eachLayer((f) => { if (f.bringToFront) f.bringToFront(); });
  },

  /* ---------- Live location tracking: heading puck, follow mode, breadcrumb trail ---------- */
  locate(silent) {
    if (!navigator.geolocation) { if (!silent) this.toast('GPS not available', 'err'); return; }
    if (!this._watchStarted) this.startWatch();
    if (!silent) {
      // Explicit tap: toggle follow mode. First tap (or after manual pan) re-centers + follows; tapping again while following just stays put.
      this.state.follow = true;
      this.updateLocateBtn();
      if (this.state.lastFix) this.centerOnFix(true);
      else this.toast('Locating…');
    }
  },
  startWatch() {
    this._watchStarted = true;
    if (this.state.watchId != null) { try { navigator.geolocation.clearWatch(this.state.watchId); } catch {} }
    this.state.watchId = navigator.geolocation.watchPosition(
      (pos) => { this._gpsDenied = false; this.onFix(pos); },
      (err) => {
        // PERMISSION_DENIED is permanent until the user changes it — tell them once.
        if (err && err.code === 1 && !this._gpsDenied) {
          this._gpsDenied = true;
          this.toast('Location is blocked — allow it in your browser settings to capture GPS', 'err');
          return;
        }
        // POSITION_UNAVAILABLE / TIMEOUT are transient (cold start, tunnels, bad sky view).
        // Keep the last fix on screen and quietly restart the watch so it never dies silently.
        if (!err || err.code !== 1) {
          clearTimeout(this._watchRestartT);
          this._watchRestartT = setTimeout(() => { if (this._watchStarted && !this._gpsDenied) this.startWatch(); }, 5000);
        }
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
    // Mobile browsers suspend geolocation in the background. When the surveyor returns to the
    // app, restart the watch immediately so a fresh fix is ready before they tap "Use GPS" —
    // this is what keeps capture instant offline, where a cold fix can take 30s+.
    if (!this._visibilityWired) {
      this._visibilityWired = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this._watchStarted && !this._gpsDenied) this.startWatch();
      });
    }
  },
  onFix(pos) {
    // While an external RTK/GNSS receiver is connected and delivering sentences,
    // phone-GPS fixes are ignored so lower-accuracy positions can't sneak in.
    if (this._gnssActive && !pos._external) {
      const fresh = this._gnssState && (Date.now() - this._gnssState.lastSentence) < 10000;
      if (fresh) return; // receiver silent >10s -> temporarily fall back to phone GPS
    }
    const { latitude, longitude, altitude, accuracy, heading, speed } = pos.coords;
    const fix = { lat: latitude, lng: longitude, z: (altitude != null && !isNaN(altitude)) ? altitude : null, accuracy, heading: (heading != null && !isNaN(heading)) ? heading : null, speed: (speed != null && !isNaN(speed)) ? speed : null, ts: Date.now() };
    this.state.lastFix = fix;
    this.showGPS(fix);
    this.pushTrail(fix);
    if (this._streamActive && !this._streamPaused) this.streamOnFix(fix);
    if (this._rapidActive) this.rapidOnFix(fix);
    if (!this._hadFirstFix) { this._hadFirstFix = true; this.centerOnFix(true); } // one-time convenience center on first-ever fix
    else if (this.state.follow && this.state.map) this.centerOnFix(false);
  },
  centerOnFix(zoomIn) {
    const f = this.state.lastFix; if (!f || !this.state.map) return;
    this.state.map.setView([f.lat, f.lng], zoomIn ? Math.max(this.state.map.getZoom(), 17) : this.state.map.getZoom(), { animate: true });
  },
  updateLocateBtn() {
    const btn = document.getElementById('locateBtn');
    btn.classList.toggle('following', !!this.state.follow);
    btn.classList.toggle('located-only', !this.state.follow && !!this.state.lastFix);
  },

  // Persistent heading-aware marker + accuracy ring, smoothly animated between fixes.
  showGPS(fix) {
    if (!this.state.map) return;
    const { lat, lng, accuracy, heading, speed } = fix;
    if (!this._gpsAccCircle) {
      this._gpsAccCircle = L.circle([lat, lng], { radius: accuracy, color: '#0079C1', weight: 1, fillColor: '#0079C1', fillOpacity: 0.08 }).addTo(this.state.gpsLayer);
      this._gpsMarker = L.marker([lat, lng], {
        icon: L.divIcon({ className: 'gps-live-marker', html: this.gpsPuckHTML(), iconSize: [46, 46], iconAnchor: [23, 23] }),
        zIndexOffset: 1000,
      }).addTo(this.state.gpsLayer);
    } else {
      this._gpsAccCircle.setLatLng([lat, lng]).setRadius(accuracy);
      this._gpsMarker.setLatLng([lat, lng]);
    }
    const hasHeading = heading != null && (speed == null || speed > 0.4);
    const el = this._gpsMarker.getElement();
    if (el) {
      const cone = el.querySelector('.cone');
      const wrap = el.querySelector('.gps-puck-icon');
      if (wrap) wrap.classList.toggle('has-heading', hasHeading);
      if (cone && hasHeading) cone.style.transform = `rotate(${heading}deg)`;
    }
    // UI pill
    const pill = document.getElementById('gpsPill'); pill.classList.add('show');
    document.getElementById('gpsAccTxt').textContent = `±${Math.round(accuracy)} m`;
    document.getElementById('gpsDot').className = 'd' + (accuracy > 20 ? ' poor' : '');
    const hdgWrap = document.getElementById('gpsHdgWrap');
    if (speed != null && speed > 0.4) {
      hdgWrap.style.display = 'flex';
      document.getElementById('gpsSpeedTxt').textContent = `${(speed * 3.6).toFixed(1)} km/h`;
      if (heading != null) document.getElementById('gpsHdgArrow').style.transform = `rotate(${heading}deg)`;
    } else {
      hdgWrap.style.display = 'none';
    }
    this.updateLocateBtn();
  },
  gpsPuckHTML() { return `<div class="gps-puck-icon"><svg class="cone" viewBox="0 0 46 46"><path d="M23 2 L33 23 L23 18 L13 23 Z" fill="#0079C1" opacity="0.85"/></svg><div class="dot"></div></div>`; },

  // Project field route: persisted continuously and exportable as a time-aware GeoJSON.
  pushTrail(fix) {
    if (!this.state.map || !this.state.project || this.state.route.paused || !isFinite(fix.lat) || !isFinite(fix.lng)) return;
    if (fix.accuracy != null && fix.accuracy > 100) return;
    const points = this.state.route.points || (this.state.route.points = []);
    const last = points[points.length - 1];
    const point = { lat: fix.lat, lng: fix.lng, z: fix.z, accuracy: fix.accuracy, heading: fix.heading, speed: fix.speed, ts: fix.ts || Date.now() };
    if (last) {
      const d = this.routeDistance(last, point), dt = Math.max(0, point.ts - last.ts);
      if (d < 2 && dt < 15000) return;
      if (d > 300 && dt < 30000) return;
      this.state.route.distanceM = (this.state.route.distanceM || 0) + d;
    }
    points.push(point);
    if (points.length > 20000) points.shift();
    this.renderRouteLine();
    clearTimeout(this._routeSaveTimer);
    this._routeSaveTimer = setTimeout(() => this.persistRoute(), 750);
  },
  routeDistance(a, b) {
    const rad = Math.PI / 180, p1 = a.lat * rad, p2 = b.lat * rad;
    const dp = (b.lat - a.lat) * rad, dl = (b.lng - a.lng) * rad;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  },
  renderRouteLine() {
    if (!this.state.map || !this.state.gpsLayer) return;
    const latlngs = (this.state.route.points || []).map((p) => [p.lat, p.lng]);
    if (!latlngs.length) {
      if (this._trailLine) { this.state.gpsLayer.removeLayer(this._trailLine); this._trailLine = null; }
      return;
    }
    if (!this._trailLine) this._trailLine = L.polyline(latlngs, { color: '#0079C1', weight: 4, opacity: 0.72, dashArray: '2,7', lineCap: 'round', interactive: false }).addTo(this.state.gpsLayer);
    else this._trailLine.setLatLngs(latlngs);
  },
  async persistRoute() {
    const p = this.state.project; if (!p) return;
    await DB.put('settings', { key: `field_route_${p.id}`, projectId: p.id, points: this.state.route.points || [], distanceM: this.state.route.distanceM || 0, paused: !!this.state.route.paused, updatedAt: nowISO() });
  },
  async restoreRoute() {
    const p = this.state.project; if (!p) return;
    const row = await DB.get('settings', `field_route_${p.id}`);
    this.state.route = row ? { points: row.points || [], distanceM: row.distanceM || 0, paused: !!row.paused } : { points: [], distanceM: 0, paused: false };
    this.renderRouteLine();
  },
  routeStats() {
    const pts = this.state.route.points || [], first = pts[0], last = pts[pts.length - 1];
    const durationS = first && last ? Math.max(0, Math.round((last.ts - first.ts) / 1000)) : 0;
    const speeds = pts.map((p) => p.speed).filter((v) => v != null && isFinite(v) && v >= 0);
    return { pointCount: pts.length, distanceM: this.state.route.distanceM || 0, durationS, startTime: first ? new Date(first.ts).toISOString() : null, endTime: last ? new Date(last.ts).toISOString() : null, avgSpeedKmh: durationS ? ((this.state.route.distanceM || 0) / durationS) * 3.6 : 0, maxSpeedKmh: speeds.length ? Math.max(...speeds) * 3.6 : 0 };
  },
  routeGeoJSON() {
    const pts = this.state.route.points || [], st = this.routeStats(), project = this.state.project;
    const geometry = pts.length > 1 ? { type: 'LineString', coordinates: pts.map((p) => p.z == null ? [p.lng, p.lat] : [p.lng, p.lat, p.z]) } : (pts.length === 1 ? { type: 'Point', coordinates: pts[0].z == null ? [pts[0].lng, pts[0].lat] : [pts[0].lng, pts[0].lat, pts[0].z] } : null);
    return { type: 'FeatureCollection', name: `${project ? project.name : 'Project'} Field Route`, features: geometry ? [{ type: 'Feature', geometry, properties: { route_name: `${project ? project.name : 'Project'} Field Route`, project_id: project ? project.id : '', project_name: project ? project.name : '', surveyor: this.state.user ? this.state.user.name : '', start_time: st.startTime, end_time: st.endTime, duration_seconds: st.durationS, distance_m: Math.round(st.distanceM * 100) / 100, distance_km: Math.round(st.distanceM) / 1000, average_speed_kmh: Math.round(st.avgSpeedKmh * 100) / 100, maximum_speed_kmh: Math.round(st.maxSpeedKmh * 100) / 100, point_count: st.pointCount, coordinate_times: pts.map((p) => new Date(p.ts).toISOString()), accuracy_m: pts.map((p) => p.accuracy == null ? null : Math.round(p.accuracy * 10) / 10), speed_mps: pts.map((p) => p.speed == null ? null : p.speed) } }] : [] };
  },
  routeDistanceText(m) { return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`; },
  routeDurationText(seconds) { const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60; return h ? `${h}h ${m}m` : (m ? `${m}m ${s}s` : `${s}s`); },
  async clearTrail() {
    const p = this.state.project;
    this.state.route = { points: [], distanceM: 0, paused: false };
    if (p) await DB.del('settings', `field_route_${p.id}`);
    this.renderRouteLine();
    this.toast('Field route cleared');
  },
};

/* ============================================================
   Part 2 — Sheets, projects (+ coordinate system), layers/feature classes
   ============================================================ */
Object.assign(App, {
  openSheet(title, bodyHTML, footHTML, noClose) {
    document.getElementById('sheetTitle').textContent = title;
    document.getElementById('sheetBody').innerHTML = bodyHTML;
    const foot = document.getElementById('sheetFoot');
    if (footHTML) { foot.innerHTML = footHTML; foot.style.display = 'flex'; } else { foot.style.display = 'none'; foot.innerHTML = ''; }
    document.getElementById('sheetClose').style.display = noClose ? 'none' : 'grid';
    document.getElementById('sheetBack').style.display = (this._navStack && this._navStack.length) ? 'grid' : 'none';
    document.getElementById('scrim').classList.add('show');
    document.getElementById('sheet').classList.add('show');
    document.getElementById('sheetBody').scrollTop = 0;
    this._noClose = !!noClose;
  },
  closeSheet() { if (this._noClose) return; document.getElementById('sheet').classList.remove('show'); document.getElementById('scrim').classList.remove('show'); this._navStack = []; this._current = null; },
  async closeSheetByUser() {
    if (this._noClose) return;
    if (this._rapidLayer) {
      this._rapidActive = false; this._rapidLayer = null; this._rapidLastFix = null;
      this.toast('Rapid capture stopped');
    }
    const d = this.state.draft;
    if (d && !this.state.placing && !this.state.draw && !this.state.editGeom) {
      for (const id of (d._newMediaIds || [])) await Media.remove(id);
      this.state.draft = null;
      this.toast(d.id ? 'Changes discarded' : 'Unsaved capture discarded');
    }
    this.closeSheet();
  },
  async goBackByUser() {
    const d = this.state.draft;
    if (d && !this.state.placing && !this.state.draw && !this.state.editGeom) {
      for (const id of (d._newMediaIds || [])) await Media.remove(id);
      this.state.draft = null;
      this.toast(d.id ? 'Changes discarded' : 'Unsaved capture discarded');
    }
    this.goBack();
  },

  // Lightweight navigation stack: navTo pushes the current screen so goBack can return to it.
  // rootNav resets the stack — use for screens reached directly from persistent map chrome.
  navTo(fn, args) { args = args || []; if (this._current) { this._navStack = this._navStack || []; this._navStack.push(this._current); } this._current = { fn, args }; fn.apply(this, args); },
  rootNav(fn, args) { args = args || []; this._navStack = []; this._current = { fn, args }; fn.apply(this, args); },
  goBack() { const prev = (this._navStack || []).pop(); if (!prev) { this.closeSheet(); return; } this._current = prev; prev.fn.apply(this, prev.args); },
  toast(msg, kind) { const w = document.getElementById('toastWrap'); w.innerHTML = `<div class="toast ${kind || ''}">${esc(msg)}</div>`; clearTimeout(this._tt); this._tt = setTimeout(() => { w.innerHTML = ''; }, 3000); },

  /* ---------- Projects ---------- */
  openProjectPicker() {
    const body = this.state.projects.length === 0
      ? `<div class="empty">${icon('folder', 44)}<h3>No projects yet</h3><p>Create a project, choose its coordinate system, then build your own layers.</p></div>`
      : this.state.projects.map((p) => {
          const lc = this.state.layers.filter((l) => l.projectId === p.id).length;
          const rc = this.state.records.filter((r) => r.projectId === p.id).length;
          return `<div class="tpl" data-pid="${p.id}"><div class="ic">${icon('folder', 21)}</div><div class="tx"><div class="t">${esc(p.name)}</div><div class="d">${lc} layer${lc !== 1 ? 's' : ''} · ${rc} record${rc !== 1 ? 's' : ''} · ${esc(p.crsName || 'WGS 84')}</div></div><div class="chev">${icon('chevron', 18)}</div></div>`;
        }).join('');
    this.openSheet('Projects', body, `<button class="btn btn-primary btn-block btn-lg" id="newProjBtn">${icon('plus', 17)} New project</button>`);
    document.getElementById('newProjBtn').onclick = () => this.navTo(this.newProjectForm);
    document.querySelectorAll('[data-pid]').forEach((el) => el.onclick = () => this.setProject(this.state.projects.find((p) => p.id === el.dataset.pid)));
  },

  newProjectForm() {
    const fix = this.state.lastFix;
    const utm = fix ? Geo.utmZoneFromLngLat(fix.lng, fix.lat) : null;
    const body = `
      <div class="field"><label class="lbl">Project name <span class="req">*</span></label><input class="inp" id="pName" placeholder="e.g. City Drainage Survey" /></div>
      <div class="field"><label class="lbl">Description</label><input class="inp" id="pDesc" placeholder="Optional" /></div>
      <div class="card" style="margin-top:4px"><div class="card-lbl">Project type <span class="req">*</span></div>
        <div class="seg" id="pMode"><button type="button" class="on" data-m="standard">Standard</button><button type="button" data-m="streaming">Streaming Capture</button></div>
        <div id="pStreamCfg" style="display:none;margin-top:11px">
          <div class="note" style="margin-bottom:10px">Coordinates are captured <b>automatically from live GPS</b> while you walk or drive. Auto-filled per feature: Z-value, coordinates, speed (m/s + km/h), direction (N/NE/E…), date & time. Optional: road name, road ID, community, district.</div>
          <div class="field"><label class="lbl">Feature class name <span class="req">*</span></label><input class="inp" id="pFeatClass" placeholder="e.g. Road_Centerline" /></div>
          <div class="field"><label class="lbl">Geometry type</label><div class="seg" id="pStreamGeom"><button type="button" class="on" data-g="point">Point</button><button type="button" data-g="line">Line</button><button type="button" data-g="polygon">Polygon</button></div></div>
          <div class="field" id="pTolWrap"><label class="lbl">Capture a point every</label><select class="sel" id="pTol"><option value="1">1 metre</option><option value="2">2 metres</option><option value="5">5 metres</option><option value="10">10 metres</option><option value="custom">Custom…</option></select><input class="inp" id="pTolCustom" style="display:none;margin-top:8px" placeholder="Distance in metres" inputmode="decimal" /></div>
          <div class="muted" id="pStreamHint">A new point record is saved silently each time you move that distance.</div>
        </div>
      </div>
      <div class="card" style="margin-top:4px"><div class="card-lbl">${icon('globe', 13, 'display:inline;vertical-align:-2px')} Coordinate system <span class="req">*</span></div>
        <div class="seg" id="crsKind" style="margin-bottom:11px"><button type="button" class="on" data-k="gcs">Geographic (GCS)</button><button type="button" data-k="utm">Projected (UTM)</button><button type="button" data-k="other">Other EPSG</button></div>
        <div id="crsGcs"><select class="sel" id="crsGcsSel"><option value="EPSG:4326|WGS 84 (GCS, lat/long)">WGS 84 (EPSG:4326) — most common</option><option value="EPSG:4269|NAD83 (GCS)">NAD83 (EPSG:4269)</option></select></div>
        <div id="crsUtm" style="display:none">
          <div class="note" style="margin-bottom:9px">${utm ? `Auto-detected from your location: <b>${utm.name}</b>` : 'Turn on GPS to auto-detect your UTM zone, or pick below.'}</div>
          <select class="sel" id="crsUtmSel">${this.utmOptions(utm ? utm.code : null)}</select>
        </div>
        <div id="crsOther" style="display:none"><input class="inp" id="crsOtherIn" placeholder="EPSG code e.g. 32643" inputmode="numeric" /><div class="muted" style="margin-top:5px">Enter any EPSG numeric code. WGS 84 UTM & common systems supported.</div></div>
      </div>
      <div class="note">Coordinates are captured in WGS 84 and re-projected to your chosen system for display and export — so your data stays correct.</div>`;
    this.openSheet('New project', body, `<button class="btn btn-ghost flex" id="pBack">Back</button><button class="btn btn-primary flex" id="pSave">${icon('check', 17)} Create</button>`);
    let kind = 'gcs', pmode = 'standard', sgeom = 'point';
    document.querySelectorAll('#pMode button').forEach((b) => b.onclick = () => { pmode = b.dataset.m; document.querySelectorAll('#pMode button').forEach((x) => x.classList.toggle('on', x === b)); document.getElementById('pStreamCfg').style.display = pmode === 'streaming' ? 'block' : 'none'; });
    const streamHints = { point: 'A new point record is saved silently each time you move that distance.', line: 'A vertex is added every 10 m and wherever your direction changes. Tap Stop to save the line.', polygon: 'A vertex is added every 10 m and at direction changes. Returning near your start point closes the polygon automatically and begins a new one.' };
    document.querySelectorAll('#pStreamGeom button').forEach((b) => b.onclick = () => { sgeom = b.dataset.g; document.querySelectorAll('#pStreamGeom button').forEach((x) => x.classList.toggle('on', x === b)); document.getElementById('pTolWrap').style.display = sgeom === 'point' ? 'block' : 'none'; document.getElementById('pStreamHint').textContent = streamHints[sgeom]; });
    document.getElementById('pTol').onchange = (e) => { document.getElementById('pTolCustom').style.display = e.target.value === 'custom' ? 'block' : 'none'; };
    document.querySelectorAll('#crsKind button').forEach((b) => b.onclick = () => { kind = b.dataset.k; document.querySelectorAll('#crsKind button').forEach((x) => x.classList.toggle('on', x === b)); document.getElementById('crsGcs').style.display = kind === 'gcs' ? 'block' : 'none'; document.getElementById('crsUtm').style.display = kind === 'utm' ? 'block' : 'none'; document.getElementById('crsOther').style.display = kind === 'other' ? 'block' : 'none'; });
    document.getElementById('pBack').onclick = () => this.goBack();
    document.getElementById('pSave').onclick = async () => {
      const name = document.getElementById('pName').value.trim();
      if (!name) { this.toast('Enter a project name', 'err'); return; }
      let crsCode = 'EPSG:4326', crsName = 'WGS 84 (GCS, lat/long)';
      if (kind === 'gcs') { const [c, n] = document.getElementById('crsGcsSel').value.split('|'); crsCode = c; crsName = n; }
      else if (kind === 'utm') { const v = document.getElementById('crsUtmSel').value; const [c, n] = v.split('|'); crsCode = c; crsName = n; }
      else { const code = document.getElementById('crsOtherIn').value.trim(); if (!/^\d+$/.test(code)) { this.toast('Enter a valid EPSG number', 'err'); return; } crsCode = `EPSG:${code}`; crsName = `EPSG:${code}`; if (typeof Geo !== 'undefined') Geo.ensureDef(crsCode); }
      const proj = { id: uid('proj'), name, description: document.getElementById('pDesc').value.trim(), crsCode, crsName, surveyor: this.state.user.name, role: this.state.user.role, createdAt: nowISO() };
      if (pmode === 'streaming') {
        const featureClass = document.getElementById('pFeatClass').value.trim().replace(/\s+/g, '_');
        if (!featureClass) { this.toast('Enter the feature class name', 'err'); return; }
        let tolerance = 1;
        if (sgeom === 'point') {
          const sel = document.getElementById('pTol').value;
          tolerance = sel === 'custom' ? Number(document.getElementById('pTolCustom').value) : Number(sel);
          if (!isFinite(tolerance) || tolerance <= 0) { this.toast('Enter a valid tolerance distance in metres', 'err'); return; }
        }
        proj.mode = 'streaming';
        proj.streamCfg = { featureClass, geomType: sgeom, tolerance };
      }
      await DB.put('projects', proj);
      this.state.projects.unshift(proj);
      this.setProject(proj);
      if (proj.mode === 'streaming') { await this.ensureStreamLayer(); this.renderStreamBar(); this.toast('Streaming project ready — tap Start when you are in position', 'ok'); }
      else this.toast('Project created', 'ok');
    };
  },

  utmOptions(selected) {
    let opts = '';
    for (let z = 1; z <= 60; z++) {
      const nCode = `EPSG:${32600 + z}`, sCode = `EPSG:${32700 + z}`;
      opts += `<option value="${nCode}|UTM Zone ${z}N (WGS 84)" ${selected === nCode ? 'selected' : ''}>UTM Zone ${z}N — ${nCode}</option>`;
      opts += `<option value="${sCode}|UTM Zone ${z}S (WGS 84)" ${selected === sCode ? 'selected' : ''}>UTM Zone ${z}S — ${sCode}</option>`;
    }
    return opts;
  },

  async setProject(p) {
    if (this.state.project && this.state.project.id !== p.id) await this.persistRoute();
    this.state.project = p;
    this.state.activeLayer = null;
    this.state.selectedRecord = null;
    this.state.selectedRecords = [];
    this.state.editingSession = false;
    this.state.route = { points: [], distanceM: 0, paused: false };
    localStorage.setItem('sm_project', p.id);
    document.getElementById('barProj').textContent = p.name;
    this.refreshBarSub();
    this.updateEditToolbar();
    this.renderAllLayers();
    await this.restoreRoute();
    this.startEditing(true);
    this.restoreImagery();
    this.closeSheet();
    // streaming projects have a dedicated bar; stop any streaming session left over from another project
    this._streamActive = false; this._streamPaused = false; this._streamVerts = []; this._streamCount = 0; this._streamPathLen = 0; this.clearStreamPreview();
    if (p.mode === 'streaming') {
      await this.ensureStreamLayer();
      this.renderStreamBar();
      setTimeout(() => this.updateGuidance(), 500);
      return;
    }
    const sb = document.getElementById('streamBar'); if (sb) sb.style.display = 'none';
    document.getElementById('collectBar').style.display = 'flex';
    // if no layers yet, prompt to create one
    const layers = this.state.layers.filter((l) => l.projectId === p.id);
    if (layers.length === 0) setTimeout(() => this.rootNav(this.projectStartChoice), 400);
    else setTimeout(() => this.updateGuidance(), 500);
  },
  refreshBarSub() {
    const p = this.state.project; if (!p) return;
    const lc = this.state.layers.filter((l) => l.projectId === p.id).length;
    const rc = this.state.records.filter((r) => r.projectId === p.id).length;
    document.getElementById('barSub').textContent = `${lc} layer${lc !== 1 ? 's' : ''} · ${rc} record${rc !== 1 ? 's' : ''} · ${p.crsName || 'WGS 84'}`;
  },

  /* ---------- Layers (feature classes) ---------- */
  openLayers() {
    if (!this.state.project) { this.toast('Select a project first', 'err'); this.rootNav(this.openProjectPicker); return; }
    const layers = this.state.layers.filter((l) => l.projectId === this.state.project.id);
    const body = layers.length === 0
      ? `<div class="empty">${icon('stack', 44)}<h3>No asset types yet</h3><p>Create an asset type, choose its point, line or polygon geometry, and define the attributes to collect.</p></div>`
      : layers.map((l) => {
          const n = this.state.records.filter((r) => r.layerId === l.id).length;
          const sw = this.symbSwatch(l);
          return `<div class="layer-row"><div class="layer-main" data-open="${l.id}"><div class="swatch">${sw}</div><div class="tx"><div class="t">${esc(l.name)}</div><div class="d">${l.geomType} · ${l.fields.length} field${l.fields.length !== 1 ? 's' : ''} · ${n} record${n !== 1 ? 's' : ''}</div></div></div><div class="layer-acts"><button class="mini" data-vis="${l.id}" title="Toggle visibility">${icon(l.hidden ? 'xCircle' : 'checkCircle', 17)}</button><button class="mini" data-symb="${l.id}" title="Symbology">${icon('palette', 17)}</button><button class="mini" data-editl="${l.id}" title="Edit layer">${icon('settings', 17)}</button></div></div>`;
        }).join('');
    this.openSheet(`Asset Types · ${this.state.project.name}`, body, `<button class="btn btn-primary btn-block btn-lg" id="newLayerBtn">${icon('plus', 17)} New Asset Type</button>`);
    document.getElementById('newLayerBtn').onclick = () => this.navTo(this.layerEditor, [null]);
    document.querySelectorAll('[data-open]').forEach((el) => el.onclick = () => { this.state.activeLayer = this.state.layers.find((l) => l.id === el.dataset.open); this.navTo(this.openRecords); });
    document.querySelectorAll('[data-symb]').forEach((el) => el.onclick = () => this.navTo(this.symbologyEditor, [el.dataset.symb]));
    document.querySelectorAll('[data-editl]').forEach((el) => el.onclick = () => this.navTo(this.layerEditor, [this.state.layers.find((l) => l.id === el.dataset.editl)]));
    document.querySelectorAll('[data-vis]').forEach((el) => el.onclick = async () => { const l = this.state.layers.find((x) => x.id === el.dataset.vis); l.hidden = !l.hidden; await DB.put('layers', l); this.renderAllLayers(); this.openLayers(); });
  },

  symbSwatch(l) {
    const s = l.symbology || {};
    const c = s.color || '#0079C1';
    if (l.geomType === 'line') return `<span style="display:block;width:22px;height:0;border-top:${(s.weight || 4)}px solid ${c};border-radius:2px"></span>`;
    if (l.geomType === 'polygon') return `<span style="display:block;width:22px;height:16px;background:${c}33;border:2px solid ${c};border-radius:3px"></span>`;
    return `<span style="display:block;width:${Math.min(22, (s.size || 7) * 2)}px;height:${Math.min(22, (s.size || 7) * 2)}px;background:${c};border:2px solid #fff;border-radius:50%;box-shadow:0 0 0 1px ${c}"></span>`;
  },
});

/* ============================================================
   Part 3 — Layer editor (custom attributes) + symbology
   ============================================================ */
Object.assign(App, {
  layerEditor(existing) {
    const newColor = existing ? null : this.nextLayerColor();
    const l = existing ? JSON.parse(JSON.stringify(existing)) : { id: uid('lyr'), projectId: this.state.project.id, name: '', geomType: 'point', fields: [], symbology: this.defaultSymb('point', newColor), createdAt: nowISO() };
    this._layerDraft = l;
    const geomLocked = !!existing && this.state.records.some((r) => r.layerId === l.id);
    const body = `
      <div class="field"><label class="lbl">Type Asset Name <span class="req">*</span></label><input class="inp" id="lName" value="${esc(l.name)}" placeholder="Enter asset type name" /></div>
      <div class="field"><label class="lbl">Geometry type <span class="req">*</span></label>
        <div class="geo-types" id="lGeom">${['point', 'line', 'polygon'].map((g) => `<div class="geo-type ${g} ${l.geomType === g ? 'on' : ''}" data-g="${g}" ${geomLocked ? 'style="opacity:.5;pointer-events:none"' : ''}>${icon(g, 26)}<div class="n">${g[0].toUpperCase() + g.slice(1)}</div></div>`).join('')}</div>
        ${geomLocked ? '<div class="muted" style="margin-top:6px">Geometry type is locked because this layer already has records.</div>' : ''}
      </div>
      <div class="card"><div class="card-lbl"><span>Attributes / fields</span><button class="btn-text" id="addField" style="padding:0">${icon('plus', 15, 'display:inline;vertical-align:-2px')} Add field</button></div>
        <div class="note" style="margin-bottom:10px">Every layer automatically includes <b>Z_Elevation</b> (auto-filled) plus record ID, surveyor, role and timestamps. Add your own fields below.</div>
        <div id="fieldList"></div>
      </div>`;
    this.openSheet(existing ? 'Edit Asset Type' : 'New Asset Type', body, `<button class="btn btn-ghost flex" id="lBack">Back</button>${existing ? `<button class="btn btn-danger" id="lDel">${icon('trash', 16)}</button>` : ''}<button class="btn btn-primary flex" id="lSave">${icon('check', 16)} Save Asset Type</button>`);
    if (!geomLocked) document.querySelectorAll('#lGeom [data-g]').forEach((el) => el.onclick = () => { const keep = l.symbology && l.symbology.color; l.geomType = el.dataset.g; if (!existing) l.symbology = this.defaultSymb(l.geomType, keep); document.querySelectorAll('#lGeom [data-g]').forEach((x) => x.classList.toggle('on', x === el)); });
    const renderFields = () => {
      const host = document.getElementById('fieldList');
      host.innerHTML = l.fields.length === 0 ? '<div class="muted" style="padding:4px 0">No custom fields yet.</div>' : l.fields.map((f, i) => {
        const others = l.fields.filter((x, xi) => xi !== i && x.label.trim());
        const cond = f.condition || null;
        return `
        <div class="fld-item">
          <div class="fld-head"><input class="inp fld-name" data-i="${i}" value="${esc(f.label)}" placeholder="Field name" style="flex:1" />
            <select class="sel fld-type" data-i="${i}" style="width:120px">${['text', 'number', 'select', 'bool', 'date', 'time'].map((t) => `<option value="${t}" ${f.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
            <button class="mini" data-rmf="${i}">${icon('trash', 16)}</button></div>
          ${f.type === 'select' ? `<input class="inp fld-opts" data-i="${i}" value="${esc((f.options || []).join(', '))}" placeholder="Options, comma-separated" style="margin-top:7px" />` : ''}
          <label class="fld-req"><input type="checkbox" class="fld-reqcb" data-i="${i}" ${f.required ? 'checked' : ''} /> required</label>
          ${others.length ? `
          <div class="fld-cond">
            <label class="fld-req"><input type="checkbox" class="fld-condcb" data-i="${i}" ${cond ? 'checked' : ''} /> only show this field when…</label>
            <div class="fld-cond-row" data-i="${i}" style="display:${cond ? 'flex' : 'none'}">
              <select class="sel fld-cond-field" data-i="${i}" style="flex:1">${others.map((o) => `<option value="${o.key || o.label}" ${cond && cond.field === (o.key || o.label) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
              <select class="sel fld-cond-op" data-i="${i}" style="width:88px"><option value="equals" ${cond && cond.op === 'equals' ? 'selected' : ''}>=</option><option value="not_equals" ${cond && cond.op === 'not_equals' ? 'selected' : ''}>≠</option></select>
              <input class="inp fld-cond-val" data-i="${i}" value="${esc(cond ? cond.value : '')}" placeholder="value" style="flex:1" />
            </div>
          </div>` : ''}
        </div>`;
      }).join('');
      host.querySelectorAll('.fld-name').forEach((el) => el.oninput = () => { l.fields[el.dataset.i].label = el.value; });
      host.querySelectorAll('.fld-type').forEach((el) => el.onchange = () => { l.fields[el.dataset.i].type = el.value; renderFields(); });
      host.querySelectorAll('.fld-opts').forEach((el) => el.oninput = () => { l.fields[el.dataset.i].options = el.value.split(',').map((s) => s.trim()).filter(Boolean); });
      host.querySelectorAll('.fld-reqcb').forEach((el) => el.onchange = () => { l.fields[el.dataset.i].required = el.checked; });
      host.querySelectorAll('[data-rmf]').forEach((el) => el.onclick = () => { l.fields.splice(parseInt(el.dataset.rmf), 1); renderFields(); });
      host.querySelectorAll('.fld-condcb').forEach((el) => el.onchange = () => {
        const i = parseInt(el.dataset.i);
        if (el.checked) { const row = host.querySelector(`.fld-cond-row[data-i="${i}"]`); const fEl = host.querySelector(`.fld-cond-field[data-i="${i}"]`); const opEl = host.querySelector(`.fld-cond-op[data-i="${i}"]`); const valEl = host.querySelector(`.fld-cond-val[data-i="${i}"]`); if (row) row.style.display = 'flex'; l.fields[i].condition = { field: fEl ? fEl.value : '', op: opEl ? opEl.value : 'equals', value: valEl ? valEl.value : '' }; }
        else { delete l.fields[i].condition; renderFields(); }
      });
      host.querySelectorAll('.fld-cond-field').forEach((el) => el.onchange = () => { const i = parseInt(el.dataset.i); if (l.fields[i].condition) l.fields[i].condition.field = el.value; });
      host.querySelectorAll('.fld-cond-op').forEach((el) => el.onchange = () => { const i = parseInt(el.dataset.i); if (l.fields[i].condition) l.fields[i].condition.op = el.value; });
      host.querySelectorAll('.fld-cond-val').forEach((el) => el.oninput = () => { const i = parseInt(el.dataset.i); if (l.fields[i].condition) l.fields[i].condition.value = el.value; });
    };
    renderFields();
    document.getElementById('addField').onclick = () => { l.fields.push({ id: uid('f'), label: '', type: 'text', required: false }); renderFields(); };
    document.getElementById('lBack').onclick = () => this.goBack();
    if (existing) document.getElementById('lDel').onclick = async () => {
      if (!confirm(`Delete layer "${l.name}" and ALL its records? This cannot be undone.`)) return;
      const recs = this.state.records.filter((r) => r.layerId === l.id);
      for (const r of recs) { for (const m of (r.media || [])) if (!m.dataUrl) await Media.remove(m.id); await DB.del('records', r.id); }
      this.state.records = this.state.records.filter((r) => r.layerId !== l.id);
      await DB.del('layers', l.id);
      this.state.layers = this.state.layers.filter((x) => x.id !== l.id);
      this.renderAllLayers(); this.refreshBarSub(); this.toast('Layer deleted'); this.goBack();
    };
    document.getElementById('lSave').onclick = async () => {
      l.name = document.getElementById('lName').value.trim();
      if (!l.name) { this.toast('Enter the asset type name', 'err'); return; }
      // Preserve existing field identifiers when labels change. New identifiers are
      // normalized once, then checked for collisions before any schema is saved.
      const normalizedFields = l.fields.filter((f) => f.label.trim()).map((f) => ({
        ...f,
        id: f.id || uid('f'),
        key: f.key || f.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      }));
      const keyCounts = normalizedFields.reduce((m, f) => m.set(f.key, (m.get(f.key) || 0) + 1), new Map());
      const duplicateKeys = [...keyCounts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
      if (duplicateKeys.length) {
        this.toast(`Field names create duplicate key${duplicateKeys.length > 1 ? 's' : ''}: ${duplicateKeys.join(', ')}`, 'err');
        return;
      }
      l.fields = normalizedFields;
      // conditions were recorded against a temp key-or-label; remap to the final generated key
      l.fields.forEach((f) => { if (f.condition && f.condition.field && !l.fields.some((x) => x.key === f.condition.field)) { const match = l.fields.find((x) => x.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') === f.condition.field || x.label === f.condition.field); if (match) f.condition.field = match.key; else delete f.condition; } });
      await DB.put('layers', l);
      const i = this.state.layers.findIndex((x) => x.id === l.id);
      if (i >= 0) this.state.layers[i] = l; else this.state.layers.push(l);
      this.renderAllLayers(); this.refreshBarSub();
      this.toast('Asset type saved', 'ok'); this.rootNav(this.afterLayerSaved, [l]);
    };
  },

  LAYER_PALETTE: ['#E14B3B', '#0079C1', '#35AC46', '#F0A324', '#7A4FBF', '#00A0B0', '#D6336C', '#8B5A2B', '#111827', '#5C940D'],
  nextLayerColor() {
    const used = this.state.layers.filter((l) => l.projectId === (this.state.project && this.state.project.id)).map((l) => (l.symbology && l.symbology.color || '').toLowerCase());
    for (const c of this.LAYER_PALETTE) if (!used.includes(c.toLowerCase())) return c;
    return this.LAYER_PALETTE[this.state.layers.length % this.LAYER_PALETTE.length];
  },
  defaultSymb(geom, color) {
    const c = color || '#0079C1';
    if (geom === 'line') return { color: c, weight: 4, opacity: 1 };
    if (geom === 'polygon') return { color: c, weight: 2, opacity: 1, fillOpacity: 0.25 };
    return { color: c, size: 7, weight: 2, opacity: 1 };
  },

  symbologyEditor(layerId) {
    const l = this.state.layers.find((x) => x.id === layerId); if (!l) return;
    const s = Object.assign(this.defaultSymb(l.geomType), l.symbology || {});
    const palette = ['#E14B3B', '#F0A324', '#35AC46', '#0079C1', '#7A4FBF', '#111827', '#00A0B0', '#D6336C', '#8B5A2B', '#ffffff'];
    const body = `
      <div class="card"><div class="card-lbl">Preview</div><div style="display:grid;place-items:center;padding:18px;background:var(--grey-100);border-radius:9px"><div id="symbPreview">${this.symbSwatch({ geomType: l.geomType, symbology: s })}</div></div></div>
      <div class="field"><label class="lbl">Color</label><div class="palette" id="palette">${palette.map((c) => `<button class="sw ${c.toLowerCase() === (s.color || '').toLowerCase() ? 'on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}<input type="color" id="customColor" value="${s.color || '#0079C1'}" class="sw-custom" /></div></div>
      ${l.geomType === 'point' ? `<div class="field"><label class="lbl">Size — <span id="sizeVal">${s.size}</span> px</label><input type="range" id="sizeR" min="3" max="16" value="${s.size}" class="range" /></div>` : ''}
      ${l.geomType !== 'point' ? `<div class="field"><label class="lbl">Line thickness — <span id="wVal">${s.weight}</span> px</label><input type="range" id="wR" min="1" max="10" value="${s.weight}" class="range" /></div>` : ''}
      ${l.geomType === 'polygon' ? `<div class="field"><label class="lbl">Fill opacity — <span id="foVal">${Math.round((s.fillOpacity ?? 0.25) * 100)}</span>%</label><input type="range" id="foR" min="0" max="100" value="${Math.round((s.fillOpacity ?? 0.25) * 100)}" class="range" /></div>` : ''}
      <div class="field"><label class="lbl">Opacity — <span id="oVal">${Math.round((s.opacity ?? 1) * 100)}</span>%</label><input type="range" id="oR" min="20" max="100" value="${Math.round((s.opacity ?? 1) * 100)}" class="range" /></div>`;
    this.openSheet(`Symbology · ${l.name}`, body, `<button class="btn btn-ghost flex" id="symBack">Back</button><button class="btn btn-primary flex" id="symSave">${icon('check', 16)} Apply</button>`);
    const upd = () => { document.getElementById('symbPreview').innerHTML = this.symbSwatch({ geomType: l.geomType, symbology: s }); };
    document.querySelectorAll('#palette .sw').forEach((b) => b.onclick = () => { s.color = b.dataset.c; document.querySelectorAll('#palette .sw').forEach((x) => x.classList.toggle('on', x === b)); upd(); });
    document.getElementById('customColor').oninput = (e) => { s.color = e.target.value; document.querySelectorAll('#palette .sw').forEach((x) => x.classList.remove('on')); upd(); };
    const sizeR = document.getElementById('sizeR'); if (sizeR) sizeR.oninput = (e) => { s.size = +e.target.value; document.getElementById('sizeVal').textContent = e.target.value; upd(); };
    const wR = document.getElementById('wR'); if (wR) wR.oninput = (e) => { s.weight = +e.target.value; document.getElementById('wVal').textContent = e.target.value; upd(); };
    const foR = document.getElementById('foR'); if (foR) foR.oninput = (e) => { s.fillOpacity = +e.target.value / 100; document.getElementById('foVal').textContent = e.target.value; upd(); };
    const oR = document.getElementById('oR'); if (oR) oR.oninput = (e) => { s.opacity = +e.target.value / 100; document.getElementById('oVal').textContent = e.target.value; upd(); };
    document.getElementById('symBack').onclick = () => this.goBack();
    document.getElementById('symSave').onclick = async () => { l.symbology = s; await DB.put('layers', l); const i = this.state.layers.findIndex((x) => x.id === l.id); this.state.layers[i] = l; this.renderAllLayers(); this.toast('Symbology applied', 'ok'); this.goBack(); };
  },
});

/* ============================================================
   Part 4 — Render layers on map, records list, detail, geometry edit
   ============================================================ */
Object.assign(App, {
  renderAllLayers() {
    if (!this.state.map) return;
    Object.values(this.state.layerGroups).forEach((g) => this.state.map.removeLayer(g));
    this.state.layerGroups = {};
    if (!this.state.project) return;
    const layers = this.state.layers.filter((l) => l.projectId === this.state.project.id);
    layers.forEach((l) => {
      const group = L.layerGroup();
      if (!l.hidden) group.addTo(this.state.map);
      this.state.layerGroups[l.id] = group;
      const recs = this.state.records.filter((r) => r.layerId === l.id);
      recs.forEach((r) => this.addFeatureToMap(r, l, group));
    });
    this.bringLayersFront();
  },

  addFeatureToMap(r, l, group) {
    const g = Exporter.geometryOf(r); if (!g) return;
    const s = Object.assign(this.defaultSymb(l.geomType), l.symbology || {});
    let layer;
    const selected = (this.state.selectedRecords || []).some((x) => x.id === r.id);
    if (g.type === 'Point') layer = L.circleMarker([g.coordinates[1], g.coordinates[0]], { radius: selected ? (s.size || 7) + 4 : s.size || 7, color: selected ? '#FFD24A' : '#fff', weight: selected ? 4 : 2, opacity: s.opacity ?? 1, fillColor: s.color, fillOpacity: s.opacity ?? 1 });
    else if (g.type === 'LineString') layer = L.polyline(g.coordinates.map((c) => [c[1], c[0]]), { color: selected ? '#FFD24A' : s.color, weight: selected ? (s.weight || 4) + 4 : s.weight || 4, opacity: s.opacity ?? 1 });
    else if (g.type === 'Polygon') layer = L.polygon(g.coordinates[0].map((c) => [c[1], c[0]]), { color: selected ? '#FFD24A' : s.color, weight: selected ? 5 : s.weight || 2, opacity: s.opacity ?? 1, fillOpacity: selected ? 0.38 : s.fillOpacity ?? 0.25 });
    if (layer) {
      layer.bindTooltip(this.recTitle(r, l), { direction: 'top' });
      this.wireMapFeature(layer, r, l);
      if (g.type === 'LineString') {
        const hit = L.polyline(g.coordinates.map((c) => [c[1], c[0]]), { color: '#000', weight: 24, opacity: 0.001, interactive: true });
        this.wireMapFeature(hit, r, l); group.addLayer(hit);
      }
      group.addLayer(layer);
    }
  },
  wireMapFeature(layer, record, featureLayer) {
    layer.on('mouseover', () => {
      clearTimeout(this._geometryHoverTimer);
      const mapEl = document.getElementById('map'); if (mapEl) mapEl.classList.add('geometry-hover');
    });
    layer.on('mouseout', () => {
      clearTimeout(this._geometryHoverTimer);
      this._geometryHoverTimer = setTimeout(() => { const mapEl = document.getElementById('map'); if (mapEl) mapEl.classList.remove('geometry-hover'); }, 20);
    });
    layer.on('click', (e) => {
      if (L.DomEvent) L.DomEvent.stopPropagation(e);
      if (this.state.activeTool === 'box' || this.state.activeTool === 'pan') return;
      if (this.state.placing || this.state.draw) { this.onMapClick(e); return; }
      if (this.state.editGeom) return;
      if (this.state.splittingLine && this.state.selectedRecord && this.state.selectedRecord.id === record.id) { this.splitSelectedLineAt(e.latlng); return; }
      const now = Date.now();
      const previous = this._lastFeatureTap;
      clearTimeout(this._featureClickTimer);
      if (previous && previous.id === record.id && now - previous.time < 550) {
        this._lastFeatureTap = null;
        if (!this.state.editingSession) this.startEditing(true);
        this.state.selectedRecord = record; this.state.selectedRecords = [record];
        this.setActiveTool('vertices'); this.startEditGeom(record, featureLayer);
        return;
      }
      this._lastFeatureTap = { id: record.id, time: now };
      const additive = !!(e.originalEvent && (e.originalEvent.ctrlKey || e.originalEvent.shiftKey));
      const pending = additive ? (this.state.selectedRecords || []).slice() : [];
      if (!pending.some((r) => r.id === record.id)) pending.push(record);
      this.state.selectedRecord = record; this.state.selectedRecords = pending;
      this.updateEditToolbar();
      this._featureClickTimer = setTimeout(() => {
        this._lastFeatureTap = null;
        this.renderAllLayers(); this.updateEditToolbar();
        this.toast(`${record.layerName || 'Feature'} selected · double-click to edit`, 'ok');
      }, 550);
    });
    layer.on('dblclick', (e) => {
      if (L.DomEvent) { L.DomEvent.stopPropagation(e); L.DomEvent.preventDefault(e); }
      if (this.state.placing || this.state.draw || this.state.editGeom || ['box', 'create'].includes(this.state.activeTool)) return;
      clearTimeout(this._featureClickTimer);
      if (!this.state.editingSession) this.startEditing(true);
      this.state.selectedRecord = record; this.state.selectedRecords = [record];
      this.setActiveTool('vertices');
      this.startEditGeom(record, featureLayer);
    });
  },

  /* ---------- Records ---------- */
  openRecords() {
    if (!this.state.project) { this.toast('Select a project first', 'err'); return; }
    this._filter = this._filter || 'all'; this._search = '';
    this.renderRecords();
  },
  renderRecords() {
    const pid = this.state.project.id;
    const layerFilter = this.state.activeLayer;
    let list = this.state.records.filter((r) => r.projectId === pid);
    if (layerFilter) list = list.filter((r) => r.layerId === layerFilter.id);
    if (this._filter === 'needs_attributes') list = list.filter((r) => r.status === 'needs_attributes');
    else if (this._filter === 'completed') list = list.filter((r) => r.status === 'completed');
    else if (this._filter === 'draft') list = list.filter((r) => r.status === 'draft');
    if (this._search && this._search.trim()) { const q = this._search.toLowerCase(); list = list.filter((r) => JSON.stringify(r.data || {}).toLowerCase().includes(q) || (r.layerName || '').toLowerCase().includes(q)); }
    list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    const layers = this.state.layers.filter((l) => l.projectId === pid);
    const incomplete = this.state.records.filter((r) => r.projectId === pid && (!layerFilter || r.layerId === layerFilter.id) && r.status === 'needs_attributes');
    const title = layerFilter ? layerFilter.name : 'All records';
    const body = `
      <div class="tools-row"><div class="search">${icon('search', 16)}<input id="recSearch" placeholder="Search" value="${esc(this._search || '')}" /></div>${layerFilter ? `<button class="btn btn-ghost" id="allLayers">All layers</button>` : ''}</div>
      <div class="filters">${[['all','All'],['needs_attributes',`Needs attributes (${incomplete.length})`],['completed','Complete'],['draft','Draft']].map(([id, name]) => `<button class="filter ${this._filter === id ? 'on' : ''}" data-status="${id}">${name}</button>`).join('')}</div>
      ${incomplete.length ? `<button class="btn btn-primary btn-block" id="nextIncomplete" style="margin-bottom:10px">${icon('edit', 16)} Complete next incomplete record</button>` : ''}
      ${!layerFilter && layers.length ? `<div class="filters">${[{ id: null, name: 'All' }].concat(layers).map((l) => `<button class="filter ${(!this._layerChip && !l.id) || this._layerChip === l.id ? 'on' : ''}" data-lc="${l.id || ''}">${esc(l.name)}</button>`).join('')}</div>` : ''}
      ${list.length === 0 ? `<div class="empty">${icon('list', 44)}<p>${this._search ? 'No records match.' : 'No records yet. Tap Collect to add.'}</p></div>` : this.groupedRecRows(list)}`;
    this.openSheet(`${title} · ${this.state.project.name}`, body);
    const srch = document.getElementById('recSearch');
    srch.oninput = (e) => { this._search = e.target.value; this.renderRecords(); setTimeout(() => { const n = document.getElementById('recSearch'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 0); };
    const al = document.getElementById('allLayers'); if (al) al.onclick = () => { this.state.activeLayer = null; this.renderRecords(); };
    document.querySelectorAll('[data-status]').forEach((el) => el.onclick = () => { this._filter = el.dataset.status; this.renderRecords(); });
    const ni = document.getElementById('nextIncomplete'); if (ni) ni.onclick = () => this.navTo(this.startCollect, [incomplete[0]]);
    document.querySelectorAll('[data-lc]').forEach((el) => el.onclick = () => { this._layerChip = el.dataset.lc || null; this.state.activeLayer = this._layerChip ? this.state.layers.find((l) => l.id === this._layerChip) : null; this.renderRecords(); });
    document.querySelectorAll('[data-rid]').forEach((el) => el.onclick = () => this.navTo(this.openDetail, [el.dataset.rid]));
  },
  /* One feature class = one group. Records are grouped under their layer with a count,
     so it is visually explicit that they are features of a single layer, not separate
     layers — mirroring an attribute table grouped by feature class. */
  groupedRecRows(list) {
    const groups = new Map();
    list.forEach((r) => {
      const l = this.state.layers.find((x) => x.id === r.layerId);
      const key = l ? l.id : (r.layerName || '?');
      if (!groups.has(key)) groups.set(key, { name: (l ? l.name : (r.layerName || 'Records')), geomType: (l ? l.geomType : r.geomType) || 'point', rows: [] });
      groups.get(key).rows.push(r);
    });
    let html = '';
    for (const g of groups.values()) {
      html += `<div class="rec-group"><span class="rg-ico">${icon(g.geomType === 'line' ? 'line' : g.geomType === 'polygon' ? 'polygon' : 'point', 13)}</span>` +
        `<span class="rg-name">${esc(g.name)}</span><span class="rg-count">${g.rows.length} record${g.rows.length === 1 ? '' : 's'} · 1 layer</span></div>`;
      html += g.rows.map((r) => this.recRow(r)).join('');
    }
    return html;
  },
  recRow(r) {
    const l = this.state.layers.find((x) => x.id === r.layerId);
    const gi = r.geomType === 'point' ? 'point' : r.geomType === 'line' ? 'line' : 'polygon';
    const title = this.recTitle(r, l);
    const media = (r.media || []).length;
    const sw = l ? this.symbSwatch(l) : '';
    return `<div class="rec s-${r.status}" data-rid="${r.id}"><div class="g">${sw || icon(gi, 18)}</div><div class="b"><div class="t">${esc(title)}</div><div class="m"><span>${esc(l ? l.name : r.layerName)}</span><span>${esc(fmtDate(r.updatedAt))}</span>${r.location && r.location.z != null ? `<span>Z ${(+r.location.z).toFixed(1)}m</span>` : ''}${media ? `<span>${icon('camera', 10, 'display:inline;vertical-align:-1px')} ${media}</span>` : ''}</div></div>${icon('chevron', 16, 'color:var(--grey-400);flex-shrink:0')}</div>`;
  },
  recTitle(r, l) {
    if (l && l.fields.length) { const first = l.fields[0]; const v = r.data && r.data[first.key]; if (v) return `${v}`; }
    return (r.data && (r.data.name || r.data.id)) || `${l ? l.name : 'Record'} ${r.id.slice(-4)}`;
  },

  openDetail(rid) {
    const r = this.state.records.find((x) => x.id === rid); if (!r) return;
    const l = this.state.layers.find((x) => x.id === r.layerId);
    const g = Exporter.geometryOf(r);
    const crs = this.state.project.crsCode;
    let geo = '';
    if (g) { const c = g.type === 'Point' ? g.coordinates : (g.type === 'LineString' ? g.coordinates[0] : g.coordinates[0][0]); geo = (typeof Geo !== 'undefined') ? Geo.format([c[0], c[1]], crs) : `${c[1].toFixed(6)}, ${c[0].toFixed(6)}`; }
    const rows = (l ? l.fields : []).map((f) => `<tr><td class="k">${esc(f.label)}</td><td class="v">${esc((r.data && r.data[f.key]) || '—')}</td></tr>`).join('');
    const body = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><span class="badge ${r.status}">${(r.status || '').replace('_', ' ')}</span><span class="muted">${esc(fmtDate(r.updatedAt))}</span></div>
      <table class="attr">
        ${rows}
        ${geo ? `<tr><td class="k">Coordinates <span class="muted">(${esc(this.state.project.crsName)})</span></td><td class="v" style="font-family:var(--mono);font-size:12px">${geo}</td></tr>` : ''}
        <tr><td class="k">Z_Elevation</td><td class="v" style="font-family:var(--mono)">${r.location && r.location.z != null ? (+r.location.z).toFixed(2) + ' m' : '—'}</td></tr>
        <tr><td class="k">Surveyor</td><td class="v">${esc(r.surveyor || '—')} ${r.role ? `<span class="muted">· ${esc(r.role)}</span>` : ''}</td></tr>
      </table>
      ${(r.media || []).length ? `<div class="card-lbl" style="margin-top:16px">Photos & video (${r.media.length})</div><div class="media-grid">${r.media.map((m, i) => this.mediaThumb(m, i)).join('')}</div>` : ''}`;
    const geomLbl = r.geomType === 'point' ? 'Move' : 'Vertices';
    const foot = `${g ? `<button class="btn btn-ghost tb" id="dZoom">${icon('mapPin', 16)}<span>Zoom</span></button><button class="btn btn-ghost tb" id="dGeom" title="${r.geomType === 'point' ? 'Drag or tap the new position' : 'Drag square vertices · use diamonds to add or move segments · undo/redo'}">${icon('move', 16)}<span>${geomLbl}</span></button>` : ''}<button class="btn btn-ghost tb flex" id="dEdit">${icon('pencil', 16)}<span>Edit</span></button><button class="btn btn-danger tb" id="dDel">${icon('trash', 16)}<span>Delete</span></button>`;
    this.openSheet(l ? l.name : 'Record', body, foot);
    this.hydrateMedia(r.media);
    if (g) {
      document.getElementById('dZoom').onclick = () => { this.closeSheet(); const c = g.type === 'Point' ? g.coordinates : (g.type === 'LineString' ? g.coordinates[0] : g.coordinates[0][0]); this.state.map.setView([c[1], c[0]], 18); };
      document.getElementById('dGeom').onclick = () => this.startEditGeom(r, l);
    }
    document.getElementById('dEdit').onclick = () => this.navTo(this.startCollect, [r]);
    let cd = false; const db = document.getElementById('dDel');
    db.onclick = async () => {
      if (!cd) { cd = true; db.innerHTML = `${icon('alert', 16)}`; this.toast('Tap again to delete'); return; }
      if (!this.state.editingSession) this.startEditing(true);
      this.captureSessionUndo();
      for (const m of (r.media || [])) if (!m.dataUrl) this.queueMediaDelete(m.id);
      await DB.del('records', r.id);
      this.state.records = this.state.records.filter((x) => x.id !== r.id);
      this.renderAllLayers(); this.refreshBarSub(); this.toast('Record deleted · Save or discard the edit session', 'ok'); this.goBack();
    };
  },

  mediaThumb(m, i, removable) {
    const geo = (m.lat != null) ? `<div class="geo">${icon('mapPin', 8)} geo</div>` : '';
    const rm = removable ? `<div class="rm" data-rm="${i}">${icon('x', 13)}</div>` : '';
    if (m.type === 'video') return `<div class="mi"><video data-media="${m.id}" ${m.dataUrl ? `src="${m.dataUrl}"` : ''} muted></video><div class="vic">${icon('play', 28)}</div><div class="tag">video</div>${geo}${rm}</div>`;
    if (m.type === 'file') return `<div class="mi" style="display:grid;place-items:center;color:var(--grey-400)">${icon('file', 26)}<div class="tag">${esc((m.name || 'file').split('.').pop())}</div>${rm}</div>`;
    return `<div class="mi"><img data-media="${m.id}" ${m.dataUrl ? `src="${m.dataUrl}"` : ''} alt="" /><div class="tag">photo</div>${geo}${rm}</div>`;
  },
  // Fill in blob-backed thumbnails after the sheet renders (legacy dataUrl entries already have src)
  async hydrateMedia(mediaList) {
    for (const m of (mediaList || [])) {
      if (m.dataUrl) continue;
      const el = document.querySelector(`[data-media="${m.id}"]`);
      if (!el || el.src) continue;
      const url = await Media.url(m);
      if (url && document.contains(el)) el.src = url;
    }
  },

  /* ---------- Edit geometry on map ---------- */
  startEditGeom(r, l) {
    if (!this.state.map) { this.toast('Map not ready', 'err'); return; }
    const g = Exporter.geometryOf(r); if (!g) return;
    this.closeSheet();
    this.hideCollectBar();
    this.state.editGeom = { record: r, layer: l, mode: r.geomType, coords: [] };
    this.updateEditToolbar();
    if (g.type === 'Point') {
      this.state.map.setView([g.coordinates[1], g.coordinates[0]], Math.max(this.state.map.getZoom(), 17));
      document.getElementById('tapHintText').textContent = 'Drag the marker to the new position — or tap the map';
      document.getElementById('tapHint').classList.add('show');
      document.getElementById('map').classList.add('placing-cursor');
      // draggable handle at the current position: precise moves without hunting for the spot
      const eg = this.state.editGeom;
      eg._moveMarker = L.marker([g.coordinates[1], g.coordinates[0]], {
        draggable: true, zIndexOffset: 900,
        icon: L.divIcon({ className: 'v-node', html: '', iconSize: [22, 22] }),
      }).addTo(this.state.map);
      eg._moveMarker.on('dragend', (ev) => {
        const p = ev.target.getLatLng();
        const snapped = this.snapCoordinate(p, r.id);
        this.applyPointMove(snapped[1], snapped[0]);
      });
    } else {
      // Load the feature's existing vertices so it can be MODIFIED rather than redrawn.
      const ring = g.type === 'Polygon' ? (g.coordinates[0] || []) : (g.coordinates || []);
      const coords = ring.map((c) => [c[0], c[1]]);
      // a polygon ring repeats its first point at the end — drop it while editing, re-add on save
      if (g.type === 'Polygon' && coords.length > 1) {
        const a = coords[0], b = coords[coords.length - 1];
        if (a[0] === b[0] && a[1] === b[1]) coords.pop();
      }
      const eg = this.state.editGeom;
      eg.coords = coords;
      eg.vertexEdit = true;                 // enables drag / insert / delete handles
      eg.activeVertex = null;
      eg._undo = []; eg._redo = [];
      eg._reLayer = L.layerGroup().addTo(this.state.map);
      this.state.map.doubleClickZoom.disable();
      const sb = document.getElementById('sketchBar');
      sb.classList.add('show'); sb.classList.add('editing');
      const hint = document.getElementById('skHint');
      if (hint) hint.textContent = 'drag square vertex · click small diamond to insert · drag diamond to move edge';
      this.redrawSketch(eg);
      this.updateSketchCount();
      try { const b2 = L.latLngBounds(coords.map((c) => [c[1], c[0]])); if (b2.isValid()) this.state.map.fitBounds(b2.pad(0.25)); } catch (e) {}
    }
  },
  /* ---------- vertex-edit history (undo / redo) ---------- */
  pushGeomUndo(dr) {
    if (!dr) return;
    dr._undo = dr._undo || []; dr._redo = [];
    dr._undo.push(JSON.stringify(dr.coords));
    if (dr._undo.length > 60) dr._undo.shift();
    this.updateEditToolbar();
  },
  geomUndo() {
    const dr = this.state.editGeom || this.state.draw;
    if (!dr || !dr._undo || !dr._undo.length) { this.toast('Nothing to undo'); return; }
    dr._redo = dr._redo || [];
    dr._redo.push(JSON.stringify(dr.coords));
    dr.coords = JSON.parse(dr._undo.pop());
    dr.activeVertex = null;
    this.redrawSketch(dr); this.updateSketchCount();
    this.updateEditToolbar();
  },
  geomRedo() {
    const dr = this.state.editGeom || this.state.draw;
    if (!dr || !dr._redo || !dr._redo.length) { this.toast('Nothing to redo'); return; }
    dr._undo = dr._undo || [];
    dr._undo.push(JSON.stringify(dr.coords));
    dr.coords = JSON.parse(dr._redo.pop());
    dr.activeVertex = null;
    this.redrawSketch(dr); this.updateSketchCount();
    this.updateEditToolbar();
  },
  /* Commit a point move — used by both drag (marker) and tap (map). */
  applyPointMove(lat, lng) {
    const eg = this.state.editGeom; if (!eg || !eg.record) return;
    const r = eg.record;
    this.captureSessionUndo();
    r.geometry = { type: 'Point', coordinates: [lng, lat, (r.location && r.location.z != null) ? r.location.z : 0] };
    r.location = Object.assign(r.location || {}, { lat, lng });
    this.dropPin({ lat, lng }, '#0079C1');
    this.finishEditGeom(r);
    this.autoZ(r);
  },
  confirmEditGeom() {
    const eg = this.state.editGeom, r = eg.record;
    const min = eg.mode === 'line' ? 2 : 3;
    if (eg.coords.length < min) { this.toast(`Add at least ${min} points`, 'err'); return; }
    this.captureSessionUndo();
    const proposed = eg.mode === 'line' ? { type: 'LineString', coordinates: [...eg.coords] } : { type: 'Polygon', coordinates: [[...eg.coords, eg.coords[0]]] };
    if (!this.requireValidGeometry(proposed)) return;
    r.geometry = proposed;
    this.finishEditGeom(r);
  },
  async finishEditGeom(r) {
    if (!this.requireValidGeometry(r.geometry)) return;
    r.updatedAt = nowISO();
    await DB.put('records', r);
    const i = this.state.records.findIndex((x) => x.id === r.id); if (i >= 0) this.state.records[i] = r;
    this.state.selectedRecord = r; this.state.selectedRecords = [r];
    this.cancelEditGeom(); this.renderAllLayers(); this.toast('Geometry updated', 'ok');
  },
  cancelEditGeom() {
    const eg = this.state.editGeom;
    if (eg && eg._reLayer) this.state.map.removeLayer(eg._reLayer);
    if (eg && eg._moveMarker) { try { this.state.map.removeLayer(eg._moveMarker); } catch (e) {} }
    this.state.editGeom = null;
    if (this.state.map) this.state.map.doubleClickZoom.enable();
    document.getElementById('tapHint').classList.remove('show');
    document.getElementById('map').classList.remove('placing-cursor');
    document.getElementById('sketchBar').classList.remove('show');
    document.getElementById('sketchBar').classList.remove('editing');
    { const h = document.getElementById('skHint'); if (h) h.textContent = 'tap map to add · double-tap to finish'; }
    this.showCollectBar();
    this.setActiveTool('select');
  },
});

/* ============================================================
   Part 5 — Collect: pick layer, fill attributes, geometry,
   auto Z-elevation, camera/media, save
   ============================================================ */
Object.assign(App, {
  startCollect(existing) {
    if (!this.state.project) { this.toast('Select a project first', 'err'); this.rootNav(this.openProjectPicker); return; }
    const layers = this.state.layers.filter((l) => l.projectId === this.state.project.id);
    if (layers.length === 0) { this.toast('Create a layer first', 'err'); this.rootNav(this.openLayers); return; }
    if (existing) {
      const l = this.state.layers.find((x) => x.id === existing.layerId);
      this.state.draft = JSON.parse(JSON.stringify(existing));
      this.state.draft._layer = l;
      this.state.draft._newMediaIds = [];
      this.state.draft._removedMediaIds = [];
      this.openForm();
      return;
    }
    // if a layer is active (from list), collect straight into it; else pick
    if (this.state.activeLayer && layers.some((l) => l.id === this.state.activeLayer.id)) { this.beginNewDraft(this.state.activeLayer); return; }
    const body = `<div class="muted" style="margin-bottom:12px">Which layer are you collecting into?</div>${layers.map((l) => `<div class="tpl" data-lc="${l.id}"><div class="ic">${this.symbSwatch(l)}</div><div class="tx"><div class="t">${esc(l.name)}</div><div class="d">${l.geomType} · ${l.fields.length} fields</div></div><div class="chev">${icon('chevron', 18)}</div></div>`).join('')}<button class="btn btn-ghost btn-block" id="newLyr" style="margin-top:6px">${icon('plus', 16)} New layer</button>`;
    this.openSheet('Collect into…', body);
    document.querySelectorAll('[data-lc]').forEach((el) => el.onclick = () => this.beginNewDraft(this.state.layers.find((l) => l.id === el.dataset.lc)));
    document.getElementById('newLyr').onclick = () => this.layerEditor(null);
  },

  beginNewDraft(layer) {
    this.state.draft = { id: null, layerId: layer.id, layerName: layer.name, geomType: layer.geomType, data: {}, media: [], geometry: null, location: null, surveyor: this.state.user.name, role: this.state.user.role, _layer: layer, _newMediaIds: [], _removedMediaIds: [] };
    this.openForm();
  },

  openForm() {
    const d = this.state.draft, l = d._layer;
    d.data = this.applyCaptureDefaults(d.data, l);
    if (l.template) this.seedTemplateDefaults(d, l);
    const missing = l.fields.filter((f) => f.required && !d.data[f.key] && this.fieldVisible(f, d.data));
    const geomBtns = l.geomType === 'point'
      ? `<button class="btn btn-primary flex" id="gpsPoint">${icon('navigation', 16)} Use GPS</button><button class="btn btn-ghost flex" id="tapMap">${icon('mapPin', 16)} Tap map</button>${!d.id ? `<button class="btn btn-ghost flex" id="rapidPoint">${icon('refresh', 16)} Rapid</button>` : ''}`
      : `<button class="btn btn-primary btn-block" id="drawMap">${icon('layers', 16)} Draw ${l.geomType} on map</button>`;
    const body = `
      <div class="card"><div class="card-lbl">Location · ${l.geomType}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${geomBtns}</div>
        ${this.geoReadout(d)}
      </div>
      <div class="card"><div class="card-lbl">${esc(l.name)} attributes</div>
        ${l.template ? `<div class="note" style="margin-bottom:10px">Template feature class — ${l.fields.filter((f) => this.isAutoMapped(f)).length} field(s) fill automatically; GDB-required fields arrive pre-defaulted (change only what you observe on site).</div><input class="inp" id="fldSearch" placeholder="Search fields…" style="margin-bottom:10px" autocomplete="off" />` : ''}
        ${l.fields.length === 0 ? '<div class="muted">This layer has no custom fields. Add some via Layers → edit.</div>' : l.fields.filter((f) => !this.isAutoMapped(f)).map((f) => this.fieldHTML(f, d.data[f.key], d.data)).join('')}
      </div>
      <div class="card"><div class="card-lbl">Photos & video ${icon('camera', 12, 'display:inline;vertical-align:-2px')}</div>
        <div style="display:flex;gap:8px;margin-bottom:${(d.media || []).length ? 11 : 0}px">
          <button class="btn btn-ghost flex" id="bPhoto">${icon('camera', 16)} Camera</button>
          <button class="btn btn-ghost flex" id="bVideo">${icon('video', 16)} Video</button>
          <button class="btn btn-ghost flex" id="bFile">${icon('file', 16)} File</button>
        </div>
        <input type="file" id="iPhoto" accept="image/*" capture="environment" multiple hidden />
        <input type="file" id="iVideo" accept="video/*" capture="environment" hidden />
        <input type="file" id="iFile" hidden multiple />
        ${(d.media || []).length ? `<div class="media-grid">${d.media.map((m, i) => this.mediaThumb(m, i, true)).join('')}</div>` : ''}
        <div class="muted" style="margin-top:8px">Photos are geotagged to your current location and linked to this ${esc(l.name)} record.</div>
      </div>
      <div class="card"><div class="card-lbl">Record info</div>
        <div class="attr-mini"><span>Surveyor</span><b>${esc(d.surveyor)} · ${esc(d.role)}</b></div>
        <div class="attr-mini"><span>Z_Elevation</span><b id="zVal">${d.location && d.location.z != null ? (+d.location.z).toFixed(2) + ' m' : 'auto on capture'}</b></div>
      </div>`;
    const foot = `<button class="btn btn-ghost" id="fDraft">${icon('save', 16)} Draft</button><button class="btn btn-primary flex" id="fDone" ${missing.length ? 'disabled' : ''}>${icon('check', 16)} Complete</button>`;
    this.openSheet(d.id ? `Edit · ${l.name}` : `New ${l.name}`, body, foot);
    this.wireForm();
    this.hydrateMedia(d.media);
  },

  geoReadout(d) {
    if (d.geometry) {
      if (d.geometry.type === 'Point') { const acc = d.location && d.location.accuracy; const poor = acc > 20; const crs = this.state.project.crsCode; const disp = (typeof Geo !== 'undefined') ? Geo.format([d.geometry.coordinates[0], d.geometry.coordinates[1]], crs) : `${d.geometry.coordinates[1].toFixed(6)}, ${d.geometry.coordinates[0].toFixed(6)}`; return `<div class="geo-readout">${disp}<div class="${poor ? 'warn' : 'ok'}">${poor ? icon('alert', 13) : icon('check', 13)} ${acc != null ? '±' + Math.round(acc) + 'm' : 'placed'} ${poor ? '· move to open sky' : '· good'}</div></div>`; }
      const v = d.geometry.type === 'Polygon' ? d.geometry.coordinates[0].length : d.geometry.coordinates.length;
      return `<div class="geo-readout"><div class="ok">${icon('check', 13)} ${d.geometry.type} · ${v} vertices</div></div>`;
    }
    return `<div class="geo-readout" style="color:var(--grey-500)">No location yet — capture it above.</div>`;
  },

  fieldVisible(f, data) {
    if (!f.condition || !f.condition.field) return true;
    const actual = (data[f.condition.field] ?? '');
    const want = f.condition.value ?? '';
    const eq = String(actual) === String(want);
    return f.condition.op === 'not_equals' ? !eq : eq;
  },
  fieldHTML(f, val, data) {
    const v = val ?? '', req = f.required ? '<span class="req">*</span>' : '';
    let ctl = '';
    const dom = f.domain && this.state.project && this.state.project.domains ? this.state.project.domains[f.domain] : null;
    if (dom && dom.values.length > 8) {
      const label = (dom.values.find((x) => String(x[0]) === String(v)) || [null, v])[1] || '';
      ctl = `<button type="button" class="inp domain-btn" data-dombtn="${f.key}" data-domname="${esc(f.domain)}">${label ? esc(label) : '<span class="ph">Select…</span>'}</button>`;
    } else if (dom) {
      ctl = `<select class="sel" data-f="${f.key}"><option value="">Select…</option>${dom.values.map(([c, n]) => `<option value="${esc(c)}" ${String(c) === String(v) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
    } else if (f.type === 'select') ctl = `<select class="sel" data-f="${f.key}"><option value="">Select…</option>${(f.options || []).map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    else if (f.type === 'bool') ctl = `<div class="seg" data-f="${f.key}"><button type="button" class="${v === 'Yes' ? 'on' : ''}" data-v="Yes">Yes</button><button type="button" class="${v === 'No' ? 'on' : ''}" data-v="No">No</button></div>`;
    else if (f.type === 'number') ctl = `<input class="inp" type="number" inputmode="decimal" data-f="${f.key}" value="${esc(v)}" />`;
    else if (f.type === 'integer') ctl = `<input class="inp" type="number" step="1" inputmode="numeric" data-f="${f.key}" value="${esc(v)}" />`;
    else if (f.type === 'datetime') ctl = `<input class="inp" type="datetime-local" data-f="${f.key}" value="${esc(v)}" />`;
    else if (f.type === 'date') ctl = `<input class="inp" type="date" data-f="${f.key}" value="${esc(v)}" />`;
    else if (f.type === 'time') ctl = `<input class="inp" type="time" data-f="${f.key}" value="${esc(v)}" />`;
    else ctl = `<div class="text-with-scan"><input class="inp" type="text" data-f="${f.key}" value="${esc(v)}"${f.length ? ` maxlength="${f.length}"` : ''} /><button type="button" class="mini scan-btn" data-scan="${f.key}" title="Scan barcode/QR">${icon('camera', 15)}</button></div>`;
    const condAttr = f.condition ? ` data-cond-field="${esc(f.condition.field)}" data-cond-op="${esc(f.condition.op)}" data-cond-val="${esc(f.condition.value)}"` : '';
    const hidden = f.condition && data && !this.fieldVisible(f, data) ? ' style="display:none"' : '';
    return `<div class="field" data-fieldwrap="${f.key}"${condAttr}${hidden}><label class="lbl">${esc(f.label)} ${req}</label>${ctl}</div>`;
  },

  wireForm() {
    const d = this.state.draft, l = d._layer;
    const reqKeys = new Set(l.fields.filter((f) => f.required).map((f) => f.key));
    const applyConditions = () => {
      document.querySelectorAll('[data-fieldwrap]').forEach((wrap) => {
        const f = l.fields.find((x) => x.key === wrap.dataset.fieldwrap);
        if (!f || !f.condition) return;
        const visible = this.fieldVisible(f, d.data);
        wrap.style.display = visible ? '' : 'none';
      });
    };
    const sync = () => {
      const m = l.fields.filter((f) => f.required && !d.data[f.key] && this.fieldVisible(f, d.data));
      const b = document.getElementById('fDone'); if (b) b.disabled = m.length > 0;
    };
    document.querySelectorAll('[data-f]').forEach((el) => {
      if (el.classList.contains('seg')) el.querySelectorAll('button').forEach((b) => b.onclick = () => { d.data[el.dataset.f] = b.dataset.v; el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); if (reqKeys.has(el.dataset.f)) sync(); applyConditions(); sync(); });
      else { el.oninput = () => { d.data[el.dataset.f] = el.value; if (reqKeys.has(el.dataset.f)) sync(); applyConditions(); sync(); }; el.onchange = () => { d.data[el.dataset.f] = el.value; if (reqKeys.has(el.dataset.f)) sync(); applyConditions(); sync(); }; }
    });
    applyConditions(); sync();
    document.querySelectorAll('[data-scan]').forEach((btn) => btn.onclick = () => this.openScanner(btn.dataset.scan));
    document.querySelectorAll('[data-dombtn]').forEach((btn) => btn.onclick = () => this.openDomainPicker(btn.dataset.dombtn, btn.dataset.domname));
    const fs = document.getElementById('fldSearch');
    if (fs) fs.oninput = () => {
      const q = fs.value.toLowerCase();
      document.querySelectorAll('[data-fieldwrap]').forEach((wrap) => {
        const f = l.fields.find((x) => x.key === wrap.dataset.fieldwrap);
        const hit = !q || wrap.dataset.fieldwrap.toLowerCase().includes(q) || (f && f.label.toLowerCase().includes(q));
        const condVisible = !f || !f.condition || this.fieldVisible(f, d.data);
        wrap.style.display = hit && condVisible ? '' : 'none';
      });
    };
    const gp = document.getElementById('gpsPoint'); if (gp) gp.onclick = () => this.captureGPS();
    const tm = document.getElementById('tapMap'); if (tm) tm.onclick = () => this.beginPlacePoint();
    const rp = document.getElementById('rapidPoint'); if (rp) rp.onclick = () => this.openRapidCapture(l);
    const dm = document.getElementById('drawMap'); if (dm) dm.onclick = () => this.beginDraw(l.geomType);
    this.wireMedia();
    document.getElementById('fDraft').onclick = () => this.saveRecord('draft');
    const fd = document.getElementById('fDone'); if (fd) fd.onclick = () => {
      // geometry is mandatory for a completed record — a feature class record without a shape is not GIS data
      if (!d.geometry) { this.toast(`Capture the ${l.geomType} on the map first — geometry is required`, 'err'); return; }
      const m = l.fields.filter((f) => f.required && !d.data[f.key]);
      if (m.length) { this.toast('Fill required: ' + m.map((f) => f.label).join(', '), 'err'); return; }
      this.saveRecord('completed');
    };
  },

  /* ---------- Geometry capture ---------- */
  /* Register a captured position on the draft. Works fully OFFLINE — the device GPS needs
     no network; only the optional elevation lookup does (and it already defers politely). */
  _registerFix(lat, lng, accuracy, note) {
    const d = this.state.draft;
    d.location = { lat, lng, accuracy, capturedAt: nowISO() };
    d.geometry = { type: 'Point', coordinates: [lng, lat] };
    this.openForm(); this.autoZ(d);
    if (note) this.toast(note, 'ok');
  },
  captureGPS() {
    if (!navigator.geolocation) { this.toast('GPS not available', 'err'); return; }
    // Make sure the continuous tracker is running so this and every future capture is instant.
    if (!this._watchStarted) this.startWatch();
    // 1) The map tracker usually already has a live fix — use it instantly (crucial offline,
    //    where a brand-new cold fix can take 30s+ without network assistance).
    const lf = this.state.lastFix;
    if (lf && lf.ts && (Date.now() - lf.ts) < 20000) {
      this._registerFix(lf.lat, lf.lng, lf.accuracy, `GPS registered (±${Math.round(lf.accuracy)} m)`);
      return;
    }
    this.toast('Getting GPS fix…');
    navigator.geolocation.getCurrentPosition(
      (pos) => this._registerFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
      () => {
        // 2) Request failed (slow cold fix / flaky provider). Fall back to the most recent
        //    tracker fix rather than losing the coordinate in the field.
        const f = this.state.lastFix;
        if (f) {
          const age = f.ts ? Math.round((Date.now() - f.ts) / 1000) : null;
          this._registerFix(f.lat, f.lng, f.accuracy, `Used last GPS fix${age != null ? ` (${age}s old)` : ''} — ±${Math.round(f.accuracy)} m`);
        } else {
          this.toast('No GPS fix yet — keep the sky visible and retry, or use Tap map', 'err');
        }
      },
      // allow a recent cached fix (30 s) and give a cold start a realistic window
      { enableHighAccuracy: true, timeout: 25000, maximumAge: 30000 }
    );
  },

  // Auto-fill Z from elevation service
  async autoZ(target) {
    const loc = target.location; if (!loc) return;
    if (!navigator.onLine) { this.toast('Offline — Z will fill when online', 'err'); return; }
    const zEl = document.getElementById('zVal'); if (zEl) zEl.textContent = 'fetching…';
    try {
      const { z, source } = await Geo.elevation(loc.lat, loc.lng);
      if (z != null) {
        loc.z = Math.round(z * 100) / 100;
        if (target.geometry && target.geometry.type === 'Point') target.geometry.coordinates[2] = loc.z;
        if (zEl) zEl.textContent = `${loc.z.toFixed(2)} m`;
        this.toast(`Z elevation: ${loc.z.toFixed(1)} m (${source})`, 'ok');
      } else if (zEl) zEl.textContent = 'unavailable';
    } catch { if (zEl) zEl.textContent = 'unavailable'; }
  },

  hideCollectBar() { document.getElementById('collectBar').style.display = 'none'; },
  showCollectBar() { if (this.isStreamingProject && this.isStreamingProject()) return; document.getElementById('collectBar').style.display = 'flex'; },

  /* ---------- Point placement: tap the map, it's placed immediately ---------- */
  beginPlacePoint() {
    if (!this.state.map) { this.toast('Map not ready', 'err'); return; }
    this.closeSheet();
    this.hideCollectBar();
    this.state.placing = { mode: 'point' };
    this.setActiveTool('create');
    document.getElementById('tapHintText').textContent = 'Tap the map to place the point';
    document.getElementById('tapHint').classList.add('show');
    document.getElementById('map').classList.add('placing-cursor');
  },
  cancelPlacing() { this.endPlacing(); this.backToForm(); },
  endPlacing() {
    this.state.placing = null;
    document.getElementById('tapHint').classList.remove('show');
    document.getElementById('map').classList.remove('placing-cursor');
    this.setActiveTool('select');
    this.showCollectBar();
  },
  backToForm() { if (this.state.draft) this.openForm(); },

  // Drops an animated Esri-style pin at a lat/lng (in screen pixel space, tracks map)
  dropPin(latlng, color) {
    const layer = document.getElementById('dropPinLayer');
    layer.innerHTML = '';
    const pt = this.state.map.latLngToContainerPoint(latlng);
    const el = document.createElement('div');
    el.className = 'drop-pin';
    el.style.left = pt.x + 'px'; el.style.top = pt.y + 'px';
    el.innerHTML = pinSVG(color || '#0079C1', 34) + '<div class="shadow"></div>';
    layer.appendChild(el);
    // keep pin anchored to its geo position as the map moves/zooms, then clear after a moment
    const reposition = () => { const p = this.state.map.latLngToContainerPoint(latlng); el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; };
    this.state.map.on('move zoom', reposition);
    setTimeout(() => { this.state.map.off('move zoom', reposition); if (layer.contains(el)) layer.removeChild(el); }, 4000);
  },

  /* ---------- Line / polygon sketching ---------- */
  beginDraw(mode) {
    if (!this.state.map) { this.toast('Map not ready', 'err'); return; }
    this.closeSheet();
    this.hideCollectBar();
    this.state.map.doubleClickZoom.disable();
    this.setActiveTool('create');
    this.state.draw = { mode, coords: [], layer: L.layerGroup().addTo(this.state.map) };
    document.getElementById('sketchBar').classList.add('show');
    this.updateSketchCount();
  },
  updateSketchCount() {
    const dr = this.state.draw || this.state.editGeom;
    const n = dr ? dr.coords.length : 0;
    document.getElementById('sketchCount').textContent = `${n} point${n !== 1 ? 's' : ''}`;
    const min = (dr && dr.mode === 'line') ? 2 : 3;
    document.getElementById('skFinish').disabled = n < min;
    const delVertex = document.getElementById('skDeleteVertex');
    if (delVertex) delVertex.disabled = !(dr && dr.vertexEdit && dr.activeVertex != null);
  },
  deleteActiveVertex() {
    const dr = this.state.editGeom;
    if (!dr || !dr.vertexEdit || dr.activeVertex == null) return;
    const min = dr.mode === 'line' ? 2 : 3;
    if (dr.coords.length <= min) { this.toast(`A ${dr.mode} needs at least ${min} vertices`, 'err'); return; }
    this.pushGeomUndo(dr);
    dr.coords.splice(dr.activeVertex, 1); dr.activeVertex = null;
    this.redrawSketch(dr); this.updateSketchCount(); this.toast('Vertex deleted', 'ok');
  },
  undoSketchPoint() {
    const dr = this.state.draw || this.state.editGeom;
    if (!dr || !dr.coords.length) return;
    dr.coords.pop();
    this.redrawSketch(dr);
    this.updateSketchCount();
  },
  redrawSketch(dr) {
    const lyr = dr.layer || dr._reLayer; lyr.clearLayers();
    const ll = dr.coords.map((c) => [c[1], c[0]]);
    dr._shape = null;
    if (dr.mode === 'line' && ll.length > 1) dr._shape = L.polyline(ll, { color: '#0079C1', weight: 4 }).addTo(lyr);
    if (dr.mode === 'polygon' && ll.length > 2) dr._shape = L.polygon(ll, { color: '#0079C1', weight: 2, fillOpacity: 0.2 }).addTo(lyr);
    if (dr.vertexEdit) {
      // midpoint handles — tap to INSERT a vertex into that segment
      const n = dr.coords.length;
      const segs = dr.mode === 'polygon' ? (n > 2 ? n : n - 1) : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = dr.coords[i], b = dr.coords[(i + 1) % n];
        if (!a || !b) continue;
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const edge = L.marker([mid[1], mid[0]], { icon: L.divIcon({ className: 'v-mid', html: '', iconSize: [16, 16] }), zIndexOffset: 400, keyboard: false, draggable: true }).addTo(lyr);
        let edgeMoved = false, edgeStart = null, before = null;
        edge.on('dragstart', () => {
          this.pushGeomUndo(dr); edgeMoved = false; edgeStart = edge.getLatLng(); before = JSON.parse(JSON.stringify(dr.coords));
        });
        edge.on('drag', (ev) => {
          const p = ev.target.getLatLng(), dx = p.lng - edgeStart.lng, dy = p.lat - edgeStart.lat;
          if (Math.abs(dx) + Math.abs(dy) > 0.0000001) edgeMoved = true;
          dr.coords[i] = [before[i][0] + dx, before[i][1] + dy];
          const next = (i + 1) % n;
          dr.coords[next] = [before[next][0] + dx, before[next][1] + dy];
          if (dr._shape) dr._shape.setLatLngs(dr.coords.map((q) => [q[1], q[0]]));
        });
        edge.on('dragend', () => { if (edgeMoved) { this.redrawSketch(dr); this.updateSketchCount(); this.toast('Edge moved'); } });
        edge.on('click', (ev) => {
          if (L.DomEvent) L.DomEvent.stopPropagation(ev);
          if (edgeMoved) { edgeMoved = false; return; }
          this.pushGeomUndo(dr); dr.coords.splice(i + 1, 0, mid); dr.activeVertex = i + 1; this.redrawSketch(dr); this.updateSketchCount(); this.toast('Vertex inserted');
        });
      }
      // vertex handles — drag to MODIFY, tap to DELETE
      dr.coords.forEach((c, i) => {
        const mk = L.marker([c[1], c[0]], { icon: L.divIcon({ className: `v-node${dr.activeVertex === i ? ' selected' : ''}`, html: '', iconSize: [20, 20] }), draggable: true, zIndexOffset: 500, keyboard: false }).addTo(lyr);
        mk.on('dragstart', () => { dr.activeVertex = i; this.pushGeomUndo(dr); this.updateSketchCount(); });
        mk.on('drag', (ev) => {
          const p = ev.target.getLatLng(), snapped = this.snapCoordinate(p, dr.record && dr.record.id);
          dr.coords[i] = snapped;
          if (Math.abs(snapped[0] - p.lng) + Math.abs(snapped[1] - p.lat) > 1e-12) ev.target.setLatLng([snapped[1], snapped[0]]);
          if (dr._shape) dr._shape.setLatLngs(dr.coords.map((q) => [q[1], q[0]]));
        });
        mk.on('dragend', (ev) => { const p = ev.target.getLatLng(), snapped = this.snapCoordinate(p, dr.record && dr.record.id); dr.coords[i] = snapped; this.redrawSketch(dr); this.updateSketchCount(); });
        mk.on('click', (ev) => {
          if (L.DomEvent) L.DomEvent.stopPropagation(ev);
          dr.activeVertex = i; this.redrawSketch(dr); this.updateSketchCount();
        });
        mk.on('contextmenu', (ev) => {
          if (L.DomEvent) { L.DomEvent.stopPropagation(ev); L.DomEvent.preventDefault(ev); }
          dr.activeVertex = i; this.deleteActiveVertex();
        });
      });
      return;
    }
    dr.coords.forEach((c) => L.circleMarker([c[1], c[0]], { radius: 5, color: '#005E95', weight: 2, fillColor: '#0079C1', fillOpacity: 1 }).addTo(lyr));
  },

  snapCoordinate(latlng, excludeRecordId) {
    if (!this.state.snapping || !this.state.map || !this.state.project) return [latlng.lng, latlng.lat];
    const target = this.state.map.latLngToLayerPoint(latlng); let best = null;
    const consider = (point, coordinate, type) => { const d = target.distanceTo(point); if (d <= (this.state.snapTolerance || 14) && (!best || d < best.distance)) best = { distance: d, coordinate, type }; };
    for (const r of this.state.records) {
      if (r.projectId !== this.state.project.id || r.id === excludeRecordId) continue;
      const layer = this.state.layers.find((l) => l.id === r.layerId); if (layer && layer.hidden) continue;
      if (this.state.snapLayerIds && !this.state.snapLayerIds.includes(r.layerId)) continue;
      const g = Exporter.geometryOf(r); if (!g) continue;
      const coords = g.type === 'Point' ? [g.coordinates] : (g.type === 'Polygon' ? g.coordinates[0] : g.coordinates);
      if (this.state.snapVertices) coords.forEach((c, i) => consider(this.state.map.latLngToLayerPoint([c[1], c[0]]), c.slice(), (i === 0 || i === coords.length - 1) ? 'endpoint' : 'vertex'));
      if (this.state.snapEdges) for (let i = 0; i < coords.length - 1; i++) {
        const a = this.state.map.latLngToLayerPoint([coords[i][1], coords[i][0]]), b = this.state.map.latLngToLayerPoint([coords[i + 1][1], coords[i + 1][0]]);
        const vx = b.x - a.x, vy = b.y - a.y, len2 = vx * vx + vy * vy, t = len2 ? Math.max(0, Math.min(1, ((target.x - a.x) * vx + (target.y - a.y) * vy) / len2)) : 0;
        const p = L.point(a.x + t * vx, a.y + t * vy), ll = this.state.map.layerPointToLatLng(p);
        const z = coords[i].length > 2 && coords[i + 1].length > 2 ? coords[i][2] + t * (coords[i + 1][2] - coords[i][2]) : undefined;
        consider(p, z == null ? [ll.lng, ll.lat] : [ll.lng, ll.lat, z], 'edge');
      }
    }
    if (best) { this.showSnapIndicator(best.coordinate, best.type); return best.coordinate; }
    return [latlng.lng, latlng.lat];
  },
  showSnapIndicator(coordinate, type) {
    if (this._snapIndicator) this.state.map.removeLayer(this._snapIndicator);
    this._snapIndicator = L.circleMarker([coordinate[1], coordinate[0]], { radius: 9, color: '#00FFFF', weight: 2, fillOpacity: 0, interactive: false }).addTo(this.state.map);
    this._snapIndicator.bindTooltip(`Snap: ${type || 'target'}`, { permanent: true, direction: 'top', offset: [0, -10], className: 'snap-tooltip' }).openTooltip();
    clearTimeout(this._snapTimer); this._snapTimer = setTimeout(() => { if (this._snapIndicator) { this.state.map.removeLayer(this._snapIndicator); this._snapIndicator = null; } }, 650);
  },

  onMapClick(e) {
    if (this._boxJustFinished || this.state.activeTool === 'box' || this.state.activeTool === 'pan') return;
    if (this.state.editGeom && this.state.editGeom.moveMode) return;
    // Point placement: tap = place immediately, no confirm step
    if (this.state.placing && this.state.placing.mode === 'point') {
      const snapped = this.snapCoordinate(e.latlng), lng = snapped[0], lat = snapped[1];
      const d = this.state.draft;
      d.location = { lat, lng, accuracy: null, capturedAt: nowISO() };
      d.geometry = { type: 'Point', coordinates: [lng, lat] };
      this.dropPin({ lat, lng }, '#0079C1');
      this.endPlacing();
      this.toast('Point placed', 'ok');
      this.autoZ(d);
      setTimeout(() => this.openForm(), 320);
      return;
    }
    // Geometry edit, point mode: tap = reposition immediately
    if (this.state.editGeom && this.state.editGeom.mode === 'point') {
      const snapped = this.snapCoordinate(e.latlng, this.state.editGeom.record.id);
      this.applyPointMove(snapped[1], snapped[0]);
      return;
    }
    // Line/polygon sketching (new draw or geometry edit)
    const dr = this.state.draw || (this.state.editGeom && this.state.editGeom.mode !== 'point' ? this.state.editGeom : null);
    if (!dr) {
      if (this.state.activeTool === 'split') this.toast('Click directly on the selected line to split it', 'err');
      else if (this.state.activeTool === 'select') {
        this.state.selectedRecord = null; this.state.selectedRecords = []; this.renderAllLayers(); this.updateEditToolbar();
      }
      return;
    }
    if (dr.vertexEdit) this.pushGeomUndo(dr);
    dr.coords.push(this.snapCoordinate(e.latlng, dr.record && dr.record.id));
    this.redrawSketch(dr);
    this.updateSketchCount();
  },
  confirmDraw() {
    const dr = this.state.draw, d = this.state.draft;
    const min = dr.mode === 'line' ? 2 : 3;
    if (dr.coords.length < min) { this.toast(`Add at least ${min} points`, 'err'); return; }
    if (dr.operation) { this.finishGeometryOperation(dr); return; }
    d.geometry = dr.mode === 'line' ? { type: 'LineString', coordinates: [...dr.coords] } : { type: 'Polygon', coordinates: [[...dr.coords, dr.coords[0]]] };
    d.location = { lat: dr.coords[0][1], lng: dr.coords[0][0], accuracy: null, capturedAt: nowISO() };
    this.endDraw(); this.toast('Shape captured', 'ok'); this.autoZ(d);
    setTimeout(() => this.openForm(), 200);
  },
  endDraw() {
    if (this.state.draw && this.state.draw.layer) this.state.map.removeLayer(this.state.draw.layer);
    this.state.draw = null;
    if (this.state.map) this.state.map.doubleClickZoom.enable();
    this.setActiveTool('select');
    document.getElementById('sketchBar').classList.remove('show');
    document.getElementById('sketchBar').classList.remove('editing');
    { const h = document.getElementById('skHint'); if (h) h.textContent = 'tap map to add · double-tap to finish'; }
    this.showCollectBar();
  },

  /* ---------- Media / camera ---------- */
  wireMedia() {
    const d = this.state.draft;
    const iP = document.getElementById('iPhoto'), iV = document.getElementById('iVideo'), iF = document.getElementById('iFile');
    document.getElementById('bPhoto').onclick = () => this.openCamera('photo');
    document.getElementById('bVideo').onclick = () => this.openCamera('video');
    document.getElementById('bFile').onclick = () => iF.click();
    const add = (files, type) => {
      const doAdd = (lat, lng) => Array.from(files).forEach(async (file) => {
        const id = uid('m');
        await Media.save(id, file); // File is a Blob
        d.media = d.media || [];
        d._newMediaIds = d._newMediaIds || [];
        d._newMediaIds.push(id);
        d.media.push({ id, type, kind: type, name: file.name, mime: file.type, size: file.size, lat, lng, capturedAt: nowISO() });
        this.openForm();
      });
      // link to record location if we have it, else current GPS
      if (d.location && d.location.lat) doAdd(d.location.lat, d.location.lng);
      else if (navigator.geolocation && type !== 'file') {
        const lf2 = this.state.lastFix;
        if (lf2 && lf2.ts && (Date.now() - lf2.ts) < 30000) doAdd(lf2.lat, lf2.lng);   // instant + offline-safe
        else navigator.geolocation.getCurrentPosition(
          (pos) => doAdd(pos.coords.latitude, pos.coords.longitude),
          () => { const f2 = this.state.lastFix; f2 ? doAdd(f2.lat, f2.lng) : doAdd(null, null); },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
      }
      else doAdd(null, null);
    };
    this._addMediaFiles = add; // reused by the camera's "upload instead" fallback
    iP.onchange = (e) => { if (e.target.files.length) add(e.target.files, 'photo'); e.target.value = ''; };
    iV.onchange = (e) => { if (e.target.files.length) add(e.target.files, 'video'); e.target.value = ''; };
    iF.onchange = (e) => { if (e.target.files.length) add(e.target.files, 'file'); e.target.value = ''; };
    document.querySelectorAll('[data-rm]').forEach((el) => el.onclick = async (ev) => {
      ev.stopPropagation();
      const removed = d.media.splice(parseInt(el.dataset.rm), 1)[0];
      if (removed && !removed.dataUrl) {
        d._newMediaIds = d._newMediaIds || [];
        d._removedMediaIds = d._removedMediaIds || [];
        const newIndex = d._newMediaIds.indexOf(removed.id);
        if (newIndex >= 0) {
          d._newMediaIds.splice(newIndex, 1);
          await Media.remove(removed.id);
        } else if (!d._removedMediaIds.includes(removed.id)) {
          d._removedMediaIds.push(removed.id);
        }
      }
      this.openForm();
    });
  },

  /* ---------- In-app camera: live preview, tap-to-capture, saved as Blob ---------- */
  camEl(id) { return document.getElementById(id); },
  camReady() {
    // Every element the camera needs must exist; if not, the deployed index.html is outdated.
    return ['cameraView', 'camVideo', 'camCanvas', 'camThumbs', 'camError', 'camErrorMsg', 'camTimer', 'camShutter'].every((id) => document.getElementById(id));
  },
  async openCamera(mode) {
    if (!this.state.draft) return;
    if (!this.camReady()) { this.toast('Camera screen missing — update the app files (index.html) and reload', 'err'); return; }
    if (!window.isSecureContext) { this.toast('Camera needs HTTPS (or localhost). Open the app from its https:// address.', 'err'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.toast('This browser does not support camera capture — using file picker instead', 'err');
      const input = mode === 'video' ? document.getElementById('iVideo') : document.getElementById('iPhoto');
      if (input) input.click();
      return;
    }
    this._camMode = mode;
    this._camFacing = this._camFacing || 'environment';
    this.camEl('camThumbs').innerHTML = '';
    this.camEl('camError').classList.remove('show');
    this.camEl('camTimer').style.display = 'none';
    this.camEl('cameraView').classList.add('show');
    this.camEl('camShutter').classList.remove('recording');
    await this.startCameraStream();
  },
  async startCameraStream(facing) {
    if (this._camStream) { this._camStream.getTracks().forEach((t) => t.stop()); this._camStream = null; }
    const video = this.camEl('camVideo');
    try {
      const constraints = { video: { facingMode: facing || this._camFacing }, audio: this._camMode === 'video' };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this._camStream = stream;
      video.srcObject = stream;
      try { await video.play(); } catch {}
      this.camEl('camError').classList.remove('show');
    } catch (err) {
      // Retry without exact facing (laptops often have a single user-facing webcam)
      if (!this._camRetried) {
        this._camRetried = true;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: this._camMode === 'video' });
          this._camStream = stream; video.srcObject = stream;
          try { await video.play(); } catch {}
          this.camEl('camError').classList.remove('show');
          this._camRetried = false;
          return;
        } catch (err2) { this._camRetried = false; this.showCameraError(err2); return; }
      }
      this.showCameraError(err);
    }
  },
  showCameraError(err) {
    const msg = this.camEl('camErrorMsg');
    if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) msg.textContent = 'Camera access was blocked. Click the camera/lock icon in the address bar, allow Camera, then Try again.';
    else if (err && err.name === 'NotFoundError') msg.textContent = 'No camera found on this device. Use "Upload a file instead".';
    else if (err && err.name === 'NotReadableError') msg.textContent = 'Camera is in use by another app. Close it and try again.';
    else msg.textContent = 'Could not start the camera (' + (err && err.name || 'unknown') + '). You can upload a photo or video file instead.';
    this.camEl('camError').classList.add('show');
  },
  wireCameraControls() {
    if (!this.camReady()) return; // outdated index.html — openCamera will surface the message
    this.camEl('camClose').onclick = () => this.closeCamera();
    this.camEl('camDone').onclick = () => this.closeCamera();
    this.camEl('camSwitch').onclick = () => { this._camFacing = this._camFacing === 'environment' ? 'user' : 'environment'; this.startCameraStream(); };
    this.camEl('camRetry').onclick = () => this.startCameraStream();
    this.camEl('camUseFile').onclick = () => { this.closeCamera(); const input = this._camMode === 'video' ? document.getElementById('iVideo') : document.getElementById('iPhoto'); if (input) input.click(); };
    this.camEl('camShutter').onclick = () => { if (this._camMode === 'photo') this.capturePhoto(); else this.toggleVideoRecording(); };
    this.wireScannerControls();
  },

  /* ---------- Barcode / QR scanning: fills a text field from a camera scan ----------
     Uses the native BarcodeDetector API (Chrome/Android — fast, offline, no dependency).
     Safari on iOS does not implement BarcodeDetector; scanning is unavailable there and
     the surveyor is told plainly to type the value, rather than silently failing. */
  scanReady() { return ['scanView', 'scanVideo', 'scanStatus', 'scanError', 'scanErrorMsg'].every((id) => document.getElementById(id)); },
  wireScannerControls() {
    if (!this.scanReady()) return;
    document.getElementById('scanClose').onclick = () => this.closeScanner();
    document.getElementById('scanCloseBtn2').onclick = () => this.closeScanner();
  },
  async openScanner(targetFieldKey) {
    if (!this.scanReady()) { this.toast('Scanner screen missing — update the app files (index.html) and reload', 'err'); return; }
    if (typeof BarcodeDetector === 'undefined') {
      document.getElementById('scanView').style.display = 'flex';
      document.getElementById('scanError').classList.add('show');
      document.getElementById('scanErrorMsg').textContent = 'Barcode scanning isn\'t supported in this browser (works on Chrome for Android). Type the value manually.';
      return;
    }
    if (!window.isSecureContext) { this.toast('Scanning needs HTTPS (or localhost).', 'err'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { this.toast('Camera not available for scanning on this device', 'err'); return; }
    this._scanTarget = targetFieldKey;
    const view = document.getElementById('scanView'), status = document.getElementById('scanStatus'), err = document.getElementById('scanError');
    err.classList.remove('show'); status.textContent = 'Point the camera at a barcode or QR code'; view.style.display = 'flex';
    const video = document.getElementById('scanVideo');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      this._scanStream = stream; video.srcObject = stream;
      try { await video.play(); } catch {}
      this._scanDetector = this._scanDetector || new BarcodeDetector({ formats: ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf', 'data_matrix', 'pdf417'] });
      this._scanning = true;
      this.scanLoop();
    } catch (e) {
      err.classList.add('show');
      document.getElementById('scanErrorMsg').textContent = (e && e.name === 'NotAllowedError') ? 'Camera access was blocked. Allow it in your browser settings, then try again.' : 'Could not start the camera for scanning.';
    }
  },
  async scanLoop() {
    if (!this._scanning) return;
    const video = document.getElementById('scanVideo');
    try {
      if (video.videoWidth) {
        const codes = await this._scanDetector.detect(video);
        if (codes && codes.length) { this.onScanSuccess(codes[0].rawValue); return; }
      }
    } catch { /* transient decode errors are expected between frames — keep looping */ }
    this._scanRAF = requestAnimationFrame(() => this.scanLoop());
  },
  onScanSuccess(value) {
    const key = this._scanTarget;
    this.closeScanner();
    if (!key || !this.state.draft) return;
    this.state.draft.data[key] = value;
    const input = document.querySelector(`[data-f="${key}"]`);
    if (input) input.value = value;
    // conditional visibility and required-field validation may depend on this value
    document.querySelectorAll('[data-fieldwrap]').forEach((wrap) => {
      const l = this.state.draft._layer, f = l && l.fields.find((x) => x.key === wrap.dataset.fieldwrap);
      if (f && f.condition) wrap.style.display = this.fieldVisible(f, this.state.draft.data) ? '' : 'none';
    });
    const btn = document.getElementById('fDone');
    if (btn && this.state.draft._layer) { const missing = this.state.draft._layer.fields.filter((f) => f.required && !this.state.draft.data[f.key] && this.fieldVisible(f, this.state.draft.data)); btn.disabled = missing.length > 0; }
    this.toast(`Scanned: ${value}`, 'ok');
  },
  closeScanner() {
    this._scanning = false;
    if (this._scanRAF) cancelAnimationFrame(this._scanRAF);
    if (this._scanStream) { this._scanStream.getTracks().forEach((t) => t.stop()); this._scanStream = null; }
    const view = document.getElementById('scanView'); if (view) view.style.display = 'none';
  },
  capturePhoto() {
    const video = this.camEl('camVideo');
    if (!video.videoWidth) { this.toast('Camera still starting — try again', 'err'); return; }
    const canvas = this.camEl('camCanvas');
    const maxEdge = 2048;
    const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(async (blob) => {
      if (!blob) { this.toast('Capture failed', 'err'); return; }
      await this.attachCapturedMedia('photo', blob);
      const url = URL.createObjectURL(blob);
      this.addCamThumb(url, 'photo');
    }, 'image/jpeg', 0.88);
    this.flashShutter();
  },
  flashShutter() {
    const v = this.camEl('camVideo');
    v.style.transition = 'none'; v.style.opacity = '0.4';
    requestAnimationFrame(() => { v.style.transition = 'opacity 0.25s'; v.style.opacity = '1'; });
  },
  toggleVideoRecording() {
    const btn = this.camEl('camShutter');
    if (this._recorder && this._recorder.state === 'recording') { this._recorder.stop(); return; }
    if (typeof MediaRecorder === 'undefined') { this.toast('Video recording not supported on this browser', 'err'); return; }
    const chunks = [];
    let mr;
    try {
      const mime = MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : (MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : '');
      mr = mime ? new MediaRecorder(this._camStream, { mimeType: mime }) : new MediaRecorder(this._camStream);
    } catch (e) { this.toast('Video recording not supported: ' + e.message, 'err'); return; }
    this._recorder = mr;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      clearInterval(this._camTimerInt);
      this.camEl('camTimer').style.display = 'none';
      btn.classList.remove('recording');
      const blob = new Blob(chunks, { type: mr.mimeType || 'video/webm' });
      await this.attachCapturedMedia('video', blob);
      this.addCamThumb(null, 'video');
    };
    mr.start();
    btn.classList.add('recording');
    let secs = 0;
    this.camEl('camTimer').style.display = 'flex';
    document.getElementById('camTimerTxt').textContent = '0:00';
    this._camTimerInt = setInterval(() => { secs++; const m = Math.floor(secs / 60), s = secs % 60; document.getElementById('camTimerTxt').textContent = `${m}:${String(s).padStart(2, '0')}`; }, 1000);
  },
  // Save capture as a Blob in the media store; the record keeps metadata only.
  async attachCapturedMedia(type, blob) {
    const d = this.state.draft; if (!d) return;
    d.media = d.media || [];
    const loc = d.location || this.state.lastFix;
    const id = uid('m');
    const ext = type === 'video' ? (blob.type.includes('mp4') ? 'mp4' : 'webm') : 'jpg';
    await Media.save(id, blob);
    d._newMediaIds = d._newMediaIds || [];
    d._newMediaIds.push(id);
    d.media.push({ id, type, kind: type, name: `${type}_${Date.now()}.${ext}`, mime: blob.type, size: blob.size, lat: loc ? loc.lat : null, lng: loc ? loc.lng : null, capturedAt: nowISO() });
    this.toast(type === 'photo' ? 'Photo saved to record' : 'Video saved to record', 'ok');
  },
  addCamThumb(objUrl, type) {
    const strip = this.camEl('camThumbs');
    const el = document.createElement(objUrl ? 'img' : 'div');
    if (objUrl) el.src = objUrl; else { el.className = 'vt'; el.innerHTML = icon('video', 18); }
    strip.appendChild(el);
    while (strip.children.length > 4) strip.removeChild(strip.firstChild);
  },
  closeCamera() {
    if (this._recorder && this._recorder.state === 'recording') this._recorder.stop();
    if (this._camStream) { this._camStream.getTracks().forEach((t) => t.stop()); this._camStream = null; }
    this.camEl('cameraView').classList.remove('show');
    if (this.state.draft) this.openForm(); // refresh sheet to show newly captured media
  },


  async saveRecord(status) {
    const d = this.state.draft, l = d._layer;
    if (status === 'completed' && !d.geometry) { this.toast(`Geometry is required — capture the ${l.geomType} on the map`, 'err'); return; }
    if (d.geometry && !this.requireValidGeometry(d.geometry)) return;
    if (l.template) this.applyTemplateAutofill(d, l);
    // carry Z into point geometry coordinates for true 3D output
    if (d.geometry && d.geometry.type === 'Point' && d.location && d.location.z != null) d.geometry.coordinates[2] = d.location.z;
    const rec = { id: d.id || uid('rec'), projectId: this.state.project.id, layerId: l.id, layerName: l.name, geomType: l.geomType, data: d.data, geometry: d.geometry, location: d.location, media: (d.media || []), surveyor: d.surveyor, role: d.role, status, createdAt: d.createdAt || nowISO(), updatedAt: nowISO() };
    this.captureSessionUndo();
    await DB.put('records', rec);
    // Existing attachments are deleted only after the edited record commits.
    // This keeps Cancel/Discard non-destructive.
    for (const id of (d._removedMediaIds || [])) this.queueMediaDelete(id);
    const i = this.state.records.findIndex((r) => r.id === rec.id);
    if (i >= 0) this.state.records[i] = rec; else this.state.records.unshift(rec);
    this.state.draft = null;
    this.renderAllLayers(); this.refreshBarSub();
    this.toast(status === 'draft' ? 'Saved as draft' : `${l.name} record saved`, 'ok');
    this.closeSheet();
    const g = rec.geometry;
    if (g && this.state.map) { const c = g.type === 'Point' ? g.coordinates : (g.type === 'LineString' ? g.coordinates[0] : g.coordinates[0][0]); this.state.map.setView([c[1], c[0]], Math.max(this.state.map.getZoom(), 16)); }
    // if Z still missing and online, backfill
    if (rec.location && rec.location.z == null && navigator.onLine) this.backfillZ(rec);
    setTimeout(() => this.updateGuidance(), 400);
  },
  async backfillZ(rec) {
    try { const { z } = await Geo.elevation(rec.location.lat, rec.location.lng); if (z != null) { rec.location.z = Math.round(z * 100) / 100; if (rec.geometry && rec.geometry.type === 'Point') rec.geometry.coordinates[2] = rec.location.z; await DB.put('records', rec); } } catch {}
  },

  openRapidCapture(layer) {
    if (!layer || layer.geomType !== 'point') { this.toast('Rapid capture is available for point layers', 'err'); return; }
    this.state.draft = null;
    const continuing = !!(this._rapidLayer && this._rapidLayer.id === layer.id);
    this._rapidLayer = layer;
    if (!continuing) { this._rapidCount = 0; this._rapidLastFix = null; this._rapidActive = false; }
    this._rapidDistance = this._rapidDistance || 5;
    this._rapidActive = !!this._rapidActive;
    if (!this._watchStarted) this.startWatch();
    const required = (layer.fields || []).filter((f) => f.required).length;
    const body = `<div class="card"><div class="card-lbl">${esc(layer.name)} · Rapid point capture</div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">
          <div><div class="muted">Captured this session</div><div style="font-size:25px;font-weight:800">${this._rapidCount}</div></div>
          <div><div class="muted">Required attributes</div><div style="font-size:25px;font-weight:800">${required}</div></div>
        </div>
      </div>
      <div class="note">Each point is stored immediately with its ID, coordinates, GPS accuracy, timestamps, surveyor, layer defaults and template autofill. Missing required attributes are marked <b>Needs attributes</b> for completion later.</div>
      <button class="btn btn-primary btn-block btn-lg" id="rapidNow">${icon('mapPin', 17)} Capture current GPS position</button>
      <div class="card" style="margin-top:12px"><div class="card-lbl">Automatic distance capture</div>
        <div class="field"><label class="lbl">Capture every</label><select class="sel" id="rapidDistance">${[1,2,5,10,20,50].map((n) => `<option value="${n}" ${n === this._rapidDistance ? 'selected' : ''}>${n} metres</option>`).join('')}</select></div>
        <button class="btn ${this._rapidActive ? 'btn-danger' : 'btn-ghost'} btn-block" id="rapidAuto">${this._rapidActive ? icon('pause', 16) + ' Stop automatic capture' : icon('play', 16) + ' Start automatic capture'}</button>
      </div>
      <div id="rapidFix" class="muted" style="margin-top:10px">${this.state.lastFix ? `Current fix ±${Math.round(this.state.lastFix.accuracy || 0)} m` : 'Waiting for GPS fix…'}</div>`;
    this.openSheet('Rapid capture', body, `<button class="btn btn-ghost btn-block" id="rapidDone">${icon('check', 16)} Finish and review records</button>`);
    document.getElementById('rapidNow').onclick = () => this.captureRapidFix(this.state.lastFix, false);
    document.getElementById('rapidDistance').onchange = (e) => { this._rapidDistance = +e.target.value || 5; };
    document.getElementById('rapidAuto').onclick = () => {
      this._rapidDistance = +document.getElementById('rapidDistance').value || 5;
      this._rapidActive = !this._rapidActive;
      this._rapidLastFix = null;
      this.openRapidCapture(layer);
      this.toast(this._rapidActive ? `Automatic capture started · every ${this._rapidDistance} m` : 'Automatic capture stopped', 'ok');
    };
    document.getElementById('rapidDone').onclick = () => {
      this._rapidActive = false; this._rapidLayer = null; this._rapidLastFix = null;
      this.state.activeLayer = layer; this._filter = 'all'; this.rootNav(this.openRecords);
    };
  },

  async captureRapidFix(fix, automatic) {
    if (!this._rapidLayer || this._rapidBusy) return;
    if (!fix || !isFinite(fix.lat) || !isFinite(fix.lng) || !fix.ts || Date.now() - fix.ts > 20000) {
      if (!automatic) this.toast('Wait for a fresh GPS fix', 'err');
      return;
    }
    const limit = Number(this.state.project && this.state.project.captureAccuracyLimit) || 15;
    if (fix.accuracy != null && fix.accuracy > limit) {
      if (!automatic) this.toast(`GPS accuracy ±${Math.round(fix.accuracy)} m is worse than the ${limit} m limit`, 'err');
      return;
    }
    this._rapidBusy = true;
    try {
      const layer = this._rapidLayer;
      const location = { lat: fix.lat, lng: fix.lng, z: fix.z != null ? Math.round(fix.z * 100) / 100 : null, accuracy: fix.accuracy, capturedAt: nowISO(), source: this._gnssActive ? 'external_gnss' : 'device_gps' };
      const data = this.applyCaptureDefaults({}, layer);
      const d = { data, location, media: [], _layer: layer, surveyor: this.state.user.name, role: this.state.user.role };
      if (layer.template) { this.seedTemplateDefaults(d, layer); this.applyTemplateAutofill(d, layer); }
      const coords = location.z == null ? [fix.lng, fix.lat] : [fix.lng, fix.lat, location.z];
      const rec = { id: uid('rec'), projectId: this.state.project.id, layerId: layer.id, layerName: layer.name, geomType: 'point', data: d.data,
        geometry: { type: 'Point', coordinates: coords }, location, media: [], surveyor: this.state.user.name, role: this.state.user.role,
        status: this.captureStatus(d.data, layer), createdAt: nowISO(), updatedAt: nowISO() };
      await DB.put('records', rec);
      this.state.records.unshift(rec); this._rapidCount = (this._rapidCount || 0) + 1; this._rapidLastFix = { ...fix };
      this.renderAllLayers(); this.refreshBarSub();
      if (location.z == null && navigator.onLine) this.backfillZ(rec);
      if (navigator.vibrate) navigator.vibrate(40);
      if (!automatic) this.toast(`Point ${this._rapidCount} captured · ${rec.status === 'needs_attributes' ? 'needs attributes' : 'complete'}`, 'ok');
      if (document.getElementById('rapidNow')) this.openRapidCapture(layer);
    } catch (e) { this.toast('Rapid capture failed: ' + e.message, 'err'); }
    finally { this._rapidBusy = false; }
  },

  rapidOnFix(fix) {
    if (!this._rapidActive || !this._rapidLayer || this._rapidBusy) return;
    if (this._rapidLastFix && this.routeDistance(this._rapidLastFix, fix) < this._rapidDistance) return;
    this.captureRapidFix(fix, true);
  },
});

/* ============================================================
   Part 6 — Menu, Export, Import (load existing), boot
   ============================================================ */
Object.assign(App, {
  async openOfflineReadiness() {
    this.openSheet('Offline readiness', '<div class="note">Checking application files, storage and offline capabilities…</div>');
    const required = [
      './index.html', './css/app.css?v=1.1.0', './js/version.js?v=1.1.0',
      './js/safety.js?v=1.1.0', './js/icons.js?v=1.1.0', './js/db.js?v=1.1.0',
      './js/geo.js?v=1.1.0', './js/export.js?v=1.1.0', './js/app.js?v=1.1.0',
      './vendor/leaflet.js', './vendor/proj4.js', './vendor/jszip.min.js',
      './vendor/xlsx.full.min.js', './vendor/turf.min.js',
    ];
    let cached = 0;
    if ('caches' in window) {
      for (const url of required) if (await caches.match(url)) cached++;
    }
    let estimate = {}, persisted = false;
    if (navigator.storage && navigator.storage.estimate) estimate = await navigator.storage.estimate();
    if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted();
    const mb = (n) => n == null ? '—' : `${(n / 1048576).toFixed(1)} MB`;
    const checks = [
      ['Service worker', !!(navigator.serviceWorker && navigator.serviceWorker.controller), 'Reload once if activation is pending'],
      ['Application shell', cached === required.length, `${cached}/${required.length} mandatory files cached`],
      ['Local dependency bundle', cached >= required.length - 1, 'GIS libraries are packaged with the app'],
      ['Map engine', typeof L !== 'undefined', 'Leaflet is available locally'],
      ['Projection engine', typeof proj4 !== 'undefined', 'Required for project CRS output'],
      ['Package engine', typeof JSZip !== 'undefined', 'Required for complete backups and ZIP exports'],
      ['Persistent storage', persisted, persisted ? 'Browser has granted protection' : 'Request protection below'],
      ['Network state', navigator.onLine, navigator.onLine ? 'Online-dependent services available' : 'Currently offline'],
    ];
    const rows = checks.map(([name, ok, detail]) => `<div class="tpl" style="cursor:default"><div class="ic" style="color:${ok ? 'var(--green)' : 'var(--orange)'}">${icon(ok ? 'checkCircle' : 'alert', 20)}</div><div class="tx"><div class="t">${esc(name)}</div><div class="d">${esc(detail)}</div></div></div>`).join('');
    const body = `${rows}
      <div class="card" style="margin-top:12px"><div class="card-lbl">Device storage</div>
        <div class="attr-mini"><span>Used by browser storage</span><b>${mb(estimate.usage)}</b></div>
        <div class="attr-mini"><span>Estimated quota</span><b>${mb(estimate.quota)}</b></div>
      </div>
      <div class="note">Basemaps are available offline only for areas and zoom levels already cached on this device. Verify the survey area in airplane mode before deployment.</div>`;
    this.openSheet('Offline readiness', body, persisted ? '' : `<button class="btn btn-primary btn-block" id="requestPersist">${icon('save', 16)} Protect offline storage</button>`);
    const b = document.getElementById('requestPersist');
    if (b) b.onclick = async () => {
      const granted = !!(navigator.storage && navigator.storage.persist && await navigator.storage.persist());
      this.toast(granted ? 'Persistent storage granted' : 'Browser did not grant persistent storage', granted ? 'ok' : 'err');
      this.openOfflineReadiness();
    };
  },

  async buildCompleteBackup() {
    if (typeof JSZip === 'undefined') throw new Error('ZIP engine is unavailable');
    const zip = new JSZip();
    const snapshot = {
      format: 'easycapture-complete-backup',
      version: 1,
      appVersion: typeof EASYCAPTURE_VERSION === 'undefined' ? 'unknown' : EASYCAPTURE_VERSION,
      createdAt: nowISO(),
      user: await DB.all('user'),
      projects: await DB.all('projects'),
      layers: await DB.all('layers'),
      records: await DB.all('records'),
      settings: await DB.all('settings'),
      media: [],
    };
    for (const row of await DB.all('media')) {
      const path = `media/${encodeURIComponent(row.id)}`;
      if (row.blob) zip.file(path, row.blob);
      snapshot.media.push({ id: row.id, savedAt: row.savedAt || null, path: row.blob ? path : null, type: row.blob && row.blob.type || '' });
    }
    snapshot.counts = EasyCaptureSafety.backupCounts(snapshot);
    zip.file('backup.json', JSON.stringify(snapshot, null, 2));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const verified = await this.verifyCompleteBackup(blob, snapshot.counts);
    if (!verified.ok) throw new Error(verified.message);
    return blob;
  },

  async verifyCompleteBackup(fileOrBlob, expectedCounts) {
    const zip = await JSZip.loadAsync(await fileOrBlob.arrayBuffer(), { checkCRC32: true });
    const entry = zip.file('backup.json');
    if (!entry) return { ok: false, message: 'Backup verification failed: backup.json is missing' };
    const snapshot = JSON.parse(await entry.async('string'));
    const counts = EasyCaptureSafety.backupCounts(snapshot);
    for (const meta of (snapshot.media || [])) if (meta.path && !zip.file(meta.path)) return { ok: false, message: `Backup verification failed: missing attachment ${meta.id}` };
    if (expectedCounts && Object.keys(expectedCounts).some((k) => expectedCounts[k] !== counts[k])) return { ok: false, message: 'Backup verification failed: item counts changed' };
    return { ok: true, counts, snapshot };
  },

  async restoreCompleteBackup(file) {
    if (typeof JSZip === 'undefined') throw new Error('ZIP engine is unavailable');
    const check = await this.verifyCompleteBackup(file);
    if (!check.ok) throw new Error(check.message);
    const zip = await JSZip.loadAsync(await file.arrayBuffer(), { checkCRC32: true });
    const entry = zip.file('backup.json');
    if (!entry) throw new Error('backup.json is missing');
    const snapshot = JSON.parse(await entry.async('string'));
    if (snapshot.format !== 'easycapture-complete-backup' || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.records)) throw new Error('not an EasyCapture complete backup');
    const media = [];
    for (const meta of (snapshot.media || [])) {
      let blob = null;
      if (meta.path) {
        const mediaEntry = zip.file(meta.path);
        if (!mediaEntry) throw new Error(`missing attachment ${meta.id}`);
        blob = await mediaEntry.async('blob');
        if (meta.type && blob.type !== meta.type) blob = new Blob([blob], { type: meta.type });
      }
      media.push({ id: meta.id, blob, savedAt: meta.savedAt || nowISO() });
    }
    await DB.replaceAll({ user: snapshot.user || [], projects: snapshot.projects, layers: snapshot.layers || [], records: snapshot.records, settings: snapshot.settings || [], media });
  },

  async openBackupRestore() {
    const last = await DB.get('settings', 'last_verified_backup');
    const ageDays = last && last.createdAt ? Math.floor((Date.now() - new Date(last.createdAt).getTime()) / 86400000) : null;
    const backupState = last ? `Last verified backup: ${fmtDate(last.createdAt)} · ${last.records || 0} records · ${last.media || 0} attachments` : 'No verified backup has been created on this device.';
    const body = `<div class="note">A complete backup includes all profiles, projects, layers, records, routes, settings, photos, videos and files stored by EasyCapture.</div>
      <div class="backup-health ${last && ageDays <= 7 ? 'good' : 'warn'}"><b>${esc(backupState)}</b>${ageDays > 7 ? '<span>Backup is more than 7 days old.</span>' : ''}</div>
      <button class="btn btn-primary btn-block btn-lg" id="backupNow">${icon('download', 17)} Download complete backup</button>
      <input type="file" id="restoreFile" accept=".zip,application/zip" hidden />
      <button class="btn btn-ghost btn-block" id="restoreNow" style="margin-top:10px">${icon('upload', 17)} Restore complete backup</button>
      <div id="backupStatus" class="muted" style="margin-top:10px"></div>`;
    this.openSheet('Backup & restore', body);
    document.getElementById('backupNow').onclick = async () => {
      const status = document.getElementById('backupStatus'); status.textContent = 'Building protected backup…';
      try {
        const blob = await this.buildCompleteBackup();
        downloadBlob(`EasyCapture_Complete_Backup_${new Date().toISOString().slice(0, 10)}.zip`, blob, 'application/zip');
        const verified = await this.verifyCompleteBackup(blob);
        await DB.put('settings', { key: 'last_verified_backup', createdAt: nowISO(), ...verified.counts });
        status.textContent = ''; this.toast(`Verified backup downloaded · ${verified.counts.records} records`, 'ok');
      } catch (e) { status.textContent = ''; this.toast('Backup failed: ' + e.message, 'err'); }
    };
    const input = document.getElementById('restoreFile');
    document.getElementById('restoreNow').onclick = () => input.click();
    input.onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      if (!confirm('Restore this backup and replace ALL data currently stored on this device? Create a current backup first.')) return;
      const status = document.getElementById('backupStatus'); status.textContent = 'Validating and restoring backup…';
      try { await this.restoreCompleteBackup(f); this.toast('Backup restored — reloading', 'ok'); setTimeout(() => location.reload(), 700); }
      catch (err) { status.textContent = ''; this.toast('Restore failed: ' + err.message, 'err'); }
    };
  },

  async runProjectQA(showSheet) {
    if (!this.state.project) throw new Error('Select a project first');
    const records = this.state.records.filter((r) => r.projectId === this.state.project.id);
    const layers = this.state.layers.filter((l) => l.projectId === this.state.project.id);
    const mediaIds = new Set((await DB.all('media')).map((m) => m.id));
    const report = EasyCaptureSafety.audit(records, layers, { domains: this.state.project.domains || {}, mediaIds, poorAccuracy: 15 });
    if (showSheet !== false) {
      const c = report.counts;
      const cells = [['Total records', c.total], ['Complete', c.complete], ['Incomplete', c.incomplete], ['Invalid geometry', c.invalidGeometry], ['Missing required', c.missingRequired], ['Domain violations', c.domainViolations], ['Poor GPS accuracy', c.poorAccuracy], ['Missing media', c.missingMedia], ['Duplicate IDs', c.duplicateIds]];
      const details = report.issues.slice(0, 100).map((r) => `<div class="qa-issue"><b>${esc(r.layer || 'Unknown layer')} · ${esc(r.recordId)}</b><span>${esc(r.issues.join(' · '))}</span></div>`).join('');
      const body = `<div class="qa-banner ${report.passed ? 'pass' : 'fail'}"><b>${report.passed ? 'QA/QC passed' : `${report.issues.length} record(s) need attention`}</b><span>Accuracy warning threshold: ±15 m</span></div>
        <div class="qa-grid">${cells.map(([n, v]) => `<div><span>${esc(n)}</span><b>${v}</b></div>`).join('')}</div>
        ${details || '<div class="note">No QA/QC problems found.</div>'}
        <button class="btn btn-ghost btn-block" id="qaDownload">Download QA report</button>`;
      this.openSheet(`QA/QC · ${this.state.project.name}`, body);
      document.getElementById('qaDownload').onclick = () => downloadBlob(`${this.state.project.name.replace(/\s+/g, '_')}_QAQC.json`, JSON.stringify(report, null, 2), 'application/json');
    }
    return report;
  },

  openRouteSummary() {
    if (!this.state.project) { this.toast('Select a project first', 'err'); return; }
    const st = this.routeStats(), paused = !!this.state.route.paused;
    const body = `
      <div class="card"><div class="card-lbl">Default Field Route</div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">
          <div><div class="muted">Distance</div><div style="font-size:21px;font-weight:750">${this.routeDistanceText(st.distanceM)}</div></div>
          <div><div class="muted">Travel time</div><div style="font-size:21px;font-weight:750">${this.routeDurationText(st.durationS)}</div></div>
          <div><div class="muted">Track points</div><div style="font-size:17px;font-weight:700">${st.pointCount}</div></div>
          <div><div class="muted">Average speed</div><div style="font-size:17px;font-weight:700">${st.avgSpeedKmh.toFixed(1)} km/h</div></div>
        </div>
        <div class="note" style="margin-top:12px">GPS route points are saved automatically to this project and included in every complete export package.</div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px"><button class="btn btn-ghost flex" id="routePause">${paused ? icon('play', 16) + ' Resume tracking' : icon('pause', 16) + ' Pause tracking'}</button><button class="btn btn-ghost flex" id="routeZoom">${icon('search', 16)} Zoom to route</button></div>
      <button class="btn btn-primary btn-block" id="routeDownload">${icon('download', 16)} Download Route GeoJSON</button>
      <button class="btn btn-danger btn-block" id="routeClear" style="margin-top:10px">${icon('trash', 16)} Clear Route</button>`;
    this.openSheet(`Field Route · ${this.state.project.name}`, body);
    document.getElementById('routePause').onclick = async () => { this.state.route.paused = !this.state.route.paused; await this.persistRoute(); this.openRouteSummary(); this.toast(`Route tracking ${this.state.route.paused ? 'paused' : 'resumed'}`, 'ok'); };
    document.getElementById('routeZoom').onclick = () => { const pts = this.state.route.points || []; if (!pts.length) { this.toast('No route points yet', 'err'); return; } this.closeSheet(); this.state.map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])).pad(0.18)); };
    document.getElementById('routeDownload').onclick = () => { if (!st.pointCount) { this.toast('No route points yet', 'err'); return; } const safe = this.state.project.name.replace(/\s+/g, '_'); downloadBlob(`${safe}_Field_Route.geojson`, JSON.stringify(this.routeGeoJSON(), null, 2), 'application/geo+json'); this.toast('Route GeoJSON downloaded', 'ok'); };
    document.getElementById('routeClear').onclick = async () => { if (!confirm('Clear the saved field route for this project?')) return; await this.clearTrail(); this.openRouteSummary(); };
  },
  openMenu() {
    const u = this.state.user || { name: '—', role: '' };
    const body = `
      <div class="userbox"><div class="ic">${icon('user', 22)}</div><div><div class="t">${esc(u.name)}</div><div class="d">${esc(u.role)}</div></div><button class="btn-text" id="editUser" style="margin-left:auto">Edit</button></div>
      <div class="tpl" id="mProjects"><div class="ic">${icon('folder', 21)}</div><div class="tx"><div class="t">Projects</div><div class="d">${esc(this.state.project ? this.state.project.name : 'None')}</div></div><div class="chev">${icon('chevron', 18)}</div></div>
      <div class="tpl" id="mLayers"><div class="ic">${icon('stack', 21)}</div><div class="tx"><div class="t">Asset Types</div><div class="d">Create, symbolize and edit feature classes</div></div><div class="chev">${icon('chevron', 18)}</div></div>
      <div class="tpl" id="mImport"><div class="ic">${icon('upload', 21)}</div><div class="tx"><div class="t">Import existing data</div><div class="d">Load GeoJSON into a layer to edit</div></div><div class="chev">${icon('chevron', 18)}</div></div>
      <div class="tpl" id="mExport"><div class="ic">${icon('download', 21)}</div><div class="tx"><div class="t">Export & share</div><div class="d">GeoJSON, KML, Shapefile, CSV, ZIP</div></div><div class="chev">${icon('chevron', 18)}</div></div>
      <div class="tpl" id="mRoute"><div class="ic">${icon('navigation', 21)}</div><div class="tx"><div class="t">Default Field Route</div><div class="d">${this.routeDistanceText(this.routeStats().distanceM)} · ${this.routeStats().pointCount} saved GPS points${this.state.route.paused ? ' · paused' : ''}</div></div><div class="chev">${icon('chevron', 18)}</div></div>
      <div class="tpl" id="mGnss"><div class="ic">${icon('target', 21)}</div><div class="tx"><div class="t">External GNSS receiver</div><div class="d">${this._gnssActive ? 'Connected · ' + this.gnssFixLabel() : 'Pair an RTK receiver for cm accuracy'}</div></div><div class="chev">${icon('chevron', 18)}</div></div>
      <div class="tpl" id="mOffline"><div class="ic">${icon('checkCircle', 21)}</div><div class="tx"><div class="t">Offline readiness</div><div class="d">Verify cache, libraries and protected storage</div></div><div class="chev">${icon('chevron', 18)}</div></div>
      <div class="tpl" id="mQA"><div class="ic">${icon('alert', 21)}</div><div class="tx"><div class="t">Project QA/QC</div><div class="d">Check attributes, geometry, GPS and attachments</div></div><div class="chev">${icon('chevron', 18)}</div></div>
      <div class="tpl" id="mBackup"><div class="ic">${icon('package', 21)}</div><div class="tx"><div class="t">Backup & restore</div><div class="d">Complete device backup including attachments</div></div><div class="chev">${icon('chevron', 18)}</div></div>
      ${this.state.project ? `<div class="card" style="margin-top:6px"><div class="card-lbl">${icon('globe', 12, 'display:inline;vertical-align:-2px')} Project coordinate system</div><div style="font-family:var(--mono);font-size:12.5px">${esc(this.state.project.crsName)} · ${esc(this.state.project.crsCode)}</div></div>` : ''}
      <button class="btn btn-danger btn-block" id="mWipe">${icon('trash', 16)} Erase all local data</button>
      <div class="muted" style="text-align:center;margin-top:14px">EasyCapture · offline-first field GIS</div>`;
    this.openSheet('Menu', body);
    document.getElementById('editUser').onclick = () => this.showWelcome();
    document.getElementById('mProjects').onclick = () => this.navTo(this.openProjectPicker);
    document.getElementById('mLayers').onclick = () => this.navTo(this.openLayers);
    const mg = document.getElementById('mGnss'); if (mg) mg.onclick = () => this.navTo(this.openGNSSSheet);
    document.getElementById('mImport').onclick = () => this.navTo(this.openImport);
    document.getElementById('mExport').onclick = () => this.navTo(this.openExport);
    document.getElementById('mRoute').onclick = () => this.navTo(this.openRouteSummary);
    document.getElementById('mOffline').onclick = () => this.navTo(this.openOfflineReadiness);
    document.getElementById('mQA').onclick = () => this.navTo(() => this.runProjectQA(true));
    document.getElementById('mBackup').onclick = () => this.navTo(this.openBackupRestore);
    document.getElementById('mWipe').onclick = async () => {
      if (!confirm('Erase ALL data on this device (projects, layers, records, media, profile)? This cannot be undone.')) return;
      await DB.clear('projects'); await DB.clear('layers'); await DB.clear('records'); await DB.clear('media'); await DB.clear('settings'); await DB.clear('user');
      localStorage.clear(); location.reload();
    };
  },

  /* ---------- Import: see Part 8 (multi-format openImport / parseGISFile / importGeoJSON) ---------- */

  /* ---------- Export ---------- */
  openExport() {
    if (!this.state.project) { this.toast('Select a project first', 'err'); return; }
    const proj = this.state.project;
    const safe = proj.name.replace(/\s+/g, '_');
    const layers = this.state.layers.filter((l) => l.projectId === this.state.project.id);
    this._exLayer = this._exLayer || 'all';
    const recsFor = () => { let rs = this.state.records.filter((r) => r.projectId === this.state.project.id); if (this._exLayer !== 'all') rs = rs.filter((r) => r.layerId === this._exLayer); return rs; };
    const recs = recsFor();
    const body = `
      <div class="field"><label class="lbl">Layer</label><select class="sel" id="exLayerSel"><option value="all" ${this._exLayer === 'all' ? 'selected' : ''}>All layers (${this.state.records.filter((r) => r.projectId === this.state.project.id).length})</option>${layers.map((l) => `<option value="${l.id}" ${this._exLayer === l.id ? 'selected' : ''}>${esc(l.name)} (${this.state.records.filter((r) => r.layerId === l.id).length})</option>`).join('')}</select></div>
      <div class="card"><div class="card-lbl">GIS formats · ${recs.length} record${recs.length !== 1 ? 's' : ''} · ${esc(this.state.project.crsName)}</div>
        <div class="export-grid">
          <button class="ex-btn" data-ex="geojson">${icon('mapPin', 22)} GeoJSON<span class="f">.geojson</span></button>
          <button class="ex-btn" data-ex="kml">${icon('mapPin', 22)} KML<span class="f">.kml</span></button>
          <button class="ex-btn" data-ex="shp">${icon('layers', 22)} Shapefile<span class="f">.zip</span></button>
          <button class="ex-btn" data-ex="csv">${icon('grid', 22)} CSV<span class="f">.csv</span></button>
          <button class="ex-btn" data-ex="xlsx">${icon('grid', 22)} Excel + Media<span class="f">.zip</span></button>
          <button class="ex-btn" data-ex="pdf">${icon('file', 22)} PDF<span class="f">.pdf</span></button>
        </div></div>
      <div class="card"><div class="card-lbl">Default Field Route · ${this.routeStats().pointCount} GPS points</div><button class="btn btn-ghost btn-block" id="exRoute">${icon('navigation', 16)} Download Route GeoJSON · ${this.routeDistanceText(this.routeStats().distanceM)} · ${this.routeDurationText(this.routeStats().durationS)}</button></div>
      <div class="card"><div class="card-lbl">Complete package</div><button class="btn btn-primary btn-block" id="exZip">${icon('package', 16)} Build ZIP (data + media + report)</button>
        <div class="muted" style="margin-top:8px">Includes GeoJSON, KML, CSV, self-contained Shapefile media bundle, clickable Excel media bundle, field route and README. Geometry carries Z.</div></div>
      <div class="card"><div class="card-lbl">Data quality</div><button class="btn btn-ghost btn-block" id="exQA">${icon('checkCircle', 16)} Run pre-export QA/QC</button>
        <div class="muted" style="margin-top:8px">Checks required fields, geometry, domains, duplicate IDs, GPS accuracy and missing attachments.</div></div>
      <div class="card"><div class="card-lbl">Share</div><div style="display:flex;gap:8px"><button class="btn btn-ghost flex" id="exShare">${icon('share', 16)} Device share</button>${proj.template ? `<button class="btn btn-primary btn-block" id="exOffice" style="margin-bottom:8px">${icon('stack', 16)} Office package — per-feature-class GeoJSON (${esc(proj.template.name.split('_Templates')[0])})</button><div class="muted" style="margin-bottom:10px">Columns match the geodatabase exactly, domain CODES, EPSG from the template. Avoid Shapefile for template layers — long field names would truncate.</div>` : ''}<button class="btn btn-ghost flex" id="exMail">${icon('mail', 16)} Email</button></div></div>`;
    this.openSheet(`Export · ${this.state.project.name}`, body);
    document.getElementById('exLayerSel').onchange = (e) => { this._exLayer = e.target.value; this.openExport(); };
    document.getElementById('exQA').onclick = () => this.runProjectQA(true);
    const reproj = (gj) => this.reprojectGeoJSON(gj, proj.crsCode);
    document.querySelectorAll('[data-ex]').forEach((b) => b.onclick = async () => {
      const s = recsFor(); if (!s.length) { this.toast('No records to export', 'err'); return; }
      const ex = b.dataset.ex;
      try {
        if (ex === 'geojson') { const gj = reproj(Exporter.toGeoJSON(s)); downloadBlob(`${safe}.geojson`, JSON.stringify(gj, null, 2), 'application/geo+json'); this.toast('GeoJSON downloaded', 'ok'); }
        else if (ex === 'kml') { downloadBlob(`${safe}.kml`, Exporter.toKML(s, proj.name), 'application/vnd.google-earth.kml+xml'); this.toast('KML downloaded (WGS84)', 'ok'); }
        else if (ex === 'csv') { downloadBlob(`${safe}.csv`, Exporter.toCSV(s), 'text/csv'); this.toast('CSV downloaded', 'ok'); }
        else if (ex === 'xlsx') { const result = await Exporter.downloadExcel(s, proj.name); this.toast(result.bundled ? 'Excel + media bundle downloaded' : 'Excel downloaded', 'ok'); }
        else if (ex === 'shp') {
          try {
            const bl = await Exporter.toShapefileZip(s, proj.name);
            downloadBlob(`${safe}_shapefile.zip`, bl, 'application/zip');
            this.toast('Shapefile downloaded', 'ok');
          } catch (err) { console.warn('shapefile export', err); this.toast(err.message || 'Shapefile export failed', 'err'); }
        }
        else if (ex === 'pdf') { if (await Exporter.openPDFReport(s, proj)) this.toast('Choose Save as PDF', 'ok'); else this.toast('Allow popups for PDF', 'err'); }
      } catch (e) { this.toast('Export failed: ' + e.message, 'err'); }
    });
    document.getElementById('exRoute').onclick = () => {
      const route = this.routeGeoJSON();
      if (!route.features.length) { this.toast('No route points yet', 'err'); return; }
      downloadBlob(`${safe}_Field_Route.geojson`, JSON.stringify(route, null, 2), 'application/geo+json');
      this.toast('Route GeoJSON downloaded', 'ok');
    };
    document.getElementById('exZip').onclick = async () => {
      const s = recsFor(), route = this.routeGeoJSON(); if (!s.length && !route.features.length) { this.toast('No records or route points', 'err'); return; }
      const btn = document.getElementById('exZip'); btn.innerHTML = `${icon('refresh', 16, 'display:inline-block')} Building…`;
      try {
        const qaReport = await this.runProjectQA(false);
        const blob = await Exporter.buildZipPackage(s, proj, route.features.length ? route : null, { layers: this.state.layers.filter((l) => l.projectId === proj.id), qaReport, appVersion: typeof EASYCAPTURE_VERSION === 'undefined' ? 'unknown' : EASYCAPTURE_VERSION });
        const checkZip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
        if (!checkZip.file('data/project.json') || !checkZip.file('data/qaqc_report.json')) throw new Error('Export integrity verification failed');
        downloadBlob(`${safe}_package.zip`, blob, 'application/zip');
        this.toast(`Verified ZIP downloaded · QA ${qaReport.passed ? 'passed' : 'warnings included'}`, 'ok');
      } catch (e) { this.toast('ZIP failed: ' + e.message, 'err'); }
      btn.innerHTML = `${icon('package', 16)} Build ZIP (data + media + report)`;
    };
    document.getElementById('exShare').onclick = async () => { const s = recsFor(); if (!s.length) return; const gj = JSON.stringify(reproj(Exporter.toGeoJSON(s)), null, 2); const file = new File([gj], `${safe}.geojson`, { type: 'application/geo+json' }); if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: proj.name }); } catch {} } else if (navigator.share) { try { await navigator.share({ title: proj.name, text: `${s.length} records` }); } catch {} } else this.toast('Sharing not supported — use download', 'err'); };
    const exTplBtn = document.getElementById('exOffice');
    if (exTplBtn) exTplBtn.onclick = async () => {
      exTplBtn.disabled = true; const prev = exTplBtn.innerHTML; exTplBtn.innerHTML = `${icon('refresh', 16)} Building…`;
      try { const blob = await this.buildOfficePackage(); downloadBlob(`${safe}_OFFICE_${(proj.template && proj.template.name || 'template')}.zip`, blob, 'application/zip'); this.toast('Office package downloaded — load with the GDB toolbox', 'ok'); }
      catch (e) { this.toast('Office export failed: ' + e.message, 'err'); }
      exTplBtn.innerHTML = prev; exTplBtn.disabled = false;
    };
    document.getElementById('exMail').onclick = async () => {
      const s = recsFor(); if (!s.length) { this.toast('No records to send', 'err'); return; }
      const btn = document.getElementById('exMail'); const prev = btn.innerHTML; btn.innerHTML = `${icon('refresh', 16, 'display:inline-block')} Preparing…`; btn.disabled = true;
      try {
        // Build the full ZIP package and hand it to the device share sheet — choosing
        // Gmail/Outlook there attaches the file automatically to a new email.
        const route = this.routeGeoJSON();
        const blob = await Exporter.buildZipPackage(s, proj, route.features.length ? route : null, { layers: this.state.layers.filter((l) => l.projectId === proj.id) });
        const file = new File([blob], `${safe}_Package.zip`, { type: 'application/zip' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: `EasyCapture export — ${proj.name}`, text: `${s.length} record(s) from "${proj.name}". Package includes GeoJSON, KML, Shapefile, CSV, Excel and media.` });
        } else {
          // Desktop / unsupported browser: download the ZIP, then open a pre-filled email.
          downloadBlob(`${safe}_Package.zip`, blob, 'application/zip');
          this.toast('ZIP downloaded — attach it to the email that opens', 'ok');
          setTimeout(() => { window.location.href = `mailto:?subject=${encodeURIComponent('EasyCapture export — ' + proj.name)}&body=${encodeURIComponent(`${s.length} record(s) from "${proj.name}". The package ZIP was just downloaded — please attach it.`)}`; }, 600);
        }
      } catch (e) { if (e && e.name !== 'AbortError') this.toast('Could not prepare the email package', 'err'); }
      btn.innerHTML = prev; btn.disabled = false;
    };
  },

  // Reproject a WGS84 GeoJSON to the project CRS for export (coordinates become E/N)
  reprojectGeoJSON(gj, crsCode) {
    if (!crsCode || crsCode === 'EPSG:4326' || typeof Geo === 'undefined') return gj;
    const conv = (coords) => { if (typeof coords[0] === 'number') { const p = Geo.project([coords[0], coords[1]], crsCode); return coords.length > 2 ? [p[0], p[1], coords[2]] : [p[0], p[1]]; } return coords.map(conv); };
    const out = JSON.parse(JSON.stringify(gj));
    out.features.forEach((f) => { if (f.geometry && f.geometry.coordinates) f.geometry.coordinates = conv(f.geometry.coordinates); });
    out.crs = { type: 'name', properties: { name: crsCode } };
    return out;
  },
});



/* ============================================================
   Part 7 — Quick layers panel, guidance system, setup wizard
   ============================================================ */
Object.assign(App, {
  /* ---------- Quick layer visibility panel (Esri layer-list pattern) ---------- */
  toggleLayersPanel() {
    const p = document.getElementById('layersPanel');
    if (p.classList.contains('show')) { p.classList.remove('show'); return; }
    this.renderLayersPanel();
    p.classList.add('show');
  },
  renderLayersPanel() {
    const host = document.getElementById('lpList');
    if (!this.state.project) { host.innerHTML = '<div class="lp-empty">No project open.</div>'; return; }
    const layers = this.state.layers.filter((l) => l.projectId === this.state.project.id);
    if (!layers.length) { host.innerHTML = '<div class="lp-empty">No layers yet — tap Manage to create one.</div>'; return; }
    const eyeOn = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    const eyeOff = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';
    host.innerHTML = layers.map((l) => {
      const n = this.state.records.filter((r) => r.layerId === l.id).length;
      return `<div class="lp-row"><div class="sw-mini lp-symb" data-lpsymb="${l.id}" title="Symbology — colour, size, transparency">${this.symbSwatch(l)}</div><div class="nm">${esc(l.name)}</div><span class="cnt">${n}</span><button class="lp-eye ${l.hidden ? 'off' : ''}" data-lpv="${l.id}">${l.hidden ? eyeOff : eyeOn}</button></div>`;
    }).join('');
    host.querySelectorAll('[data-lpsymb]').forEach((el) => el.onclick = (e) => {
      e.stopPropagation();
      document.getElementById('layersPanel').classList.remove('show');
      this.rootNav(this.symbologyEditor, [el.dataset.lpsymb]);
    });
    host.querySelectorAll('[data-lpv]').forEach((el) => el.onclick = async () => {
      const l = this.state.layers.find((x) => x.id === el.dataset.lpv);
      l.hidden = !l.hidden;
      await DB.put('layers', l);
      this.renderAllLayers();
      this.renderLayersPanel();
    });
  },

  /* ---------- Contextual guidance ---------- */
  guide(title, msg, actionLabel, actionFn) {
    const b = document.getElementById('guideBanner');
    document.getElementById('gbTitle').textContent = title;
    document.getElementById('gbMsg').textContent = msg;
    const act = document.getElementById('gbAction');
    if (actionLabel) { act.style.display = 'block'; act.textContent = actionLabel; act.onclick = () => { this.hideGuide(); actionFn && actionFn(); }; }
    else act.style.display = 'none';
    b.classList.add('show');
    clearTimeout(this._guideT);
    this._guideT = setTimeout(() => this.hideGuide(), 14000);
  },
  hideGuide() { document.getElementById('guideBanner').classList.remove('show'); clearTimeout(this._guideT); },
  // Called after key state changes: shows the user their current status and next step
  updateGuidance() {
    if (!this.state.user) return;
    if (!this.state.project) { this.guide('No project open', 'Create or open a project to begin.', 'Projects', () => this.rootNav(this.openProjectPicker)); return; }
    if (this.isStreamingProject()) {
      if (!this._streamActive) this.guide('Streaming Capture ready', 'Walk or drive to your start position, then tap Start on the bar below. Coordinates are captured automatically.', null, null);
      else this.hideGuide();
      return;
    }
    const layers = this.state.layers.filter((l) => l.projectId === this.state.project.id);
    if (!layers.length) { this.guide('Project ready', 'Now add your first layer — import GIS data or create one from scratch.', 'Set up', () => this.rootNav(this.projectStartChoice)); return; }
    const recs = this.state.records.filter((r) => r.projectId === this.state.project.id);
    if (!recs.length) { this.guide(`${layers.length} layer${layers.length > 1 ? 's' : ''} ready`, 'Tap Collect to capture your first record, or import existing data from the menu.', 'Collect', () => this.rootNav(this.startCollect)); return; }
    this.hideGuide();
  },

  /* ---------- Setup wizard: after project creation ---------- */
  projectStartChoice() {
    const body = `
      <div class="note" style="margin-bottom:14px"><b>${esc(this.state.project.name)}</b> is ready. How do you want to start?</div>
      <div class="tpl" id="wTemplate"><div class="ic">${icon('stack', 21)}</div><div class="tx"><div class="t">Import Schema (Template)</div><div class="d">Load a municipal Template Pack (.smtp.json) — all feature classes, fields and dropdown domains, ready to collect</div></div><div class="chev">${icon('chevron', 18)}</div></div>
      <div class="tpl" id="wImport"><div class="ic">${icon('upload', 21)}</div><div class="tx"><div class="t">Import existing GIS data</div><div class="d">GeoJSON, Shapefile (.zip) or KML — layers & fields are created automatically</div></div><div class="chev">${icon('chevron', 18)}</div></div>
      <div class="tpl" id="wScratch"><div class="ic">${icon('plus', 21)}</div><div class="tx"><div class="t">Start from scratch</div><div class="d">Create your first Asset Type and define its fields</div></div><div class="chev">${icon('chevron', 18)}</div></div>`;
    this.openSheet('Set up your project', body);
    document.getElementById('wTemplate').onclick = () => this.navTo(this.openTemplateImport);
    document.getElementById('wImport').onclick = () => this.navTo(this.openImport);
    document.getElementById('wScratch').onclick = () => this.navTo(this.layerEditor, [null]);
  },

  /* ---------- After an Asset Type is saved: add another or start collecting ---------- */
  afterLayerSaved(layer) {
    const layers = this.state.layers.filter((l) => l.projectId === this.state.project.id);
    const body = `
      <div class="note" style="margin-bottom:14px">Asset Type <b>${esc(layer.name)}</b> saved (${layer.geomType}, ${layer.fields.length} field${layer.fields.length !== 1 ? 's' : ''}). Project now has ${layers.length} asset type${layers.length !== 1 ? 's' : ''}.</div>
      <div class="tpl" id="wAnother"><div class="ic">${icon('plus', 21)}</div><div class="tx"><div class="t">Add another Asset Type</div><div class="d">Point, line or polygon with custom attributes</div></div><div class="chev">${icon('chevron', 18)}</div></div>
      <div class="tpl" id="wCollect"><div class="ic">${icon('point', 21)}</div><div class="tx"><div class="t">Start collecting</div><div class="d">Capture your first ${esc(layer.name)} record</div></div><div class="chev">${icon('chevron', 18)}</div></div>
      <div class="tpl" id="wLayers"><div class="ic">${icon('stack', 21)}</div><div class="tx"><div class="t">Review Asset Types</div><div class="d">Symbology, fields, visibility</div></div><div class="chev">${icon('chevron', 18)}</div></div>`;
    this.openSheet('Asset Type saved', body);
    document.getElementById('wAnother').onclick = () => this.navTo(this.layerEditor, [null]);
    document.getElementById('wCollect').onclick = () => { this.state.activeLayer = layer; this.rootNav(this.startCollect); };
    document.getElementById('wLayers').onclick = () => this.rootNav(this.openLayers);
  },
});

/* ============================================================
   Part 8 — Custom GeoTIFF imagery + multi-format GIS import
   ============================================================ */
Object.assign(App, {
  /* ---------- Custom imagery: upload a georeferenced GeoTIFF, rendered in-app ---------- */
  wireImagery() {
    const btn = document.getElementById('bmAddImagery');
    const input = document.getElementById('geotiffInput');
    if (!btn || !input) return;
    btn.onclick = () => {
      if (typeof parseGeoraster === 'undefined' || typeof GeoRasterLayer === 'undefined') { this.toast('Imagery engine still loading — try again in a moment (needs one online load)', 'err'); return; }
      input.click();
    };
    input.onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      await this.loadGeoTIFF(f, true);
    };
    document.getElementById('bmImageryOpacity').oninput = (ev) => { if (this._imageryLayer) this._imageryLayer.setOpacity(+ev.target.value / 100); };
    document.getElementById('bmImageryRemove').onclick = async () => {
      if (this._imageryLayer && this.state.map) this.state.map.removeLayer(this._imageryLayer);
      this._imageryLayer = null;
      document.getElementById('bmImageryRow').style.display = 'none';
      if (this.state.project) { await Media.remove('geotiff_' + this.state.project.id); await DB.del('settings', 'imagery_' + this.state.project.id).catch(() => {}); }
      this.toast('Imagery removed');
    };
  },
  async loadGeoTIFF(fileOrBlob, persist) {
    if (!this.state.map) { this.toast('Map not ready', 'err'); return; }
    if (!this.state.project) { this.toast('Open a project first', 'err'); return; }
    this.toast('Reading GeoTIFF…');
    try {
      const buf = await fileOrBlob.arrayBuffer();
      const georaster = await parseGeoraster(buf);
      if (this._imageryLayer) this.state.map.removeLayer(this._imageryLayer);
      this._imageryLayer = new GeoRasterLayer({ georaster, opacity: 1, resolution: 256 });
      this._imageryLayer.addTo(this.state.map);
      try { this.state.map.fitBounds(this._imageryLayer.getBounds()); } catch {}
      const row = document.getElementById('bmImageryRow');
      row.style.display = 'flex';
      document.getElementById('bmImageryName').textContent = fileOrBlob.name || 'imagery';
      document.getElementById('bmImageryOpacity').value = 100;
      if (persist) {
        await Media.save('geotiff_' + this.state.project.id, fileOrBlob);
        await DB.put('settings', { key: 'imagery_' + this.state.project.id, name: fileOrBlob.name || 'imagery', savedAt: nowISO() });
      }
      this.toast('Imagery loaded — zoom in for full detail', 'ok');
      this.renderAllLayers(); // keep features above imagery
    } catch (err) {
      console.warn('GeoTIFF load failed', err);
      this.toast('Could not read this GeoTIFF. It must be a georeferenced .tif (WGS84 or UTM work best).', 'err');
    }
  },
  // Restore saved imagery when the project opens
  async restoreImagery() {
    if (this._imageryLayer && this.state.map) { this.state.map.removeLayer(this._imageryLayer); this._imageryLayer = null; }
    const row = document.getElementById('bmImageryRow'); if (row) row.style.display = 'none';
    if (!this.state.project) return;
    const meta = await DB.get('settings', 'imagery_' + this.state.project.id).catch(() => null);
    if (!meta) return;
    const blob = await Media.blob('geotiff_' + this.state.project.id);
    if (!blob) return;
    if (typeof parseGeoraster === 'undefined') { setTimeout(() => this.restoreImagery(), 2500); return; } // lib still loading
    blob.name = meta.name;
    await this.loadGeoTIFF(blob, false);
  },

  /* ---------- Multi-format import: GeoJSON / Shapefile(.zip) / KML ---------- */
  openImport() {
    if (!this.state.project) { this.toast('Select a project first', 'err'); return; }
    const layers = this.state.layers.filter((l) => l.projectId === this.state.project.id);
    const body = `
      <div class="note" style="margin-bottom:12px">Import <b>GeoJSON</b> (.geojson/.json), <b>Shapefile</b> (.zip) or <b>KML</b> (.kml). Layers, fields and symbology are created automatically from the data, and every feature stays fully editable — geometry and attributes.</div>
      <input type="file" id="impFile" accept=".geojson,.json,.kml,.zip,application/geo+json,application/json,application/vnd.google-earth.kml+xml,application/zip" hidden />
      <button class="btn btn-primary btn-block btn-lg" id="impBtn">${icon('upload', 17)} Choose file to import</button>
      ${layers.length ? `<div class="field" style="margin-top:14px"><label class="lbl">Or import into an existing layer (matching geometry only)</label><select class="sel" id="impLayer"><option value="">— create new layer(s) automatically —</option>${layers.map((l) => `<option value="${l.id}">${esc(l.name)} (${l.geomType})</option>`).join('')}</select></div>` : ''}
      <div id="impStatus" class="muted" style="margin-top:12px"></div>
      <div class="card" style="margin-top:16px"><div class="card-lbl">Merge from another surveyor</div>
        <div class="note" style="margin-bottom:10px">Combine another device's work into this project — bring in their <b>project.json</b> (or the full ZIP export) from an offline surveyor. Matches records by ID and keeps the newest version of anything captured on both devices; layers not in this project are created automatically. <b>Photos/videos are not carried over</b> by this merge — only geometry and attributes; for media, copy the ZIP's media folder manually.</div>
        <input type="file" id="mergeFile" accept=".json,.zip,application/json,application/zip" hidden />
        <button class="btn btn-ghost btn-block" id="mergeBtn">${icon('upload', 17)} Choose project.json or ZIP to merge</button>
        <div id="mergeStatus" class="muted" style="margin-top:10px"></div>
      </div>`;
    this.openSheet('Import GIS data', body);
    const file = document.getElementById('impFile');
    document.getElementById('impBtn').onclick = () => file.click();
    file.onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      const status = document.getElementById('impStatus');
      status.textContent = 'Reading ' + f.name + '…';
      try {
        const gj = await this.parseGISFile(f);
        const targetSel = document.getElementById('impLayer');
        await this.importGeoJSON(gj, f.name, targetSel ? targetSel.value : '');
      } catch (err) {
        console.warn('import failed', err);
        status.textContent = '';
        this.toast('Import failed: ' + (err.message || 'unreadable file'), 'err');
      }
    };
    const mergeFile = document.getElementById('mergeFile');
    document.getElementById('mergeBtn').onclick = () => mergeFile.click();
    mergeFile.onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      const status = document.getElementById('mergeStatus');
      status.textContent = 'Reading ' + f.name + '…';
      try {
        const payload = await this.readMergePayload(f);
        status.textContent = 'Merging…';
        const summary = await this.mergeProjectData(payload);
        status.textContent = '';
        this.toast(`Merged: ${summary.layersCreated} layer(s) added, ${summary.added} record(s) added, ${summary.updated} updated, ${summary.kept} kept (already newer locally)`, 'ok');
        this.renderAllLayers(); this.refreshBarSub();
      } catch (err) {
        console.warn('merge failed', err);
        status.textContent = '';
        this.toast('Merge failed: ' + (err.message || 'unreadable file'), 'err');
      }
    };
  },

  // Read either a raw project.json file, or a full ZIP export (extracts data/project.json from it).
  async readMergePayload(f) {
    const name = (f.name || '').toLowerCase();
    if (name.endsWith('.zip')) {
      if (typeof JSZip === 'undefined') throw new Error('ZIP engine not available');
      const zip = await JSZip.loadAsync(await f.arrayBuffer());
      const entry = zip.file('data/project.json');
      if (!entry) throw new Error('no data/project.json found inside this ZIP');
      return JSON.parse(await entry.async('string'));
    }
    return JSON.parse(await f.text());
  },

  // Merge another device's project.json payload into the currently open project.
  // Matches layers by (name + geomType); matches records by their stable id, newest updatedAt wins.
  async mergeProjectData(payload) {
    if (!payload || !Array.isArray(payload.records)) throw new Error('not a recognized project export');
    const proj = this.state.project;
    const localLayers = this.state.layers.filter((l) => l.projectId === proj.id);
    const srcLayers = Array.isArray(payload.layers) ? payload.layers : [];
    const layerMap = new Map(); // source layerId -> local layer object
    let layersCreated = 0;
    for (const sl of srcLayers) {
      let match = localLayers.find((ll) => ll.name.toLowerCase() === (sl.name || '').toLowerCase() && ll.geomType === sl.geomType);
      if (!match) {
        match = { id: uid('lyr'), projectId: proj.id, name: sl.name || 'Merged Layer', geomType: sl.geomType || 'point', fields: (sl.fields || []).map((f) => ({ ...f })), symbology: sl.symbology || this.defaultSymb(sl.geomType || 'point', this.nextLayerColor()), stream: !!sl.stream, createdAt: nowISO() };
        await DB.put('layers', match);
        this.state.layers.push(match); localLayers.push(match);
        layersCreated++;
      }
      layerMap.set(sl.id, match);
    }
    // records referencing a layer we couldn't map (e.g. layers array missing/older export) fall back
    // to a single catch-all "Merged Records" layer matched on geometry type, created on demand.
    const fallbackLayer = {};
    const getFallback = (geomType) => {
      if (fallbackLayer[geomType]) return fallbackLayer[geomType];
      let match = localLayers.find((ll) => ll.name === 'Merged Records' && ll.geomType === geomType);
      if (!match) { match = { id: uid('lyr'), projectId: proj.id, name: 'Merged Records', geomType, fields: [], symbology: this.defaultSymb(geomType, this.nextLayerColor()), createdAt: nowISO() }; }
      fallbackLayer[geomType] = match;
      return match;
    };

    let added = 0, updated = 0, kept = 0;
    const localById = new Map(this.state.records.map((r) => [r.id, r]));
    for (const sr of payload.records) {
      if (!sr || !sr.id || !sr.geometry) continue;
      let targetLayer = layerMap.get(sr.layerId);
      if (!targetLayer) {
        const geomType = sr.geomType || (sr.geometry.type === 'Point' ? 'point' : sr.geometry.type === 'LineString' ? 'line' : 'polygon');
        targetLayer = getFallback(geomType);
        if (!this.state.layers.some((l) => l.id === targetLayer.id)) { await DB.put('layers', targetLayer); this.state.layers.push(targetLayer); localLayers.push(targetLayer); layersCreated++; }
      }
      const rec = { ...sr, projectId: proj.id, layerId: targetLayer.id, layerName: targetLayer.name };
      const existing = localById.get(rec.id);
      if (!existing) {
        await DB.put('records', rec);
        this.state.records.unshift(rec); localById.set(rec.id, rec);
        added++;
      } else {
        const srcTime = Date.parse(rec.updatedAt || rec.createdAt || 0) || 0;
        const localTime = Date.parse(existing.updatedAt || existing.createdAt || 0) || 0;
        if (srcTime > localTime) {
          await DB.put('records', rec);
          const i = this.state.records.findIndex((r) => r.id === rec.id);
          if (i >= 0) this.state.records[i] = rec;
          updated++;
        } else kept++;
      }
    }
    return { layersCreated, added, updated, kept };
  },

  async parseGISFile(f) {
    const name = (f.name || '').toLowerCase();
    if (name.endsWith('.zip')) {
      if (typeof shp === 'undefined') throw new Error('Shapefile engine still loading — try again (needs one online load)');
      const buf = await f.arrayBuffer();
      const out = await shp(buf); // FeatureCollection or array of them (multi-layer zip)
      if (Array.isArray(out)) {
        // A zip may hold several shapefiles. Tag each feature with its source .shp so the
        // importer can keep one layer per shapefile instead of merging them together.
        const merged = { type: 'FeatureCollection', features: [] };
        out.forEach((fc) => { (fc.features || []).forEach((ft) => { ft.properties = ft.properties || {}; ft.properties.__source_layer = fc.fileName || ''; merged.features.push(ft); }); });
        return merged;
      }
      return out;
    }
    if (name.endsWith('.kml')) {
      const text = await f.text();
      const dom = new DOMParser().parseFromString(text, 'text/xml');
      if (typeof toGeoJSON !== 'undefined' && toGeoJSON.kml) return toGeoJSON.kml(dom);
      if (typeof window.toGeoJSON !== 'undefined') return window.toGeoJSON.kml(dom);
      throw new Error('KML engine still loading — try again (needs one online load)');
    }
    // GeoJSON
    const text = await f.text();
    return JSON.parse(text);
  },

  // Import a FeatureCollection. If targetLayerId given, features with matching geometry go into it;
  // otherwise layers are created automatically per geometry type with fields derived from properties.
  async importGeoJSON(gj, sourceName, targetLayerId) {
    let feats = gj.type === 'FeatureCollection' ? (gj.features || []) : (gj.type === 'Feature' ? [gj] : []);
    // explode Multi* geometries into single-part features so everything is editable
    const exploded = [];
    for (const f of feats) {
      if (!f || !f.geometry) continue;
      const g = f.geometry, p = f.properties || {};
      if (g.type === 'MultiPoint') g.coordinates.forEach((c) => exploded.push({ geometry: { type: 'Point', coordinates: c }, properties: p }));
      else if (g.type === 'MultiLineString') g.coordinates.forEach((c) => exploded.push({ geometry: { type: 'LineString', coordinates: c }, properties: p }));
      else if (g.type === 'MultiPolygon') g.coordinates.forEach((c) => exploded.push({ geometry: { type: 'Polygon', coordinates: c }, properties: p }));
      else if (['Point', 'LineString', 'Polygon'].includes(g.type)) exploded.push({ geometry: g, properties: p });
      // GeometryCollections and others skipped
    }
    if (!exploded.length) throw new Error('no importable Point/Line/Polygon features found');

    const typeMap = { Point: 'point', LineString: 'line', Polygon: 'polygon' };
    const base = (sourceName || 'import').replace(/\.(geojson|json|kml|zip)$/i, '').replace(/[^\w\- ]+/g, '').trim() || 'IMPORT';

    // Group by SOURCE first (each .shp inside a zip, or the file itself), then by geometry type.
    // One shapefile therefore becomes ONE layer the surveyor works on as a single unit — a layer is
    // only ever split when a single source genuinely mixes geometry types (a GIS layer can't do that).
    const bySource = new Map();
    exploded.forEach((f) => {
      const src = ((f.properties && f.properties.__source_layer) || '').replace(/\.shp$/i, '').replace(/[^\w\- ]+/g, '').trim();
      const key = src || base;
      if (!bySource.has(key)) bySource.set(key, { Point: [], LineString: [], Polygon: [] });
      bySource.get(key)[f.geometry.type].push(f);
    });

    let totalImported = 0; const layersTouched = [];
    for (const [srcName, byType] of bySource.entries()) {
      const kindsInSource = Object.values(byType).filter((x) => x.length).length;
      for (const [gtype, list] of Object.entries(byType)) {
        if (!list.length) continue;
        let layer = null;
        if (targetLayerId) {
          const cand = this.state.layers.find((l) => l.id === targetLayerId);
          if (cand && cand.geomType === typeMap[gtype]) layer = cand;
          else if (cand) continue; // geometry mismatch with chosen layer — skip this type
        }
        if (!layer) {
          // auto-create a layer with fields derived from properties
          const fieldKeys = new Set();
          list.slice(0, 200).forEach((f) => Object.keys(f.properties || {}).forEach((k) => fieldKeys.add(k)));
          const fields = [...fieldKeys].filter((k) => k !== '__source_layer').slice(0, 30).map((k) => {
            const sample = list.find((f) => f.properties && f.properties[k] != null);
            const v = sample ? sample.properties[k] : '';
            const inferred = typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v === 'boolean' ? 'bool' : 'text';
            return { id: uid('f'), label: k, key: k.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), type: inferred, required: false };
          });
          // only suffix when this one source really contains more than one geometry type
          const suffix = kindsInSource > 1 ? '_' + typeMap[gtype].toUpperCase() : '';
          layer = { id: uid('lyr'), projectId: this.state.project.id, name: (srcName + suffix).toUpperCase(), geomType: typeMap[gtype], fields, symbology: this.defaultSymb(typeMap[gtype], this.nextLayerColor()), createdAt: nowISO(), imported: true, sourceFile: sourceName };
          await DB.put('layers', layer);
          this.state.layers.push(layer);
        }
        layersTouched.push(layer.name);
      for (const f of list) {
        const props = f.properties || {};
        const data = {};
        layer.fields.forEach((fl) => {
          const hit = Object.keys(props).find((k) => k.toLowerCase() === fl.key || k === fl.label);
          if (hit == null || props[hit] == null) return;
          const raw = props[hit];
          if (fl.type === 'integer') data[fl.key] = Number.isFinite(+raw) ? Math.trunc(+raw) : null;
          else if (fl.type === 'number') data[fl.key] = Number.isFinite(+raw) ? +raw : null;
          else if (fl.type === 'bool') data[fl.key] = typeof raw === 'boolean' ? (raw ? 'Yes' : 'No') : String(raw);
          else data[fl.key] = String(raw);
        });
        const g = f.geometry;
        const c0 = g.type === 'Point' ? g.coordinates : (g.type === 'LineString' ? g.coordinates[0] : g.coordinates[0][0]);
        const z = (g.type === 'Point' && g.coordinates.length > 2) ? g.coordinates[2] : (props.Z_Elevation != null ? +props.Z_Elevation : null);
        const rec = { id: uid('rec'), projectId: this.state.project.id, layerId: layer.id, layerName: layer.name, geomType: layer.geomType, data, geometry: g, location: { lat: c0[1], lng: c0[0], z, accuracy: null }, media: [], surveyor: props.surveyor || this.state.user.name, role: props.role || this.state.user.role, status: 'completed', createdAt: nowISO(), updatedAt: nowISO(), imported: true };
        await DB.put('records', rec);
        this.state.records.unshift(rec);
        totalImported++;
        }
      }
    }
    this.renderAllLayers(); this.refreshBarSub();
    this.closeSheet();
    this.toast(`Imported ${totalImported} feature${totalImported !== 1 ? 's' : ''} into ${[...new Set(layersTouched)].join(', ')}`, 'ok');
    // zoom to imported data
    const first = this.state.records.find((r) => r.imported && r.projectId === this.state.project.id);
    if (first && this.state.map) { const g = Exporter.geometryOf(first); const c = g.type === 'Point' ? g.coordinates : (g.type === 'LineString' ? g.coordinates[0] : g.coordinates[0][0]); this.state.map.setView([c[1], c[0]], 15); }
    setTimeout(() => this.updateGuidance(), 600);
  },
});

/* ============================================================
   Part 9 — Streaming Capture (continuous GPS coordinate capture)
   A dedicated project type: the app records features automatically
   from the live GPS watch while the surveyor walks or drives.
   Point  -> a new point record every <tolerance> metres (silent save)
   Line   -> auto vertex every 10 m + at direction changes; Stop saves
   Polygon-> auto vertex; auto-closes near the start point, then begins
             a new polygon automatically.
   ============================================================ */
Object.assign(App, {
  STREAM_ACC_LIMIT: 15,        // ignore fixes with accuracy worse than 15 m
  STREAM_LINE_STEP: 10,        // line/polygon: vertex every 10 m
  STREAM_TURN_DEG: 20,         // extra vertex when heading changes by more than this
  STREAM_TURN_MIN_D: 2,        // ...but only if moved at least 2 m (kills jitter)
  STREAM_CLOSE_D: 5,           // polygon auto-close: within 5 m of start
  STREAM_CLOSE_MINVERT: 8,     // ...after at least 8 vertices
  STREAM_CLOSE_MINLEN: 30,     // ...and at least 30 m walked

  isStreamingProject() { return !!(this.state.project && this.state.project.mode === 'streaming'); },

  compass8(deg) {
    if (deg == null || !isFinite(deg)) return '';
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  },
  bearingBetween(a, b) {
    const rad = Math.PI / 180;
    const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
    const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
    return ((Math.atan2(y, x) / rad) + 360) % 360;
  },

  // Ensure the dedicated streaming layer exists (created from streamCfg at project creation,
  // but re-created here defensively so an imported/synced project still works).
  async ensureStreamLayer() {
    const p = this.state.project, cfg = p.streamCfg || {};
    let l = this.state.layers.find((x) => x.projectId === p.id && x.stream);
    if (l) return l;
    l = {
      id: uid('lyr'), projectId: p.id, stream: true,
      name: cfg.featureClass || 'Streaming_Capture', geomType: cfg.geomType || 'point',
      fields: [
        { id: uid('f'), key: 'ROADNAME', label: 'RoadName', type: 'text' },
        { id: uid('f'), key: 'ROADID', label: 'RoadID', type: 'text' },
        { id: uid('f'), key: 'COMMUNITY', label: 'Community', type: 'text' },
        { id: uid('f'), key: 'DISTRICT', label: 'District', type: 'text' },
      ],
      symbology: { color: '#0079C1', size: 8 }, createdAt: nowISO(),
    };
    await DB.put('layers', l);
    this.state.layers.push(l);
    return l;
  },

  // User-editable optional attributes stamped onto every captured feature.
  streamAttrs() { return this._streamAttrs || (this._streamAttrs = { ROADNAME: '', ROADID: '', COMMUNITY: '', DISTRICT: '' }); },

  streamAutoFields(fix) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const heading = fix.heading != null ? fix.heading : (this._streamLastPt ? this.bearingBetween(this._streamLastPt, fix) : null);
    const spd = fix.speed != null && isFinite(fix.speed) ? fix.speed : null;
    return {
      FEATURECLASS: (this.state.project.streamCfg || {}).featureClass || 'Streaming_Capture',
      Z_VALUE: fix.z != null ? Math.round(fix.z * 100) / 100 : '',
      SPEED_MPS: spd != null ? Math.round(spd * 100) / 100 : '',
      SPEED_KMH: spd != null ? Math.round(spd * 3.6 * 100) / 100 : '',
      DIRECTION: this.compass8(heading),
      CAP_DATE: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      CAP_TIME: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      ...this.streamAttrs(),
    };
  },
  applyCaptureDefaults(data, layer) {
    const out = { ...(data || {}) };
    for (const f of ((layer && layer.fields) || [])) {
      if ((out[f.key] == null || out[f.key] === '') && f.default != null) out[f.key] = f.default;
    }
    return out;
  },
  captureStatus(data, layer) {
    const missing = ((layer && layer.fields) || []).some((f) => f.required && (data[f.key] == null || data[f.key] === ''));
    return missing ? 'needs_attributes' : 'completed';
  },

  /* ---------- lifecycle ---------- */
  async startStreaming() {
    if (!this.isStreamingProject()) return;
    this._streamLayer = await this.ensureStreamLayer();
    this._streamActive = true; this._streamPaused = false;
    this._streamLastPt = null; this._streamVerts = []; this._streamVertHeading = null; this._streamPathLen = 0;
    this._streamStartISO = nowISO(); this._streamCount = this._streamCount || 0;
    if (!this._watchStarted) this.startWatch();
    this.renderStreamBar();
    const g = (this.state.project.streamCfg || {}).geomType || 'point';
    const tol = (this.state.project.streamCfg || {}).tolerance || 1;
    this.toast(g === 'point' ? `Streaming started — a point every ${tol} m` : g === 'line' ? 'Streaming started — walk the line, tap Stop to save' : 'Streaming started — walk the boundary, it closes automatically', 'ok');
  },
  pauseStreaming() { this._streamPaused = true; this.renderStreamBar(); this.toast('Streaming paused'); },
  resumeStreaming() { this._streamPaused = false; this.renderStreamBar(); this.toast('Streaming resumed', 'ok'); },
  async stopStreaming() {
    const g = (this.state.project.streamCfg || {}).geomType || 'point';
    if (g === 'line' && (this._streamVerts || []).length >= 2) await this.saveStreamPath('LineString');
    else if (g === 'polygon' && (this._streamVerts || []).length >= 3) await this.saveStreamPath('Polygon');
    else if (g !== 'point' && (this._streamVerts || []).length) this.toast('Not enough vertices — discarded', 'err');
    this._streamActive = false; this._streamPaused = false; this._streamVerts = []; this.clearStreamPreview();
    this.renderStreamBar();
    this.toast('Streaming stopped', 'ok');
  },

  /* ---------- per-fix engine (called from onFix) ---------- */
  async streamOnFix(fix) {
    if (!this._streamActive || this._streamPaused || !this.isStreamingProject()) return;
    if (fix.accuracy != null && fix.accuracy > this.STREAM_ACC_LIMIT) return; // bad sky view — skip
    const cfg = this.state.project.streamCfg || {}, g = cfg.geomType || 'point';
    if (g === 'point') return this.streamPointFix(fix, cfg);
    return this.streamPathFix(fix, g);
  },

  async streamPointFix(fix, cfg) {
    const tol = Math.max(0.5, Number(cfg.tolerance) || 1);
    if (this._streamLastPt && this.routeDistance(this._streamLastPt, fix) < tol) return;
    const data = this.applyCaptureDefaults(this.streamAutoFields(fix), this._streamLayer);
    this._streamLastPt = { lat: fix.lat, lng: fix.lng };
    const coords = fix.z != null ? [fix.lng, fix.lat, Math.round(fix.z * 100) / 100] : [fix.lng, fix.lat];
    const rec = {
      id: uid('rec'), projectId: this.state.project.id, layerId: this._streamLayer.id, layerName: this._streamLayer.name,
      geomType: 'point', data,
      geometry: { type: 'Point', coordinates: coords },
      location: { lat: fix.lat, lng: fix.lng, z: fix.z != null ? Math.round(fix.z * 100) / 100 : null, accuracy: fix.accuracy != null ? Math.round(fix.accuracy * 100) / 100 : null, capturedAt: nowISO() },
      media: [], surveyor: this.state.user.name, role: this.state.user.role, status: this.captureStatus(data, this._streamLayer), createdAt: nowISO(), updatedAt: nowISO(),
    };
    await DB.put('records', rec);
    this.state.records.unshift(rec);
    this._streamCount = (this._streamCount || 0) + 1;
    if (rec.location.z == null && navigator.onLine) this.backfillZ(rec);
    this.throttledStreamRender();
  },

  streamPathFix(fix, g) {
    const verts = this._streamVerts;
    const pt = { lat: fix.lat, lng: fix.lng, z: fix.z != null ? Math.round(fix.z * 100) / 100 : null };
    if (!verts.length) { verts.push(pt); this._streamVertHeading = null; this.renderStreamPreview(); this.renderStreamBar(); return; }
    const last = verts[verts.length - 1];
    const d = this.routeDistance(last, pt);
    const heading = this.bearingBetween(last, pt);
    let turn = 0;
    if (this._streamVertHeading != null) { turn = Math.abs(heading - this._streamVertHeading); if (turn > 180) turn = 360 - turn; }
    const stepHit = d >= this.STREAM_LINE_STEP;
    const turnHit = this._streamVertHeading != null && turn >= this.STREAM_TURN_DEG && d >= this.STREAM_TURN_MIN_D;
    if (!stepHit && !turnHit) return;
    verts.push(pt);
    this._streamVertHeading = heading;
    this._streamPathLen += d;
    this.renderStreamPreview(); this.renderStreamBar();
    // polygon auto-close
    if (g === 'polygon' && verts.length >= this.STREAM_CLOSE_MINVERT && this._streamPathLen >= this.STREAM_CLOSE_MINLEN
        && this.routeDistance(verts[0], pt) <= this.STREAM_CLOSE_D) {
      this.saveStreamPath('Polygon').then(() => {
        this.toast('Polygon completed — starting a new one', 'ok');
        this._streamVerts = []; this._streamVertHeading = null; this._streamPathLen = 0; this._streamStartISO = nowISO();
        this.clearStreamPreview(); this.renderStreamBar();
      });
    }
  },

  async saveStreamPath(type) {
    const verts = this._streamVerts.slice();
    if (type === 'Polygon' && (verts[0].lat !== verts[verts.length - 1].lat || verts[0].lng !== verts[verts.length - 1].lng)) verts.push({ ...verts[0] });
    const toC = (v) => (v.z != null ? [v.lng, v.lat, v.z] : [v.lng, v.lat]);
    const geometry = type === 'Polygon' ? { type: 'Polygon', coordinates: [verts.map(toC)] } : { type: 'LineString', coordinates: verts.map(toC) };
    const now = new Date(), pad = (n) => String(n).padStart(2, '0');
    const startD = new Date(this._streamStartISO);
    const data = this.applyCaptureDefaults({
      FEATURECLASS: (this.state.project.streamCfg || {}).featureClass || 'Streaming_Capture',
      ...this.streamAttrs(),
      START_DATE: `${startD.getFullYear()}-${pad(startD.getMonth() + 1)}-${pad(startD.getDate())}`,
      START_TIME: `${pad(startD.getHours())}:${pad(startD.getMinutes())}:${pad(startD.getSeconds())}`,
      END_DATE: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      END_TIME: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      VERTEX_CNT: verts.length,
      LENGTH_M: Math.round(this._streamPathLen * 100) / 100,
    }, this._streamLayer);
    const first = verts[0];
    const rec = {
      id: uid('rec'), projectId: this.state.project.id, layerId: this._streamLayer.id, layerName: this._streamLayer.name,
      geomType: type === 'Polygon' ? 'polygon' : 'line', data, geometry,
      location: { lat: first.lat, lng: first.lng, z: first.z, accuracy: null, capturedAt: this._streamStartISO },
      media: [], surveyor: this.state.user.name, role: this.state.user.role, status: this.captureStatus(data, this._streamLayer), createdAt: nowISO(), updatedAt: nowISO(),
    };
    await DB.put('records', rec);
    this.state.records.unshift(rec);
    this._streamCount = (this._streamCount || 0) + 1;
    this.renderAllLayers(); this.refreshBarSub();
  },

  throttledStreamRender() {
    clearTimeout(this._streamRenderT);
    this._streamRenderT = setTimeout(() => { this.renderAllLayers(); this.refreshBarSub(); this.renderStreamBar(); }, 700);
  },

  /* ---------- live preview of the line/polygon being walked ---------- */
  renderStreamPreview() {
    if (!this.state.map || typeof L === 'undefined') return;
    const pts = (this._streamVerts || []).map((v) => [v.lat, v.lng]);
    if (this._streamPreview) { try { this.state.map.removeLayer(this._streamPreview); } catch {} this._streamPreview = null; }
    if (pts.length < 2) return;
    this._streamPreview = L.polyline(pts, { color: '#E14B3B', weight: 4, dashArray: '7 6', opacity: 0.9 }).addTo(this.state.map);
  },
  clearStreamPreview() { if (this._streamPreview && this.state.map) { try { this.state.map.removeLayer(this._streamPreview); } catch {} this._streamPreview = null; } },

  /* ---------- streaming control bar ---------- */
  renderStreamBar() {
    const bar = document.getElementById('streamBar');
    if (!bar) return;
    if (!this.isStreamingProject()) { bar.style.display = 'none'; return; }
    document.getElementById('collectBar').style.display = 'none';
    bar.style.display = 'flex';
    const cfg = this.state.project.streamCfg || {}, g = cfg.geomType || 'point';
    const active = this._streamActive, paused = this._streamPaused;
    const stat = !active ? 'Ready' : paused ? 'Paused' : 'Recording';
    const detail = g === 'point'
      ? `${this._streamCount || 0} point${(this._streamCount || 0) === 1 ? '' : 's'} · every ${cfg.tolerance || 1} m`
      : `${(this._streamVerts || []).length} vertices · ${Math.round(this._streamPathLen || 0)} m · ${this._streamCount || 0} saved`;
    bar.innerHTML = `
      <div class="stream-info"><span class="stream-dot ${active && !paused ? 'rec' : ''}"></span><div><div class="stream-t">${stat} · ${esc(cfg.featureClass || 'Streaming')}</div><div class="stream-d">${g.toUpperCase()} · ${detail}</div></div></div>
      <div class="stream-btns">
        ${!active ? `<button class="btn btn-primary" id="stStart">${icon('play', 15)} Start</button>`
          : `${paused ? `<button class="btn btn-primary" id="stResume">${icon('play', 15)} Resume</button>` : `<button class="btn btn-ghost" id="stPause">${icon('pause', 15)} Pause</button>`}
             <button class="btn btn-danger" id="stStop">${icon('check', 15)} Stop${g !== 'point' ? ' & Save' : ''}</button>`}
        <button class="btn btn-ghost" id="stFields">${icon('edit', 15)} Fields</button>
      </div>`;
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    on('stStart', () => this.startStreaming());
    on('stPause', () => this.pauseStreaming());
    on('stResume', () => this.resumeStreaming());
    on('stStop', () => this.stopStreaming());
    on('stFields', () => this.openStreamFields());
  },

  openStreamFields() {
    const a = this.streamAttrs();
    const body = `
      <div class="note" style="margin-bottom:12px">Optional attributes — whatever is entered here is stamped onto every captured feature. Update them when you enter a new road or area; capture continues in the background.</div>
      <div class="field"><label class="lbl">Road name</label><input class="inp" id="sfRoad" value="${esc(a.ROADNAME)}" placeholder="e.g. Sheikh Zayed Road" /></div>
      <div class="field"><label class="lbl">Road ID</label><input class="inp" id="sfRoadId" value="${esc(a.ROADID)}" placeholder="e.g. RD-104" /></div>
      <div class="field"><label class="lbl">Community</label><input class="inp" id="sfComm" value="${esc(a.COMMUNITY)}" placeholder="Optional" /></div>
      <div class="field"><label class="lbl">District</label><input class="inp" id="sfDist" value="${esc(a.DISTRICT)}" placeholder="Optional" /></div>`;
    this.openSheet('Streaming attributes', body, `<button class="btn btn-primary btn-block" id="sfSave">${icon('check', 17)} Apply</button>`);
    document.getElementById('sfSave').onclick = () => {
      a.ROADNAME = document.getElementById('sfRoad').value.trim();
      a.ROADID = document.getElementById('sfRoadId').value.trim();
      a.COMMUNITY = document.getElementById('sfComm').value.trim();
      a.DISTRICT = document.getElementById('sfDist').value.trim();
      this.closeSheet(); this.toast('Attributes applied to next captures', 'ok');
    };
  },
});

/* ============================================================
   Part 10 — External RTK/GNSS receiver support (Web Bluetooth)
   Pairs a Bluetooth GNSS receiver (Nordic UART-style serial),
   parses its NMEA stream (GGA + GST + RMC + VTG) and feeds fixes
   into the SAME onFix() pipeline the phone GPS uses — so manual
   capture, streaming capture and route tracking all pick up the
   corrected positions automatically.
   Platform note: Web Bluetooth exists on Chrome for Android and
   desktop Chrome/Edge. Safari on iOS does NOT implement it — the
   feature reports that plainly instead of failing silently.
   ============================================================ */
Object.assign(App, {
  // Nordic UART Service — the de-facto BLE serial used by many GNSS receivers
  GNSS_NUS_SERVICE: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  GNSS_NUS_TX: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', // notifications from device

  gnssSupported() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); },

  async connectGNSS() {
    if (!this.gnssSupported()) {
      this.toast('Web Bluetooth is not available in this browser. Works on Chrome for Android and desktop Chrome/Edge — not on iPhone Safari.', 'err');
      return;
    }
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [this.GNSS_NUS_SERVICE] }],
        optionalServices: [this.GNSS_NUS_SERVICE],
      });
      this.toast(`Connecting to ${device.name || 'receiver'}…`);
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(this.GNSS_NUS_SERVICE);
      const tx = await service.getCharacteristic(this.GNSS_NUS_TX);
      this._gnssDevice = device;
      this._gnssBuffer = '';
      this._gnssState = { fixQuality: 0, hdop: null, accuracy: null, alt: null, speed: null, heading: null, lastSentence: 0 };
      device.addEventListener('gattserverdisconnected', () => this.onGNSSDisconnect());
      tx.addEventListener('characteristicvaluechanged', (e) => this.onGNSSData(e.target.value));
      await tx.startNotifications();
      this._gnssActive = true;
      // External receiver takes over as the position source; phone GPS watch stays
      // running as a fallback but its fixes are ignored while the receiver is live.
      this.toast(`${device.name || 'GNSS receiver'} connected — waiting for satellite fix`, 'ok');
      this.updateGNSSBadge();
    } catch (e) {
      if (e && e.name === 'NotFoundError') return; // user cancelled the picker — not an error
      this.toast('Could not connect to the receiver: ' + (e.message || e.name || 'unknown error'), 'err');
    }
  },
  disconnectGNSS() {
    this._gnssActive = false;
    try { if (this._gnssDevice && this._gnssDevice.gatt.connected) this._gnssDevice.gatt.disconnect(); } catch {}
    this._gnssDevice = null;
    this.updateGNSSBadge();
    this.toast('External receiver disconnected — using phone GPS', 'ok');
  },
  onGNSSDisconnect() {
    if (!this._gnssActive) return;
    this._gnssActive = false;
    this.updateGNSSBadge();
    this.toast('GNSS receiver connection lost — using phone GPS. Reconnect from the menu.', 'err');
  },

  onGNSSData(dataView) {
    // BLE delivers arbitrary chunks; accumulate and process complete lines only.
    let text = '';
    for (let i = 0; i < dataView.byteLength; i++) text += String.fromCharCode(dataView.getUint8(i));
    this._gnssBuffer += text;
    let idx;
    while ((idx = this._gnssBuffer.indexOf('\n')) >= 0) {
      const line = this._gnssBuffer.slice(0, idx).trim();
      this._gnssBuffer = this._gnssBuffer.slice(idx + 1);
      if (line.startsWith('$')) this.parseNMEA(line);
    }
    if (this._gnssBuffer.length > 4096) this._gnssBuffer = ''; // corrupt stream guard
  },

  nmeaChecksumOK(line) {
    const star = line.lastIndexOf('*');
    if (star < 0) return false;
    let sum = 0;
    for (let i = 1; i < star; i++) sum ^= line.charCodeAt(i);
    return sum === parseInt(line.slice(star + 1, star + 3), 16);
  },
  // ddmm.mmmm (+ hemisphere) -> decimal degrees
  nmeaCoord(value, hemi) {
    if (!value) return null;
    const dot = value.indexOf('.');
    const degDigits = dot > 4 ? 3 : 2; // longitude has 3 degree digits, latitude 2
    const deg = parseInt(value.slice(0, degDigits), 10);
    const min = parseFloat(value.slice(degDigits));
    if (!isFinite(deg) || !isFinite(min)) return null;
    let dd = deg + min / 60;
    if (hemi === 'S' || hemi === 'W') dd = -dd;
    return dd;
  },

  parseNMEA(line) {
    if (!this.nmeaChecksumOK(line)) return;
    const star = line.lastIndexOf('*');
    const parts = line.slice(0, star).split(',');
    const type = parts[0].slice(3); // strip $GP/$GN/$GL talker prefix
    const st = this._gnssState;
    st.lastSentence = Date.now();

    if (type === 'GGA') {
      // $..GGA,time,lat,NS,lon,EW,quality,numSV,HDOP,alt,M,sep,M,diffAge,diffStation
      const lat = this.nmeaCoord(parts[2], parts[3]);
      const lng = this.nmeaCoord(parts[4], parts[5]);
      st.fixQuality = parseInt(parts[6], 10) || 0;
      st.hdop = parseFloat(parts[8]);
      st.alt = parseFloat(parts[9]);
      if (lat == null || lng == null || st.fixQuality === 0) { this.updateGNSSBadge(); return; }
      // Accuracy: prefer GST-reported error when fresh; otherwise estimate from HDOP.
      // RTK Fixed(4)≈2cm base error, Float(5)≈0.3m, DGPS(2)≈1m, autonomous(1)≈3m per HDOP unit.
      const base = st.fixQuality === 4 ? 0.02 : st.fixQuality === 5 ? 0.3 : st.fixQuality === 2 ? 1.0 : 3.0;
      const accuracy = st.gstAccuracy != null && (Date.now() - (st.gstAt || 0)) < 5000
        ? st.gstAccuracy
        : Math.round(base * (isFinite(st.hdop) ? Math.max(st.hdop, 0.6) : 1) * 100) / 100;
      this.onFix({ coords: {
        latitude: lat, longitude: lng,
        altitude: isFinite(st.alt) ? st.alt : null,
        accuracy,
        heading: st.heading, speed: st.speed,
      }, timestamp: Date.now(), _external: true });
      this.updateGNSSBadge();
    } else if (type === 'GST') {
      // $..GST,time,rms,semiMajor,semiMinor,orient,latErr,lonErr,altErr
      const latErr = parseFloat(parts[6]), lonErr = parseFloat(parts[7]);
      if (isFinite(latErr) && isFinite(lonErr)) { st.gstAccuracy = Math.round(Math.sqrt(latErr * latErr + lonErr * lonErr) * 100) / 100; st.gstAt = Date.now(); }
    } else if (type === 'RMC') {
      // $..RMC,time,status,lat,NS,lon,EW,speedKnots,course,...
      const spd = parseFloat(parts[7]), crs = parseFloat(parts[8]);
      st.speed = isFinite(spd) ? spd * 0.514444 : st.speed; // knots -> m/s
      st.heading = isFinite(crs) ? crs : st.heading;
    } else if (type === 'VTG') {
      // $..VTG,courseTrue,T,courseMag,M,speedKnots,N,speedKmh,K
      const crs = parseFloat(parts[1]), kmh = parseFloat(parts[7]);
      st.heading = isFinite(crs) ? crs : st.heading;
      st.speed = isFinite(kmh) ? kmh / 3.6 : st.speed;
    }
  },

  gnssFixLabel() {
    const q = this._gnssState ? this._gnssState.fixQuality : 0;
    return q === 4 ? 'RTK FIXED' : q === 5 ? 'RTK FLOAT' : q === 2 ? 'DGPS' : q === 1 ? 'GPS' : q === 0 ? 'NO FIX' : 'Q' + q;
  },
  updateGNSSBadge() {
    const el = document.getElementById('gnssBadge');
    if (!el) return;
    if (!this._gnssActive) { el.style.display = 'none'; return; }
    const q = this._gnssState.fixQuality;
    el.style.display = 'inline-flex';
    el.textContent = '⛯ ' + this.gnssFixLabel();
    el.className = 'gnss-badge ' + (q === 4 ? 'rtk-fixed' : q === 5 ? 'rtk-float' : q >= 1 ? 'gps' : 'nofix');
  },

  openGNSSSheet() {
    const supported = this.gnssSupported();
    const connected = !!this._gnssActive;
    const st = this._gnssState || {};
    const body = `
      <div class="note" style="margin-bottom:12px">Pair an external <b>RTK/GNSS receiver</b> over Bluetooth for sub-metre to centimetre accuracy. The receiver's corrected positions replace the phone GPS everywhere — manual capture, streaming capture and route tracking.</div>
      ${!supported ? `<div class="card"><div class="card-lbl" style="color:var(--red)">Not available in this browser</div><div class="muted">Web Bluetooth works on <b>Chrome for Android</b> and desktop Chrome/Edge. It is not supported in Safari on iPhone/iPad — on those devices the app uses the phone's own GPS.</div></div>` : connected ? `
      <div class="card"><div class="card-lbl">Connected · ${esc((this._gnssDevice && this._gnssDevice.name) || 'GNSS receiver')}</div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">
          <div><div class="muted">Fix type</div><div style="font-size:19px;font-weight:750">${this.gnssFixLabel()}</div></div>
          <div><div class="muted">Est. accuracy</div><div style="font-size:19px;font-weight:750">${st.gstAccuracy != null ? '±' + st.gstAccuracy + ' m' : (this.state.lastFix && this.state.lastFix.accuracy != null ? '±' + this.state.lastFix.accuracy + ' m' : '—')}</div></div>
          <div><div class="muted">HDOP</div><div style="font-weight:700">${isFinite(st.hdop) ? st.hdop : '—'}</div></div>
          <div><div class="muted">Altitude</div><div style="font-weight:700">${isFinite(st.alt) ? st.alt.toFixed(2) + ' m' : '—'}</div></div>
        </div>
        <div class="note" style="margin-top:11px">RTK FIXED = centimetre accuracy. RTK FLOAT = decimetre. DGPS/GPS = the receiver has no correction stream — check its NTRIP/base-station link.</div>
      </div>
      <button class="btn btn-danger btn-block" id="gnssDisc">${icon('x', 16)} Disconnect receiver</button>` : `
      <button class="btn btn-primary btn-block btn-lg" id="gnssConn">${icon('navigation', 17)} Pair Bluetooth GNSS receiver</button>
      <div class="muted" style="margin-top:10px">Supported: receivers exposing a Bluetooth LE serial (Nordic UART) NMEA stream — common on survey GNSS units. Make sure the receiver is on and in Bluetooth LE mode.</div>`}
    `;
    this.openSheet('External GNSS receiver', body);
    const c = document.getElementById('gnssConn'); if (c) c.onclick = async () => { await this.connectGNSS(); this.openGNSSSheet(); };
    const d = document.getElementById('gnssDisc'); if (d) d.onclick = () => { this.disconnectGNSS(); this.openGNSSSheet(); };
  },
});

/* ============================================================
   Part 11 — Template System (municipal schema packs)
   Import an EasyCapture Template Pack (.smtp.json, produced by the
   EasyCapture.pyt geoprocessing tool from the office .gdb): creates
   schema-locked feature classes with domain dropdowns, auto-field
   mapping, entry-time validation, and an office round-trip export
   whose columns match the geodatabase exactly.
   ============================================================ */
Object.assign(App, {
  // Auto-map suggestions: template field name -> app value source
  AUTOMAP_SUGGEST: {
    XCOORD: 'east', X_COORD: 'east', EASTING: 'east',
    YCOORD: 'north', Y_COORD: 'north', NORTHING: 'north',
    ZCOORD: 'z', Z_VALUE: 'z', Z_LEVEL: 'z', ELEVATION: 'z',
    INSPECTED_BY: 'surveyor', SURVEYOR: 'surveyor', COLLECTOR: 'surveyor', CREATED_USER: 'surveyor',
    INSPECTION_DATE: 'date', SURVEY_DATE: 'date', CREATED_DATE: 'date',
    ASSET_IMAGE: 'photo', PHOTO_URL: 'photo', IMAGE_URL: 'photo',
    DATA_SOURCE: 'gps_const', DATASOURCE: 'gps_const',
  },
  AUTOMAP_LABELS: { east: 'Easting (project CRS)', north: 'Northing (project CRS)', z: 'Z elevation', surveyor: 'Surveyor name', date: 'Capture date', photo: 'Photo file name (at export)', gps_const: 'Constant "GPS"', none: "Don't auto-fill" },

  isAutoMapped(f) {
    const am = this.state.project && this.state.project.autoMap;
    return !!(am && am[f.key.toUpperCase()] && am[f.key.toUpperCase()] !== 'none');
  },
  validateTemplatePack(pack) {
    if (!pack || !Array.isArray(pack.layers) || !pack.layers.length) throw new Error('template contains no feature classes');
    const layerNames = new Set();
    for (const layer of pack.layers) {
      if (!layer || typeof layer.name !== 'string' || !layer.name.trim()) throw new Error('template contains an unnamed feature class');
      const layerKey = layer.name.trim().toLowerCase();
      if (layerNames.has(layerKey)) throw new Error(`duplicate feature class: ${layer.name}`);
      layerNames.add(layerKey);
      if (!['point', 'line', 'polygon'].includes(layer.geomType)) throw new Error(`unsupported geometry type in ${layer.name}`);
      if (!Array.isArray(layer.fields)) throw new Error(`fields are missing from ${layer.name}`);
      const fieldNames = new Set();
      for (const field of layer.fields) {
        if (!field || typeof field.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field.name)) throw new Error(`unsafe or invalid field name in ${layer.name}`);
        const key = field.name.toUpperCase();
        if (fieldNames.has(key)) throw new Error(`duplicate field ${field.name} in ${layer.name}`);
        fieldNames.add(key);
      }
    }
    for (const [name, domain] of Object.entries(pack.domains || {})) {
      if (!name || !domain || !Array.isArray(domain.values)) throw new Error('template contains an invalid domain');
    }
    return true;
  },

  /* ---------- import flow ---------- */
  openTemplateImport() {
    const body = `
      <div class="note" style="margin-bottom:12px">Load a <b>Template Pack</b> (.smtp.json) produced by your GIS office from the master geodatabase. Every feature class arrives with its exact fields, dropdown domains and coordinate system — the surveyor only collects.</div>
      <input type="file" id="tplFile" accept=".json,application/json" hidden />
      <button class="btn btn-primary btn-block btn-lg" id="tplBtn">${icon('upload', 17)} Choose Template Pack file</button>
      <div id="tplStatus" class="muted" style="margin-top:12px"></div>`;
    this.openSheet('Import Schema (Template)', body);
    const file = document.getElementById('tplFile');
    document.getElementById('tplBtn').onclick = () => file.click();
    file.onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      const status = document.getElementById('tplStatus');
      status.textContent = 'Reading ' + f.name + '…';
      try {
        const pack = JSON.parse(await f.text());
        const supportedTemplateFormats = ['easycapture-template-pack', 'smart-maidani-template-pack'];
        if (!supportedTemplateFormats.includes(pack.format) || !Array.isArray(pack.layers)) throw new Error('not an EasyCapture Template Pack');
        this.validateTemplatePack(pack);
        this.templateActivationSheet(pack);
      } catch (err) { status.textContent = ''; this.toast('Template import failed: ' + (err.message || 'unreadable file'), 'err'); }
    };
  },

  templateActivationSheet(pack) {
    const proj = this.state.project;
    const existing = new Set(this.state.layers.filter((l) => l.projectId === proj.id && l.template).map((l) => l.name));
    const upgrade = proj.template && proj.template.name === pack.name;
    const rows = pack.layers.map((L, i) => `
      <label class="tpl-fc-row"><input type="checkbox" data-tfc="${i}" ${existing.has(L.name) ? 'checked disabled' : ''} />
        <span class="n">${esc(L.name)}</span><span class="d">${L.geomType} · ${L.fields.length} fields${L.dataset ? ' · ' + esc(L.dataset) : ''}${existing.has(L.name) ? ' · already active' : ''}</span></label>`).join('');
    const body = `
      <div class="note" style="margin-bottom:10px"><b>${esc(pack.name)}</b> — ${pack.layers.length} feature classes, ${Object.keys(pack.domains || {}).length} domains, EPSG:${pack.crs && pack.crs.epsg}${upgrade ? '<br><b>Existing template detected — this will upgrade domains and field definitions in place.</b>' : ''}</div>
      <input class="inp" id="tplSearch" placeholder="Search feature classes…" style="margin-bottom:9px" />
      <div style="display:flex;gap:8px;margin-bottom:9px"><button class="btn-text" id="tplAll">Select all</button><button class="btn-text" id="tplNone">Select none</button></div>
      <div class="tpl-fc-list" id="tplList">${rows}</div>`;
    this.openSheet('Choose feature classes to survey', body, `<button class="btn btn-primary btn-block" id="tplGo">${icon('check', 17)} Activate & continue</button>`);
    const list = document.getElementById('tplList');
    document.getElementById('tplSearch').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      list.querySelectorAll('.tpl-fc-row').forEach((r) => r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none');
    };
    document.getElementById('tplAll').onclick = () => list.querySelectorAll('input:not(:disabled)').forEach((c) => { if (c.parentElement.style.display !== 'none') c.checked = true; });
    document.getElementById('tplNone').onclick = () => list.querySelectorAll('input:not(:disabled)').forEach((c) => c.checked = false);
    document.getElementById('tplGo').onclick = () => {
      const picked = [...list.querySelectorAll('input:checked:not(:disabled)')].map((c) => pack.layers[parseInt(c.dataset.tfc)]);
      if (!picked.length && !upgrade) { this.toast('Tick at least one feature class', 'err'); return; }
      this.applyTemplatePack(pack, picked);
    };
  },

  packFieldToLayerField(pf) {
    // Non-nullable in the GDB is an OFFICE constraint, not a surveyor duty: it is
    // satisfied by pre-filled defaults (below), never by blocking the field crew.
    return { id: uid('f'), key: pf.name, label: pf.alias || pf.name, type: pf.type || 'text',
             length: pf.length || null, required: false, gdbRequired: pf.nullable === false,
             domain: pf.domain || null,
             default: pf.default != null ? pf.default : null, template: true };
  },

  // Smart default for a non-nullable template field with no authored default:
  // domain -> N/A-style code if the domain has one; text -> 'N/A'; numbers -> 0;
  // dates -> the capture moment. Surveyor can change any of them; office can refine.
  templateSmartDefault(f) {
    if (f.default != null && f.default !== '') return f.default;
    if (!f.gdbRequired) return null;
    const dom = f.domain && this.state.project.domains ? this.state.project.domains[f.domain] : null;
    if (dom) {
      const prefer = ['N/A', 'NA', 'Undefined', 'UNDEFINED', 'Unknown', 'Other'];
      for (const p of prefer) { const hit = dom.values.find(([c]) => String(c) === p); if (hit) return hit[0]; }
      return dom.values.length ? dom.values[0][0] : null;
    }
    if (f.type === 'number' || f.type === 'integer') return 0;
    if (f.type === 'datetime' || f.type === 'date') {
      const n = new Date(), pad = (x) => String(x).padStart(2, '0');
      const d = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
      return f.type === 'datetime' ? `${d}T${pad(n.getHours())}:${pad(n.getMinutes())}` : d;
    }
    const v = 'N/A';
    return f.length && f.length < 3 ? v.slice(0, f.length) : v;
  },

  seedTemplateDefaults(d, l) {
    for (const f of l.fields) {
      if (d.data[f.key] == null || d.data[f.key] === '') {
        const v = this.templateSmartDefault(f);
        if (v != null) d.data[f.key] = v;
      }
    }
  },

  async applyTemplatePack(pack, pickedLayers) {
    const proj = this.state.project;
    const upgrade = proj.template && proj.template.name === pack.name;
    proj.template = { name: pack.name, sourceGdb: pack.sourceGdb, generated: pack.generated, epsg: pack.crs && pack.crs.epsg };
    proj.domains = pack.domains || {};
    if (pack.crs && pack.crs.epsg) { proj.crsCode = 'EPSG:' + pack.crs.epsg; proj.crsName = 'EPSG:' + pack.crs.epsg + ' (template)'; }
    // upgrade existing template layers' field definitions in place
    let upgraded = 0;
    if (upgrade) {
      for (const l of this.state.layers.filter((x) => x.projectId === proj.id && x.template)) {
        const def = pack.layers.find((p) => p.name === l.name);
        if (def) { l.fields = def.fields.map((pf) => this.packFieldToLayerField(pf)); l.hasZ = !!def.hasZ; await DB.put('layers', l); upgraded++; }
      }
    }
    // create newly picked layers
    let created = 0;
    for (const def of pickedLayers) {
      const l = { id: uid('lyr'), projectId: proj.id, name: def.name, dataset: def.dataset || '',
                  geomType: def.geomType, hasZ: !!def.hasZ, template: true, sourceGeometry: def.sourceGeometry || '',
                  fields: def.fields.map((pf) => this.packFieldToLayerField(pf)),
                  symbology: this.defaultSymb(def.geomType, this.nextLayerColor()), createdAt: nowISO() };
      await DB.put('layers', l);
      this.state.layers.push(l);
      created++;
    }
    await DB.put('projects', proj);
    this.renderAllLayers(); this.refreshBarSub();
    document.getElementById('barProj').textContent = `${proj.name} · ${pack.name.split('_Templates')[0]}`;
    this.toast(`Template applied: ${created} feature class(es) activated${upgraded ? `, ${upgraded} upgraded` : ''}`, 'ok');
    this.templateAutoMapSheet(pack);
  },

  /* ---------- auto-field mapping (user confirms once per template) ---------- */
  templateAutoMapSheet(pack) {
    const proj = this.state.project;
    const activeLayers = this.state.layers.filter((l) => l.projectId === proj.id && l.template);
    const fieldNames = new Set();
    activeLayers.forEach((l) => l.fields.forEach((f) => { if (this.AUTOMAP_SUGGEST[f.key.toUpperCase()]) fieldNames.add(f.key); }));
    if (!fieldNames.size) { proj.autoMap = proj.autoMap || {}; DB.put('projects', proj); this.rootNav(this.templateReadySheet); return; }
    const current = proj.autoMap || {};
    const rows = [...fieldNames].sort().map((fn) => {
      const sel = current[fn.toUpperCase()] || this.AUTOMAP_SUGGEST[fn.toUpperCase()];
      return `<div class="field"><label class="lbl">${esc(fn)}</label>
        <select class="sel" data-amap="${esc(fn.toUpperCase())}">${Object.entries(this.AUTOMAP_LABELS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`;
    }).join('');
    const body = `<div class="note" style="margin-bottom:12px">These template fields can be <b>filled automatically</b> at capture — coordinates in the template CRS, surveyor, dates, photo names. Confirm the mapping (pre-suggested by field name); mapped fields disappear from the form so the surveyor never types them.</div>${rows}`;
    this.openSheet('Automatic field mapping', body, `<button class="btn btn-primary btn-block" id="amapSave">${icon('check', 17)} Confirm mapping</button>`);
    document.getElementById('amapSave').onclick = async () => {
      const am = {};
      document.querySelectorAll('[data-amap]').forEach((el) => { am[el.dataset.amap] = el.value; });
      proj.autoMap = am;
      await DB.put('projects', proj);
      this.rootNav(this.templateReadySheet);
    };
  },

  templateReadySheet() {
    const proj = this.state.project;
    const n = this.state.layers.filter((l) => l.projectId === proj.id && l.template).length;
    const body = `<div class="note" style="margin-bottom:14px"><b>${n} feature class(es) ready.</b> Schema, dropdown domains and validation are active — collection only from here.</div>
      <div class="tpl" id="trCollect"><div class="ic">${icon('point', 21)}</div><div class="tx"><div class="t">Start collecting</div><div class="d">Pick a feature class and capture</div></div><div class="chev">${icon('chevron', 18)}</div></div>`;
    this.openSheet('Template ready', body);
    document.getElementById('trCollect').onclick = () => this.rootNav(this.startCollect);
  },

  /* ---------- autofill at save ---------- */
  applyTemplateAutofill(d, l) {
    const proj = this.state.project, am = proj.autoMap || {};
    const loc = d.location || {};
    let en = null;
    if (loc.lat != null && typeof Geo !== 'undefined') { try { en = Geo.project([loc.lng, loc.lat], proj.crsCode); } catch {} }
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    for (const f of l.fields) {
      const src = am[f.key.toUpperCase()];
      if (!src || src === 'none') continue;
      let v = null;
      if (src === 'east' && en) v = Math.round(en[0] * 1000) / 1000;
      else if (src === 'north' && en) v = Math.round(en[1] * 1000) / 1000;
      else if (src === 'z' && loc.z != null) v = loc.z;
      else if (src === 'surveyor') v = this.state.user.name;
      else if (src === 'date') v = f.type === 'datetime' ? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}` : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      else if (src === 'gps_const') v = 'GPS';
      // 'photo' resolves at export (file name isn't final until the package is built)
      if (v != null) d.data[f.key] = v;
    }
    // defaults for untouched fields
    for (const f of l.fields) if (d.data[f.key] == null && f.default != null) d.data[f.key] = f.default;
  },

  /* ---------- searchable domain picker ---------- */
  openDomainPicker(fieldKey, domainName) {
    const dom = this.state.project.domains && this.state.project.domains[domainName];
    if (!dom) return;
    const ov = document.getElementById('domainPicker');
    document.getElementById('dpTitle').textContent = domainName;
    const list = document.getElementById('dpList');
    const render = (q) => {
      const ql = (q || '').toLowerCase();
      list.innerHTML = dom.values.filter(([c, n]) => !ql || n.toLowerCase().includes(ql) || String(c).toLowerCase().includes(ql))
        .map(([c, n]) => `<div class="dp-item" data-code="${esc(String(c))}">${esc(n)}${String(c) !== String(n) ? `<span class="cd">${esc(String(c))}</span>` : ''}</div>`).join('') || '<div class="muted" style="padding:10px">No matches</div>';
      list.querySelectorAll('.dp-item').forEach((el) => el.onclick = () => this.pickDomainValue(fieldKey, domainName, el.dataset.code));
    };
    document.getElementById('dpSearch').value = '';
    document.getElementById('dpSearch').oninput = (e) => render(e.target.value);
    document.getElementById('dpClose').onclick = () => { ov.style.display = 'none'; };
    render('');
    ov.style.display = 'flex';
    setTimeout(() => document.getElementById('dpSearch').focus(), 150);
  },
  pickDomainValue(fieldKey, domainName, code) {
    document.getElementById('domainPicker').style.display = 'none';
    const d = this.state.draft; if (!d) return;
    d.data[fieldKey] = code;
    const dom = this.state.project.domains[domainName];
    const label = (dom.values.find((x) => String(x[0]) === String(code)) || [null, code])[1];
    const btn = document.querySelector(`[data-dombtn="${fieldKey}"]`);
    if (btn) btn.innerHTML = esc(label);
    // revalidate + conditions
    const l = d._layer;
    document.querySelectorAll('[data-fieldwrap]').forEach((wrap) => { const f = l.fields.find((x) => x.key === wrap.dataset.fieldwrap); if (f && f.condition) wrap.style.display = this.fieldVisible(f, d.data) ? '' : 'none'; });
    const b = document.getElementById('fDone');
    if (b) { const m = l.fields.filter((f) => f.required && !this.isAutoMapped(f) && !d.data[f.key] && this.fieldVisible(f, d.data)); b.disabled = m.length > 0; }
  },

  /* ---------- office round-trip export ---------- */
  async buildOfficePackage() {
    const proj = this.state.project;
    const zip = new JSZip();
    const layers = this.state.layers.filter((l) => l.projectId === proj.id && l.template);
    const crsCode = proj.crsCode || 'EPSG:4326';
    let total = 0;
    const projPt = (c) => { try { const p = Geo.project([c[0], c[1]], crsCode); return c.length > 2 ? [p[0], p[1], c[2]] : [p[0], p[1]]; } catch { return c; } };
    const projGeom = (g) => {
      if (!g) return null;
      if (g.type === 'Point') return { type: 'Point', coordinates: projPt(g.coordinates) };
      if (g.type === 'LineString') return { type: 'LineString', coordinates: g.coordinates.map(projPt) };
      if (g.type === 'Polygon') return { type: 'Polygon', coordinates: g.coordinates.map((ring) => ring.map(projPt)) };
      return g;
    };
    for (const l of layers) {
      const recs = this.state.records.filter((r) => r.layerId === l.id && r.status === 'completed' && r.geometry);
      if (!recs.length) continue;
      const feats = recs.map((r) => {
        const props = {};
        for (const f of l.fields) {
          let v = r.data ? r.data[f.key] : null;
          if ((v == null || v === '') && (proj.autoMap || {})[f.key.toUpperCase()] === 'photo') {
            const ph = (r.media || []).find((m) => (m.kind || m.type) === 'photo');
            v = ph ? (ph.name || ph.id + '.jpg') : null;
          }
          props[f.key] = v != null && v !== '' ? v : null;
        }
        return { type: 'Feature', properties: props, geometry: projGeom(r.geometry) };
      });
      zip.file(`${l.name}.geojson`, JSON.stringify({ type: 'FeatureCollection', name: l.name,
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:' + crsCode.replace(':', '::') } }, features: feats }, null, 1));
      total += feats.length;
    }
    if (!total) throw new Error('no completed template records to export');
    zip.file('README_OFFICE.txt', `${proj.name} — office round-trip export
Template: ${proj.template.name} (${proj.template.sourceGdb || ''}, generated ${proj.template.generated || ''})
CRS: ${crsCode}. One GeoJSON per feature class; columns match the geodatabase exactly; domain values are CODES.
Load with the "Field Data To GDB" geoprocessing tool (EasyCapture.pyt), one file per target feature class.
NOTE: do not convert these to Shapefile — field names over 10 characters would be truncated.`);
    return zip.generateAsync({ type: 'blob' });
  },
});

document.addEventListener('DOMContentLoaded', () => App.init());
