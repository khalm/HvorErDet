/* HvorErDet – pek kameraet på hus og se adressene.
 * Bruker: kamera, GPS og kompass i telefonen + Kartverkets åpne adresse-API (gratis, ingen nøkkel).
 * Virker best i Norge. Utenfor Norge brukes OpenStreetMap som reserve.
 */
(() => {
  'use strict';

  // ---------- Innstillinger (lagres lokalt på telefonen) ----------
  const DEFAULTS = { radius: 150, fov: 55, offset: 0, hideBehind: true };
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
    pos: null,            // { lat, lon, acc }
    heading: null,        // grader, 0 = nord (rå, før justering)
    upright: true,        // holdes telefonen oppreist?
    addresses: [],        // [{ id, title, sub, lat, lon, raw }]
    fetchedAt: null,      // { lat, lon, radius } for siste oppslag
    fetching: false,
    frozen: false,
    source: '',
    visible: [],
  };

  const $ = (id) => document.getElementById(id);
  const video = $('video');

  // ---------- Oppstart ----------
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
    $('start').hidden = true;
    $('cam').hidden = false;
    initSettingsUI();
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
    // Android/Chrome: absolutt retning (i forhold til nord)
    window.addEventListener('deviceorientationabsolute', (e) => {
      gotAbsolute = true;
      handleOrientation(e, true);
    }, true);
    // iPhone (webkitCompassHeading) og andre nettlesere
    window.addEventListener('deviceorientation', (e) => {
      if (gotAbsolute) return;
      handleOrientation(e, !!e.absolute);
    }, true);
  }

  function handleOrientation(e, absolute) {
    let h = null;
    const beta = e.beta || 0, gamma = e.gamma || 0;

    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      // iPhone gir kompassretning direkte
      h = e.webkitCompassHeading;
      state.upright = Math.abs(beta) > 35 || Math.abs(gamma) > 35;
    } else if (absolute && e.alpha != null) {
      const r = cameraHeading(e.alpha, beta, gamma);
      h = r.heading;
      state.upright = r.horiz > 0.45;
    }
    if (h == null || isNaN(h)) return;

    // Glatt ut retningen (sirkulært gjennomsnitt) så labelene ikke hopper
    const rad = h * Math.PI / 180;
    const k = 0.2;
    if (!haveSmooth) { smoothSin = Math.sin(rad); smoothCos = Math.cos(rad); haveSmooth = true; }
    else {
      smoothSin = smoothSin * (1 - k) + Math.sin(rad) * k;
      smoothCos = smoothCos * (1 - k) + Math.cos(rad) * k;
    }
    state.heading = norm360(Math.atan2(smoothSin, smoothCos) * 180 / Math.PI);
  }

  // Retningen bak-kameraet peker (enhetens -Z-akse) ut fra alpha/beta/gamma.
  function cameraHeading(alpha, beta, gamma) {
    const d = Math.PI / 180;
    const cA = Math.cos(alpha * d), sA = Math.sin(alpha * d);
    const cB = Math.cos(beta * d), sB = Math.sin(beta * d);
    const cG = Math.cos(gamma * d), sG = Math.sin(gamma * d);
    const east = -cA * sG - sA * sB * cG;
    const north = -sA * sG + cA * sB * cG;
    void cB;
    return { heading: norm360(Math.atan2(east, north) * 180 / Math.PI), horiz: Math.hypot(east, north) };
  }

  // ---------- Posisjon ----------
  function startGeolocation() {
    if (!navigator.geolocation) { setStatus('Telefonen støtter ikke posisjon.'); return; }
    navigator.geolocation.watchPosition(
      (p) => {
        state.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
        maybeFetch();
      },
      (err) => {
        setStatus(err.code === 1
          ? 'Ingen tilgang til posisjon. Slå på posisjon for nettleseren.'
          : 'Finner ikke posisjon … (' + err.message + ')');
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
    );
  }

  // ---------- Hent adresser ----------
  function maybeFetch(force) {
    if (!state.pos || state.fetching) return;
    const f = state.fetchedAt;
    if (!force && f && f.radius >= settings.radius &&
        distance(f.lat, f.lon, state.pos.lat, state.pos.lon) < 20) return;
    fetchAddresses();
  }

  async function fetchAddresses() {
    state.fetching = true;
    const { lat, lon } = state.pos;
    const radius = settings.radius;
    try {
      let list = await fetchKartverket(lat, lon, radius);
      if (list.length === 0) list = await fetchOSM(lat, lon, radius);   // utenfor Norge
      state.addresses = list;
      state.fetchedAt = { lat, lon, radius };
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
      }));
  }

  // Reserve utenfor Norge: adresser fra OpenStreetMap (gratis, men mindre komplett)
  async function fetchOSM(lat, lon, radius) {
    const r = Math.round(radius);
    const q = `[out:json][timeout:20];(node["addr:housenumber"](around:${r},${lat},${lon});` +
              `way["addr:housenumber"](around:${r},${lat},${lon}););out center 500;`;
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!res.ok) throw new Error('OpenStreetMap svarte ' + res.status);
    const json = await res.json();
    return (json.elements || []).map((el) => {
      const t = el.tags || {};
      const p = el.type === 'node' ? el : el.center;
      if (!p) return null;
      return {
        id: 'osm' + el.type + el.id,
        title: [t['addr:street'] || t['addr:place'] || '', t['addr:housenumber']].join(' ').trim(),
        sub: [t['addr:postcode'], t['addr:city']].filter(Boolean).join(' '),
        lat: p.lat, lon: p.lon, raw: t,
      };
    }).filter(Boolean);
  }

  // ---------- Tegning ----------
  let lastDraw = 0;
  function loop(t) {
    requestAnimationFrame(loop);
    if (t - lastDraw < 66) return;        // ca. 15 bilder i sekundet holder
    lastDraw = t;
    if (!state.frozen) draw();
    updateStatus();
  }

  function currentHeading() {
    return state.heading == null ? null : norm360(state.heading + settings.offset);
  }

  function draw() {
    const heading = currentHeading();
    const labels = $('labels');
    $('headingTxt').textContent = heading == null ? '–' : Math.round(heading) + '° ' + compassName(heading);

    const hint = $('hint');
    if (heading == null) {
      hint.textContent = 'Venter på kompass … Fungerer best i Chrome (Android) eller Safari (iPhone).';
      hint.hidden = false;
    } else if (!state.upright) {
      hint.textContent = 'Hold telefonen oppreist og pek kameraet mot husene.';
      hint.hidden = false;
    } else if (!state.pos) {
      hint.textContent = 'Finner posisjonen din …';
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }

    if (heading == null || !state.pos || !state.upright) {
      labels.innerHTML = '';
      state.visible = [];
      return;
    }

    const half = settings.fov / 2;
    let items = [];
    for (const a of state.addresses) {
      const dist = distance(state.pos.lat, state.pos.lon, a.lat, a.lon);
      if (dist > settings.radius) continue;
      const diff = angleDiff(bearing(state.pos.lat, state.pos.lon, a.lat, a.lon), heading);
      // Svært nære adresser (< 12 m) får litt større vinkel-slingringsmonn
      const extra = dist < 12 ? 10 : 2;
      if (Math.abs(diff) > half + extra) continue;
      items.push({ a, dist, diff });
    }

    // Skjul adresser som ligger rett bak en nærmere adresse
    if (settings.hideBehind) {
      items.sort((x, y) => x.dist - y.dist);
      const kept = [];
      for (const it of items) {
        const blockAngle = (d) => Math.max(3, Math.min(14, Math.atan2(8, d) * 180 / Math.PI));
        const hidden = kept.some((k) => Math.abs(k.diff - it.diff) < blockAngle(k.dist) && it.dist > k.dist + 10);
        if (!hidden) kept.push(it);
      }
      items = kept;
    }

    items.sort((x, y) => x.diff - y.diff);
    state.visible = items;

    // Plasser labelene i rader så de ikke overlapper
    const W = window.innerWidth, H = window.innerHeight;
    // Nærmeste adresser havner nederst (rad 0), de bakenforliggende stables oppover.
    const rows = [];
    const rowH = 54, bottom = H - 150, maxRows = Math.max(1, Math.floor((bottom - 90) / rowH));
    const byNear = [...items].sort((x, y) => x.dist - y.dist);
    const pos = new Map();
    for (const it of byNear) {
      const x = W / 2 + (it.diff / settings.fov) * W;
      const w = Math.min(220, 24 + it.a.title.length * 8.5);
      let r = 0;
      while (r < maxRows && (rows[r] || []).some((o) => Math.abs(o.x - x) < (o.w + w) / 2 + 6)) r++;
      if (r >= maxRows) continue;
      (rows[r] = rows[r] || []).push({ x, w });
      pos.set(it.a.id, { x, y: bottom - r * rowH });
    }

    // Gjenbruk eksisterende label-elementer for jevn animasjon
    const existing = new Map([...labels.children].map((el) => [el.dataset.id, el]));
    for (const it of items) {
      const p = pos.get(it.a.id);
      if (!p) continue;
      let el = existing.get(it.a.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'lbl';
        el.dataset.id = it.a.id;
        el.innerHTML = '<b></b><span></span>';
        el.addEventListener('click', () => showDetail(it.a.id));
        labels.appendChild(el);
      }
      existing.delete(it.a.id);
      el.firstChild.textContent = it.a.title;
      el.lastChild.textContent = Math.round(it.dist) + ' m';
      el.classList.toggle('near', it.dist < 40);
      el.classList.toggle('far', it.dist > settings.radius * 0.66);
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
    }
    for (const el of existing.values()) el.remove();
  }

  function updateStatus() {
    if (!state.pos) return;
    const acc = Math.round(state.pos.acc);
    let s = `GPS ±${acc} m`;
    if (state.fetching) s += ' · henter adresser …';
    else if (state.fetchedAt && state.addresses.length === 0) s += ' · ingen adresser i nærheten';
    else if (state.fetchedAt) s += ` · ${state.visible.length} av ${state.addresses.length} adresser i bildet`;
    if (acc > 30) s += ' · svak GPS, gå gjerne ut i åpent lende';
    if (state.frozen) s = '❄︎ Frosset · ' + s;
    setStatus(s);
  }

  function setStatus(s) { $('status').textContent = s; }

  // ---------- Frys / liste / detaljer ----------
  $('freezeBtn').addEventListener('click', () => {
    state.frozen = !state.frozen;
    const btn = $('freezeBtn');
    btn.classList.toggle('frozen', state.frozen);
    btn.textContent = state.frozen ? '▶' : '❚❚';
    if (state.frozen) video.pause(); else video.play().catch(() => {});
  });

  $('listBtn').addEventListener('click', () => {
    const ol = $('addrList');
    ol.innerHTML = '';
    const items = [...state.visible].sort((x, y) => x.diff - y.diff);
    if (!items.length) {
      ol.innerHTML = '<li>Ingen adresser i bildet akkurat nå.</li>';
    }
    for (const it of items) {
      const li = document.createElement('li');
      const side = Math.abs(it.diff) < 4 ? 'rett frem' : (it.diff < 0 ? 'til venstre' : 'til høyre');
      li.innerHTML = `<b></b><br><small></small>`;
      li.querySelector('b').textContent = it.a.title;
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
    if (a.raw && a.raw.kommunenavn) {
      add('Kommune', a.raw.kommunenavn);
      add('Gårds- / bruksnummer', `${a.raw.gardsnummer}/${a.raw.bruksnummer}` +
        (a.raw.festenummer ? `/${a.raw.festenummer}` : ''));
      if (a.raw.adressetilleggsnavn) add('Navn', a.raw.adressetilleggsnavn);
    }
    const links = document.createElement('div');
    const q = encodeURIComponent(`${a.title}${a.sub ? ', ' + a.sub : ''}`);
    links.innerHTML =
      `<a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${a.lat},${a.lon}">Vis i kart</a>` +
      `<a target="_blank" rel="noopener" href="https://www.google.com/search?q=${q}">Søk på adressen</a>`;
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
    openPanel('detailPanel');
  }

  function openPanel(id) {
    for (const p of ['listPanel', 'detailPanel', 'settingsPanel']) $(p).hidden = p !== id;
  }
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => { $(b.dataset.close).hidden = true; }));

  // ---------- Innstillinger-UI ----------
  function initSettingsUI() {
    const bind = (id, key, fmt = (v) => v) => {
      const input = $(id), out = $(id + 'Val');
      input.value = settings[key];
      out.textContent = fmt(settings[key]);
      input.addEventListener('input', () => {
        settings[key] = Number(input.value);
        out.textContent = fmt(settings[key]);
        saveSettings();
        if (key === 'radius') maybeFetch();
      });
    };
    bind('radius', 'radius');
    bind('fov', 'fov');
    bind('offset', 'offset', (v) => (v > 0 ? '+' : '') + v);
    const hb = $('hideBehind');
    hb.checked = settings.hideBehind;
    hb.addEventListener('change', () => { settings.hideBehind = hb.checked; saveSettings(); });
    $('settingsBtn').addEventListener('click', () => {
      $('settingsPanel').hidden ? openPanel('settingsPanel') : ($('settingsPanel').hidden = true);
    });
  }

  // ---------- Matte ----------
  function norm360(a) { return ((a % 360) + 360) % 360; }
  function angleDiff(a, b) { return ((a - b + 540) % 360) - 180; }   // -180..180
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
  function compassName(h) {
    return ['N', 'NØ', 'Ø', 'SØ', 'S', 'SV', 'V', 'NV'][Math.round(h / 45) % 8];
  }

  // ---------- Offline / installering ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
