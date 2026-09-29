import { h, svg, splitLine, isDarkTheme } from "./util.js";
import { icons } from "./icons.js";

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
let libPromise = null;

function loadLibrary() {
  if (!libPromise) {
    document.head.append(h("link", { rel: "stylesheet", href: "vendor/maplibre/maplibre-gl.css" }));
    libPromise = import("../vendor/maplibre/maplibre-gl.mjs");
  }
  return libPromise;
}

function palette() {
  const css = getComputedStyle(document.body);
  const v = (name) => css.getPropertyValue(name).trim();
  const dark = isDarkTheme();
  return {
    land: dark ? "#1c1f26" : "#f4efe6",
    landAlt: dark ? "#20242c" : "#efe8db",
    water: dark ? "#1a2533" : "#d8e6f3",
    label: dark ? "#9d9ca3" : "#8a8272",
    halo: dark ? "#1c1f26" : "#f4efe6",
    done: v("--accent"),
    ahead: v("--line"),
    deep: v("--deep"),
  };
}

/** Recolour the base style: pastel land and water, no borders, no roads, few labels. */
function restyle(map, c) {
  for (const layer of map.getStyle().layers) {
    const id = layer.id;
    const hide = () => map.setLayoutProperty(id, "visibility", "none");
    if (/boundary|admin/.test(id)) hide();
    else if (/road|highway|tunnel|bridge|building|poi|housenumber|aeroway|transportation|railway|ferry|oneway/.test(id)) hide();
    else if (layer.type === "background") map.setPaintProperty(id, "background-color", c.land);
    else if (/water/.test(id) && layer.type === "fill") map.setPaintProperty(id, "fill-color", c.water);
    else if (/water/.test(id) && layer.type === "line") map.setPaintProperty(id, "line-color", c.water);
    else if (layer.type === "fill") map.setPaintProperty(id, "fill-color", c.landAlt);
    else if (layer.type === "symbol") {
      if (!/place|city|town|country|state/.test(id) || /village|hamlet|suburb|neighbourhood|state|country/.test(id)) hide();
      else {
        map.setPaintProperty(id, "text-color", c.label);
        map.setPaintProperty(id, "text-halo-color", c.halo);
      }
    }
  }
}

/**
 * Mount a map. opts: { mode, line: [[lon,lat],...], fraction, position: [lon,lat], trackDeg, live }
 * Returns { update(opts), destroy() }.
 */
export async function mountMap(container, opts) {
  const { Map, Marker, LngLatBounds } = await loadLibrary();
  const c = palette();
  const map = new Map({
    container,
    style: STYLE_URL,
    attributionControl: { compact: true, customAttribution: "OpenFreeMap © OpenMapTiles, data © OpenStreetMap contributors" },
    cooperativeGestures: true,
    dragRotate: false,
    pitchWithRotate: false,
    fadeDuration: 150,
  });

  const markerEl =
    opts.mode === "flight"
      ? h("div", { class: "map-plane", "aria-hidden": "true" }, svg(icons.plane))
      : h("div", { class: "map-marker", "aria-hidden": "true" });
  const marker = new Marker({ element: markerEl, rotationAlignment: "map" });

  const empty = { type: "FeatureCollection", features: [] };
  const lineFeature = (coords) => ({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} });

  let ready = false;
  let pending = opts;
  let fitted = false;

  function apply(o) {
    if (!ready) {
      pending = o;
      return;
    }
    const line = (o.line || []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (line.length < 2) return;
    let done, ahead, split;
    if (o.done && o.ahead) [done, ahead, split] = [o.done, o.ahead, o.position];
    else [done, ahead, split] = splitLine(line, o.fraction ?? 0);
    const pos = o.position || split;
    map.getSource("done").setData(lineFeature(done));
    map.getSource("ahead").setData(lineFeature(ahead));
    map.getSource("ends").setData({
      type: "FeatureCollection",
      features: [line[0], line.at(-1)].map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: {} })),
    });
    if (o.hideMarker) marker.remove();
    else marker.setLngLat(pos).addTo(map);
    if (o.mode === "flight" && Number.isFinite(o.trackDeg)) marker.setRotation(o.trackDeg);
    if (!fitted) {
      const b = new LngLatBounds(line[0], line[0]);
      line.forEach((p) => b.extend(p));
      map.fitBounds(b, { padding: { top: 56, bottom: 40, left: 40, right: 40 }, duration: 0, maxZoom: 9 });
      fitted = true;
    }
  }

  const slow = setTimeout(() => {
    if (ready) return;
    const note = container.parentElement?.querySelector(".map-note");
    if (note) note.textContent = "The map is taking a while to load. Everything else is up to date.";
  }, 10000);

  map.on("load", () => {
    clearTimeout(slow);
    try {
      restyle(map, c);
    } catch (e) {
      console.warn("restyle", e);
    }
    map.addSource("done", { type: "geojson", data: empty });
    map.addSource("ahead", { type: "geojson", data: empty });
    map.addSource("ends", { type: "geojson", data: empty });
    map.addLayer({
      id: "ahead",
      type: "line",
      source: "ahead",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.ahead, "line-width": 3, "line-dasharray": [0.5, 2.2] },
    });
    map.addLayer({
      id: "done",
      type: "line",
      source: "done",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.done, "line-width": 4 },
    });
    map.addLayer({
      id: "ends",
      type: "circle",
      source: "ends",
      paint: { "circle-radius": 6, "circle-color": "#ffffff", "circle-stroke-color": c.done, "circle-stroke-width": 3 },
    });
    ready = true;
    container.querySelector(".maplibregl-compact-show")?.classList.remove("maplibregl-compact-show");
    apply(pending);
  });

  return {
    update: apply,
    destroy: () => {
      clearTimeout(slow);
      map.remove();
    },
  };
}
