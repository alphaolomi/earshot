// The narrator: Gemma (open weights) running locally in the browser via WebLLM + WebGPU.

// Swappable open-weight narrators. f16 builds need WebGPU's shader-f16 feature; f32 is the fallback.
export const NARRATORS = {
  gemma2: {
    label: "Gemma 2 2B · best · 1.5 GB",
    f16: "gemma-2-2b-it-q4f16_1-MLC",
    f32: "gemma-2-2b-it-q4f32_1-MLC",
  },
  gemma3: {
    label: "Gemma 3 1B · lite · 540 MB",
    f16: "gemma3-1b-it-q4f16_1-MLC",
    f32: "gemma-2-2b-it-q4f32_1-MLC",
    // WebLLM's Gemma 3 record sets a 4096 context while the weights declare a 512 sliding
    // window, and the runtime refuses both. Keep the native sliding window: prompts are short.
    chatOpts: { context_window_size: -1, attention_sink_size: 0 },
  },
};

let engine = null;
export let modelId = null;

export async function webgpuStatus() {
  if (!("gpu" in navigator)) return { ok: false, reason: "This browser has no WebGPU. Try Chrome or Edge on desktop, or Chrome on Android 12+." };
  const adapter = await navigator.gpu.requestAdapter().catch(() => null);
  if (!adapter) return { ok: false, reason: "WebGPU is present but no GPU adapter was found." };
  return { ok: true, f16: adapter.features.has("shader-f16") };
}

