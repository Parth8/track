# Track a train or flight

A calm, ad-free live tracker for Indian trains and flights.

- `index.html`, `styles.css`, `js/` : the website (GitHub Pages)
- `vendor/maplibre/` : MapLibre GL JS 6.11.2 (BSD-3-Clause), self-hosted
- `fonts/` : Fraunces and Plus Jakarta Sans (SIL Open Font License)

The live data comes from a separate Cloudflare Worker (`worker.js`, not part of this repo).
Its address is set in the two lines at the top of `index.html`.
