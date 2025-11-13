// ---------------------------------------------
// Titan Depot Indexing Agent - Option B (Bing)
// ---------------------------------------------

import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import fetch from "node-fetch";
import pino from "pino";
import { google } from "googleapis";
import { CronJob } from "cron";

const {
  PORT,
  SHOPIFY_WEBHOOK_SECRET,
  BING_API_KEY,
  GSC_SITE_URL = "https://titandepot.co.uk/",
  GSC_SITEMAP_URL = "https://titandepot.co.uk/sitemap.xml",
  GOOGLE_CREDENTIALS_JSON,
} = process.env;

const log = pino({ transport: { target: "pino-pretty" } });
const app = express();

if (!BING_API_KEY) {
  log.warn("BING_API_KEY is not set; Bing submissions will be skipped until you add it.");
}
if (!SHOPIFY_WEBHOOK_SECRET) {
  log.warn("SHOPIFY_WEBHOOK_SECRET is not set; Shopify webhooks will fail verification.");
}

// Helpers
function getHostBase() {
  return "https://titandepot.co.uk";
}

// Simple pages
app.get("/", (_req, res) => res.send("Titan Indexing Agent (Bing) is running"));
app.get("/healthz", (_req, res) => res.send("ok"));

// Raw body for Shopify
app.use("/webhooks/shopify", express.raw({ type: "*/*" }));

function verifyShopifyHmac(req) {
  const hmacHeader = req.get("x-shopify-hmac-sha256");
  if (!hmacHeader || !SHOPIFY_WEBHOOK_SECRET) return false;
  const digest = createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.body, "utf8")
    .digest("base64");
  try {
    return timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

function buildPublicUrl(topic, payload) {
  const host = getHostBase();
  const isDelete = topic.endsWith("delete");

  if (topic.startsWith("products/")) {
    if (isDelete) return null; // Shopify often omits handle on delete
    return payload?.handle ? `${host}/products/${payload.handle}` : null;
  }

  if (topic.startsWith("collections/")) {
    if (isDelete) return null;
    return payload?.handle ? `${host}/collections/${payload.handle}` : null;
  }

  if (topic.startsWith("articles/")) {
    if (isDelete) return null;
    const blogHandle = payload?.blog?.handle || "news";
    return payload?.handle ? `${host}/blogs/${blogHandle}/${payload.handle}` : null;
  }

  return null;
}

// -------------------
// Bing URL Submission
// -------------------
async function submitToBing(urls) {
  if (!BING_API_KEY) {
    log.warn("BING_API_KEY missing; skipping Bing submit.");
    return;
  }

  const urlList = Array.isArray(urls) ? urls : [urls];
  const body = {
    siteUrl: getHostBase() + "/",
    urlList,
  };

  const endpoint =
    "https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlbatch?apikey=" + BING_API_KEY;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`Bing submit ${res.status}: ${txt}`);
  }

  log.info({ submitted: urlList.length, status: res.status }, "Bing submit OK");
}

// -------------------
// Google sitemap submit
// -------------------
async function submitSitemapToGSC() {
  if (!GOOGLE_CREDENTIALS_JSON) {
    log.warn("GOOGLE_CREDENTIALS_JSON not set; skipping GSC sitemap submit.");
    return;
  }

  const creds = JSON.parse(GOOGLE_CREDENTIALS_JSON);
  const normalizedKey = (creds.private_key || "").replace(/\\n/g, "\n");

  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    normalizedKey,
    ["https://www.googleapis.com/auth/webmasters"]
  );

  await jwt.authorize();
  const webmasters = google.webmasters("v3");

  await webmasters.sitemaps.submit({
    auth: jwt,
    siteUrl: GSC_SITE_URL,
    feedpath: GSC_SITEMAP_URL,
  });

  log.info("GSC sitemap submitted OK");
}

// -------------------
// Shopify webhook handler
// -------------------
app.post("/webhooks/shopify", async (req, res) => {
  try {
    if (!verifyShopifyHmac(req)) {
      log.warn("Invalid Shopify HMAC");
      return res.status(401).send("Invalid HMAC");
    }

    const topic = req.get("x-shopify-topic") || "";
    const payload = JSON.parse(req.body.toString("utf8"));
    const singleUrl = buildPublicUrl(topic, payload);

    const urls = [];
    if (singleUrl) urls.push(singleUrl);
    urls.push(`${getHostBase()}/`);
    urls.push(`${getHostBase()}/collections/all`);

    await submitToBing(urls);

    if (topic.endsWith("create") || topic.startsWith("collections/")) {
      try {
        await submitSitemapToGSC();
      } catch (e) {
        log.warn(e, "GSC submit warning");
      }
    }

    log.info({ topic, urls }, "Webhook processed");
    res.status(200).send("OK");
  } catch (err) {
    log.error(err, "Webhook error");
    res.status(500).send("ERROR");
  }
});

// Daily job 08:15 London
new CronJob(
  "15 8 * * *",
  async () => {
    try {
      await submitToBing([
        `${getHostBase()}/`,
        `${getHostBase()}/sitemap.xml`,
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

// Start server
const listenPort = Number(PORT) || 8080;
app.listen(listenPort, "0.0.0.0", () => {
  log.info(`Indexing agent (Bing) running on :${listenPort}`);
});

process.on("unhandledRejection", (err) => log.error(err, "unhandledRejection"));
process.on("uncaughtException", (err) => log.error(err, "uncaughtException"));
