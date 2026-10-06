/* Literary Atlas — application. Depends on d3 v7, topojson-client and js/data.js. */
(function () {
  "use strict";

  const D = window.ATLAS_DATA;
  const $ = (s) => document.querySelector(s);
  const canvasEl = $("#canvas");
  const detailEl = $("#detail");
  const tooltipEl = $("#tooltip");

  if (!window.d3) {
    canvasEl.innerHTML = '<p style="padding:24px">Could not load the D3 library. Check your network connection and reload.</p>';
    return;
  }

  // ------------------------------------------------------------------ indexes
  const bookById = new Map(D.books.map((b) => [b.id, b]));
  const conceptById = new Map(D.concepts.map((c) => [c.id, c]));
  const valueById = new Map(D.values.map((v) => [v.id, v]));
  const regionById = new Map(D.regions.map((r) => [r.id, r]));
  const regionIndex = new Map(D.regions.map((r, i) => [r.id, i]));
  const journeyById = new Map(D.journeys.map((j) => [j.id, j]));

  const adjacency = new Map(D.books.map((b) => [b.id, []]));
  for (const l of D.links) {
    adjacency.get(l.source).push({ link: l, other: l.target, dir: "out" });
    adjacency.get(l.target).push({ link: l, other: l.source, dir: "in" });
  }
  const degree = (id) => adjacency.get(id).length;

  const YEAR_MIN = -1300;
  const YEAR_MAX = 2030;

  const fmtYear = (y, approx) => (approx ? "c. " : "") + (y < 0 ? `${-y} BCE` : `${y}`);
  const yearOf = (b) => fmtYear(b.year, b.approx);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return ((h >>> 0) % 10000) / 10000;
  }

  // Kindred works: strongest shared-concept overlap, excluding explicit links.
  const kindredCache = new Map();
  function kindred(id, n = 6) {
    if (kindredCache.has(id)) return kindredCache.get(id);
    const b = bookById.get(id);
    const linked = new Set(adjacency.get(id).map((a) => a.other));
    const out = [];
    for (const o of D.books) {
      if (o.id === id || linked.has(o.id)) continue;
      const sc = o.concepts.filter((c) => b.concepts.includes(c));
      if (sc.length < 2) continue;
      const sv = o.values.filter((v) => b.values.includes(v));
      const score = sc.length + 0.5 * sv.length + (o.region !== b.region ? 0.25 : 0);
      out.push({ book: o, concepts: sc, values: sv, score });
    }
    out.sort((a, c) => c.score - a.score || a.book.year - c.book.year);
    const res = out.slice(0, n);
    kindredCache.set(id, res);
    return res;
  }

  // Values compass target position for each book (mean of its value anchors).
  for (const b of D.books) {
    const vs = b.values.map((v) => valueById.get(v));
    b.vx = d3.mean(vs, (v) => v.x) + (hash(b.id) - 0.5) * 0.08;
    b.vy = d3.mean(vs, (v) => v.y) + (hash(b.id + "y") - 0.5) * 0.08;
  }

  // Spread works that share a city so they don't stack on the map.
  {
    const groups = d3.group(D.books, (b) => `${b.lat},${b.lon}`);
    for (const g of groups.values()) {
      if (g.length < 2) { g[0].mlat = g[0].lat; g[0].mlon = g[0].lon; continue; }
      g.sort((a, b) => a.year - b.year);
      g.forEach((b, i) => {
        const r = 0.55 * Math.sqrt(i + 0.6);
        const a = i * 2.39996;
        b.mlat = b.lat + r * Math.sin(a);
        b.mlon = b.lon + (r * Math.cos(a)) / Math.cos((b.lat * Math.PI) / 180);
      });
    }
  }

  // ------------------------------------------------------------------ state
  const state = {
    view: "map",
    selected: null,
    focus: null, // {kind:'concept'|'value'|'region'|'cell', id, region?, axis?}
    journey: null,
    regions: new Set(D.regions.map((r) => r.id)),
    eraMin: YEAR_MIN,
    eraMax: YEAR_MAX,
    showLinks: true,
    hubMode: "concepts",
    matrixRows: "concepts",
    matrixNorm: "share",
  };

  const isVisible = (b) =>
    (state.regions.has(b.region) && b.year >= state.eraMin && b.year <= state.eraMax) || b.id === state.selected;
  const visibleBooks = () => D.books.filter(isVisible);

  function matchesFocus(b, f = state.focus) {
    if (!f) return false;
    if (f.kind === "concept") return b.concepts.includes(f.id);
    if (f.kind === "value") return b.values.includes(f.id);
    if (f.kind === "region") return b.region === f.id;
    if (f.kind === "cell") return b.region === f.region && (f.axis === "values" ? b.values : b.concepts).includes(f.id);
    return false;
  }

  // What should light up right now?
  function computeHighlight() {
    const H = { nodes: null, links: new Set(), shared: [], labels: new Set(), journey: null };
    const j = state.journey && journeyById.get(state.journey);
    if (j) H.journey = j.steps;
    if (state.selected) {
      const id = state.selected;
      H.nodes = new Set([id]);
      for (const a of adjacency.get(id)) { H.nodes.add(a.other); H.links.add(a.link); }
      for (const k of kindred(id, 5)) { H.nodes.add(k.book.id); H.shared.push({ s: id, t: k.book.id }); }
      H.labels = new Set(H.nodes);
    } else if (j) {
      H.nodes = new Set(j.steps);
      for (const l of D.links) if (H.nodes.has(l.source) && H.nodes.has(l.target)) H.links.add(l);
      H.labels = new Set(j.steps);
    } else if (state.focus) {
      H.nodes = new Set(D.books.filter((b) => matchesFocus(b)).map((b) => b.id));
      for (const l of D.links) if (H.nodes.has(l.source) && H.nodes.has(l.target)) H.links.add(l);
      if (H.nodes.size <= 24) H.labels = new Set(H.nodes);
    }
    return H;
  }

  // ------------------------------------------------------------------ colours
  let palette = {};
  function refreshPalette() {
    const cs = getComputedStyle(document.documentElement);
    palette = {
      regions: D.regions.map((_, i) => cs.getPropertyValue(`--r${i + 1}`).trim()),
      surface: cs.getPropertyValue("--surface-1").trim(),
      surface2: cs.getPropertyValue("--surface-2").trim(),
      ink: cs.getPropertyValue("--ink").trim(),
      seq: cs.getPropertyValue("--r1").trim(),
      dark: document.documentElement.dataset.theme === "dark" ||
        (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches),
    };
  }
  const regionColor = (id) => palette.regions[regionIndex.get(id)];

  // ------------------------------------------------------------------ tooltip
  function showTip(event, html) {
    tooltipEl.innerHTML = html;
    tooltipEl.hidden = false;
    moveTip(event);
  }
  function moveTip(event) {
    const pad = 14;
    const w = tooltipEl.offsetWidth, h = tooltipEl.offsetHeight;
    let x = event.clientX + pad, y = event.clientY + pad;
    if (x + w > innerWidth - 8) x = event.clientX - w - pad;
    if (y + h > innerHeight - 8) y = event.clientY - h - pad;
    tooltipEl.style.left = x + "px";
    tooltipEl.style.top = y + "px";
  }
  const hideTip = () => { tooltipEl.hidden = true; };
  const bookTip = (b) =>
    `<strong>${esc(b.title)}</strong><div class="tm">${esc(b.author)} · ${yearOf(b)} · ${esc(b.place)}</div>` +
    `<div class="tc">${b.concepts.map((c) => esc(conceptById.get(c).name)).join(" · ")}</div>`;

  // ------------------------------------------------------------------ geometry
  function arc(p, q, bend) {
    if (!p || !q) return null;
    const [x1, y1] = p, [x2, y2] = q;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1;
    const cx = mx - dy * bend, cy = my + dx * bend;
    return `M${x1},${y1}Q${cx},${cy} ${x2},${y2}`;
  }

  // Shared overlay: links, shared-concept edges, journey trail, nodes, labels.
  function buildOverlay(parent, books, opts = {}) {
    const g = parent.append("g").attr("class", "overlay");
    const o = {
      g, books, ids: new Set(books.map((b) => b.id)), bend: opts.bend ?? 0.2, P: opts.P,
      gl: g.append("g"), gs: g.append("g"), gj: g.append("g"), gn: g.append("g"), gt: g.append("g"),
    };
    const lk = state.showLinks ? D.links.filter((l) => o.ids.has(l.source) && o.ids.has(l.target)) : [];
    o.linkSel = o.gl.selectAll("path").data(lk).join("path").attr("class", (l) => "link " + l.type);
    o.nodeSel = o.gn
      .selectAll("circle")
      .data(books, (b) => b.id)
      .join("circle")
      .attr("class", "node")
      .attr("r", (b) => (opts.radius ? opts.radius(b) : 3.6 + Math.min(degree(b.id), 6) * 0.45))
      .attr("fill", (b) => regionColor(b.region))
      .attr("tabindex", 0)
      .attr("role", "button")
      .attr("aria-label", (b) => `${b.title} by ${b.author}`)
      .on("mouseenter", (e, b) => showTip(e, bookTip(b)))
      .on("mousemove", moveTip)
      .on("mouseleave", hideTip)
      .on("click", (e, b) => { e.stopPropagation(); hideTip(); selectBook(b.id); })
      .on("keydown", (e, b) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectBook(b.id); } });
    return o;
  }

  function highlightOverlay(o) {
    const H = computeHighlight();
    o.H = H;
    const on = (id) => !H.nodes || H.nodes.has(id);
    o.nodeSel
      .classed("dim", (b) => !on(b.id))
      .classed("hl", (b) => !!H.nodes && H.nodes.has(b.id) && b.id !== state.selected)
      .classed("sel", (b) => b.id === state.selected);
    o.nodeSel.filter((b) => H.nodes && H.nodes.has(b.id)).raise();
    o.nodeSel.filter((b) => b.id === state.selected).raise();
    o.linkSel
      .classed("dim", (l) => !!H.nodes && !H.links.has(l))
      .classed("hl", (l) => H.links.has(l));
    o.sharedData = state.showLinks ? H.shared.filter((e) => o.ids.has(e.s) && o.ids.has(e.t)) : [];
    o.sharedSel = o.gs.selectAll("path").data(o.sharedData).join("path").attr("class", "link shared hl");
    const steps = H.journey ? H.journey.filter((id) => o.ids.has(id)) : [];
    o.jSteps = steps;
    o.jPath = o.gj.selectAll("path").data(d3.pairs(steps)).join("path").attr("class", "journey-path");
    o.jBadge = o.gj.selectAll("g.badge").data(steps).join((en) => {
      const g = en.append("g").attr("class", "badge");
      g.append("circle").attr("class", "journey-badge").attr("r", 8);
      g.append("text").attr("class", "journey-num");
      return g;
    });
    o.jBadge.select("text").text((d) => H.journey.indexOf(d) + 1);
    const labelBooks = o.books.filter((b) => H.labels.has(b.id));
    o.labelSel = o.gt
      .selectAll("text")
      .data(labelBooks, (b) => b.id)
      .join("text")
      .attr("class", (b) => "label" + (b.id === state.selected ? "" : " muted"))
      .text((b) => b.title);
    placeOverlay(o);
  }

  function placeOverlay(o) {
    const P = o.P;
    o.nodeSel.attr("cx", (b) => P(b.id)[0]).attr("cy", (b) => P(b.id)[1]);
    o.linkSel.attr("d", (l) => arc(P(l.source), P(l.target), o.bend));
    if (o.sharedSel) o.sharedSel.attr("d", (e) => arc(P(e.s), P(e.t), -o.bend * 0.6));
    if (o.jPath) {
      o.jPath.attr("d", ([a, b]) => arc(P(a), P(b), 0.15));
      o.jBadge.attr("transform", (id) => {
        const [x, y] = P(id);
        return `translate(${x + 9},${y - 9})`;
      });
    }
    if (o.labelSel) {
      o.labelSel.attr("x", (b) => P(b.id)[0] + 9).attr("y", (b) => P(b.id)[1] + 4);
    }
  }

  // ------------------------------------------------------------------ views
  let current = null; // {update(), destroy?()}
  let world = null;
  let worldRequested = false;

  function loadWorld() {
    if (worldRequested || !window.topojson) return;
    worldRequested = true;
    fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json")
      .then((r) => r.json())
      .then((w) => {
        world = {
          land: topojson.feature(w, w.objects.land),
          borders: topojson.mesh(w, w.objects.countries, (a, b) => a !== b),
        };
        if (state.view === "map") mount();
      })
      .catch(() => { /* map still works without coastlines */ });
  }

  const views = {};

  views.map = {
    caption: ["World Map", "Each dot is a work, placed where it is rooted. Arcs trace influence, response and kinship across the world — select a work to light up its web. Scroll to zoom, drag to pan."],
    mount(el) {
      loadWorld();
      const W = el.clientWidth, H = el.clientHeight;
      const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
      const projection = d3.geoNaturalEarth1().fitExtent([[12, 12], [W - 12, H - 12]], { type: "Sphere" });
      const path = d3.geoPath(projection);
      const base = svg.append("g");
      base.append("path").attr("class", "sphere").attr("d", path({ type: "Sphere" }));
      base.append("path").attr("class", "graticule").attr("d", path(d3.geoGraticule10()));
      if (world) {
        base.append("path").attr("class", "land").attr("d", path(world.land));
        base.append("path").attr("class", "graticule").attr("d", path(world.borders));
      }
      base.selectAll("path").attr("vector-effect", "non-scaling-stroke");

      const books = visibleBooks();
      const pos = new Map(books.map((b) => [b.id, projection([b.mlon, b.mlat])]));
      let t = views.map.transform || d3.zoomIdentity;
      const o = buildOverlay(svg, books, { P: (id) => t.apply(pos.get(id)), bend: 0.25 });

      const zoom = d3.zoom().scaleExtent([1, 14]).translateExtent([[0, 0], [W, H]]).on("zoom", (e) => {
        t = e.transform;
        views.map.transform = t;
        base.attr("transform", t);
        placeOverlay(o);
      });
      svg.call(zoom).call(zoom.transform, t);
      svg.on("click", () => { if (state.selected) selectBook(null); });

      const tools = d3.select(el).append("div").attr("class", "canvas-tools");
      tools.append("button").text("+").attr("aria-label", "Zoom in").on("click", () => svg.transition().call(zoom.scaleBy, 1.6));
      tools.append("button").text("−").attr("aria-label", "Zoom out").on("click", () => svg.transition().call(zoom.scaleBy, 1 / 1.6));
      tools.append("button").text("Reset").on("click", () => svg.transition().call(zoom.transform, d3.zoomIdentity));

      return {
        update() { highlightOverlay(o); },
        focusBook(id) {
          const p = pos.get(id);
          if (!p || t.k > 1.5) return;
          svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(2).translate(-p[0], -p[1]));
        },
      };
    },
  };

  const netCache = { concepts: new Map(), values: new Map() };
  views.network = {
    caption: ["Constellation", "Works orbit the ideas they share. Hubs are concepts (or values); works pulled between several hubs sit where those ideas meet. Click a hub to light up its works."],
    mount(el) {
      const W = el.clientWidth, H = el.clientHeight;
      const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
      const mode = state.hubMode;
      const cache = netCache[mode];
      const books = visibleBooks();
      const key = mode === "concepts" ? "concepts" : "values";
      const list = mode === "concepts" ? D.concepts : D.values;
      const hubs = list
        .map((c) => ({ id: "h:" + c.id, key: c.id, name: c.name, count: books.filter((b) => b[key].includes(c.id)).length, hub: true }))
        .filter((h) => h.count > 0);
      const hubById = new Map(hubs.map((h) => [h.key, h]));
      const bnodes = books.map((b) => ({ id: b.id, book: b }));
      const nodes = [...hubs, ...bnodes];
      for (const n of nodes) {
        const c = cache.get(n.id);
        if (c) { n.x = c[0]; n.y = c[1]; }
        else { const a = hash(n.id) * Math.PI * 2, r = 50 + hash(n.id + "r") * Math.min(W, H) * 0.35; n.x = W / 2 + Math.cos(a) * r; n.y = H / 2 + Math.sin(a) * r; }
      }
      const nodeById = new Map(nodes.map((n) => [n.id, n]));
      const spokes = [];
      for (const b of books) for (const k of b[key]) if (hubById.has(k)) spokes.push({ source: b.id, target: "h:" + k, key: k });
      const blinks = D.links.filter((l) => nodeById.has(l.source) && nodeById.has(l.target)).map((l) => ({ source: l.source, target: l.target }));
      const hubR = (h) => 10 + Math.sqrt(h.count) * 3.2;

      let t = d3.zoomIdentity;
      const gSpokes = svg.append("g");
      const gHubs = svg.append("g");
      const spokeSel = gSpokes.selectAll("line").data(spokes).join("line").attr("class", "spoke");
      const hubSel = gHubs.selectAll("g").data(hubs).join("g")
        .attr("class", "hub" + (mode === "values" ? " value" : ""))
        .attr("tabindex", 0).attr("role", "button")
        .on("click", (e, h) => { e.stopPropagation(); setFocus({ kind: mode === "concepts" ? "concept" : "value", id: h.key }); })
        .on("keydown", (e, h) => { if (e.key === "Enter") setFocus({ kind: mode === "concepts" ? "concept" : "value", id: h.key }); })
        .on("mouseenter", (e, h) => showTip(e, `<strong>${esc(h.name)}</strong><div class="tm">${h.count} works</div><div class="tc">${esc((mode === "concepts" ? conceptById : valueById).get(h.key).desc)}</div>`))
        .on("mousemove", moveTip).on("mouseleave", hideTip);
      hubSel.append("circle").attr("r", hubR);
      hubSel.append("text").attr("dy", (h) => hubR(h) + 14).text((h) => h.name);

      const o = buildOverlay(svg, books, {
        P: (id) => { const n = nodeById.get(id); return t.apply([n.x, n.y]); },
        bend: 0.15,
        radius: (b) => 3.4 + Math.min(degree(b.id), 6) * 0.35,
      });

      function place() {
        spokeSel
          .attr("x1", (s) => t.applyX(s.source.x)).attr("y1", (s) => t.applyY(s.source.y))
          .attr("x2", (s) => t.applyX(s.target.x)).attr("y2", (s) => t.applyY(s.target.y));
        hubSel.attr("transform", (h) => `translate(${t.applyX(h.x)},${t.applyY(h.y)})`);
        placeOverlay(o);
      }

      const sim = d3.forceSimulation(nodes)
        .force("spokes", d3.forceLink(spokes).id((d) => d.id).distance((s) => 34 + hubR(s.target)).strength((s) => 0.9 / s.source.book[key].length))
        .force("links", d3.forceLink(blinks).id((d) => d.id).distance(40).strength(0.08))
        .force("charge", d3.forceManyBody().strength((d) => (d.hub ? -520 : -38)))
        .force("collide", d3.forceCollide((d) => (d.hub ? hubR(d) + 6 : 7)))
        .force("x", d3.forceX(W / 2).strength(0.04))
        .force("y", d3.forceY(H / 2).strength(0.06))
        .alpha(cache.size ? 0.3 : 1)
        .on("tick", () => {
          for (const n of nodes) {
            n.x = Math.max(20, Math.min(W - 20, n.x));
            n.y = Math.max(20, Math.min(H - 20, n.y));
            cache.set(n.id, [n.x, n.y]);
          }
          place();
        });

      const drag = d3.drag()
        .on("start", (e, h) => { if (!e.active) sim.alphaTarget(0.2).restart(); h.fx = h.x; h.fy = h.y; })
        .on("drag", (e, h) => { h.fx = t.invertX(e.x); h.fy = t.invertY(e.y); })
        .on("end", (e, h) => { if (!e.active) sim.alphaTarget(0); h.fx = null; h.fy = null; });
      hubSel.call(drag);

      const zoom = d3.zoom().scaleExtent([0.5, 6]).on("zoom", (e) => { t = e.transform; place(); });
      svg.call(zoom).on("dblclick.zoom", null);
      svg.on("click", () => { if (state.selected) selectBook(null); });

      const tools = d3.select(el).append("div").attr("class", "canvas-tools");
      const seg = tools.append("div").attr("class", "seg");
      for (const [m, label] of [["concepts", "Concept hubs"], ["values", "Value hubs"]]) {
        seg.append("button").text(label).attr("aria-pressed", m === mode).on("click", () => { if (state.hubMode !== m) { state.hubMode = m; mount(); } });
      }

      return {
        update() {
          highlightOverlay(o);
          const H = o.H;
          const f = state.focus;
          const activeKey = f && ((f.kind === "concept" && mode === "concepts") || (f.kind === "value" && mode === "values") || (f.kind === "cell" && f.axis === mode)) ? f.id : null;
          const selBook = state.selected && bookById.get(state.selected);
          hubSel.classed("active", (h) => h.key === activeKey || (selBook && selBook[key].includes(h.key)));
          hubSel.classed("dim", (h) => (selBook && !selBook[key].includes(h.key)) || (activeKey && h.key !== activeKey && !selBook));
          spokeSel.classed("hl", (s) => (selBook && s.source.id === selBook.id) || (!selBook && activeKey === s.key && (!H.nodes || H.nodes.has(s.source.id))));
          place();
        },
        destroy() { sim.stop(); },
      };
    },
  };

  views.timeline = {
    caption: ["Timeline", "Four thousand years in parallel lanes, one per literary region. Time is compressed for antiquity and stretched for the modern era. Arcs show influence leaping across centuries and cultures."],
    mount(el) {
      el.classList.add("scroll-x");
      const H0 = el.clientHeight;
      const W = Math.max(el.clientWidth, 1500);
      const books = visibleBooks();
      const lanes = D.regions.filter((r) => books.some((b) => b.region === r.id));
      const margin = { l: 150, r: 30, t: 44, b: 34 };
      const breaks = [YEAR_MIN, 0, 1000, 1500, 1800, 1900, 1950, YEAR_MAX];
      const weights = [1.1, 0.9, 0.8, 1.1, 1.3, 1.4, 1.6];
      const total = d3.sum(weights);
      let acc = 0;
      const range = [margin.l];
      for (const w of weights) { acc += w; range.push(margin.l + ((W - margin.l - margin.r) * acc) / total); }
      const x = d3.scaleLinear().domain(breaks).range(range).clamp(true);

      // Beeswarm rows within each lane.
      const R = 5, gap = 2 * R + 3;
      const rowOf = new Map();
      const laneRows = new Map();
      for (const lane of lanes) {
        const lb = books.filter((b) => b.region === lane.id).sort((a, b) => a.year - b.year);
        const lastX = new Map();
        let maxAbs = 0;
        for (const b of lb) {
          const bx = x(b.year);
          for (let k = 0; ; k++) {
            const row = k === 0 ? 0 : k % 2 ? (k + 1) / 2 : -k / 2;
            if (!lastX.has(row) || bx - lastX.get(row) >= gap) {
              lastX.set(row, bx); rowOf.set(b.id, row); maxAbs = Math.max(maxAbs, Math.abs(row)); break;
            }
          }
        }
        laneRows.set(lane.id, maxAbs);
      }
      const laneH = (id) => Math.max(44, (laneRows.get(id) * 2 + 1) * gap + 16);
      const totalH = margin.t + margin.b + d3.sum(lanes, (l) => laneH(l.id));
      const Hh = Math.max(H0, totalH);
      const laneY = new Map();
      let yy = margin.t;
      for (const l of lanes) { laneY.set(l.id, yy + laneH(l.id) / 2); yy += laneH(l.id); }
      if (totalH > H0) el.style.overflowY = "auto";

      const svg = d3.select(el).append("svg").attr("width", W).attr("height", Hh);
      svg.on("click", () => { if (state.selected) selectBook(null); });

      const eras = [[YEAR_MIN, 500, "Antiquity"], [500, 1500, "Middle Ages"], [1500, 1800, "Early modern"], [1800, 1900, "19th century"], [1900, 2000, "20th century"], [2000, YEAR_MAX, "21st"]];
      const eraG = svg.append("g");
      eras.forEach(([a, b, name], i) => {
        if (i % 2) eraG.append("rect").attr("class", "lane-bg").attr("x", x(a)).attr("width", x(b) - x(a)).attr("y", margin.t - 26).attr("height", yy - margin.t + 26);
        eraG.append("text").attr("class", "quad-label").attr("x", (x(a) + x(b)) / 2).attr("y", margin.t - 10).attr("text-anchor", "middle").text(name);
      });
      const ticks = [-1200, -800, -400, 0, 500, 1000, 1250, 1500, 1600, 1700, 1800, 1850, 1900, 1925, 1950, 1975, 2000, 2020];
      const axis = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${yy + 4})`)
        .call(d3.axisBottom(x).tickValues(ticks).tickFormat((d) => fmtYear(d)).tickSizeOuter(0));
      axis.select(".domain").remove();
      const grid = svg.append("g").attr("class", "grid");
      grid.selectAll("line").data(ticks).join("line").attr("x1", x).attr("x2", x).attr("y1", margin.t).attr("y2", yy);

      for (const l of lanes) {
        svg.append("line").attr("x1", margin.l - 8).attr("x2", W - margin.r).attr("y1", laneY.get(l.id) + laneH(l.id) / 2).attr("y2", laneY.get(l.id) + laneH(l.id) / 2).attr("stroke", "var(--hair)");
        const lab = svg.append("g").attr("transform", `translate(14,${laneY.get(l.id)})`).style("cursor", "pointer")
          .on("click", (e) => { e.stopPropagation(); setFocus({ kind: "region", id: l.id }); });
        lab.append("circle").attr("r", 4.5).attr("cx", 4).attr("fill", regionColor(l.id));
        const words = l.name.split(" ");
        const lines = words.length > 2 ? [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")] : [l.name];
        lines.forEach((ln, i) => lab.append("text").attr("class", "lane-label").attr("x", 14).attr("y", 4 + (i - (lines.length - 1) / 2) * 13).text(ln));
      }

      const pos = new Map(books.map((b) => [b.id, [x(b.year), laneY.get(b.region) + rowOf.get(b.id) * gap]]));
      const o = buildOverlay(svg, books, { P: (id) => pos.get(id), bend: 0.12, radius: () => R });

      return {
        update() { highlightOverlay(o); },
        focusBook(id) {
          const p = pos.get(id);
          if (p) el.scrollTo({ left: Math.max(0, p[0] - el.clientWidth / 2), behavior: "smooth" });
        },
      };
    },
  };

  views.compass = {
    caption: ["Values Compass", "An interpretive lens: each work sits at the average of the values it carries — the self against the collective, continuity against change. Values are anchored in faint type; click one to see who holds it."],
    mount(el) {
      const W = el.clientWidth, H = el.clientHeight;
      const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
      svg.on("click", () => { if (state.selected) selectBook(null); });
      const m = { l: 40, r: 40, t: 34, b: 34 };
      const x = d3.scaleLinear().domain([-1.15, 1.15]).range([m.l, W - m.r]);
      const y = d3.scaleLinear().domain([-1.15, 1.15]).range([H - m.b, m.t]);
      const g = svg.append("g");
      g.append("line").attr("x1", x(-1.15)).attr("x2", x(1.15)).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", "var(--axis)");
      g.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", y(-1.15)).attr("y2", y(1.15)).attr("stroke", "var(--axis)");
      g.append("text").attr("class", "axis-title").attr("x", x(-1.12)).attr("y", y(0) - 8).text("← Self");
      g.append("text").attr("class", "axis-title").attr("x", x(1.12)).attr("y", y(0) - 8).attr("text-anchor", "end").text("Collective →");
      g.append("text").attr("class", "axis-title").attr("x", x(0) + 8).attr("y", y(1.1)).text("↑ Change & questioning");
      g.append("text").attr("class", "axis-title").attr("x", x(0) + 8).attr("y", y(-1.1) + 8).text("↓ Continuity & tradition");
      const quads = [[-1.12, 1.08, "start", "The questioning self"], [1.12, 1.08, "end", "Remaking the community"], [-1.12, -1.12, "start", "The contemplative self"], [1.12, -1.12, "end", "Keepers of order & heritage"]];
      for (const [qx, qy, anchor, t] of quads) g.append("text").attr("class", "quad-label").attr("x", x(qx)).attr("y", y(qy)).attr("text-anchor", anchor).text(t);

      const anchors = g.append("g").selectAll("text").data(D.values).join("text")
        .attr("class", "value-anchor").attr("x", (v) => x(v.x)).attr("y", (v) => y(v.y)).text((v) => v.name)
        .on("click", (e, v) => { e.stopPropagation(); setFocus({ kind: "value", id: v.id }); })
        .on("mouseenter", (e, v) => showTip(e, `<strong>${esc(v.name)}</strong><div class="tc">${esc(v.desc)}</div>`))
        .on("mousemove", moveTip).on("mouseleave", hideTip);

      const books = visibleBooks();
      const nodes = books.map((b) => ({ id: b.id, x: x(b.vx), y: y(b.vy), tx: x(b.vx), ty: y(b.vy) }));
      d3.forceSimulation(nodes)
        .force("x", d3.forceX((d) => d.tx).strength(0.3))
        .force("y", d3.forceY((d) => d.ty).strength(0.3))
        .force("c", d3.forceCollide(6.2))
        .stop()
        .tick(160);
      const pos = new Map(nodes.map((n) => [n.id, [n.x, n.y]]));
      const o = buildOverlay(svg, books, { P: (id) => pos.get(id), bend: 0.2, radius: () => 4.8 });

      return {
        update() {
          highlightOverlay(o);
          const f = state.focus;
          const sel = state.selected && bookById.get(state.selected);
          anchors.classed("active", (v) => (f && f.kind === "value" && f.id === v.id) || (sel && sel.values.includes(v.id)));
        },
      };
    },
  };

  views.matrix = {
    caption: ["Concepts × Cultures", "How strongly each idea runs through each literary region, as a share of that region's works in the atlas. Click a cell to see the works behind it."],
    mount(el) {
      el.style.overflowY = "auto";
      const books = visibleBooks();
      const axis = state.matrixRows;
      const rowsAll = axis === "concepts" ? D.concepts : D.values;
      const cols = D.regions.filter((r) => books.some((b) => b.region === r.id));
      const colTotals = new Map(cols.map((c) => [c.id, books.filter((b) => b.region === c.id).length]));
      const count = (rowId, regionId) => books.filter((b) => b.region === regionId && b[axis].includes(rowId)).length;
      const rows = rowsAll
        .map((r) => ({ ...r, total: books.filter((b) => b[axis].includes(r.id)).length }))
        .filter((r) => r.total > 0)
        .sort((a, b) => b.total - a.total);
      const cells = [];
      for (const r of rows) for (const c of cols) {
        const n = count(r.id, c.id);
        cells.push({ row: r, col: c, n, share: colTotals.get(c.id) ? n / colTotals.get(c.id) : 0 });
      }
      const W0 = el.clientWidth;
      const m = { l: 170, t: 150, r: 70, b: 20 };
      const cw = Math.max(54, Math.min(110, (W0 - m.l - m.r) / cols.length));
      const ch = 26;
      const W = m.l + cw * cols.length + m.r;
      const H = m.t + ch * rows.length + m.b;
      const svg = d3.select(el).append("svg").attr("width", Math.max(W, W0)).attr("height", H);

      const norm = state.matrixNorm;
      const valueOf = (c) => (norm === "share" ? c.share : c.n);
      const maxV = d3.max(cells, valueOf) || 1;
      const color = d3.scaleSequential(d3.interpolateRgb.gamma(1.4)(palette.surface2, palette.seq)).domain([0, maxV]);

      const colG = svg.append("g").selectAll("g").data(cols).join("g")
        .attr("transform", (c, i) => `translate(${m.l + i * cw + cw / 2},${m.t - 10}) rotate(-35)`)
        .style("cursor", "pointer")
        .on("click", (e, c) => setFocus({ kind: "region", id: c.id }));
      colG.append("circle").attr("r", 4).attr("cx", -8).attr("cy", -4).attr("fill", (c) => regionColor(c.id));
      colG.append("text").attr("class", "col-label").text((c) => (c.name.length > 22 ? c.name.replace(" & ", " & ").slice(0, 22) + "…" : c.name)).append("title").text((c) => `${c.name} — ${colTotals.get(c.id)} works`);

      const rowLabels = svg.append("g").selectAll("text").data(rows).join("text")
        .attr("class", "row-label").attr("x", m.l - 10).attr("y", (r, i) => m.t + i * ch + ch / 2).text((r) => r.name)
        .on("click", (e, r) => setFocus({ kind: axis === "concepts" ? "concept" : "value", id: r.id }));

      svg.append("g").selectAll("text").data(rows).join("text")
        .attr("class", "cell-text").attr("x", m.l + cols.length * cw + 22).attr("y", (r, i) => m.t + i * ch + ch / 2)
        .attr("fill", "var(--ink-3)").text((r) => r.total);
      svg.append("text").attr("class", "col-label").attr("x", m.l + cols.length * cw + 22).attr("y", m.t - 10).attr("text-anchor", "middle").text("All");

      const rowIdx = new Map(rows.map((r, i) => [r.id, i]));
      const colIdx = new Map(cols.map((c, i) => [c.id, i]));
      const cellG = svg.append("g").selectAll("g").data(cells).join("g")
        .attr("transform", (c) => `translate(${m.l + colIdx.get(c.col.id) * cw},${m.t + rowIdx.get(c.row.id) * ch})`);
      const rects = cellG.append("rect").attr("class", "cell").attr("width", cw).attr("height", ch).attr("rx", 3)
        .attr("fill", (c) => color(valueOf(c)))
        .on("mouseenter", (e, c) => showTip(e, `<strong>${esc(c.row.name)}</strong><div class="tm">${esc(c.col.name)}</div><div class="tc">${c.n} of ${colTotals.get(c.col.id)} works (${Math.round(c.share * 100)}%)</div>`))
        .on("mousemove", moveTip).on("mouseleave", hideTip)
        .on("click", (e, c) => { if (c.n) setFocus({ kind: "cell", id: c.row.id, region: c.col.id, axis }); });
      cellG.append("text").attr("class", "cell-text").attr("x", cw / 2).attr("y", ch / 2)
        .attr("fill", (c) => (valueOf(c) / maxV > 0.55 ? "#fff" : "var(--ink-2)"))
        .text((c) => (c.n ? (norm === "share" ? Math.round(c.share * 100) + "%" : c.n) : ""));

      const tools = d3.select(el).append("div").attr("class", "canvas-tools");
      const seg1 = tools.append("div").attr("class", "seg");
      for (const [k, label] of [["concepts", "Concepts"], ["values", "Values"]]) {
        seg1.append("button").text(label).attr("aria-pressed", k === axis).on("click", () => { state.matrixRows = k; updateCaption(); mount(); });
      }
      const seg2 = tools.append("div").attr("class", "seg");
      for (const [k, label] of [["share", "% of region"], ["count", "Count"]]) {
        seg2.append("button").text(label).attr("aria-pressed", k === norm).on("click", () => { state.matrixNorm = k; mount(); });
      }

      return {
        update() {
          const f = state.focus;
          rects.classed("sel", (c) => f && f.kind === "cell" && f.id === c.row.id && f.region === c.col.id);
          rowLabels.classed("active", (r) => f && ((f.kind === "concept" && axis === "concepts") || (f.kind === "value" && axis === "values") || f.kind === "cell") && f.id === r.id);
          const sel = state.selected && bookById.get(state.selected);
          rects.attr("opacity", (c) => {
            if (sel) return sel.region === c.col.id && sel[axis].includes(c.row.id) ? 1 : 0.35;
            if (f && f.kind === "region") return c.col.id === f.id ? 1 : 0.35;
            return 1;
          });
        },
      };
    },
  };

  // ------------------------------------------------------------------ mount / update
  function updateCaption() {
    let [title, text] = views[state.view].caption;
    if (state.view === "matrix" && state.matrixRows === "values") {
      title = "Values × Cultures";
      text = "How often each value is carried by works from each literary region, as a share of that region's works in the atlas. Click a cell to see the works behind it.";
    }
    $("#view-caption").innerHTML = `<h2>${esc(title)}</h2><p>${esc(text)}</p>`;
  }

  function mount() {
    if (current && current.destroy) current.destroy();
    hideTip();
    canvasEl.innerHTML = "";
    canvasEl.className = "canvas";
    canvasEl.style.overflowY = "";
    current = views[state.view].mount(canvasEl);
    updateCaption();
    update();
  }

  function update() {
    if (current) current.update();
    renderFocusBar();
    renderDetail();
    renderSidebarState();
    renderStatus();
    syncHash();
  }

  // ------------------------------------------------------------------ actions
  function selectBook(id, opts = {}) {
    state.selected = id;
    const b = id && bookById.get(id);
    if (b && !isVisibleIgnoringSelection(b)) {
      // a filtered-out work was chosen: make sure it appears
      mount();
    } else {
      update();
    }
    if (id && current && current.focusBook) current.focusBook(id);
    if (id && window.matchMedia("(max-width: 900px)").matches && opts.scroll !== false) detailEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const isVisibleIgnoringSelection = (b) => state.regions.has(b.region) && b.year >= state.eraMin && b.year <= state.eraMax;

  function setFocus(f) {
    const same = state.focus && f && state.focus.kind === f.kind && state.focus.id === f.id && state.focus.region === f.region;
    state.focus = same ? null : f;
    state.selected = null;
    state.journey = null;
    update();
  }

  function setJourney(id) {
    state.journey = state.journey === id ? null : id;
    state.selected = null;
    state.focus = null;
    update();
  }

  function setView(v) {
    if (!views[v]) return;
    state.view = v;
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === v));
    mount();
    const target = state.selected || (state.journey && journeyById.get(state.journey).steps[0]);
    if (target && current.focusBook) current.focusBook(target);
  }

  // ------------------------------------------------------------------ detail panel
  function chip(kind, id, active) {
    const item = kind === "concept" ? conceptById.get(id) : valueById.get(id);
    return `<button class="chip ${kind === "value" ? "value" : ""} ${active ? "active" : ""}" data-focus="${kind}:${id}" title="${esc(item.desc)}">${esc(item.name)}</button>`;
  }
  const dot = (regionId) => `<i style="background:${regionColor(regionId)}"></i>`;
  function bookItem(b, note) {
    return `<li data-book="${b.id}">${dot(b.region)}<div><div class="ct">${esc(b.title)}</div><div class="cm">${esc(b.author)} · ${yearOf(b)} · ${esc(b.place)}</div>${note ? `<div class="cn">${note}</div>` : ""}</div></li>`;
  }

  function renderDetail() {
    let html = "";
    const j = state.journey && journeyById.get(state.journey);
    if (state.selected) {
      const b = bookById.get(state.selected);
      if (j) html += journeyStepper(j, b.id);
      else if (state.focus) html += `<button class="link-btn" data-action="unselect">← Back to ${esc(focusLabel(state.focus))}</button>`;
      html += bookDetail(b);
    } else if (j) {
      html += journeyDetail(j);
    } else if (state.focus) {
      html += focusDetail(state.focus);
    } else {
      html += introDetail();
    }
    detailEl.innerHTML = html;
  }

  function bookDetail(b) {
    const r = regionById.get(b.region);
    const groups = { influencedBy: [], influenced: [], answers: [], answeredBy: [], kin: [] };
    for (const a of adjacency.get(b.id)) {
      const o = bookById.get(a.other);
      if (a.link.type === "influence") (a.dir === "in" ? groups.influencedBy : groups.influenced).push([o, a.link]);
      else if (a.link.type === "response") (a.dir === "in" ? groups.answers : groups.answeredBy).push([o, a.link]);
      else groups.kin.push([o, a.link]);
    }
    const sec = (title, kind, list) =>
      list.length
        ? `<h3><span class="conn-kind ${kind}">${title}</span></h3><ul class="conn-list">${list.sort((x, y) => x[0].year - y[0].year).map(([o, l]) => bookItem(o, esc(l.note))).join("")}</ul>`
        : "";
    const kin = kindred(b.id);
    return `
      <div class="eyebrow">${dot(b.region)} ${esc(r.name)}</div>
      <h2 class="title">${esc(b.title)}</h2>
      <div class="byline">${esc(b.author)}</div>
      <div class="meta">${yearOf(b)} · ${esc(b.place)} · ${esc(b.lang)}</div>
      <p class="summary">${esc(b.summary)}</p>
      <h3>Concepts</h3><div class="chip-cloud">${b.concepts.map((c) => chip("concept", c)).join("")}</div>
      <h3>Values</h3><div class="chip-cloud">${b.values.map((v) => chip("value", v)).join("")}</div>
      ${sec("Shaped by", "influence", groups.influencedBy)}
      ${sec("Went on to shape", "influence", groups.influenced)}
      ${sec("Answers / rewrites", "response", groups.answers)}
      ${sec("Answered by", "response", groups.answeredBy)}
      ${sec("Kindred works", "kinship", groups.kin)}
      ${kin.length ? `<h3>Shares ideas with</h3><ul class="conn-list">${kin.map((k) => bookItem(k.book, "Shared: " + k.concepts.map((c) => esc(conceptById.get(c).name)).join(", "))).join("")}</ul>` : ""}
    `;
  }

  function focusLabel(f) {
    if (f.kind === "concept") return conceptById.get(f.id).name;
    if (f.kind === "value") return valueById.get(f.id).name;
    if (f.kind === "region") return regionById.get(f.id).name;
    if (f.kind === "cell") return `${(f.axis === "values" ? valueById : conceptById).get(f.id).name} in ${regionById.get(f.region).name}`;
    return "";
  }

  function bars(entries, colorFn, action) {
    const max = d3.max(entries, (e) => e.n) || 1;
    return `<div class="bars">${entries.map((e) => `
      <div class="bar-row" data-focus="${action}:${e.id}"><span>${esc(e.name)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(e.n / max) * 100}%;background:${colorFn(e)}"></div></div>
        <span class="n">${e.n}</span></div>`).join("")}</div>`;
  }

  function focusDetail(f) {
    const works = D.books.filter((b) => matchesFocus(b, f)).sort((a, b) => a.year - b.year);
    let head = "", body = "";
    if (f.kind === "concept" || f.kind === "value") {
      const item = (f.kind === "concept" ? conceptById : valueById).get(f.id);
      head = `<div class="eyebrow">${f.kind === "concept" ? "Concept" : "Value"}</div><h2 class="title">${esc(item.name)}</h2><p class="summary">${esc(item.desc)}</p>`;
      const byRegion = D.regions.map((r) => ({ id: r.id, name: r.name, n: works.filter((b) => b.region === r.id).length })).filter((e) => e.n);
      body += `<h3>Across cultures</h3>` + bars(byRegion, (e) => regionColor(e.id), "region");
      const co = new Map();
      for (const b of works) for (const c of b.concepts) if (c !== f.id) co.set(c, (co.get(c) || 0) + 1);
      const top = [...co].sort((a, b) => b[1] - a[1]).slice(0, 8);
      body += `<h3>${f.kind === "concept" ? "Travels with" : "Concepts it gathers"}</h3><div class="chip-cloud">${top.map(([c, n]) => chip("concept", c).replace("</button>", ` <span class="n">${n}</span></button>`)).join("")}</div>`;
      if (f.kind === "concept") {
        const vals = new Map();
        for (const b of works) for (const v of b.values) vals.set(v, (vals.get(v) || 0) + 1);
        const topV = [...vals].sort((a, b) => b[1] - a[1]).slice(0, 6);
        body += `<h3>Values it carries</h3><div class="chip-cloud">${topV.map(([v, n]) => chip("value", v).replace("</button>", ` <span class="n">${n}</span></button>`)).join("")}</div>`;
      }
    } else if (f.kind === "region") {
      const r = regionById.get(f.id);
      head = `<div class="eyebrow">${dot(r.id)} Literary region</div><h2 class="title">${esc(r.name)}</h2><p class="summary">${esc(r.note)}.</p>`;
      const cc = D.concepts.map((c) => ({ id: c.id, name: c.name, n: works.filter((b) => b.concepts.includes(c.id)).length })).filter((e) => e.n).sort((a, b) => b.n - a.n).slice(0, 8);
      body += `<h3>Leading concepts</h3>` + bars(cc, () => regionColor(r.id), "concept");
      const vv = D.values.map((v) => ({ id: v.id, name: v.name, n: works.filter((b) => b.values.includes(v.id)).length })).filter((e) => e.n).sort((a, b) => b.n - a.n).slice(0, 6);
      body += `<h3>Leading values</h3>` + bars(vv, () => regionColor(r.id), "value");
      const ext = new Map();
      for (const b of works) for (const a of adjacency.get(b.id)) {
        const o = bookById.get(a.other);
        if (o.region !== r.id) ext.set(o.region, (ext.get(o.region) || 0) + 1);
      }
      const extE = [...ext].map(([id, n]) => ({ id, name: regionById.get(id).name, n })).sort((a, b) => b.n - a.n);
      if (extE.length) body += `<h3>Connected cultures</h3>` + bars(extE, (e) => regionColor(e.id), "region");
    } else if (f.kind === "cell") {
      const item = (f.axis === "values" ? valueById : conceptById).get(f.id);
      const r = regionById.get(f.region);
      head = `<div class="eyebrow">${dot(r.id)} ${esc(r.name)}</div><h2 class="title">${esc(item.name)}</h2><p class="summary">${esc(item.desc)}</p>`;
    }
    body += `<h3>${works.length} works</h3><ul class="conn-list">${works.map((b) => bookItem(b)).join("")}</ul>`;
    return `<button class="close-btn" data-action="clear-focus" aria-label="Clear">×</button>` + head + body;
  }

  function journeyStepper(j, currentId) {
    const i = j.steps.indexOf(currentId);
    return `<div class="eyebrow">Journey · ${esc(j.name)}</div>
      <div class="step-nav">
        <button data-action="step" data-step="${i - 1}" ${i <= 0 ? "disabled" : ""}>← Prev</button>
        <button data-action="step" data-step="${i + 1}" ${i < 0 || i >= j.steps.length - 1 ? "disabled" : ""}>Next →</button>
        <span>${i >= 0 ? `Stop ${i + 1} of ${j.steps.length}` : "Off the trail"}</span>
        <button class="link-btn" data-action="journey-overview" style="margin-left:auto">Overview</button>
      </div>
      <hr style="border:0;border-top:1px solid var(--hair);margin:14px 0 12px">`;
  }

  function journeyDetail(j) {
    return `<button class="close-btn" data-action="clear-journey" aria-label="Close journey">×</button>
      <div class="eyebrow">Journey</div>
      <h2 class="title">${esc(j.name)}</h2>
      <p class="summary">${esc(j.desc)}</p>
      <div class="step-nav"><button data-action="step" data-step="0">Begin →</button><span>${j.steps.length} stops</span></div>
      <h3>Stops</h3>
      <ol class="ol-steps">${j.steps.map((id) => { const b = bookById.get(id); return `<li data-book="${id}"><div><div class="ct">${esc(b.title)}</div><div class="cm">${esc(b.author)} · ${yearOf(b)} · ${esc(b.place)}</div></div></li>`; }).join("")}</ol>`;
  }

  function introDetail() {
    const cross = D.links.filter((l) => bookById.get(l.source).region !== bookById.get(l.target).region).length;
    const langs = new Set(D.books.map((b) => b.lang)).size;
    const pick = D.books[Math.floor(Math.random() * D.books.length)];
    return `<div class="empty-state">
      <h2>An atlas of the world's books</h2>
      <p>${D.books.length} works from every inhabited continent, spanning four thousand years and ${langs} languages — mapped by place, time, the ideas they explore and the values their cultures hold.</p>
      <div class="stat-row">
        <div><strong>${D.links.length}</strong><span>documented links</span></div>
        <div><strong>${cross}</strong><span>cross-cultural</span></div>
        <div><strong>${D.concepts.length}</strong><span>concepts</span></div>
      </div>
      <p><strong>Ways in</strong></p>
      <ul>
        <li>Click any dot to see what shaped a work, what it shaped, and its kindred spirits.</li>
        <li>Pick a <em>concept</em> or <em>value</em> on the left to light up every work that carries it.</li>
        <li>Follow a <em>journey</em> — a curated trail of connected books.</li>
        <li>Switch views: the same selection follows you from map to timeline to compass.</li>
      </ul>
      <p>Start with <a href="#" data-book="${pick.id}">${esc(pick.title)}</a>, or the journey <a href="#" data-journey="empire">Writing Back to Empire</a>.</p>
    </div>`;
  }

  function renderFocusBar() {
    const bar = $("#focus-bar");
    const parts = [];
    if (state.focus) parts.push(`Lens: <strong>${esc(focusLabel(state.focus))}</strong> <button data-action="clear-focus" aria-label="Clear lens">×</button>`);
    if (state.journey) parts.push(`Journey: <strong>${esc(journeyById.get(state.journey).name)}</strong> <button data-action="clear-journey" aria-label="End journey">×</button>`);
    if (state.selected) parts.push(`Selected: <strong>${esc(bookById.get(state.selected).title)}</strong> <button data-action="unselect" aria-label="Clear selection">×</button>`);
    bar.hidden = !parts.length;
    bar.innerHTML = parts.join('<span style="color:var(--ink-3)">·</span>');
  }

  function renderStatus() {
    const vis = D.books.filter(isVisibleIgnoringSelection);
    const ids = new Set(vis.map((b) => b.id));
    const nl = D.links.filter((l) => ids.has(l.source) && ids.has(l.target)).length;
    $("#status").textContent = `${vis.length} of ${D.books.length} works · ${nl} links shown`;
  }

  // ------------------------------------------------------------------ sidebar
  function buildSidebar() {
    $("#journey-list").innerHTML = D.journeys
      .map((j) => `<button class="journey-btn" data-journey="${j.id}"><strong>${esc(j.name)}</strong><span>${j.steps.length} stops</span></button>`)
      .join("");
    const cCount = (id) => D.books.filter((b) => b.concepts.includes(id)).length;
    const vCount = (id) => D.books.filter((b) => b.values.includes(id)).length;
    $("#concept-list").innerHTML = [...D.concepts].sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => chip("concept", c.id).replace("</button>", ` <span class="n">${cCount(c.id)}</span></button>`)).join("");
    $("#value-list").innerHTML = [...D.values].sort((a, b) => a.name.localeCompare(b.name))
      .map((v) => chip("value", v.id).replace("</button>", ` <span class="n">${vCount(v.id)}</span></button>`)).join("");
    renderRegions();
    const presets = [["All", YEAR_MIN, YEAR_MAX], ["Antiquity", YEAR_MIN, 499], ["Medieval", 500, 1499], ["1500–1800", 1500, 1799], ["19th c.", 1800, 1899], ["20th c.", 1900, 1999], ["21st c.", 2000, YEAR_MAX]];
    $("#era-presets").innerHTML = presets.map(([n, a, b]) => `<button data-era="${a},${b}">${n}</button>`).join("");
    $("#era-min").value = state.eraMin;
    $("#era-max").value = state.eraMax;
  }

  function renderRegions() {
    $("#region-list").innerHTML = D.regions
      .map((r) => `<button class="region-row ${state.regions.has(r.id) ? "" : "off"}" data-region="${r.id}" aria-pressed="${state.regions.has(r.id)}" title="${esc(r.note)} — shift-click to show only this region">
        <span class="sw" style="background:${regionColor(r.id)}"></span>${esc(r.name)}<span class="n">${D.books.filter((b) => b.region === r.id).length}</span></button>`)
      .join("");
    $("#region-legend").innerHTML = D.regions.map((r) => `<span><i style="background:${regionColor(r.id)}"></i>${esc(r.name)}</span>`).join("");
  }

  function renderSidebarState() {
    document.querySelectorAll(".sidebar .chip").forEach((el) => {
      const [kind, id] = el.dataset.focus.split(":");
      const f = state.focus;
      const sel = state.selected && bookById.get(state.selected);
      const active = (f && ((f.kind === kind && f.id === id) || (f.kind === "cell" && (f.axis === "values" ? "value" : "concept") === kind && f.id === id))) ||
        (sel && (kind === "concept" ? sel.concepts : sel.values).includes(id));
      el.classList.toggle("active", !!active);
    });
    document.querySelectorAll(".journey-btn").forEach((el) => el.classList.toggle("active", el.dataset.journey === state.journey));
  }

  // ------------------------------------------------------------------ search
  const searchEl = $("#search");
  const resultsEl = $("#search-results");
  let results = [];
  let activeIdx = -1;
  const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  function runSearch() {
    const q = norm(searchEl.value.trim());
    if (!q) { resultsEl.hidden = true; results = []; return; }
    const terms = q.split(/\s+/);
    const hit = (s) => terms.every((t) => norm(s).includes(t));
    results = [
      ...D.books.filter((b) => hit(`${b.title} ${b.author} ${b.place} ${b.lang} ${b.year}`)).slice(0, 12).map((b) => ({ type: "book", id: b.id, label: b.title, meta: `${b.author} · ${yearOf(b)}` })),
      ...D.concepts.filter((c) => hit(c.name)).map((c) => ({ type: "concept", id: c.id, label: c.name, meta: "concept" })),
      ...D.values.filter((v) => hit(v.name)).map((v) => ({ type: "value", id: v.id, label: v.name, meta: "value" })),
      ...D.regions.filter((r) => hit(r.name)).map((r) => ({ type: "region", id: r.id, label: r.name, meta: "region" })),
    ];
    activeIdx = results.length ? 0 : -1;
    drawResults();
  }
  function drawResults() {
    resultsEl.hidden = !searchEl.value.trim();
    resultsEl.innerHTML = results.length
      ? results.map((r, i) => `<li role="option" data-i="${i}" aria-selected="${i === activeIdx}"><span>${esc(r.label)}</span><span class="sr-meta">${esc(r.meta)}</span></li>`).join("")
      : `<li aria-disabled="true"><span class="sr-meta" style="margin:0">No matches</span></li>`;
  }
  function choose(r) {
    if (!r) return;
    searchEl.value = "";
    resultsEl.hidden = true;
    if (r.type === "book") selectBook(r.id);
    else setFocus({ kind: r.type, id: r.id });
  }
  searchEl.addEventListener("input", runSearch);
  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { activeIdx = Math.min(results.length - 1, activeIdx + 1); drawResults(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { activeIdx = Math.max(0, activeIdx - 1); drawResults(); e.preventDefault(); }
    else if (e.key === "Enter") choose(results[activeIdx]);
    else if (e.key === "Escape") { searchEl.value = ""; resultsEl.hidden = true; }
  });
  resultsEl.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) { e.preventDefault(); choose(results[+li.dataset.i]); }
  });
  searchEl.addEventListener("blur", () => setTimeout(() => { resultsEl.hidden = true; }, 100));

  // ------------------------------------------------------------------ events
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-book],[data-focus],[data-journey],[data-region],[data-era],[data-action]");
    if (!t || t.closest("svg")) return;
    if (t.tagName === "A") e.preventDefault();
    if (t.dataset.book) {
      selectBook(t.dataset.book);
    } else if (t.dataset.focus) {
      const [kind, id] = t.dataset.focus.split(":");
      setFocus({ kind, id });
    } else if (t.dataset.journey) {
      setJourney(t.dataset.journey);
    } else if (t.dataset.region) {
      const id = t.dataset.region;
      if (e.shiftKey) state.regions = new Set([id]);
      else if (state.regions.has(id)) { if (state.regions.size > 1) state.regions.delete(id); }
      else state.regions.add(id);
      renderRegions();
      mount();
    } else if (t.dataset.era) {
      const [a, b] = t.dataset.era.split(",").map(Number);
      setEra(a, b);
    } else {
      const a = t.dataset.action;
      if (a === "clear-focus") { state.focus = null; update(); }
      else if (a === "clear-journey") { state.journey = null; state.selected = null; update(); }
      else if (a === "unselect") selectBook(null);
      else if (a === "journey-overview") selectBook(null);
      else if (a === "step") {
        const j = journeyById.get(state.journey);
        const i = +t.dataset.step;
        if (j && j.steps[i]) selectBook(j.steps[i], { scroll: false });
      }
    }
  });

  function setEra(a, b) {
    state.eraMin = Math.min(a, b);
    state.eraMax = Math.max(a, b);
    $("#era-min").value = state.eraMin;
    $("#era-max").value = state.eraMax;
    mount();
  }
  $("#era-min").addEventListener("change", () => setEra(+$("#era-min").value || YEAR_MIN, state.eraMax));
  $("#era-max").addEventListener("change", () => setEra(state.eraMin, +$("#era-max").value || YEAR_MAX));
  $("#regions-all").addEventListener("click", () => { state.regions = new Set(D.regions.map((r) => r.id)); renderRegions(); mount(); });
  $("#show-links").addEventListener("change", (e) => { state.showLinks = e.target.checked; mount(); });
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("#toggle-sidebar").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#stage").addEventListener("click", () => $("#sidebar").classList.remove("open"));

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input")) return;
    if (e.key === "Escape") {
      if (state.selected) selectBook(null);
      else if (state.journey) { state.journey = null; update(); }
      else if (state.focus) { state.focus = null; update(); }
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && state.journey) {
      const j = journeyById.get(state.journey);
      const i = state.selected ? j.steps.indexOf(state.selected) : -1;
      const n = e.key === "ArrowRight" ? i + 1 : i - 1;
      if (j.steps[n]) selectBook(j.steps[n], { scroll: false });
    } else if (e.key === "/") {
      e.preventDefault();
      searchEl.focus();
    }
  });

  // Theme
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    refreshPalette();
    renderRegions();
    mount();
  }
  $("#theme-toggle").addEventListener("click", () => {
    const next = palette.dark ? "light" : "dark";
    try { localStorage.setItem("lit-atlas-theme", next); } catch (_) { /* storage unavailable */ }
    applyTheme(next);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (!document.documentElement.dataset.theme) applyTheme(null); });

  // Resize
  let resizeTimer = null;
  let lastSize = "";
  new ResizeObserver(() => {
    const size = `${canvasEl.clientWidth}x${canvasEl.clientHeight}`;
    if (size === lastSize) return;
    lastSize = size;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { views.map.transform = null; mount(); }, 150);
  }).observe(canvasEl);

  // ------------------------------------------------------------------ URL hash
  let hashLock = false;
  function syncHash() {
    const p = new URLSearchParams();
    if (state.view !== "map") p.set("view", state.view);
    if (state.selected) p.set("work", state.selected);
    if (state.journey) p.set("journey", state.journey);
    if (state.focus) {
      p.set(state.focus.kind, state.focus.id);
      if (state.focus.kind === "cell") { p.set("in", state.focus.region); p.set("axis", state.focus.axis); }
    }
    const h = p.toString();
    hashLock = true;
    history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
    hashLock = false;
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (views[p.get("view")]) state.view = p.get("view");
    if (bookById.has(p.get("work"))) state.selected = p.get("work");
    if (journeyById.has(p.get("journey"))) state.journey = p.get("journey");
    if (conceptById.has(p.get("concept"))) state.focus = { kind: "concept", id: p.get("concept") };
    else if (valueById.has(p.get("value"))) state.focus = { kind: "value", id: p.get("value") };
    else if (regionById.has(p.get("region"))) state.focus = { kind: "region", id: p.get("region") };
    else if (p.get("cell") && regionById.has(p.get("in"))) {
      const axis = p.get("axis") === "values" ? "values" : "concepts";
      if ((axis === "values" ? valueById : conceptById).has(p.get("cell"))) state.focus = { kind: "cell", id: p.get("cell"), region: p.get("in"), axis };
    }
  }
  window.addEventListener("hashchange", () => { if (!hashLock) { readHash(); setView(state.view); } });

  // ------------------------------------------------------------------ boot
  try {
    const saved = localStorage.getItem("lit-atlas-theme");
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch (_) { /* storage unavailable */ }
  refreshPalette();
  readHash();
  buildSidebar();
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === state.view));
  mount();
})();
