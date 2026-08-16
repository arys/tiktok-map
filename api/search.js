import { runSearch } from "../lib/pipeline.js";

export default async function handler(req, res) {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing query ?q=" });
  try {
    const payload = await runSearch(q);
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate");
    res.status(200).json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
}
