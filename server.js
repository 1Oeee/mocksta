import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// JSON for non-reference requests
app.use(express.json({ limit: "2mb" }));

// Static
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Folders
const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const POSTS_PATH = path.join(DATA_DIR, "posts.json");
if (!fs.existsSync(POSTS_PATH)) fs.writeFileSync(POSTS_PATH, "[]", "utf8");

// OpenAI
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Multer for multipart/form-data reference uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

function readPosts() {
  try {
    return JSON.parse(fs.readFileSync(POSTS_PATH, "utf8"));
  } catch {
    return [];
  }
}

function writePosts(posts) {
  fs.writeFileSync(POSTS_PATH, JSON.stringify(posts, null, 2), "utf8");
}

function safeText(s, max = 800) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function generateCaption(prompt) {
  const r = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content:
          "Write a short Instagram caption. Output ONLY the caption. 1-2 sentences and up to 5 hashtags max."
      },
      { role: "user", content: prompt }
    ]
  });
  return safeText(r.output_text, 400);
}

async function openaiImageEditJSON({ prompt, dataUrl }) {
  const r = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      input_fidelity: "high",
      size: "1024x1024",
      images: [{ image_url: dataUrl }]
    })
  });

  const text = await r.text();

  if (!r.ok) {
    try {
      const j = JSON.parse(text);
      throw new Error(j?.error?.message || text);
    } catch {
      throw new Error(text);
    }
  }

  return JSON.parse(text);
}

async function generateImage(prompt) {
  const img = await client.images.generate({
    model: "gpt-image-1",
    prompt: `Photorealistic Instagram-style photo. ${prompt}`,
    size: "1024x1024"
  });

  const b64 = img.data?.[0]?.b64_json;
  if (!b64) throw new Error("No image data returned from images.generate.");

  const buf = Buffer.from(b64, "base64");
  const filename = `${Date.now()}_${crypto.randomBytes(6).toString("hex")}.png`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);

  return `/uploads/${filename}`;
}

async function editImageWithReference(prompt, file) {
  const mime = file.mimetype || "image/png";
  const dataUrl = `data:${mime};base64,${file.buffer.toString("base64")}`;

  const edited = await openaiImageEditJSON({
    prompt: `Use the reference image as identity/style anchor. ${prompt}`,
    dataUrl
  });

  const b64 = edited.data?.[0]?.b64_json;
  if (!b64) throw new Error("No image data returned from images/edits.");

  const buf = Buffer.from(b64, "base64");
  const filename = `${Date.now()}_${crypto.randomBytes(6).toString("hex")}.png`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);

  return `/uploads/${filename}`;
}

// Endpoints
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/posts", (req, res) => {
  const posts = readPosts();
  posts.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  res.json({ posts });
});

app.post("/api/generate-post", upload.array("ref", 8), async (req, res) => {
  try {
    let prompt = safeText(req.body?.prompt, 800);
    if (!prompt) {
      prompt = await generateAutoPrompt();
    }

    const caption = await generateCaption(prompt);

    const firstFile = req.files?.[0];
    let imageUrl;
    if (firstFile) imageUrl = await editImageWithReference(prompt, firstFile);
    else imageUrl = await generateImage(prompt);

    const post = {
      id: crypto.randomBytes(10).toString("hex"),
      createdAt: Date.now(),
      prompt,
      caption,
      imageUrl,
      user: { handle: "mocksta_ai", displayName: "Mocksta AI" },
      stats: {
        likes: Math.floor(Math.random() * 5000) + 10,
        comments: Math.floor(Math.random() * 120)
      }
    };

    const posts = readPosts();
    posts.push(post);
    writePosts(posts);

    res.json({ post });
  } catch (e) {
    console.log("---- GENERATION ERROR ----");
    console.log(e);

    if (e?.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "Reference image too large (LIMIT_FILE_SIZE)" });
    }

    const msg =
      e?.error?.message ||
      e?.response?.data?.error?.message ||
      e?.message ||
      "generation failed";

    return res.status(500).json({ error: msg });
  }
});

// Express global error handler
app.use((err, req, res, next) => {
  console.log("---- EXPRESS ERROR ----");
  console.log(err);
  res.status(500).json({ error: err?.message || "Unhandled server error" });
});

// Listen
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`running http://localhost:${port}`));

async function generateAutoPrompt() {
  const activities = [
    "walking through a neighborhood at golden hour",
    "hiking on a forest trail",
    "waiting for a train on a platform",
    "sitting in the back seat of a taxi at night",
    "at a grocery store aisle holding a basket",
    "cooking at home in a small kitchen",
    "at the gym mirror after a workout (subtle, not influencer)",
    "at a beach promenade with wind in hair",
    "at a museum exhibit, casual selfie with art behind",
    "at an outdoor market with stalls",
    "on a boat ferry deck with water behind",
    "on a snowy street in winter clothes",
    "in an airport terminal with carry-on bag",
    "in a park on a bench, earbuds in",
    "at a friend's house party (1–3 people in background)",
    "on a road trip, stopping at a roadside viewpoint",
    "at a festival crowd (non-branded, generic)",
    "at a lake at sunset",
    "in a hotel room mirror while traveling",
    "cycling slowly on a bike path"
  ];

  const locations = [
    "Stockholm", "Gothenburg", "a small coastal town", "a mountain village",
    "a Mediterranean street", "a quiet suburb", "a city center", "a countryside road"
  ];

  const cameraFeels = [
    "handheld phone selfie, slightly imperfect framing",
    "front camera selfie with mild motion blur",
    "grainy low-light selfie, natural noise",
    "sunlit selfie with soft shadows",
    "overcast daylight selfie, muted tones"
  ];

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const seed = `Scene seed: ${pick(activities)}. Location vibe: ${pick(locations)}. Camera: ${pick(cameraFeels)}.`;

  const r = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content:
          "Write ONE single-sentence image prompt for a photorealistic amateur phone selfie of a normal person. " +
          "It must feel like real life, not staged, not influencer. No brand names. No celebrities. " +
          "Avoid repeating the same theme. " +
          "Make sure the images look natural and amateur and not overly polished. " +
          "Just use the face of the reference image if provided, not the background or other elements. " +
          "Include: place + action + time/weather + mood + camera feel. Output only the prompt."
      },
      {
        role: "user",
        content:
          "Use this seed, but rewrite it naturally into one coherent prompt: " + seed +
          " Make it varied and everyday-life realistic."
      }
    ]
  });

  return safeText(r.output_text, 260);
}
