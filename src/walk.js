// The walk itself: watches GPS, speaks a place's narration when you reach it,
// and fills long quiet stretches with small "notice this" prompts.
// Nothing here needs the network or the model: everything was prepared beforehand.
import { distanceM, bearingDeg } from "./places.js";

const AMBIENT_EVERY_MS = 3 * 60 * 1000;
const DEMO_AMBIENT_EVERY_MS = 20 * 1000;
const DEMO_SPEED_MS = 12; // metres per simulated second (fast-forwarded walking)

export class Walk {
  constructor(pack, { demo = false, onUpdate = () => {} } = {}) {
    this.pack = pack;
    this.demo = demo;
    this.onUpdate = onUpdate;
    this.heard = new Set();
    this.ambientIndex = 0;
    this.speaking = false;
    this.lastSpokeAt = Date.now();
    this.lastText = "";
    this.position = null;
    this.heading = null;
    this.nearest = null;
    this.voice = pickVoice();
  }

  async start() {
    this.running = true;
    await this.lockScreen();
    this.onVisibility = () => document.visibilityState === "visible" && this.running && this.lockScreen();
    document.addEventListener("visibilitychange", this.onVisibility);

    this.say(
      `Hi, I'm Wren. I've found ${this.pack.places.length} places worth seeing around ${this.pack.area}. ` +
        `Put your phone in your pocket and start walking. I'll speak up when you reach one.`
    );

    if (this.demo) this.startDemo();
    else
      this.watchId = navigator.geolocation.watchPosition(
        (p) => this.onPosition({ lat: p.coords.latitude, lon: p.coords.longitude }, p.coords.heading),
        () => this.update({ error: "I can't see where you are. Check that location is turned on and allowed for this site." }),
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
      );

    const ambientEvery = this.demo ? DEMO_AMBIENT_EVERY_MS : AMBIENT_EVERY_MS;
    this.ambientTimer = setInterval(() => {
      if (!this.speaking && Date.now() - this.lastSpokeAt > ambientEvery) this.ambient();
    }, 2000);
    this.update();
  }

  stop() {
    this.running = false;
    speechSynthesis.cancel();
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    clearInterval(this.ambientTimer);
    clearInterval(this.demoTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.wakeLock?.release().catch(() => {});
  }

  repeat() {
    if (this.lastText) this.say(this.lastText);
  }

  skip() {
    speechSynthesis.cancel();
    this.speaking = false;
    this.lastSpokeAt = Date.now();
  }

  onPosition(pos, gpsHeading) {
    if (this.position && distanceM(this.position, pos) > 4) this.heading = bearingDeg(this.position, pos);
    if (gpsHeading != null && !Number.isNaN(gpsHeading)) this.heading = gpsHeading;
    this.position = pos;

    let nearest = null;
    for (const place of this.pack.places) {
      if (this.heard.has(place.id)) continue;
      const d = distanceM(pos, place);
      if (!nearest || d < nearest.distance) nearest = { place, distance: d };
    }
    this.nearest = nearest;

    if (nearest && !this.speaking && nearest.distance <= nearest.place.radius) {
      const { place } = nearest;
      this.heard.add(place.id);
      this.say(`${this.direction(place)}: ${place.name}. ${place.narration}`, true);
    }
    this.update();
  }

  direction(place) {
    if (this.heading == null || !this.position) return "Nearby";
    const rel = (bearingDeg(this.position, place) - this.heading + 360) % 360;
    if (rel < 45 || rel >= 315) return "Just ahead";
    if (rel < 135) return "On your right";
    if (rel < 225) return "Just behind you";
    return "On your left";
  }

  ambient() {
    const lines = this.pack.ambient;
    if (!lines?.length) return;
    this.say(lines[this.ambientIndex++ % lines.length]);
  }

  say(text, remember = false) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    this.voice ||= pickVoice(); // the voice list loads lazily in some browsers
    if (this.voice) u.voice = this.voice;
    u.rate = 0.95;
    u.onend = u.onerror = () => {
      this.speaking = false;
      this.lastSpokeAt = Date.now();
      this.update();
    };
    this.speaking = true;
    if (remember) this.lastText = text;
    this.spokenText = text;
    speechSynthesis.speak(u);
    this.update();
  }

  async lockScreen() {
    // Mobile browsers pause GPS when the screen turns off, so we keep it awake and
    // show a black screen instead (cheap on OLED, and invisible in a pocket).
    try {
      this.wakeLock = await navigator.wakeLock?.request("screen");
    } catch {
      if (!this.demo) this.update({ error: "Tip: keep your screen on during the walk. Turn off auto-lock in your phone's settings." });
    }
  }

  // Simulated walk for demos and desk testing: a nearest-neighbour stroll past every place.
  startDemo() {
    const route = [this.pack.center];
    const left = [...this.pack.places];
    while (left.length) {
      const here = route[route.length - 1];
      left.sort((a, b) => distanceM(here, a) - distanceM(here, b));
      route.push(left.shift());
    }
    let leg = 0;
    let pos = { ...route[0] };
    this.demoTimer = setInterval(() => {
      if (this.speaking) return; // pause while talking so no place gets skipped
      let step = DEMO_SPEED_MS;
      while (step > 0 && leg < route.length - 1) {
        const target = route[leg + 1];
        const d = distanceM(pos, target);
        if (d <= step) {
          pos = { lat: target.lat, lon: target.lon };
          step -= d;
          leg++;
        } else {
          const f = step / d;
          pos = { lat: pos.lat + (target.lat - pos.lat) * f, lon: pos.lon + (target.lon - pos.lon) * f };
          step = 0;
        }
      }
      this.onPosition(pos, null);
      if (leg >= route.length - 1 && this.heard.size === this.pack.places.length) {
        clearInterval(this.demoTimer);
        setTimeout(() => this.say("That's every stop on this walk. Thanks for walking with me, and for looking up."), 1500);
      }
    }, 1000);
  }

  update(extra = {}) {
    this.onUpdate({
      heard: this.heard.size,
      total: this.pack.places.length,
      nearest: this.nearest && { name: this.nearest.place.name, distance: Math.round(this.nearest.distance) },
      speaking: this.speaking,
      text: this.spokenText,
      demo: this.demo,
      ...extra,
    });
  }
}

function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith("en"));
  return (
    voices.find((v) => /natural|neural/i.test(v.name)) ||
    voices.find((v) => /google/i.test(v.name)) ||
    voices.find((v) => v.default) ||
    voices[0] ||
    null
  );
}
