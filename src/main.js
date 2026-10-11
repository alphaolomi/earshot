import "./style.css";
import { findPlaces, addWikipedia, geocode, reverseGeocode } from "./places.js";
import { loadGuide, narrate, ambientPrompts, webgpuStatus, modelId, NARRATORS, DEFAULT_AMBIENT, fallbackNarration } from "./guide.js";
import { Walk } from "./walk.js";

const $ = (sel) => document.querySelector(sel);
const STORE = "earshot:packs";

let walk = null;
let currentPack = null;

// ---------- saved walk packs (everything needed to walk offline) ----------

const loadPacks = () => JSON.parse(localStorage.getItem(STORE) || "[]");
const savePacks = (packs) => localStorage.setItem(STORE, JSON.stringify(packs));

function savePack(pack) {
  savePacks([pack, ...loadPacks().filter((p) => p.id !== pack.id)].slice(0, 10));
}

// ---------- screens ----------

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
  window.scrollTo(0, 0);
}

function renderHome() {
  const packs = loadPacks();
  const list = $("#saved");
  list.replaceChildren();
  $("#saved-section").hidden = !packs.length;
  for (const pack of packs) {
    const li = el("li", { class: "saved" }, [
      el("div", {}, [
        el("strong", { text: pack.area }),
        el("small", { text: `${pack.places.length} places · ${new Date(pack.createdAt).toLocaleDateString()}` }),
      ]),
      el("div", { class: "row" }, [
        el("button", { class: "small", text: "Walk", onclick: () => startWalk(pack, false) }),
        el("button", { class: "small ghost", text: "Simulate", onclick: () => startWalk(pack, true) }),
        el("button", {
          class: "small ghost",
          text: "✕",
          "aria-label": `Delete ${pack.area}`,
          onclick: () => {
            savePacks(loadPacks().filter((p) => p.id !== pack.id));
            renderHome();
          },
        }),
      ]),
    ]);
    list.append(li);
  }
  show("home");
}

// ---------- planning: places → Gemma → saved pack ----------

async function plan(getPoint) {
  show("prepare");
  $("#places").replaceChildren();
  $("#walk-actions").hidden = true;
  $("#prep-error").hidden = true;
  setStep("find", "active");

  try {
    const { point, area } = await getPoint();
    $("#prep-title").textContent = `A walk around ${area}`;
    const radius = +$("#radius").value;
    const places = await findPlaces(point, radius);
    if (!places.length) throw new Error("Nothing mapped nearby yet. Try a bigger radius or a busier area.");
    const fromOsm = places.filter((p) => p.source === "osm").length;
    setStep("find", "done", `${places.length} places within ${radius} m (${fromOsm} from OpenStreetMap, ${places.length - fromOsm} from Wikipedia)`);

    const cards = new Map(places.map((p) => [p.id, placeCard(p)]));
    $("#places").append(...cards.values());

    setStep("wiki", "active");
    await Promise.all(places.map(addWikipedia));
    setStep("wiki", "done", `${places.filter((p) => p.facts.some((f) => f.startsWith("Wikipedia"))).length} with a Wikipedia article`);

    let ambient = DEFAULT_AMBIENT;
    let model = null;
    setStep("model", "active");
    try {
      await loadGuide($("#narrator").value, (progress, text) => {
        $("#model-bar").value = progress;
        setStep("model", "active", text.replace(/\[.*?\]\s*/, "").slice(0, 90));
      });
      model = modelId;
      setStep("model", "done", `${modelId} running on your GPU`);
    } catch (e) {
      setStep("model", "failed", `${e.message} Using plain facts instead.`);
    }

    setStep("write", "active");
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 20 ? "evening" : "night";
    for (const [i, place] of places.entries()) {
      setStep("write", "active", `${i + 1} of ${places.length}: ${place.name}`);
      place.narration = model ? await narrate(place, area) : fallbackNarration(place);
      fillCard(cards.get(place.id), place);
    }
    if (model) {
      setStep("write", "active", "Between-places prompts");
      ambient = await ambientPrompts(area, timeOfDay);
    }
    setStep("write", "done", model ? `Written locally by ${model}` : "Plain-fact narration");

    currentPack = {
      id: `${point.lat.toFixed(3)},${point.lon.toFixed(3)}`,
      area,
      center: point,
      radius,
      model,
      createdAt: Date.now(),
      places,
      ambient,
    };
    savePack(currentPack);
    setStep("save", "done", "Saved on this phone. You can walk with no signal.");
    $("#walk-actions").hidden = false;
  } catch (e) {
    $("#prep-error").textContent = e.message;
    $("#prep-error").hidden = false;
    for (const li of document.querySelectorAll("#steps li.active")) li.className = "failed";
  }
}

