require("dotenv").config();

const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const express = require("express");
const multer = require("multer");
const path = require("path");
const cors = require("cors");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(process.cwd(), "public")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const SYSTEM_INSTRUCTIONS = `
You are a precise document analyst. Output one JSON object only. No prose. No code fences.

Detect "document_type" in "receipt", "invoice", or "other".

If "document_type" is "receipt" or "invoice", return this object. Missing data becomes empty string or empty array.

{
  "document_type": "receipt",
  "vendor_name": "",
  "vendor_address": "",
  "vendor_phone": "",
  "date": "",
  "time": "",
  "currency": "",
  "invoice_number": "",
  "order_number": "",
  "payment_method": "",
  "last4": "",
  "items": [
    {"name": "", "qty": "", "unit_price": "", "line_total": "", "sku": ""}
  ],
  "subtotal": "",
  "taxes": [ {"name": "", "rate": "", "amount": ""} ],
  "discounts": [ {"name": "", "amount": ""} ],
  "fees": [ {"name": "", "amount": ""} ],
  "tips": "",
  "total": "",
  "notes": "",
  "confidence": {"total": 0, "items": 0}
}

If the file is not a receipt or invoice, return:
{
  "document_type":"other",
  "title":"",
  "summary":"",
  "notes":""
}

Normalization rules:
1) All money values are plain strings using a dot as decimal separator with two decimals when possible
2) "qty" is a plain string and prefer an integer when possible
3) If multiple taxes exist, fill the "taxes" array with one entry per tax, and put the rate number only in "rate" without the percent sign
4) Compute "subtotal" as the sum of "line_total" when possible
5) Compute a candidate grand total as subtotal plus all tax and fee and tip amounts minus all discounts
6) If the printed total and your computed total differ by more than one percent, keep the printed total in "total" and add a one line warning in "notes"
`;

function buildUserPrompt(filename) {
  return `Analyze the uploaded file named ${filename}. Extract data per the schema. Respond in pure JSON only. No markdown. No backticks.`;
}

function extractJsonMaybe(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1]) return fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return text.slice(first, last + 1).trim();
  }
  return null;
}

async function callGemini(base64, mime, filename) {
  if (!GOOGLE_API_KEY) throw new Error("Missing GOOGLE_API_KEY");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GOOGLE_API_KEY}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: SYSTEM_INSTRUCTIONS },
          { text: buildUserPrompt(filename) },
          { inline_data: { mime_type: mime, data: base64 } }
        ]
      }
    ],
    generationConfig: { temperature: 0.2 }
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Gemini HTTP ${res.status}: ${t}`);
    }
    const data = await res.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") ||
      JSON.stringify(data);
    return text;
  } catch (e) {
    throw new Error(`Gemini fetch failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

app.post("/analyze", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { originalname, mimetype, buffer } = req.file;
    const base64 = buffer.toString("base64");

    const rawText = await callGemini(base64, mimetype, originalname);

    const cleaned = extractJsonMaybe(rawText);
    let parsed;
    try {
      parsed = JSON.parse(cleaned || rawText);
    } catch {
      parsed = { document_type: "other", title: "Analysis", summary: "", notes: rawText };
    }

    res.json({ ok: true, data: parsed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
