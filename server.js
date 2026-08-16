import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { runSearch } from "./lib/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing query ?q=" });
  try {
    res.json(await runSearch(q));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`tiktok-map running → http://localhost:${PORT}`);
});
