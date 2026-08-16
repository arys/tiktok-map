// Shared search pipeline: TikAPI → Gemini extraction → Google Places geocoding.
// Used by both server.js (local Express) and api/search.js (Vercel function).

const TIK_API_KEY = process.env.TIK_API_KEY;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// simple in-memory cache so repeated searches don't re-spend API quota
const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;

// ---------- TikTok search (TikAPI public search) ----------
async function searchTikTok(query, pages = 2) {
  const items = [];
  let cursor;
  for (let p = 0; p < pages; p++) {
    const url = new URL("https://api.tikapi.io/public/search/videos");
    url.searchParams.set("query", query);
    if (cursor) url.searchParams.set("nextCursor", cursor);
    const res = await fetch(url, { headers: { "X-API-KEY": TIK_API_KEY } });
    if (!res.ok) {
      if (items.length) break; // keep what we already have
      throw new Error(`TikAPI error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    items.push(...(data.item_list || []));
    cursor = data.nextCursor;
    if (!data.has_more || !cursor) break;
  }
  return items.map((it, i) => ({
    index: i,
    id: it.id,
    desc: it.desc || "",
    author: it.author?.uniqueId || "",
    authorName: it.author?.nickname || "",
    avatar: it.author?.avatarThumb || "",
    cover: it.video?.cover || "",
    url: `https://www.tiktok.com/@${it.author?.uniqueId}/video/${it.id}`,
    plays: it.stats?.playCount || 0,
    likes: it.stats?.diggCount || 0,
    saves: it.stats?.collectCount || 0,
  }));
}

// ---------- Gemini: extract venue names from video descriptions ----------
async function extractPlaces(userQuery, videos) {
  const compact = videos.map((v) => ({ i: v.index, author: v.author, desc: v.desc.slice(0, 500) }));
  const prompt = `You are extracting real-world venues (restaurants, cafes, bars, bakeries, attractions, shops) from TikTok video descriptions.

The user searched TikTok for: "${userQuery}"

Videos (JSON): each has "i" (index), "author" (creator handle), "desc" (caption).
${JSON.stringify(compact)}

Rules:
- Extract only specific, named physical venues actually mentioned or clearly identifiable in the caption (📍 pins, "at X", venue names, or a creator handle that IS the venue, e.g. a cafe's own account).
- Skip videos with no identifiable venue. Never invent names.
- Infer the city from the caption or from the user's search query.
- "query" must be a Google Maps text search string: venue name + city (+ street if given).
- The same venue mentioned in several videos must use the exact same "place" spelling each time.

Return a JSON array of objects: {"i": <video index>, "place": "<venue name>", "city": "<city>", "query": "<maps search string>"}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                i: { type: "INTEGER" },
                place: { type: "STRING" },
                city: { type: "STRING" },
                query: { type: "STRING" },
              },
              required: ["i", "place", "query"],
            },
          },
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

// ---------- Google Places: geocode a venue ----------
async function geocodePlace(query) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.location,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri,places.primaryTypeDisplayName",
    },
    body: JSON.stringify({ textQuery: query }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const p = data.places?.[0];
  if (!p) return null;
  return {
    placeId: p.id,
    name: p.displayName?.text || query,
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    address: p.formattedAddress || "",
    rating: p.rating || null,
    ratingCount: p.userRatingCount || 0,
    mapsUri: p.googleMapsUri || "",
    type: p.primaryTypeDisplayName?.text || "",
  };
}

// ---------- Orchestration ----------
export async function runSearch(q) {
  const cached = cache.get(q.toLowerCase());
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const videos = await searchTikTok(q);
  if (!videos.length) return { query: q, videosScanned: 0, places: [] };

  const extractions = await extractPlaces(q, videos);

  // group extractions by venue (normalized name+city)
  const groups = new Map();
  for (const ex of extractions) {
    const video = videos[ex.i];
    if (!video || !ex.place) continue;
    const key = `${ex.place}|${ex.city || ""}`.toLowerCase().replace(/\s+/g, " ");
    if (!groups.has(key)) groups.set(key, { place: ex.place, city: ex.city || "", query: ex.query, videos: [] });
    groups.get(key).videos.push(video);
  }

  // geocode each unique venue in parallel
  const geocoded = await Promise.all(
    [...groups.values()].map(async (g) => {
      const geo = await geocodePlace(g.query || `${g.place} ${g.city}`);
      return geo && geo.lat != null ? { ...geo, city: g.city, videos: g.videos } : null;
    })
  );

  // merge venues that geocoded to the same Google place
  const byPlaceId = new Map();
  for (const g of geocoded.filter(Boolean)) {
    const existing = byPlaceId.get(g.placeId);
    if (existing) {
      const seen = new Set(existing.videos.map((v) => v.id));
      existing.videos.push(...g.videos.filter((v) => !seen.has(v.id)));
    } else {
      byPlaceId.set(g.placeId, g);
    }
  }

  const places = [...byPlaceId.values()]
    .map((p) => ({ ...p, totalPlays: p.videos.reduce((s, v) => s + v.plays, 0) }))
    .sort((a, b) => b.totalPlays - a.totalPlays);

  const payload = { query: q, videosScanned: videos.length, places };
  cache.set(q.toLowerCase(), { at: Date.now(), data: payload });
  return payload;
}
