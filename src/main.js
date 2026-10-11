import "./style.css";
import { findPlaces, addWikipedia, geocode, reverseGeocode } from "./places.js";
import { loadGuide, narrate, ambientPrompts, webgpuStatus, modelId, NARRATORS, DEFAULT_AMBIENT, fallbackNarration } from "./guide.js";
import { Walk } from "./walk.js";

const $ = (sel) => document.querySelector(sel);
const STORE = "earshot:packs";
const WALK_SPEED = 80; // metres per minute, an unhurried stroll

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
    list.append(
      el("li", { class: "saved" }, [
        el("div", { class: "saved-head" }, [
          el("div", {}, [
            el("strong", { text: pack.area }),
            el("small", { text: `${pack.places.length} stops · planned ${friendlyDate(pack.createdAt)}` }),
          ]),
          el("button", {
            class: "icon",
            text: "✕",
            "aria-label": `Delete the walk around ${pack.area}`,
            onclick: () => {
              if (!confirm(`Delete your walk around ${pack.area}?`)) return;
              savePacks(loadPacks().filter((p) => p.id !== pack.id));
              renderHome();
            },
          }),
        ]),
        el("div", { class: "saved-actions" }, [
          el("button", { class: "primary small", text: "Start walk", onclick: () => startWalk(pack, false) }),
          el("button", { class: "secondary small", text: "Preview", onclick: () => startWalk(pack, true) }),
        ]),
      ])
    );
  }
  show("home");
}

// ---------- planning: places → Wren writes → saved pack ----------

async function plan(getPoint) {
  show("prepare");
  $("#prep-title").textContent = "Planning your walk";
  $("#places").replaceChildren();
  $("#stops-title").hidden = true;
  $("#walk-actions").hidden = true;
  $("#prep-error").hidden = true;
  for (const li of document.querySelectorAll("#steps li")) setStep(li.dataset.step, "", "");
  wrenSays("Let me look around…");
  setStep("find", "active");

  try {
    const { point, area } = await getPoint();
    $("#prep-title").textContent = `Your walk around ${area}`;
    const radius = +document.querySelector('input[name="radius"]:checked').value;
    const places = await findPlaces(point, radius);
    if (!places.length) throw new Error("I couldn't find anything interesting nearby. Try a longer walk or a busier area.");
    setStep("find", "done", `${places.length} spots nearby`);
    wrenSays(`Ooh, I found ${places.length} spots. Let me read up on them.`);

    const cards = new Map(places.map((p, i) => [p.id, placeCard(p, i + 1)]));
    $("#places").append(...cards.values());
    $("#stops-title").hidden = false;

    setStep("wiki", "active");
    await Promise.all(places.map(addWikipedia));
    const withStories = places.filter((p) => p.facts.length).length;
    setStep("wiki", "done", `Found background on ${withStories} of them`);

    const narrator = $("#narrator").value;
    const size = (NARRATORS[narrator] || NARRATORS.full).size;
    let ready = false;
    setStep("model", "active", "Starting up…");
    // Big downloads can sit on one percentage for a while on slow or nearly full phones.
    let lastProgress = Date.now();
    const stallHint = setInterval(() => {
      if (Date.now() - lastProgress > 90000 && narrator !== "light")
        setStep("model", "active", "Still downloading… On slow internet, the Light option in Settings is quicker.");
    }, 5000);
    try {
      await loadGuide(narrator, (progress, text) => {
        lastProgress = Date.now();
        $("#model-bar").value = progress;
        const pct = Math.round(progress * 100);
        if (text === "retry") setStep("model", "active", "The connection hiccuped. Trying again…");
        else if (/from cache/i.test(text)) setStep("model", "active", `Waking up… ${pct}%`);
        else if (pct >= 100) setStep("model", "active", "Almost ready…");
        else {
          setStep("model", "active", `One-time download (${size}) · ${pct}%. Best on Wi-Fi.`);
          wrenSays("First time we've met! I'm settling into your phone. After this, I'll work without internet.");
        }
      });
      ready = true;
      setStep("model", "done", "Ready, and running on this phone");
    } catch (e) {
      console.warn("Wren couldn't load:", e);
      setStep("model", "failed", "Wren couldn't start on this device, so you'll hear short facts instead.");
    } finally {
      clearInterval(stallHint);
    }

    setStep("write", "active");
    wrenSays("Now I'm writing what I'll tell you at each stop.");
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 20 ? "evening" : "night";
    for (const [i, place] of places.entries()) {
      setStep("write", "active", `Stop ${i + 1} of ${places.length}: ${place.name}`);
      place.narration = ready ? await narrate(place, area) : fallbackNarration(place);
      fillCard(cards.get(place.id), place);
    }
    let ambient = DEFAULT_AMBIENT;
    if (ready) {
      setStep("write", "active", "A few things to notice between stops");
      ambient = await ambientPrompts(area, timeOfDay);
    }
    setStep("write", "done", `${places.length} stops written`);

    currentPack = {
      id: `${point.lat.toFixed(3)},${point.lon.toFixed(3)}`,
      area,
      center: point,
      radius,
      model: ready ? modelId : null,
      createdAt: Date.now(),
      places,
      ambient,
    };
    savePack(currentPack);
    setStep("save", "done", "You can walk with no signal");
    wrenSays("All set! Put your earbuds in and let's go.");
    $("#walk-actions").hidden = false;
    $("#walk-actions").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) {
    $("#prep-error").textContent = e.message;
    $("#prep-error").hidden = false;
    wrenSays("Hmm, something went wrong. See below.");
    for (const li of document.querySelectorAll("#steps li.active")) li.className = "failed";
  }
}

