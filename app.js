/* HvorErDet – pek kameraet på hus og se adressene.
 *
 * Slik virker det:
 *  1. GPS og kompass sier hvor du står og hvilken vei kameraet peker.
 *  2. Adresser hentes fra Kartverket (Matrikkelen).
 *  3. Bygningsomriss hentes fra OpenStreetMap (i Norge importert fra Matrikkelen),
 *     og terrenghøyde fra Kartverkets høydemodell (1 m oppløsning).
 *  4. Hver adresse kobles til huset sitt. Appen regner ut hvilke hus du faktisk ser
 *     (hus bak andre hus skjules, men hus oppe i en li vises), og setter adressen midt på fasaden.
 */
(() => {
  'use strict';

  // ---------- Innstillinger (lagres lokalt på telefonen) ----------
  const APP_VERSION = '7';
  const DEFAULTS = {
    radius: 150, lensFov: 67, offset: 0, pitchOffset: 0, hideBehind: true, aim: 4, eyeH: 1.6,
    autoCompass: true, calibrated: false, dragHintShown: false,
  };
  const settings = loadSettings();

  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('hvorerdet') || '{}')); }
    catch { return { ...DEFAULTS }; }
  }
  function saveSettings() {
    try { localStorage.setItem('hvorerdet', JSON.stringify(settings)); } catch { /* ignorer */ }
  }

  // ---------- Tilstand ----------
  const state = {
    pos: null,            // posisjonen som brukes: { lat, lon, acc, manual }
    gpsPos: null,         // utjevnet GPS-posisjon
    manual: null,         // posisjon satt på kartet: { lat, lon, gpsRef }
    heading: null,        // grader, 0 = nord (rå, før justering)
    pitch: null,          // grader over (+) / under (−) horisonten
    upright: true,
    addresses: [],        // [{ id, title, sub, lat, lon, raw, building }]
    buildings: [],        // [{ id, rings, lat, lon, height, ground, addrs, small }]
    buildingsOk: false,
    terrainOk: false,
    userGround: null,     // { lat, lon, z }
    groundPending: false,
    fetchedAt: null,
    fetching: false,
    pano: null,           // utregnet utsikt fra der du står
    panoDirty: true,
    frozen: false,
    frozenSensors: null,
    visible: [],
    zoom: 1,
    screenFov: null,
  };

  window.HvorErDetState = state;   // for feilsøking
  const $ = (id) => document.getElementById(id);
  const video = $('video');

  // ---------- Oppstart ----------
  document.querySelectorAll('.app-version').forEach((el) => { el.textContent = 'Versjon ' + APP_VERSION; });
  $('startBtn').addEventListener('click', start);

  async function start() {
    $('startError').hidden = true;
    try {
      await requestOrientationPermission();   // må skje i klikket (iPhone)
      await startCamera();
    } catch (e) {
      showStartError(e);
      return;
    }
    startOrientation();
    startGeolocation();
    detectPhone();
    $('start').hidden = true;
    $('cam').hidden = false;
    initSettingsUI();
    initDragAlign();
    requestAnimationFrame(loop);
  }

  function showStartError(e) {
    console.error(e);
    let msg = 'Noe gikk galt: ' + (e && e.message ? e.message : e);
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      msg = 'Appen fikk ikke tilgang til kameraet. Gi tillatelse i nettleserens innstillinger og prøv igjen.';
    } else if (e && e.name === 'NotFoundError') {
      msg = 'Fant ikke noe kamera på enheten.';
    } else if (!window.isSecureContext) {
      msg = 'Appen må åpnes via https:// for å få bruke kamera og posisjon.';
    }
    const el = $('startError');
    el.textContent = msg;
    el.hidden = false;
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Nettleseren støtter ikke kamera. Prøv Chrome (Android) eller Safari (iPhone).');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.zoom && caps.zoom.min <= 1 && caps.zoom.max >= 1) await track.applyConstraints({ advanced: [{ zoom: 1 }] });
      const st = track.getSettings ? track.getSettings() : {};
      if (st.zoom) state.zoom = st.zoom;
    } catch { /* ikke støttet – bruk 1x */ }
  }

  // ---------- Kompass ----------
  async function requestOrientationPermission() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      const res = await DOE.requestPermission();   // iPhone
      if (res !== 'granted') throw new Error('Appen trenger tilgang til bevegelse og retning (kompass).');
    }
  }

  let gotAbsolute = false;
  let smoothSin = 0, smoothCos = 0, haveSmooth = false;

  function startOrientation() {
    window.addEventListener('deviceorientationabsolute', (e) => {
      gotAbsolute = true;
      handleOrientation(e, true);
    }, true);
    window.addEventListener('deviceorientation', (e) => {
      if (gotAbsolute) return;
      handleOrientation(e, !!e.absolute);
    }, true);
  }

  function handleOrientation(e, absolute) {
    let h = null;
    const beta = e.beta || 0, gamma = e.gamma || 0;

    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      h = e.webkitCompassHeading;
      state.upright = Math.abs(beta) > 35 || Math.abs(gamma) > 35;
    } else if (absolute && e.alpha != null) {
      const r = cameraHeading(e.alpha, beta, gamma);
      h = r.heading;
      state.upright = r.horiz > 0.45;
    }
    if (h == null || isNaN(h)) return;

    const d = Math.PI / 180;
    const p = Math.asin(Math.max(-1, Math.min(1, -Math.cos(beta * d) * Math.cos(gamma * d)))) / d;
    state.pitch = state.pitch == null ? p
      : state.pitch + (p - state.pitch) * Math.min(1, 0.25 + Math.abs(p - state.pitch) / 6);

    const rad = h * d;
    if (!haveSmooth) { smoothSin = Math.sin(rad); smoothCos = Math.cos(rad); haveSmooth = true; }
    else {
      const cur = Math.atan2(smoothSin, smoothCos) / d;
      const jump = Math.abs(angleDiff(h, cur));
      const k = Math.min(1, 0.25 + jump / 6);
      smoothSin = smoothSin * (1 - k) + Math.sin(rad) * k;
      smoothCos = smoothCos * (1 - k) + Math.cos(rad) * k;
    }
    state.heading = norm360(Math.atan2(smoothSin, smoothCos) / d);
  }

  function cameraHeading(alpha, beta, gamma) {
    const d = Math.PI / 180;
    const cA = Math.cos(alpha * d), sA = Math.sin(alpha * d);
    const sB = Math.sin(beta * d);
    const cG = Math.cos(gamma * d), sG = Math.sin(gamma * d);
    const east = -cA * sG - sA * sB * cG;
    const north = -sA * sG + cA * sB * cG;
    return { heading: norm360(Math.atan2(east, north) / d), horiz: Math.hypot(east, north) };
  }

  // Retning og vipping som brukes (med justering, og frosset hvis bildet er frosset)
  function currentHeading() {
    const h = state.frozen && state.frozenSensors ? state.frozenSensors.heading : state.heading;
    return h == null ? null : norm360(h + settings.offset);
  }
  function currentPitch() {
    const p = state.frozen && state.frozenSensors ? state.frozenSensors.pitch : state.pitch;
    return (p || 0) + settings.pitchOffset;
  }

  // ---------- Posisjon ----------
  function startGeolocation() {
    if (!navigator.geolocation) { setStatus('Telefonen støtter ikke posisjon.'); return; }
    navigator.geolocation.watchPosition(
      onPosition,
      (err) => {
        setStatus(err.code === 1
          ? 'Ingen tilgang til posisjon. Slå på posisjon for nettleseren.'
          : 'Finner ikke posisjon … (' + err.message + ')');
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  }

  let avg = null;
  function onPosition(p) {
    const c = p.coords;
    const acc = Math.max(c.accuracy || 50, 3);
    const moving = c.speed != null && c.speed > 0.7;
    const w = 1 / (acc * acc);

    if (!avg || moving || distance(avg.lat, avg.lon, c.latitude, c.longitude) > Math.max(8, acc * 1.5)) {
      avg = { lat: c.latitude, lon: c.longitude, w, n: 1 };
    } else {
      avg.w *= 0.85;
      const tw = avg.w + w;
      avg.lat = (avg.lat * avg.w + c.latitude * w) / tw;
      avg.lon = (avg.lon * avg.w + c.longitude * w) / tw;
      avg.w = tw;
      avg.n++;
    }
    state.gpsPos = { lat: avg.lat, lon: avg.lon, acc: Math.min(acc, 1 / Math.sqrt(avg.w)) };

    // Posisjon satt på kartet gjelder til du har gått et stykke
    if (state.manual) {
      if (!state.manual.gpsRef) state.manual.gpsRef = { ...state.gpsPos };
      const moved = distance(state.manual.gpsRef.lat, state.manual.gpsRef.lon, state.gpsPos.lat, state.gpsPos.lon);
      if (moved > Math.max(15, state.gpsPos.acc * 2)) {
        state.manual = null;
        toast('Du har flyttet deg – bruker GPS igjen');
      }
    }
    updatePos();
    autoCalibrateCompass(c);
  }

  function updatePos() {
    if (state.manual) state.pos = { lat: state.manual.lat, lon: state.manual.lon, acc: 1, manual: true };
    else if (state.gpsPos) state.pos = { ...state.gpsPos, manual: false };
    maybeFetch();
  }

  function setManualPos(lat, lon) {
    state.manual = { lat, lon, gpsRef: state.gpsPos ? { ...state.gpsPos } : null };
    state.panoDirty = true;
    updatePos();
    toast('Posisjonen er satt ✓');
  }

  // ---------- Automatisk kompass-kalibrering (når du går) ----------
  let track = null;
  const calSamples = [];
  function autoCalibrateCompass(c) {
    if (!settings.autoCompass || state.heading == null || !state.upright || state.frozen) { track = null; return; }
    let course = null;
    if (c.heading != null && !isNaN(c.heading) && c.speed != null && c.speed > 0.7 && c.speed < 4) {
      course = c.heading;
    } else if (c.accuracy < 20) {
      if (!track) { track = { lat: c.latitude, lon: c.longitude }; return; }
      const d = distance(track.lat, track.lon, c.latitude, c.longitude);
      if (d < Math.max(8, c.accuracy)) return;
      course = bearing(track.lat, track.lon, c.latitude, c.longitude);
      track = { lat: c.latitude, lon: c.longitude };
    }
    if (course == null) return;

    calSamples.push(angleDiff(course, state.heading));
    if (calSamples.length > 10) calSamples.shift();
    if (calSamples.length < 5) return;

    let s = 0, k = 0;
    for (const v of calSamples) { s += Math.sin(toRad(v)); k += Math.cos(toRad(v)); }
    const R = Math.hypot(s, k) / calSamples.length;
    if (R < 0.97) return;
    const mean = Math.atan2(s, k) * 180 / Math.PI;
    if (Math.abs(mean) > 90) return;
    setOffset(Math.round(mean));
    settings.calibrated = true;
    saveSettings();
    toast('Kompasset er kalibrert ✓');
    calSamples.length = 0;
  }

  function setOffset(v) {
    settings.offset = Math.round(Math.max(-90, Math.min(90, v)) * 2) / 2;
    saveSettings();
    const o = $('offset');
    if (o) { o.value = settings.offset; $('offsetVal').textContent = signed(settings.offset); }
  }
  function setPitchOffset(v) {
    settings.pitchOffset = Math.round(Math.max(-15, Math.min(15, v)) * 2) / 2;
    saveSettings();
    const o = $('pitchOffset');
    if (o) { o.value = settings.pitchOffset; $('pitchOffsetVal').textContent = signed(settings.pitchOffset); }
  }
  function signed(v) { return (v > 0 ? '+' : '') + v; }

  let toastTimer = null;
  function toast(msg, ms = 3000) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------- Telefongjenkjenning ----------
  const PHONE_CAMERAS = [
    { match: /Pixel 10 Pro/i, name: 'Pixel 10 Pro', lensFov: 70 },   // 82° diagonal (Google)
  ];

  async function detectPhone() {
    try {
      if (!navigator.userAgentData || !navigator.userAgentData.getHighEntropyValues) return;
      const { model } = await navigator.userAgentData.getHighEntropyValues(['model']);
      if (!model) return;
      state.phoneModel = model;
      const known = PHONE_CAMERAS.find((p) => p.match.test(model));
      if (known) {
        state.phoneModel = known.name;
        state.phoneKnown = true;
        if (!settings.lensFovManual) settings.lensFov = known.lensFov;
      }
    } catch { /* ikke tilgjengelig */ }
  }

  function focalPx(W, H) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return (W / 2) / Math.tan(toRad(20));
    const fVideo = (Math.max(vw, vh) / 2) / Math.tan(toRad(settings.lensFov / 2)) * (state.zoom || 1);
    const scale = Math.max(W / vw, H / vh);
    return fVideo * scale;
  }

  // ---------- Hent data ----------
  function maybeFetch(force) {
    if (!state.pos || state.fetching) return;
    const f = state.fetchedAt;
    if (!force && f && f.radius >= settings.radius &&
        distance(f.lat, f.lon, state.pos.lat, state.pos.lon) < 40) return;
    fetchArea();
  }

  async function fetchArea() {
    state.fetching = true;
    const { lat, lon } = state.pos;
    const radius = settings.radius;
    try {
      const [addrs, blds] = await Promise.all([
        fetchKartverket(lat, lon, radius + 50).catch((e) => { console.error(e); return null; }),
        fetchBuildings(lat, lon, radius + 100).catch((e) => { console.error(e); return null; }),
      ]);
      let list = addrs;
      if (list && list.length === 0) list = await fetchOSMAddresses(lat, lon, radius + 50).catch(() => []);
      if (!list) throw new Error('Fikk ikke adresser');

      const buildings = blds || [];
      if (buildings.length) await fetchTerrain(buildings);

      state.addresses = list;
      state.buildings = buildings;
      state.buildingsOk = !!blds && buildings.length > 0;
      linkAddresses();
      state.fetchedAt = { lat, lon, radius };
      state.panoDirty = true;
    } catch (e) {
      console.error(e);
      setStatus('Klarte ikke å hente adresser. Sjekk nettet.');
      state.fetchedAt = null;
    } finally {
      state.fetching = false;
    }
  }

  async function fetchKartverket(lat, lon, radius) {
    const url = 'https://ws.geonorge.no/adresser/v1/punktsok?' + new URLSearchParams({
      lat: lat.toFixed(6), lon: lon.toFixed(6), radius: String(Math.round(radius)),
      treffPerSide: '1000', utkoordsys: '4258', asciiKompatibel: 'false',
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error('Kartverket svarte ' + res.status);
    const json = await res.json();
    return (json.adresser || [])
      .filter((a) => a.representasjonspunkt)
      .map((a) => ({
        id: 'kv' + a.adressekode + '-' + a.kommunenummer + '-' + a.adressetekst,
        title: a.adressetekst,
        sub: [a.postnummer, a.poststed].filter(Boolean).join(' '),
        lat: a.representasjonspunkt.lat,
        lon: a.representasjonspunkt.lon,
        raw: a,
        building: null,
      }));
  }

  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  async function overpass(q) {
    let lastErr = null;
    for (const url of OVERPASS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(url, {
          method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctrl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        clearTimeout(timer);
        if (res.ok) return await res.json();
        lastErr = new Error('Overpass ' + res.status);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Overpass');
  }

  // Utenfor Norge: adresser fra OpenStreetMap
  async function fetchOSMAddresses(lat, lon, radius) {
    const r = Math.round(radius);
    const json = await overpass(`[out:json][timeout:20];(node["addr:housenumber"](around:${r},${lat},${lon});` +
      `way["addr:housenumber"](around:${r},${lat},${lon}););out center 500;`);
    return (json.elements || []).map((el) => {
      const t = el.tags || {};
      const p = el.type === 'node' ? el : el.center;
      if (!p) return null;
      return {
        id: 'osm' + el.type + el.id,
        title: [t['addr:street'] || t['addr:place'] || '', t['addr:housenumber']].join(' ').trim(),
        sub: [t['addr:postcode'], t['addr:city']].filter(Boolean).join(' '),
        lat: p.lat, lon: p.lon, raw: t, building: null,
      };
    }).filter(Boolean);
  }

  // Typiske høyder (meter) når bygningen ikke har oppgitt høyde
  const TYPE_HEIGHT = {
    garage: 3, garages: 3, carport: 3, shed: 2.5, hut: 3, roof: 4, greenhouse: 3, kiosk: 3, container: 3,
    cabin: 5, bungalow: 5, house: 7, detached: 7, semidetached_house: 7, residential: 8, terrace: 8,
    farm: 7, farm_auxiliary: 7, barn: 8, apartments: 13, dormitory: 12, hotel: 15, commercial: 10,
    retail: 8, office: 12, industrial: 10, warehouse: 9, school: 10, kindergarten: 5, church: 15,
    hospital: 18, public: 10, sports_hall: 10, yes: 6,
  };
  const SMALL_TYPES = new Set(['garage', 'garages', 'carport', 'shed', 'hut', 'roof', 'greenhouse', 'kiosk',
    'container', 'toilets', 'service', 'transformer_tower', 'boathouse', 'farm_auxiliary', 'barn']);

  function buildingHeight(t) {
    const h = parseFloat(t.height);
    if (h > 1 && h < 400) return h;
    const lv = parseFloat(t['building:levels']);
    if (lv > 0 && lv < 100) return lv * 3 + 2;
    return TYPE_HEIGHT[t.building] || 6;
  }

  async function fetchBuildings(lat, lon, r) {
    r = Math.round(r);
    const json = await overpass(`[out:json][timeout:25];(way["building"](around:${r},${lat},${lon});` +
      `relation["building"](around:${r},${lat},${lon}););out geom;`);
    const out = [];
    for (const el of json.elements || []) {
      const t = el.tags || {};
      let rings = [];
      if (el.type === 'way' && el.geometry) rings.push(el.geometry);
      else if (el.type === 'relation' && el.members) {
        for (const m of el.members) if (m.type === 'way' && m.role !== 'inner' && m.geometry) rings.push(m.geometry);
      }
      rings = rings.map((g) => g.filter(Boolean).map((p) => [p.lat, p.lon])).filter((g) => g.length >= 3);
      if (!rings.length) continue;
      let sLat = 0, sLon = 0, n = 0;
      for (const g of rings) for (const p of g) { sLat += p[0]; sLon += p[1]; n++; }
      out.push({
        id: el.type[0] + el.id, rings, lat: sLat / n, lon: sLon / n, type: t.building,
        height: buildingHeight(t), small: SMALL_TYPES.has(t.building), ground: null, addrs: [], tags: t,
      });
    }
    return out;
  }

  // Terrenghøyde fra Kartverket (maks 50 punkter per kall)
  async function fetchElevations(points) {
    const out = new Array(points.length).fill(null);
    const starts = [];
    for (let i = 0; i < points.length; i += 50) starts.push(i);
    await Promise.all(starts.map(async (i) => {
      const part = points.slice(i, i + 50);
      const url = 'https://ws.geonorge.no/hoydedata/v1/punkt?' + new URLSearchParams({
        koordsys: '4258', geojson: 'false',
        punkter: JSON.stringify(part.map((p) => [+p[1].toFixed(6), +p[0].toFixed(6)])),
      });
      const res = await fetch(url);
      if (!res.ok) throw new Error('Høydedata svarte ' + res.status);
      const j = await res.json();
      const got = j.punkter || [];
      got.forEach((p, k) => {
        if (typeof p.z !== 'number') return;
        let idx = i + k;
        const q = points[idx];
        if (!q || Math.abs(q[1] - p.x) > 1e-4 || Math.abs(q[0] - p.y) > 1e-4) {
          idx = -1;
          for (let m = 0; m < part.length; m++) {
            if (Math.abs(part[m][1] - p.x) < 1e-4 && Math.abs(part[m][0] - p.y) < 1e-4) { idx = i + m; break; }
          }
        }
        if (idx >= 0) out[idx] = p.z;
      });
    }));
    return out;
  }

  async function fetchTerrain(buildings) {
    try {
      const z = await fetchElevations(buildings.map((b) => [b.lat, b.lon]));
      const ok = z.filter((v) => v != null);
      const median = ok.length ? ok.slice().sort((a, b) => a - b)[Math.floor(ok.length / 2)] : 0;
      buildings.forEach((b, i) => { b.ground = z[i] != null ? z[i] : median; });
      state.terrainOk = ok.length > buildings.length * 0.5;
    } catch (e) {
      console.error(e);
      buildings.forEach((b) => { b.ground = 0; });
      state.terrainOk = false;
    }
  }

  function ensureUserGround() {
    if (!state.pos || state.groundPending || !state.terrainOk) return;
    const g = state.userGround;
    if (g && distance(g.lat, g.lon, state.pos.lat, state.pos.lon) < 4) return;
    state.groundPending = true;
    const { lat, lon } = state.pos;
    fetchElevations([[lat, lon]])
      .then(([z]) => { if (z != null) { state.userGround = { lat, lon, z }; state.panoDirty = true; } })
      .catch(() => {})
      .finally(() => { state.groundPending = false; });
  }

  // ---------- Koble adresser til hus ----------
  function linkAddresses() {
    const o = state.fetchedAt || state.pos;
    for (const b of state.buildings) {
      b.addrs = [];
      b.local = b.rings.map((g) => g.map((p) => toLocal(p[0], p[1], o)));
    }
    for (const a of state.addresses) {
      a.building = null;
      const [x, y] = toLocal(a.lat, a.lon, o);
      let best = null, bestScore = Infinity;
      for (const b of state.buildings) {
        const inside = b.local.some((r) => pointInRing(x, y, r));
        const d = inside ? 0 : minDistToRings(x, y, b.local);
        if (d > 30) continue;
        const score = d + (b.small ? 12 : 0) - (inside ? 5 : 0);
        if (score < bestScore) { bestScore = score; best = b; }
      }
      if (best) { a.building = best; best.addrs.push(a); }
    }
    const coll = new Intl.Collator('nb', { numeric: true });
    for (const b of state.buildings) b.addrs.sort((p, q) => coll.compare(p.title, q.title));
  }

  function buildingTitle(b) {
    const t = b.addrs.map((a) => a.title);
    if (t.length <= 2) return t.join(' / ');
    return t[0] + ` +${t.length - 1}`;
  }

  // ---------- Utsikt: hvilke hus ser du herfra? ----------
  // Sender 720 stråler (hver halve grad) ut fra der du står, og finner hvilke hus hver stråle treffer.
  // Et hus er synlig i en retning hvis toppen av det stikker opp over alle nærmere hus.
  const RAYS = 720, STEP = 360 / RAYS;

  function computePanorama() {
    const o = state.pos;
    const ground = state.terrainOk && state.userGround ? state.userGround.z : null;
    const nearestGround = () => {
      let best = null, bd = Infinity;
      for (const b of state.buildings) {
        const d = distance(o.lat, o.lon, b.lat, b.lon);
        if (d < bd) { bd = d; best = b; }
      }
      return best && best.ground != null ? best.ground : 0;
    };
    const zEye = (state.terrainOk ? (ground != null ? ground : nearestGround()) : 0) + settings.eyeH;
    const maxDist = settings.radius + 60;
    const hitsPerRay = Array.from({ length: RAYS }, () => []);

    for (const b of state.buildings) {
      const rings = b.rings.map((g) => g.map((p) => toLocal(p[0], p[1], o)));
      // Huset du selv står i / på balkongen til teller ikke
      b.inside = rings.some((r) => pointInRing(0, 0, r)) || minDistToRings(0, 0, rings) < 1.5;
      if (b.inside) continue;
      const [cx, cy] = toLocal(b.lat, b.lon, o);
      if (Math.hypot(cx, cy) > maxDist + 40) continue;
      const c = norm360(Math.atan2(cx, cy) * 180 / Math.PI);
      let lo = 0, hi = 0;
      for (const r of rings) for (const p of r) {
        const d = angleDiff(norm360(Math.atan2(p[0], p[1]) * 180 / Math.PI), c);
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
      const i0 = Math.floor((c + lo) / STEP) - 1, i1 = Math.ceil((c + hi) / STEP) + 1;
      for (let ii = i0; ii <= i1; ii++) {
        const i = ((ii % RAYS) + RAYS) % RAYS;
        const th = toRad(i * STEP), dx = Math.sin(th), dy = Math.cos(th);
        let tMin = Infinity;
        for (const r of rings) {
          for (let k = 0; k < r.length; k++) {
            const t = raySeg(dx, dy, r[k], r[(k + 1) % r.length]);
            if (t < tMin) tMin = t;
          }
        }
        if (tMin <= maxDist) hitsPerRay[i].push({ b, t: tMin });
      }
    }

    const vis = new Map();
    const firstHit = new Float32Array(RAYS).fill(Infinity);
    for (let i = 0; i < RAYS; i++) {
      const hits = hitsPerRay[i];
      if (!hits.length) continue;
      hits.sort((p, q) => p.t - q.t);
      firstHit[i] = hits[0].t;
      let maxTop = -90;
      for (const h of hits) {
        const g = state.terrainOk && h.b.ground != null ? h.b.ground : 0;
        const top = Math.atan2(g + h.b.height - zEye, h.t) * 180 / Math.PI;
        const base = Math.atan2(g - zEye, h.t) * 180 / Math.PI;
        if (!settings.hideBehind || top > maxTop + 0.3) {
          const vb = settings.hideBehind ? Math.max(base, maxTop) : base;
          if (!vis.has(h.b)) vis.set(h.b, []);
          vis.get(h.b).push({ i, t: h.t, vb, vt: top });
        }
        if (top > maxTop) maxTop = top;
      }
    }

    // Finn den største synlige delen av hvert hus med adresse
    const items = [];
    for (const [b, list] of vis) {
      if (!b.addrs.length) continue;
      list.sort((p, q) => p.i - q.i);
      const runs = [];
      let run = [list[0]];
      for (let k = 1; k < list.length; k++) {
        if (list[k].i === list[k - 1].i + 1) run.push(list[k]);
        else { runs.push(run); run = [list[k]]; }
      }
      runs.push(run);
      if (runs.length > 1 && runs[0][0].i === 0 && runs[runs.length - 1].slice(-1)[0].i === RAYS - 1) {
        runs[0] = runs.pop().concat(runs[0]);
      }
      let best = runs[0];
      for (const r of runs) if (r.length > best.length) best = r;
      const mid = best[Math.floor(best.length / 2)];
      const tMin = Math.min(...best.map((x) => x.t));
      if (best.length < 2 && tMin > 25) continue;
      if (mid.vt - mid.vb < 0.3) continue;
      items.push({
        key: 'b' + b.id, b, a: b.addrs[0], addrs: b.addrs, title: buildingTitle(b),
        bearing: mid.i * STEP, lo: best[0].i * STEP, hi: best[best.length - 1].i * STEP,
        dist: mid.t, v: (mid.vb + mid.vt) / 2,
      });
    }
    state.pano = { at: { lat: o.lat, lon: o.lon }, zEye, items, firstHit };
    state.panoDirty = false;
  }

  function maybePanorama() {
    if (!state.pos || !state.buildingsOk) { state.pano = null; return; }
    ensureUserGround();
    const p = state.pano;
    if (state.panoDirty || !p || distance(p.at.lat, p.at.lon, state.pos.lat, state.pos.lon) > 1.5) {
      computePanorama();
    }
  }

  // ---------- Tegning ----------
  let lastTick = 0;
  function loop(t) {
    requestAnimationFrame(loop);
    if (t - lastTick > 250) { lastTick = t; maybePanorama(); updateStatus(); }
    draw();
  }

  function collectItems(heading, half) {
    const items = [];
    const pos = state.pos;

    // Hus med adresse (fra utsikt-beregningen)
    if (state.pano) {
      for (const it of state.pano.items) {
        if (it.dist > settings.radius) continue;
        let lo = angleDiff(it.lo, heading), hi = angleDiff(it.hi, heading);
        if (hi < lo) hi += 360;
        if (hi < -half || lo > half) continue;
        const c = angleDiff(it.bearing, heading);
        const diff = Math.max(Math.max(lo, -half + 3), Math.min(Math.min(hi, half - 3), c));
        items.push({ ...it, diff });
      }
    }

    // Adresser uten kjent hus: vis punktet
    const half2 = half + 2;
    const fh = state.pano ? state.pano.firstHit : null;
    const pointItems = [];
    for (const a of state.addresses) {
      if (state.buildingsOk && a.building) continue;
      const dist = distance(pos.lat, pos.lon, a.lat, a.lon);
      if (dist > settings.radius) continue;
      const brg = bearing(pos.lat, pos.lon, a.lat, a.lon);
      const diff = angleDiff(brg, heading);
      if (Math.abs(diff) > half2 + (dist < 12 ? 8 : 0)) continue;
      if (settings.hideBehind && fh) {
        const i = Math.round(brg / STEP) % RAYS;
        if (fh[i] < dist - 8) continue;
      }
      pointItems.push({
        key: a.id, b: null, a, addrs: [a], title: a.title, bearing: brg, dist, diff,
        v: Math.atan2(settings.aim - settings.eyeH, Math.max(dist, 3)) * 180 / Math.PI,
      });
    }
    // Uten bygningsdata: skjul adresser rett bak en nærmere adresse
    if (!state.buildingsOk && settings.hideBehind) {
      pointItems.sort((x, y) => x.dist - y.dist);
      const kept = [];
      for (const it of pointItems) {
        const blockAngle = (d) => Math.max(3, Math.min(14, Math.atan2(8, d) * 180 / Math.PI));
        if (!kept.some((k) => Math.abs(k.diff - it.diff) < blockAngle(k.dist) && it.dist > k.dist + 10)) kept.push(it);
      }
      items.push(...kept);
    } else {
      items.push(...pointItems);
    }
    return items;
  }

  function draw() {
    const heading = currentHeading();
    const labels = $('labels');
    $('headingTxt').textContent = heading == null ? '–' : Math.round(heading) + '° ' + compassName(heading);

    const hint = $('hint');
    const upright = state.frozen || state.upright;
    if (heading == null) {
      hint.textContent = 'Venter på kompass … Fungerer best i Chrome (Android) eller Safari (iPhone).';
      hint.hidden = false;
    } else if (!upright) {
      hint.textContent = 'Hold telefonen oppreist og pek kameraet mot husene.';
      hint.hidden = false;
    } else if (!state.pos) {
      hint.textContent = 'Finner posisjonen din …';
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }

    if (heading == null || !state.pos || !upright) {
      labels.innerHTML = '';
      state.visible = [];
      return;
    }

    const W = window.innerWidth, H = window.innerHeight;
    const f = focalPx(W, H);
    state.focal = f;
    const half = Math.atan((W / 2) / f) * 180 / Math.PI;
    state.screenFov = Math.round(half * 2);

    const items = collectItems(heading, half);
    items.sort((x, y) => x.diff - y.diff);
    state.visible = items;

    const pitch = currentPitch();
    const rowH = 50, minY = 110, maxY = H - 130;
    const placed = [];
    const pos = new Map();
    for (const it of [...items].sort((x, y) => x.dist - y.dist)) {
      const x = W / 2 + f * Math.tan(toRad(it.diff));
      let y = H / 2 - f * Math.tan(toRad(Math.max(-60, Math.min(60, it.v - pitch))));
      y = Math.min(maxY, Math.max(minY, y));
      const w = Math.min(230, 24 + it.title.length * 8.5);
      let tries = 0;
      while (tries < 8 && placed.some((o) => Math.abs(o.x - x) < (o.w + w) / 2 + 6 && Math.abs(o.y - y) < rowH)) {
        y -= rowH; tries++;
      }
      if (y < 70) continue;
      placed.push({ x, y, w });
      pos.set(it.key, { x, y });
    }

    const existing = new Map([...labels.children].map((el) => [el.dataset.id, el]));
    for (const it of items) {
      const p = pos.get(it.key);
      if (!p) continue;
      let el = existing.get(it.key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'lbl';
        el.dataset.id = it.key;
        el.innerHTML = '<b></b><span></span>';
        labels.appendChild(el);
      }
      el.onclick = () => showDetail(it.a.id);
      existing.delete(it.key);
      el.firstChild.textContent = it.title;
      el.lastChild.textContent = Math.round(it.dist) + ' m' + (it.b ? '' : ' · omtrentlig');
      el.classList.toggle('near', it.dist < 40);
      el.classList.toggle('far', it.dist > settings.radius * 0.66);
      el.classList.toggle('approx', !it.b);
      const sc = it.dist > settings.radius * 0.66 ? 0.85 : 1;
      el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${sc})`;
    }
    for (const el of existing.values()) el.remove();
  }

  function updateStatus() {
    if (!state.pos) return;
    let s = state.pos.manual ? '📍 Posisjon satt på kart' : `GPS ±${Math.round(state.pos.acc)} m`;
    if (state.fetching) s += ' · henter hus og adresser …';
    else if (state.fetchedAt && state.addresses.length === 0) s += ' · ingen adresser i nærheten';
    else if (state.fetchedAt) {
      s += ` · ${state.visible.length} i bildet`;
      if (!state.buildingsOk) s += ' · fant ikke husomriss, viser omtrentlig';
      else if (!state.terrainOk) s += ' · uten terrenghøyde';
    }
    if (!state.pos.manual && state.pos.acc > 12) s += ' · tips: trykk 🗺 og sett hvor du står';
    else if (!settings.calibrated) s += ' · dra labelene sidelengs til de treffer husene';
    if (state.frozen) s = '❄︎ Frosset · ' + s;
    setStatus(s);
  }

  function setStatus(s) { $('status').textContent = s; }

  // ---------- Dra for å justere ----------
  // Dra sidelengs: retter opp kompasset. Dra opp/ned: retter opp vippingen.
  function initDragAlign() {
    const cam = $('cam');
    let start = null;
    cam.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.panel, .map-panel, button, .lbl, #topbar, #bottombar')) return;
      start = { x: e.clientX, y: e.clientY, off: settings.offset, po: settings.pitchOffset, active: false, id: e.pointerId };
    });
    cam.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!start.active && Math.hypot(dx, dy) < 10) return;
      start.active = true;
      const f = state.focal || 500;
      setOffset(start.off - Math.atan(dx / f) * 180 / Math.PI);
      setPitchOffset(start.po + Math.atan(dy / f) * 180 / Math.PI);
      toast(`Kompass ${signed(settings.offset)}° · vipp ${signed(settings.pitchOffset)}°`, 1500);
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      if (start.active) {
        settings.calibrated = true;
        saveSettings();
        toast('Justering lagret ✓');
      }
      start = null;
    };
    cam.addEventListener('pointerup', end);
    cam.addEventListener('pointercancel', end);
  }

  // ---------- Frys / liste / detaljer ----------
  $('freezeBtn').addEventListener('click', () => {
    state.frozen = !state.frozen;
    state.frozenSensors = state.frozen ? { heading: state.heading, pitch: state.pitch } : null;
    const btn = $('freezeBtn');
    btn.classList.toggle('frozen', state.frozen);
    btn.textContent = state.frozen ? '▶' : '❚❚';
    if (state.frozen) {
      video.pause();
      if (!settings.dragHintShown) {
        toast('Tips: Dra labelene med fingeren til de står på riktig hus', 5000);
        settings.dragHintShown = true;
        saveSettings();
      }
    } else video.play().catch(() => {});
  });

  $('listBtn').addEventListener('click', () => {
    const ol = $('addrList');
    ol.innerHTML = '';
    const items = [...state.visible].sort((x, y) => x.diff - y.diff);
    if (!items.length) ol.innerHTML = '<li>Ingen adresser i bildet akkurat nå.</li>';
    for (const it of items) {
      const li = document.createElement('li');
      const side = Math.abs(it.diff) < 4 ? 'rett frem' : (it.diff < 0 ? 'til venstre' : 'til høyre');
      li.innerHTML = '<b></b><br><small></small>';
      li.querySelector('b').textContent = it.addrs.map((a) => a.title).join(', ');
      li.querySelector('small').textContent = `${it.a.sub ? it.a.sub + ' · ' : ''}${Math.round(it.dist)} m ${side}`;
      li.addEventListener('click', () => showDetail(it.a.id));
      ol.appendChild(li);
    }
    openPanel('listPanel');
  });

  function showDetail(id) {
    const a = state.addresses.find((x) => x.id === id);
    if (!a) return;
    const dist = state.pos ? Math.round(distance(state.pos.lat, state.pos.lon, a.lat, a.lon)) : '?';
    $('dTitle').textContent = a.title;
    const body = $('dBody');
    body.innerHTML = '';
    const add = (label, val) => {
      if (val === undefined || val === null || val === '') return;
      const p = document.createElement('p');
      p.innerHTML = '<small style="color:var(--muted)"></small><br>';
      p.firstChild.textContent = label;
      p.appendChild(document.createTextNode(val));
      body.appendChild(p);
    };
    add('Postnummer og sted', a.sub);
    add('Avstand', dist + ' meter');
    if (a.building && a.building.addrs.length > 1) {
      add('Flere adresser i samme bygg', a.building.addrs.filter((x) => x !== a).map((x) => x.title).join(', '));
    }
    if (a.raw && a.raw.kommunenavn) {
      add('Kommune', a.raw.kommunenavn);
      add('Gårds- / bruksnummer', `${a.raw.gardsnummer}/${a.raw.bruksnummer}` +
        (a.raw.festenummer ? `/${a.raw.festenummer}` : ''));
      if (a.raw.adressetilleggsnavn) add('Navn', a.raw.adressetilleggsnavn);
    }
    if (!a.building) add('Merk', 'Fant ikke husomrisset – plasseringen er omtrentlig.');

    const links = document.createElement('div');
    const q = encodeURIComponent(`${a.title}${a.sub ? ', ' + a.sub : ''}`);
    links.innerHTML =
      `<a target="_blank" rel="noopener" href="${directionsUrl(a)}">Vis i kart og veibeskrivelse</a>` +
      `<a target="_blank" rel="noopener" href="https://www.google.com/search?q=${q}">Søk på adressen</a>`;
    const inApp = document.createElement('a');
    inApp.href = '#';
    inApp.textContent = 'Vis på kartet her';
    inApp.addEventListener('click', (e) => { e.preventDefault(); openMap(a.id); });
    links.appendChild(inApp);
    if (navigator.clipboard) {
      const b = document.createElement('a');
      b.href = '#';
      b.textContent = 'Kopier';
      b.addEventListener('click', (e) => {
        e.preventDefault();
        navigator.clipboard.writeText(`${a.title}${a.sub ? ', ' + a.sub : ''}`).then(() => { b.textContent = 'Kopiert ✓'; });
      });
      links.appendChild(b);
    }
    body.appendChild(links);

    const cal = document.createElement('div');
    cal.className = 'calib';
    cal.innerHTML = '<p class="small">Står adressen på feil hus? Pek den stiplede midtlinja på dette huset og trykk:</p>' +
      '<button class="primary small-btn">Huset er midt i bildet nå</button>';
    cal.querySelector('button').addEventListener('click', () => {
      const h = currentHeading();
      if (h == null || !state.pos) return;
      setOffset(settings.offset + angleDiff(targetBearing(a), h));
      settings.calibrated = true;
      saveSettings();
      $('detailPanel').hidden = true;
      toast('Kompasset er kalibrert ✓');
    });
    body.appendChild(cal);
    openPanel('detailPanel');
  }

  // Retningen til midten av den synlige delen av huset (eller til adressepunktet)
  function targetBearing(a) {
    if (state.pano && a.building) {
      const it = state.pano.items.find((x) => x.b === a.building);
      if (it) return it.bearing;
    }
    const t = a.building || a;
    return bearing(state.pos.lat, state.pos.lon, t.lat, t.lon);
  }

  function directionsUrl(a) {
    const params = new URLSearchParams({ api: '1', destination: `${a.lat},${a.lon}` });
    if (state.pos) params.set('origin', `${state.pos.lat},${state.pos.lon}`);
    return 'https://www.google.com/maps/dir/?' + params.toString();
  }

  // ---------- Kart inne i appen (Kartverket, gratis) ----------
  let leafletLoading = null, map = null, mapLayer = null, didFit = false, pickMode = false;
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      js.onload = resolve;
      js.onerror = () => { leafletLoading = null; reject(new Error('Klarte ikke å laste kartet. Sjekk nettet.')); };
      document.head.appendChild(js);
    });
    return leafletLoading;
  }

  async function openMap(focusId) {
    openPanel('mapPanel');
    setPickMode(false);
    try { await loadLeaflet(); } catch (e) { $('mapMsg').textContent = e.message; $('mapMsg').hidden = false; return; }
    $('mapMsg').hidden = true;
    if (!map) {
      map = L.map('map', { zoomControl: true, attributionControl: true });
      const kv = L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png',
        { maxZoom: 20, maxNativeZoom: 18, attribution: '© Kartverket' });
      const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap-bidragsytere' });
      kv.addTo(map);
      L.control.layers({ 'Kartverket': kv, 'OpenStreetMap': osm }, null, { position: 'topright' }).addTo(map);
      mapLayer = L.layerGroup().addTo(map);
      map.setView(state.pos ? [state.pos.lat, state.pos.lon] : [65, 13], state.pos ? 18 : 4);
      map.on('click', (e) => {
        if (!pickMode) return;
        setPickMode(false);
        setManualPos(e.latlng.lat, e.latlng.lng);
        drawMap();
      });
      didFit = false;
    }
    setTimeout(() => { map.invalidateSize(); drawMap(focusId); }, 50);
  }

  function setPickMode(on) {
    pickMode = on;
    $('setPosBtn').classList.toggle('active', on);
    $('pickHint').hidden = !on;
    $('gpsBtn').hidden = !state.manual;
  }
  $('setPosBtn').addEventListener('click', () => setPickMode(!pickMode));
  $('gpsBtn').addEventListener('click', () => {
    state.manual = null;
    state.panoDirty = true;
    updatePos();
    setPickMode(false);
    toast('Bruker GPS igjen');
    drawMap();
  });

  function drawMap(focusId) {
    if (!map) return;
    mapLayer.clearLayers();
    $('gpsBtn').hidden = !state.manual;
    const order = [...state.visible].sort((x, y) => x.diff - y.diff);
    const visibleB = new Set(order.filter((v) => v.b).map((v) => v.b));
    const bounds = [];

    // Husomriss: synlige hus oransje, andre hus grå
    for (const b of state.buildings) {
      const seen = visibleB.has(b);
      L.polygon(b.rings, {
        color: seen ? '#f59e0b' : '#64748b', weight: seen ? 2 : 1,
        fillOpacity: seen ? 0.35 : 0.08, interactive: !!b.addrs.length,
      }).bindPopup(b.addrs.length ? popupHtml(b.addrs[0], b) : '').addTo(mapLayer);
    }

    // Kameraets synsfelt
    const h = currentHeading();
    if (state.pos && h != null) {
      const half = (state.screenFov || 40) / 2, r = settings.radius;
      const pts = [[state.pos.lat, state.pos.lon]];
      for (let a = -half; a <= half + 0.01; a += half / 6) pts.push(destPoint(state.pos.lat, state.pos.lon, h + a, r));
      L.polygon(pts, { color: '#f59e0b', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(mapLayer);
    }

    // Nummer for adressene i bildet (samme rekkefølge som lista)
    order.forEach((it, idx) => {
      const ll = it.b ? [it.b.lat, it.b.lon] : [it.a.lat, it.a.lon];
      const focus = it.addrs.some((a) => a.id === focusId);
      const m = L.marker(ll, {
        icon: L.divIcon({ className: 'map-num' + (focus ? ' focus' : ''), html: String(idx + 1), iconSize: [26, 26] }),
        zIndexOffset: 500,
      }).bindPopup(popupHtml(it.a, it.b)).addTo(mapLayer);
      bounds.push(ll);
      if (focus) setTimeout(() => m.openPopup(), 100);
    });

    // Adresser uten hus
    for (const a of state.addresses) {
      if (a.building && state.buildingsOk) continue;
      L.circleMarker([a.lat, a.lon], { radius: 4, color: '#64748b', weight: 1, fillOpacity: 0.7 })
        .bindPopup(popupHtml(a, null)).addTo(mapLayer);
    }

    // Din posisjon
    if (state.pos) {
      if (!state.pos.manual) {
        L.circle([state.pos.lat, state.pos.lon], { radius: state.pos.acc, color: '#3b82f6', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(mapLayer);
      }
      L.circleMarker([state.pos.lat, state.pos.lon], { radius: 8, color: '#fff', weight: 3, fillColor: state.pos.manual ? '#ef4444' : '#3b82f6', fillOpacity: 1 })
        .bindPopup(state.pos.manual ? 'Du står her (satt på kartet)' : 'Du er her (GPS)').addTo(mapLayer);
      bounds.push([state.pos.lat, state.pos.lon]);
    }

    const focus = focusId && state.addresses.find((x) => x.id === focusId);
    if (focus) {
      const t = focus.building || focus;
      map.setView([t.lat, t.lon], 19);
    } else if (!didFit && bounds.length > 1) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 19 });
      didFit = true;
    }
  }

  function popupHtml(a, b) {
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const titles = b ? b.addrs.map((x) => x.title).join(', ') : a.title;
    const dist = state.pos ? Math.round(distance(state.pos.lat, state.pos.lon, a.lat, a.lon)) + ' m unna' : '';
    return `<b>${esc(titles)}</b><br><small>${esc(a.sub || '')}${a.sub && dist ? ' · ' : ''}${dist}</small><br>` +
      `<a target="_blank" rel="noopener" href="${directionsUrl(a)}">Veibeskrivelse i Google Maps</a>`;
  }

  function destPoint(lat, lon, brg, dist) {
    const R = 6371000, d = dist / R, b = toRad(brg), p1 = toRad(lat), l1 = toRad(lon);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [p2 * 180 / Math.PI, l2 * 180 / Math.PI];
  }

  $('mapBtn').addEventListener('click', () => openMap());
  $('listMapBtn').addEventListener('click', () => openMap());

  function openPanel(id) {
    for (const p of ['listPanel', 'detailPanel', 'settingsPanel', 'mapPanel']) $(p).hidden = p !== id;
  }
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => { $(b.dataset.close).hidden = true; }));

  // ---------- Innstillinger-UI ----------
  function initSettingsUI() {
    const bind = (id, key, fmt = (v) => v, after) => {
      const input = $(id), out = $(id + 'Val');
      input.value = settings[key];
      out.textContent = fmt(settings[key]);
      input.addEventListener('input', () => {
        settings[key] = Number(input.value);
        out.textContent = fmt(settings[key]);
        saveSettings();
        if (after) after();
      });
    };
    bind('radius', 'radius', undefined, () => { maybeFetch(); state.panoDirty = true; });
    bind('lensFov', 'lensFov', undefined, () => { settings.lensFovManual = true; saveSettings(); });
    bind('eyeH', 'eyeH', undefined, () => { state.panoDirty = true; });
    bind('aim', 'aim');
    bind('offset', 'offset', signed);
    bind('pitchOffset', 'pitchOffset', signed);
    const ac = $('autoCompass');
    ac.checked = settings.autoCompass;
    ac.addEventListener('change', () => { settings.autoCompass = ac.checked; saveSettings(); });
    const hb = $('hideBehind');
    hb.checked = settings.hideBehind;
    hb.addEventListener('change', () => { settings.hideBehind = hb.checked; saveSettings(); state.panoDirty = true; });
    $('resetCal').addEventListener('click', () => {
      setOffset(0);
      setPitchOffset(0);
      settings.calibrated = false;
      saveSettings();
      toast('Justeringen er nullstilt');
    });
    $('settingsBtn').addEventListener('click', () => {
      $('screenFovVal').textContent = state.screenFov ? state.screenFov + '°' : '–';
      $('lensFov').value = settings.lensFov;
      $('lensFovVal').textContent = settings.lensFov;
      $('phoneVal').textContent = state.phoneModel
        ? state.phoneModel + (state.phoneKnown ? ' (kameraet er kjent)' : ' (ukjent kamera, bruker standard)')
        : 'ukjent';
      $('dataVal').textContent = `${state.addresses.length} adresser, ${state.buildings.length} hus` +
        (state.terrainOk ? ', med terrenghøyde' : '');
      $('settingsPanel').hidden ? openPanel('settingsPanel') : ($('settingsPanel').hidden = true);
    });
  }

  // ---------- Matte ----------
  function norm360(a) { return ((a % 360) + 360) % 360; }
  function angleDiff(a, b) { return ((a - b + 540) % 360) - 180; }
  function toRad(x) { return x * Math.PI / 180; }
  function distance(lat1, lon1, lat2, lon2) {
    const R = 6371000, dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return norm360(Math.atan2(y, x) * 180 / Math.PI);
  }
  // Lokale meter-koordinater (øst, nord) rundt et origo
  function toLocal(lat, lon, o) {
    const R = 6371000;
    return [toRad(lon - o.lon) * R * Math.cos(toRad(o.lat)), toRad(lat - o.lat) * R];
  }
  // Avstand langs strålen (dx, dy) fra origo til linjestykket p–q, eller Infinity
  function raySeg(dx, dy, p, q) {
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) return Infinity;
    const t = (p[0] * ey - p[1] * ex) / den;
    const s = (p[0] * dy - p[1] * dx) / den;
    return (t > 0.3 && s >= 0 && s <= 1) ? t : Infinity;
  }
  function pointInRing(x, y, r) {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function minDistToRings(x, y, rings) {
    let best = Infinity;
    for (const r of rings) {
      for (let k = 0; k < r.length; k++) {
        const p = r[k], q = r[(k + 1) % r.length];
        const ex = q[0] - p[0], ey = q[1] - p[1];
        const L2 = ex * ex + ey * ey;
        let s = L2 ? ((x - p[0]) * ex + (y - p[1]) * ey) / L2 : 0;
        s = Math.max(0, Math.min(1, s));
        const d = Math.hypot(x - (p[0] + s * ex), y - (p[1] + s * ey));
        if (d < best) best = d;
      }
    }
    return best;
  }
  function compassName(h) {
    return ['N', 'NØ', 'Ø', 'SØ', 'S', 'SV', 'V', 'NV'][Math.round(h / 45) % 8];
  }

  // ---------- Offline / installering ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
