# Earshot

**A walking guide that lives in your pocket.**

Plan a walk while you have Wi-Fi. Earshot finds the interesting corners around you on OpenStreetMap and Wikipedia, and **Gemma, running entirely on your own device**, writes a short spoken piece about each one. Then the phone goes in your pocket. When GPS says you've reached a place, Earshot speaks up in your earbuds. In the quiet stretches between places it nudges you to notice things: a sound, a colour, the sky.

The screen is the shortest part of the walk.

## How it works

```
 plan (online, ~1 min)                         walk (offline, phone in pocket)
 ─────────────────────                         ───────────────────────────────
 OpenStreetMap (Overpass) ─┐                   GPS ──► nearest unheard place within ~35 m?
 Wikipedia geosearch ──────┼─► places + facts            │
                           │        │                    ▼
                           │        ▼           Web Speech API reads the narration
                           │  Gemma 3 1B (WebLLM, WebGPU, in a Web Worker)
                           │  writes 2-3 grounded sentences per place
                           │        │
                           └────────▼
                     "walk pack" saved in localStorage ──► works with no signal
```

- **Model:** [`gemma3-1b-it-q4f16_1-MLC`](https://huggingface.co/mlc-ai/gemma3-1b-it-q4f16_1-MLC) via [WebLLM](https://github.com/mlc-ai/web-llm). Falls back to Gemma 2 2B (f32) on GPUs without `shader-f16`, and to plain facts if there's no WebGPU at all.
- **Grounding:** the prompt passes only OSM tags and the Wikipedia intro, and tells Gemma to describe what to look at rather than invent history when facts are thin. Every narration ends with a small physical action: look up, touch, listen.
- **Privacy:** the live GPS trace never leaves the device. While planning, only a coarse (~100 m) point is sent to OpenStreetMap and Wikipedia.
- **Offline:** narration is generated at planning time, so the walk needs no network and no model. A service worker caches the app shell. Gemma's weights are cached by WebLLM after the first download (~700 MB).
- **Pocket mode:** mobile browsers pause GPS when the screen sleeps, so Earshot holds a Wake Lock and shows an all-black screen (cheap on OLED, invisible in a pocket).

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173 in Chrome or Edge (desktop), or Chrome on Android 12+. Geolocation and WebGPU need `localhost` or HTTPS.

**No time to go outside?** After planning, tap **Simulate the walk here**. It fast-forwards a stroll past every place so you can hear the whole thing at your desk.

## Build

```bash
npm run build   # static site in dist/, deployable anywhere (GitHub Pages, Render, ...)
```

## Credits

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
- Place summaries from [Wikipedia](https://en.wikipedia.org), CC BY-SA.
- [Gemma](https://ai.google.dev/gemma) open-weight models by Google, under the Gemma Terms of Use.
- [WebLLM](https://github.com/mlc-ai/web-llm) by MLC, Apache-2.0.

## License

MIT