function wrenSays(text) {
  $("#wren-says").textContent = text;
}

function setStep(id, state, detail) {
  const li = $(`#steps [data-step="${id}"]`);
  li.className = state;
  if (detail !== undefined) li.querySelector("small").textContent = detail;
  if (id === "model") $("#model-bar").hidden = state !== "active";
}

function placeCard(place, n) {
  return el("li", { class: "place" }, [
    el("span", { class: "stop-num", text: String(n) }),
    el("div", { class: "place-body" }, [
      el("div", { class: "place-head" }, [
        el("div", {}, [
          el("strong", { text: place.name }),
          el("small", { text: `${capitalize(place.kind)} · ${minutes(place.distance)} min away` }),
        ]),
        el("button", { class: "icon play", text: "▶", disabled: true, "aria-label": `Hear what Wren says about ${place.name}` }),
      ]),
      el("p", { class: "narration waiting", text: "Wren is thinking…" }),
    ]),
  ]);
}

function fillCard(card, place) {
  const p = card.querySelector(".narration");
  p.textContent = place.narration;
  p.classList.remove("waiting");
  const btn = card.querySelector(".play");
  btn.disabled = false;
  btn.onclick = () => {
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(`${place.name}. ${place.narration}`));
  };
}

// ---------- the walk ----------

function startWalk(pack, demo) {
  show("walking");
  $("#walk-area").textContent = pack.area;
  $("#demo-badge").hidden = !demo;
  $("#walk-error").textContent = "";
  walk = new Walk(pack, { demo, onUpdate: renderWalk });
  walk.start();
}

function renderWalk(s) {
  $("#walk-count").textContent = `${s.heard} of ${s.total} stops so far`;
  $("#walk-next").textContent = s.nearest
    ? `Next up: ${s.nearest.name}, about ${minutes(s.nearest.distance)} min away`
    : "Finding where you are…";
  $("#walk-text").textContent = s.text || "";
  $("#walk-state").textContent = s.speaking ? "Wren is talking" : "Wren is listening";
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

const minutes = (metres) => Math.max(1, Math.round(metres / WALK_SPEED));
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function friendlyDate(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const here = () =>
  new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      async (p) => {
        const point = { lat: p.coords.latitude, lon: p.coords.longitude };
        resolve({ point, area: await reverseGeocode(point) });
      },
      () => reject(new Error("I couldn't see where you are. Allow location access when your browser asks, or search for a place instead.")),
      { enableHighAccuracy: true, timeout: 20000 }
    )
  );

$("#use-here").onclick = () => plan(here);
$("#search-form").onsubmit = (e) => {
  e.preventDefault();
  const q = $("#search").value.trim();
  if (!q) return $("#search").focus();
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
const savedNarrator = localStorage.getItem("earshot:narrator");
$("#narrator").value = NARRATORS[savedNarrator] ? savedNarrator : "full";
$("#narrator").onchange = () => localStorage.setItem("earshot:narrator", $("#narrator").value);

webgpuStatus().then((s) => {
  if (!s.ok) {
    $("#gpu-note").textContent =
      "Heads up: this browser can't run Wren's storytelling, so you'll hear short facts instead. For the full experience, use Chrome on an Android phone or on a computer.";
    $("#gpu-note").hidden = false;
  }
});

speechSynthesis.getVoices(); // warm up the voice list (Chrome loads it lazily)

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
}

renderHome();
