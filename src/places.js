// Finds interesting places around a point using OpenStreetMap (Overpass API),
// and enriches them with Wikipedia summaries where OSM links to an article.

// Public Overpass servers are individually flaky, so we ask several and take the first good answer.
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const MAX_PLACES = 20; // plenty for an hour, and keeps planning quick

export async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("I couldn't search for places just now. Check your internet connection and try again.");
  const [hit] = await res.json();
  if (!hit) throw new Error(`I couldn't find "${query}". Try adding the town or city, like "Stone Town, Zanzibar".`);
  return { lat: +hit.lat, lon: +hit.lon, label: hit.display_name.split(",").slice(0, 2).join(",") };
}

// Only a coarse (~100 m) point is ever sent to OSM servers, and only while planning.
export const coarse = ({ lat, lon }) => ({ lat: +lat.toFixed(3), lon: +lon.toFixed(3) });

export async function reverseGeocode(point) {
  const { lat, lon } = coarse(point);
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&lat=${lat}&lon=${lon}`);
    const { address = {} } = await res.json();
    const local = address.neighbourhood || address.suburb || address.quarter || address.village || address.town;
    const city = address.city || address.town || address.county;
    return [local, city].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "your neighbourhood";
  } catch {
    return "your neighbourhood";
  }
}

export async function findPlaces(point, radius) {
  const center = coarse(point);
  const [osm, wiki] = await Promise.allSettled([osmPlaces(center, radius), wikiPlaces(center, radius)]);
  if (osm.status === "rejected" && wiki.status === "rejected")
    throw new Error("I couldn't reach the map just now. Check your internet connection and try again in a minute.");

  // OSM first: its tags are richer, so it wins when both sources know a place.
  const seen = new Set();
  const places = [];
  const candidates = [...(osm.value || []), ...(wiki.value || [])].sort((x, y) => y.score - x.score);
  for (const p of candidates) {
    p.distance = Math.round(distanceM(center, p));
    if (p.distance > radius * 1.1) continue; // big areas whose centre is far away
    const keys = [p.name.toLowerCase(), p.wikipedia?.replace(/^[a-z-]+:/, "").toLowerCase()].filter(Boolean);
    if (keys.some((k) => seen.has(k))) continue;
    // The same building is often mapped twice with slightly different names.
    if (places.some((q) => distanceM(p, q) < 60 && sharesWord(p.name, q.name))) continue;
    keys.forEach((k) => seen.add(k));
    places.push(p);
  }
  return places.slice(0, MAX_PLACES).sort((x, y) => x.distance - y.distance);
}

async function osmPlaces({ lat, lon }, radius) {
  const a = `(around:${radius},${lat},${lon})`;
  const query = `[out:json][timeout:25];
(
  nwr${a}["tourism"~"^(attraction|viewpoint|artwork|museum|picnic_site)$"];
  nwr${a}["historic"];
  nwr${a}["memorial"]["name"];
  nwr${a}["natural"~"^(peak|spring|water|wood|cliff|rock|beach|wetland|cave_entrance)$"]["name"];
  node${a}["natural"="tree"]["name"];
  node${a}["natural"="tree"]["species"];
  node${a}["natural"="tree"]["species:en"];
  node${a}["natural"="tree"]["denotation"~"^(natural_monument|landmark)$"];
  nwr${a}["leisure"~"^(park|garden|nature_reserve)$"]["name"];
  nwr${a}["amenity"~"^(place_of_worship|fountain|marketplace|library|clock)$"]["name"];
  nwr${a}["man_made"~"^(tower|lighthouse|water_tower|bridge|windmill)$"]["name"];
);
out center tags 200;`;

  const { elements } = await overpass(query);

  const places = [];
  for (const el of elements) {
    const t = el.tags || {};
    const pos = el.type === "node" ? { lat: el.lat, lon: el.lon } : el.center;
    if (!pos) continue;
    const name = nameOf(t);
    if (!name) continue;
    places.push({
      id: `${el.type}/${el.id}`,
      source: "osm",
      name,
      kind: kindOf(t),
      lat: pos.lat,
      lon: pos.lon,
      // Areas (parks, big buildings) get a wider trigger zone than single points.
      radius: el.type === "node" ? 35 : 70,
      facts: factsOf(t),
      wikipedia: t.wikipedia || null,
      score: scoreOf(t),
    });
  }
  return places;
}

// Wikipedia's geosearch: nearby articles with coordinates and an intro, in one call.
const NOT_A_SPOT = /\b(city|town|old town|historic district|district|region|ward|country|island|archipelago|municipality|village|neighbou?rhood|constituency|suburb|county|province|capital|ocean|sea|channel|human settlement|territory|diocese|archdiocese|revolution|overthrow|war|battle|coup|treaty|election|dynasty|sultanate|protectorate|team|club|company|airline|newspaper|radio|television|album|song|film|people|ethnic group|language)\b/i;

// "Fort in Zanzibar, Tanzania" -> "Fort": judge the thing itself, not where it is.
const headNoun = (description = "") => description.split(/,| in | of | on | near /)[0];

async function wikiPlaces({ lat, lon }, radius) {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*" +
    `&generator=geosearch&ggscoord=${lat}|${lon}&ggsradius=${Math.min(radius, 10000)}&ggslimit=20` +
    "&prop=coordinates|description|extracts&exintro=1&explaintext=1&exsentences=5&exlimit=20";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wikipedia: ${res.status}`);
  const pages = Object.values((await res.json()).query?.pages || {});
  return pages
    .filter((p) => p.coordinates?.[0] && p.extract && !NOT_A_SPOT.test(headNoun(p.description)))
    .map((p) => ({
      id: `wiki/${p.pageid}`,
      source: "wikipedia",
      name: p.title.replace(/\s*\(.*\)$/, ""),
      kind: p.description || "landmark",
      lat: p.coordinates[0].lat,
      lon: p.coordinates[0].lon,
      radius: 60,
      facts: [`Wikipedia: ${p.extract.slice(0, 700)}`],
      wikipedia: `en:${p.title}`,
      wikiFetched: true,
      score: 3,
    }));
}

