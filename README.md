# TIKMAP

Type a craving like **"breakfast in budapest"** → the app searches viral TikToks, extracts the venues with AI, geocodes them, and pins them on a map.

## Pipeline

1. **TikAPI** (`GET /public/search/videos`) — fetches ~40 TikTok videos for the query (2 pages via `nextCursor`)
2. **Gemini 2.5 Flash** — reads all video captions in one call and extracts named venues as structured JSON (`{videoIndex, place, city, query}`)
3. **Google Places (Text Search, v1)** — geocodes each unique venue to lat/lng, address, rating, Google Maps link
4. **Leaflet** frontend — dark map with numbered pins, ranked by total TikTok plays; each place card links back to the source videos

Results are cached in memory for 30 minutes per query.

## Run

```bash
npm install
npm start          # http://localhost:3000
PORT=3456 npm start  # alternate port
```

Requires `.env` with:

```
TIK_API_KEY=...
GOOGLE_PLACES_API_KEY=...   # Places API (New) must be enabled
GEMINI_API_KEY=...
```

## Endpoints

- `GET /` — the map UI
- `GET /api/search?q=<query>` — JSON: `{query, videosScanned, places: [{name, lat, lng, address, rating, ratingCount, mapsUri, totalPlays, videos: [{url, author, desc, cover, plays}]}]}`
