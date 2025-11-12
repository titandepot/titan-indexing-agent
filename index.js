// -----------------------------
// Titan Depot Indexing Agent
// -----------------------------

import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import pino from "pino";
import { google } from "googleapis";
import { CronJob } from "cron";

// === Read environment variables (you’ll set these on Render later) ===
const {
  PORT = 8080,
  SHOPIFY_WEBHOOK_SECRET,
  INDEXNOW_KEY,
  INDEXNOW_KEY_URL,
  GSC_SITE_URL,
  GSC_SITEMAP_URL,
  GOOGLE_CREDENTIALS_JSON,
} = process.env;

const log = pino({ transport: { target: "pino-pretty" } });
const app = express();

// Shopify sends a raw body; we must not parse JSON yet
app.use("/webhooks/shopify", express.raw({ type: "*/*" }));

// --- Verify Shopify webhook using HMAC ---
function verifyShopifyHmac(req) {
  const hmac = req.get("x-shopify-hmac-sha256");
  if (!hmac) return false;
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.body, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

// --- Build the public URL from Shopify payload ---
function buildPublicUrl(topic, payload) {
  const host = "https://titandepot.co.uk";
  if (topic.startsWith("products/")) return `${host}/products/${payload.handle}`;
  if (topic.startsWith("collections/")) return `${host}/collections/${payload.handle}`;
  if (topic.startsWith("articles/")) {
    const blogHandle = payload.blog?.handle || "news";
    return `${host}/blogs/${blogHandle}/${payload.handle}`;
  }
  return null;
}

// --- Send URLs to IndexNow (Bing + partners) ---
async function submitIndexNow(urls) {
  const body = {
    host: "titandepot.co.uk",
    key: INDEXNOW_KEY,
    keyLocation: INDEXNOW_KEY_URL,
    urlList: Array.isArray(urls) ? urls : [urls],
  };
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IndexNow failed ${res.status}: ${text}`);
  }
  return true;
}

// --- Tell Google that sitemap is updated ---
async function submitSitemapToGSC() {
  const creds = JSON.parse(GOOGLE_CREDENTIALS_JSON);
  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/webmasters"]
  );
  await jwt.authorize();
  const webmasters = google.webmasters("v3");
  await webmasters.sitemaps.submit({
    auth: jwt,
    siteUrl: GSC_SITE_URL,
    feedpath: GSC_SITEMAP_URL,
  });
  log.info("Sitemap submitted to Google Search Console");
}

// --- Webhook endpoint that Shopify will call ---
app.post("/webhooks/shopify", async (req, res) => {
  try {
    if (!verifyShopifyHmac(req)) return res.status(401).send("Invalid HMAC");
    const topic = req.get("x-shopify-topic") || "";
    const payload = JSON.parse(req.body.toString("utf8"));
    const url = buildPublicUrl(topic, payload);

    const urls = [];
    if (url) urls.push(url);
    // Always include main pages
    urls.push("https://titandepot.co.uk/");
    urls.push("https://titandepot.co.uk/collections/all");

    await submitIndexNow(urls);
    if (topic.endsWith("create") || topic.startsWith("collections/")) {
      await submitSitemapToGSC();
    }

    log.info({ topic, urls }, "Indexed");
    res.status(200).send("OK");
  } catch (err) {
    log.error(err, "Webhook error");
    res.status(500).send("ERROR");
  }
});

// --- Daily job at 08:15 London time ---
new CronJob(
  "15 8 * * *",
  async () => {
    try {
      await submitIndexNow([
        "https://titandepot.co.uk/",
        "https://titandepot.co.uk/sitemap.xml",
      ]);
      await submitSitemapToGSC();
      log.info("Daily health submit complete");
    } catch (e) {
      log.error(e, "Daily job failed");
    }
  },
  null,
  true,
  "Europe/London"
);

// --- Simple health page ---
app.get("/healthz", (req, res) => res.send("ok"));

app.listen(PORT, () => log.info(`Indexing agent running on port ${PORT}`));