async function overpass(query) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 25000);
  try {
    return await Promise.any(
      OVERPASS_MIRRORS.map(async (url) => {
        const res = await fetch(`${url}?data=${encodeURIComponent(query)}`, { signal: abort.signal });
        if (!res.ok) throw new Error(`${url}: ${res.status}`);
        const json = await res.json();
        if (!Array.isArray(json.elements)) throw new Error(`${url}: bad response`);
        return json;
      })
    );
  } catch {
    throw new Error("OpenStreetMap's servers are busy right now.");
  } finally {
    clearTimeout(timer);
    abort.abort(); // cancel the slower mirrors
  }
}

export async function addWikipedia(place) {
  if (!place.wikipedia || place.wikiFetched) return;
  const m = place.wikipedia.match(/^([a-z-]+):(.+)$/);
  if (!m) return;
  const [, lang, title] = m;
  try {
    const res = await fetch(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`
    );
    if (!res.ok) return;
    const { extract, coordinates } = await res.json();
    // OSM links are sometimes wrong (a Zanzibar market pointing at a building in South Carolina).
    if (coordinates && distanceM(place, coordinates) > 2000) return;
    if (extract) {
      place.facts.push(`Wikipedia: ${extract.slice(0, 700)}`);
      place.score += 3;
    }
  } catch {
    // Wikipedia is a bonus; the narration still works from OSM tags alone.
  }
}

export function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearingDeg(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const STOPWORDS = new Set(["the", "old", "house", "of", "and", "ya", "la", "le", "de", "st", "saint", "a", "an"]);
const words = (name) =>
  name.toLowerCase().normalize("NFD").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
function sharesWord(a, b) {
  const wb = words(b).map((w) => w.slice(0, 5)); // "freddy"/"freddie", "art"/"arts"
  return words(a).some((w) => wb.includes(w.slice(0, 5)));
}

const pretty = (s) => s.replace(/_/g, " ").replace(/;/g, ", ");

function nameOf(t) {
  if (t["name:en"]) return t["name:en"];
  if (t.name) return t.name;
  if (t.natural === "tree") {
    const species = t["species:en"] || t.species || t.genus;
    return species ? `A ${species} tree` : "A notable tree";
  }
  return null;
}

function kindOf(t) {
  if (t.historic) return ["yes", "true"].includes(t.historic) ? "historic site" : `historic ${pretty(t.historic)}`;
  if (t.tourism) return pretty(t.tourism);
  if (t.memorial) return `memorial (${pretty(t.memorial)})`;
  if (t.natural) return pretty(t.natural);
  if (t.leisure) return pretty(t.leisure);
  if (t.amenity === "place_of_worship") return t.religion ? `${pretty(t.religion)} place of worship` : "place of worship";
  if (t.amenity) return pretty(t.amenity);
  if (t.man_made) return pretty(t.man_made);
  return "place";
}

const FACT_TAGS = {
  description: "Description",
  inscription: "Inscription",
  start_date: "Dates from",
  architect: "Architect",
  artist_name: "Artist",
  artwork_type: "Artwork type",
  religion: "Religion",
  denomination: "Denomination",
  heritage: "Heritage listing level",
  "species:en": "Species",
  species: "Species (scientific)",
  genus: "Genus",
  leaf_type: "Leaf type",
  height: "Height (m)",
  ele: "Elevation (m)",
  denotation: "Status",
  material: "Material",
  "building:architecture": "Architectural style",
  "name:sw": "Swahili name",
  old_name: "Old name",
  alt_name: "Also called",
};

function factsOf(t) {
  const facts = [];
  for (const [tag, label] of Object.entries(FACT_TAGS)) {
    if (t[tag]) facts.push(`${label}: ${pretty(String(t[tag])).slice(0, 300)}`);
  }
  if (t.name && t["name:en"] && t.name !== t["name:en"]) facts.push(`Local name: ${t.name}`);
  return facts;
}

function scoreOf(t) {
  let s = Object.keys(FACT_TAGS).some((k) => t[k]) ? 0 : -2; // nothing to say about it
  if (t.wikipedia || t.wikidata) s += 3;
  if (t.historic || t.tourism) s += 2;
  if (t.description || t.inscription) s += 2;
  if (t.natural === "tree") s += 1;
  if (t.heritage) s += 1;
  return s;
}