function setStep(id, state, detail) {
  const li = $(`#steps [data-step="${id}"]`);
  li.className = state;
  if (detail !== undefined) li.querySelector("small").textContent = detail;
  $("#model-bar").hidden = !(id === "model" && state === "active");
}

function placeCard(place) {
  return el("li", { class: "place" }, [
    el("div", { class: "place-head" }, [
      el("div", {}, [el("strong", { text: place.name }), el("small", { text: `${place.kind} · ${place.distance} m` })]),
      el("button", { class: "small ghost play", text: "▶", disabled: true, "aria-label": `Hear ${place.name}` }),
    ]),
    el("p", { class: "narration muted", text: "Waiting for the narrator…" }),
  ]);
}

function fillCard(card, place) {
  card.querySelector(".narration").textContent = place.narration;
  card.querySelector(".narration").classList.remove("muted");
  const btn = card.querySelector(".play");
  btn.disabled = false;
  btn.onclick = () => {
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(place.narration));
  };
}

// ---------- the walk ----------

function startWalk(pack, demo) {
  show("walking");
  $("#walk-area").textContent = pack.area;
  $("#demo-badge").hidden = !demo;
  walk = new Walk(pack, { demo, onUpdate: renderWalk });
  walk.start();
}

function renderWalk(s) {
  $("#walk-count").textContent = `${s.heard} of ${s.total} places heard`;
  $("#walk-next").textContent = s.nearest ? `Nearest: ${s.nearest.name} · ${s.nearest.distance} m` : "Waiting for GPS…";
  $("#walk-text").textContent = s.text || "";
  $("#walk-state").textContent = s.speaking ? "Speaking" : "Listening";
  $("#walking").classList.toggle("speaking", s.speaking);
  if (s.error) $("#walk-error").textContent = s.error;
}

function endWalk() {
  walk?.stop();
  walk = null;
  renderHome();
}

// ---------- helpers & wiring ----------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node[k] = v;
    else if (k === "disabled") node.disabled = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

const here = () =>
  new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      async (p) => {
        const point = { lat: p.coords.latitude, lon: p.coords.longitude };
        resolve({ point, area: await reverseGeocode(point) });
      },
      (e) => reject(new Error(`Couldn't get your location: ${e.message}`)),
      { enableHighAccuracy: true, timeout: 20000 }
    )
  );

$("#use-here").onclick = () => plan(here);
$("#search-form").onsubmit = (e) => {
  e.preventDefault();
  const q = $("#search").value.trim();
  if (!q) return;
  plan(async () => {
    const { lat, lon, label } = await geocode(q);
    return { point: { lat, lon }, area: label };
  });
};
$("#back").onclick = renderHome;
$("#start-real").onclick = () => startWalk(currentPack, false);
$("#start-demo").onclick = () => startWalk(currentPack, true);
$("#repeat").onclick = () => walk?.repeat();
$("#skip").onclick = () => walk?.skip();
$("#end").onclick = endWalk;

for (const [value, { label }] of Object.entries(NARRATORS)) $("#narrator").append(el("option", { value, text: label }));
$("#narrator").value = localStorage.getItem("earshot:narrator") || "gemma2";
$("#narrator").onchange = () => localStorage.setItem("earshot:narrator", $("#narrator").value);

webgpuStatus().then((s) => {
  if (!s.ok) {
    $("#gpu-note").textContent = `${s.reason} Earshot will still work, reading plain facts instead of Gemma's narration.`;
    $("#gpu-note").hidden = false;
  }
});

speechSynthesis.getVoices(); // warm up the voice list (Chrome loads it lazily)

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
}

renderHome();