export async function loadGuide(narrator, onProgress) {
  const choice = NARRATORS[narrator] || NARRATORS.gemma2;
  const gpu = await webgpuStatus();
  if (!gpu.ok) throw new Error(gpu.reason);
  const wanted = gpu.f16 ? choice.f16 : choice.f32;
  if (engine && modelId === wanted) return engine;
  if (engine) await engine.unload?.();
  engine = null;
  modelId = wanted;
  // Loaded on demand so the app shell stays small and opens instantly offline.
  const { CreateWebWorkerMLCEngine, prebuiltAppConfig } = await import("@mlc-ai/web-llm");
  let useIndexedDBCache = localStorage.getItem("earshot:idb") === "1";
  // Weights arrive as many shards; finished shards stay cached, so a retry resumes.
  for (let attempt = 1; ; attempt++) {
    const worker = new Worker(new URL("./llm-worker.js", import.meta.url), { type: "module" });
    try {
      engine = await CreateWebWorkerMLCEngine(
        worker,
        modelId,
        {
          appConfig: { ...prebuiltAppConfig, cacheBackend: useIndexedDBCache ? "indexeddb" : "cache" },
          initProgressCallback: (p) => onProgress?.(p.progress, p.text),
        },
        modelId === choice.f16 ? choice.chatOpts : undefined
      );
      return engine;
    } catch (e) {
      worker.terminate();
      const message = String(e?.message || e);
      // Some browsers choke storing large entries in Cache Storage; IndexedDB is the fallback.
      if (/on 'Cache'/.test(message) && !useIndexedDBCache) {
        useIndexedDBCache = true;
        localStorage.setItem("earshot:idb", "1");
      }
      const network = /fetch|network|cors|load|cache/i.test(message);
      if (attempt === 3 || !network) throw new Error(`Couldn't load Gemma (${e?.message || e}).`);
      onProgress?.(0, `Download hiccup, retrying (${attempt} of 2)…`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function ask(prompt, maxTokens, examples = [], temperature = 0.6) {
  // Gemma's chat template has no system role, so instructions go in the user turn.
  // Worked examples are passed as earlier turns: a 1B model copies inline examples verbatim.
  const reply = await engine.chat.completions.create({
    messages: [
      ...examples.flatMap(([q, a]) => [
        { role: "user", content: q },
        { role: "assistant", content: a },
      ]),
      { role: "user", content: prompt },
    ],
    temperature,
    top_p: 0.9,
    frequency_penalty: 0.4,
    max_tokens: maxTokens,
  });
  return clean(reply.choices[0].message.content);
}

const NARRATE_RULES =
  "You are a walking guide speaking into someone's earbuds. Reply with only the spoken words: 2 or 3 sentences, under 60 words. Use only the facts given, never invent dates or people. End by asking the listener to look at, touch or listen to something real.";

const NARRATE_EXAMPLES = [
  [
    `${NARRATE_RULES}

Place: Old Clock Tower (historic tower)
Facts: Dates from: 1898; Material: coral stone`,
    "This coral stone clock tower has stood here since 1898. Look up and find the clock face, then stand still for a moment. Can you hear it ticking?",
  ],
];

export async function narrate(place, area) {
  const facts = place.facts.length ? place.facts.join("; ") : "none recorded";
  const prompt = `${NARRATE_RULES}

Place: ${place.name} (${place.kind}), in ${area}
Facts: ${facts}`;
  // Grounding check: every number Gemma says (years, heights, counts) must appear in the facts.
  // One stricter retry, then fall back to reading the facts plainly rather than risk inventing history.
  for (const temperature of [0.6, 0.2]) {
    const text = await ask(prompt, 120, NARRATE_EXAMPLES, temperature);
    if (text.split(" ").length >= 8 && grounded(text, facts + " " + place.name)) return text;
  }
  return fallbackNarration(place);
}

export function grounded(text, source) {
  const numbers = text.match(/\d[\d,.]*/g) || [];
  return numbers.every((n) => source.includes(n.replace(/[.,]$/, "")));
}

const THEMES = [
  "sounds they can hear right now",
  "colours around them",
  "the sky and the light",
  "smells in the air",
  "the ground under their feet",
  "people, birds or animals nearby",
  "how their body feels as they walk",
];

export async function ambientPrompts(area, timeOfDay) {
  const lines = [];
  for (const theme of THEMES) {
    lines.push(
      await ask(
        `You are Earshot, a calm walking guide speaking into earbuds. Someone is walking through ${area} in the ${timeOfDay}, between landmarks. Write ONE short spoken sentence, under 25 words, inviting them to notice ${theme}. No emoji, no markdown, no quotes.`,
        50
      )
    );
  }
  return lines;
}

// Fallback lines when no model is available, so a walk still works.
export const DEFAULT_AMBIENT = [
  "Take a moment. How many different sounds can you hear right now?",
  "Look for three different shades of green before the next corner.",
  "Glance up. What is the sky doing right now?",
  "Take one slow breath in through your nose. What can you smell?",
  "Notice the ground under your feet. Is it soft, rough, warm?",
  "Is anyone else out walking? Give them a nod.",
];

export function fallbackNarration(place) {
  const wiki = place.facts.find((f) => f.startsWith("Wikipedia: "));
  const about = wiki
    ? (wiki.slice(11).match(/[^.!?]+[.!?]+/g) || []).slice(0, 2).join(" ").trim()
    : place.facts.slice(0, 2).join(". ");
  const article = /^[aeiou]/i.test(place.kind) ? "an" : "a";
  // The walk already announces the name ("On your left: Old Fort."), so start with the facts.
  return `${about || `It's ${article} ${place.kind}.`} Take a second to look at it properly.`;
}

function clean(text) {
  const flat = text
    .replace(/[*_#`>]/g, "")
    .replace(/^\s*[-•]\s*/gm, "")
    .replace(/\s+/g, " ")
    .replace(/^(okay|ok|sure)[,.!]\s*/i, "")
    .replace(/^here(’|')?s[^:]*:\s*/i, "")
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "")
    .trim();
  // Small models sometimes ramble. Keep it to three sentences, but keep the last one:
  // that's where the "look up / touch / listen" invitation lives.
  const sentences = (flat.match(/[^.!?]+[.!?]+/g) || [flat]).map((x) => x.trim());
  const kept = sentences.length > 3 ? [...sentences.slice(0, 2), sentences.at(-1)] : sentences;
  return kept.join(" ");
}
