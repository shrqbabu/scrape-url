import puppeteer from "puppeteer-core";

const BROWSERLESS_API_KEY = [
  ...(process.env.BROWSERLESS_API_KEY || "2VPrd9d9J6Gtzouf167dfe599cda46fb4799f789ef7ed00a5").split(",")
].map(k => k.trim()).filter(Boolean);

const ZENROWS_API_KEY = [
  ...(process.env.ZENROWS_API_KEY || "f69ce7f2c0a17dcb2fb4c073f24442893b60328a").split(",")
].map(k => k.trim()).filter(Boolean);

const SCRAPINGANT_API_KEY = (process.env.SCRAPINGANT_API_KEY || "").trim();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const TABLE_NAME = "live_channels";

const CHANNELS_TO_UPDATE = [
  { id: "star4b", name: "Star Sports 1 (Hi)", pageUrl: "https://playsza.ru/uembed.php?v=star4b", referer: "https://playsza.ru/", language: "Hindi", category: "Cricket" },
  { id: "ptvskpr", name: "PTV Sports Live", pageUrl: "https://playsza.ru/uembed.php?v=ptvskpr", referer: "https://playsza.ru/", language: "Hindi", category: "Cricket" },
  { id: "star2u", name: "Star Sports 2 (Eng)", pageUrl: "https://playsza.ru/uembed.php?v=star2u", referer: "https://playsza.ru/", language: "English", category: "Cricket" }
];

function randomKey(keys) {
  return keys.length ? keys[Math.floor(Math.random() * keys.length)] : null;
}

function unpackPackedJs(html) {
  let unpackedAll = "";
  const packedRegex = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[rd]\s*\)\s*\{[\s\S]+?\}\s*\(\s*['"]([\s\S]+?)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]([\s\S]+?)['"]\.split\(['"]\|['"]\)/g;
  let match;
  while ((match = packedRegex.exec(html || "")) !== null) {
    try {
      let p = match[1];
      const a = parseInt(match[2], 10);
      let c = parseInt(match[3], 10);
      const k = match[4].split("|");
      const e = (val) => (val < a ? "" : e(Math.floor(val / a))) + ((val = val % a) > 35 ? String.fromCharCode(val + 29) : val.toString(36));
      while (c--) {
        if (k[c]) {
          p = p.replace(new RegExp("\\b" + e(c) + "\\b", "g"), k[c]);
        }
      }
      unpackedAll += "\n" + p;
    } catch (_) {}
  }
  return unpackedAll;
}

function extractM3u8FromHtml(html, baseUrl) {
  if (!html) return null;

  const unpacked = unpackPackedJs(html);
  const cleaned = (html + "\n" + unpacked)
    .replace(/\\\//g, "/")
    .replace(/\\u002F/gi, "/");

  const direct = cleaned.match(/(?:https?:)?\/\/[^"'`\s<>]+?\.m3u8(?:\?[^"'`\s<>]*)?/i);
  if (direct) {
    let url = direct[0];
    if (url.startsWith("//")) url = "https:" + url;
    return url;
  }

  const b64 = cleaned.match(/[A-Za-z0-9+/=]{20,}/g) || [];
  for (const item of b64) {
    try {
      const decoded = Buffer.from(item, "base64").toString("utf8");
      if (decoded.includes(".m3u8")) {
        const match = decoded.match(/(?:https?:)?\/\/[^"'`\s<>]+?\.m3u8(?:\?[^"'`\s<>]*)?/i);
        if (match) {
          let url = match[0];
          if (url.startsWith("//")) url = "https:" + url;
          return url;
        }
      }
    } catch (_) {}
  }

  if (baseUrl) {
    const relMatch = cleaned.match(/["'](\/[^"'`\s<>]+\.m3u8(?:\?[^"'`\s<>]*)?)["']/i);
    if (relMatch) {
      try {
        return new URL(relMatch[1], baseUrl).toString();
      } catch (_) {}
    }
  }

  return null;
}

function findEmbeddedIframes(html, baseUrl) {
  const urls = [];
  const regex = /<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html || "")) !== null) {
    try {
      const url = new URL(match[1], baseUrl).toString();
      if (url.startsWith("http:") || url.startsWith("https:")) urls.push(url);
    } catch (_) {}
  }
  return [...new Set(urls)];
}

// 1. Browserless with explicit /stealth endpoint & Cloudflare clearance loop
async function fetchWithBrowserless(targetUrl) {
  const key = randomKey(BROWSERLESS_API_KEY);
  if (!key) throw new Error("No Browserless API key configured");

  // /stealth is required to bypass Cloudflare Turnstile
  const endpoint = `wss://production-sfo.browserless.io/stealth?token=${encodeURIComponent(key)}&proxy=residential&proxyCountry=in&blockAds=true`;
  let browser;

  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: endpoint,
      defaultViewport: { width: 1280, height: 720 }
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      Referer: "https://playsza.xyz/"
    });

    let capturedUrl = null;
    let resolveCapture;
    const capturePromise = new Promise(resolve => { resolveCapture = resolve; });

    const handleIntercept = (url) => {
      if (url && /\.m3u8(\?|$)/i.test(url) && !capturedUrl) {
        capturedUrl = url;
        resolveCapture(url);
      }
    };

    page.on("request", req => handleIntercept(req.url()));
    page.on("response", res => handleIntercept(res.url()));

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});

    // Wait for Cloudflare "Just a moment..." challenge to clear
    for (let i = 0; i < 15; i++) {
      const title = await page.title().catch(() => "");
      if (!/just a moment|checking your browser/i.test(title)) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    // Click play buttons or interact with player
    await page.evaluate(() => {
      const btn = document.querySelector(".play-button, button, video, .vjs-big-play-button");
      if (btn) btn.click();
    }).catch(() => {});

    const streamUrl = await Promise.race([
      capturePromise,
      new Promise(resolve => setTimeout(() => resolve(null), 8000))
    ]);

    if (streamUrl) {
      return { streamUrl, html: "" };
    }

    const html = await page.content();
    return { streamUrl: null, html };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// 2. ZenRows with WebSocket support and automatic REST fallback
async function fetchWithZenRows(targetUrl) {
  const key = randomKey(ZENROWS_API_KEY);
  if (!key) throw new Error("No ZenRows API key configured");

  // Attempt Puppeteer WebSocket first
  try {
    const wsEndpoint = `wss://browser.zenrows.com?apikey=${encodeURIComponent(key)}`;
    const browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: { width: 1280, height: 720 }
    });

    try {
      const page = await browser.newPage();
      await page.setExtraHTTPHeaders({ Referer: "https://playsza.xyz/" });

      let capturedUrl = null;
      let resolveCapture;
      const capturePromise = new Promise(resolve => { resolveCapture = resolve; });

      const handleIntercept = (url) => {
        if (url && /\.m3u8(\?|$)/i.test(url) && !capturedUrl) {
          capturedUrl = url;
          resolveCapture(url);
        }
      };

      page.on("request", req => handleIntercept(req.url()));
      page.on("response", res => handleIntercept(res.url()));

      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});

      for (let i = 0; i < 10; i++) {
        const title = await page.title().catch(() => "");
        if (!/just a moment|checking/i.test(title)) break;
        await new Promise(r => setTimeout(r, 1000));
      }

      await page.evaluate(() => {
        const btn = document.querySelector(".play-button, button, video, .vjs-big-play-button");
        if (btn) btn.click();
      }).catch(() => {});

      const streamUrl = await Promise.race([
        capturePromise,
        new Promise(resolve => setTimeout(() => resolve(null), 7000))
      ]);

      if (streamUrl) return { streamUrl, html: "" };

      const html = await page.content();
      return { streamUrl: null, html };
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (wsErr) {
    console.log(`   ↳ [ZenRows WS failed (${wsErr.message.slice(0, 40)}), falling back to REST API]`);

    // REST API fallback with anti-bot
    const endpoint = new URL("https://api.zenrows.com/v1/");
    endpoint.searchParams.set("url", targetUrl);
    endpoint.searchParams.set("apikey", key);
    endpoint.searchParams.set("js_render", "true");
    endpoint.searchParams.set("antibot", "true");
    endpoint.searchParams.set("premium_proxy", "true");
    endpoint.searchParams.set("wait", "6000");

    const res = await fetch(endpoint, { signal: AbortSignal.timeout(45000) });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 160);
      throw new Error(`ZenRows HTTP ${res.status}: ${body}`);
    }
    const html = await res.text();
    return { streamUrl: null, html };
  }
}

// 3. ScrapingAnt REST API
async function fetchWithScrapingAnt(targetUrl) {
  if (!SCRAPINGANT_API_KEY) throw new Error("No ScrapingAnt API key configured");

  await new Promise(resolve => setTimeout(resolve, 2000));

  const endpoint = new URL("https://api.scrapingant.com/v2/general");
  endpoint.searchParams.set("url", targetUrl);
  endpoint.searchParams.set("x-api-key", SCRAPINGANT_API_KEY);
  endpoint.searchParams.set("browser", "true");
  endpoint.searchParams.set("return_page_source", "true");

  const res = await fetch(endpoint, { signal: AbortSignal.timeout(50000) });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 160);
    throw new Error(`ScrapingAnt HTTP ${res.status}: ${body}`);
  }
  const html = await res.text();
  if (!html.trim()) throw new Error("Empty HTML response");
  return { streamUrl: null, html };
}

const PROVIDERS = [
  { name: "Browserless", enabled: () => BROWSERLESS_API_KEY.length > 0, fetch: fetchWithBrowserless },
  { name: "ZenRows", enabled: () => ZENROWS_API_KEY.length > 0, fetch: fetchWithZenRows },
  { name: "ScrapingAnt", enabled: () => Boolean(SCRAPINGANT_API_KEY), fetch: fetchWithScrapingAnt }
];

async function fetchM3u8WithFallback(targetUrl) {
  const failures = [];

  for (const provider of PROVIDERS) {
    if (!provider.enabled()) {
      console.log(`[${provider.name}] Skipped: API key not configured`);
      continue;
    }

    try {
      console.log(`[${provider.name}] Fetching ${targetUrl}`);
      const result = await provider.fetch(targetUrl);
      let streamUrl = result.streamUrl || extractM3u8FromHtml(result.html, targetUrl);

      if (!streamUrl && result.html) {
        const frames = findEmbeddedIframes(result.html, targetUrl).filter(url =>
          url !== targetUrl && !/ads|doubleclick|dtscout/i.test(url)
        );

        for (const frameUrl of frames.slice(0, 3)) {
          try {
            console.log(`   ↳ [${provider.name}] Checking embedded frame: ${frameUrl}`);
            const frameResult = await provider.fetch(frameUrl);
            streamUrl = frameResult.streamUrl || extractM3u8FromHtml(frameResult.html, frameUrl);
            if (streamUrl) break;
          } catch (err) {
            console.log(`   ↳ Frame fetch failed: ${err.message}`);
          }
        }
      }

      if (streamUrl) {
        console.log(`[${provider.name}] M3U8 found`);
        return { streamUrl, provider: provider.name };
      }

      const titleMatch = result.html ? result.html.match(/<title[^>]*>([^<]*)<\/title>/i) : null;
      const title = titleMatch ? titleMatch[1].trim() : "No title";
      throw new Error(`No M3U8 found (HTML ${result.html ? result.html.length : 0} chars; title: ${title})`);
    } catch (err) {
      const message = err?.message || String(err);
      console.error(`[${provider.name}] ${message}`);
      failures.push(`${provider.name}: ${message}`);
    }
  }

  throw new Error(failures.length
    ? `All configured providers failed:\n${failures.join("\n")}`
    : "No provider API keys configured. Set Browserless, ZenRows, or ScrapingAnt key.");
}

async function updateChannelInSupabase(channel, streamUrl) {
  if (!SUPABASE_KEY) {
    throw new Error("SUPABASE_KEY secret is missing");
  }

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };

  const patchUrl = `${SUPABASE_URL}/rest/v1/${TABLE_NAME}?id=eq.${encodeURIComponent(channel.id)}`;
  const patchRes = await fetch(patchUrl, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      stream_url: streamUrl,
      referer: channel.referer || "https://playsza.xyz/"
    })
  });

  const patchText = await patchRes.text();
  let patchData = [];
  try { patchData = patchText ? JSON.parse(patchText) : []; } catch (_) {}

  if (!patchRes.ok) {
    throw new Error(`Supabase PATCH HTTP ${patchRes.status}: ${patchText.slice(0, 250)}`);
  }

  if (Array.isArray(patchData) && patchData.length > 0) {
    console.log(`[Supabase] Updated ${channel.id} (${channel.name})`);
    return;
  }

  const insertUrl = `${SUPABASE_URL}/rest/v1/${TABLE_NAME}`;
  const insertRes = await fetch(insertUrl, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      id: channel.id,
      title: channel.name,
      stream_url: streamUrl,
      cdn_url: streamUrl,
      referer: channel.referer || "https://playsza.xyz/",
      poster_url: channel.poster_url || "https://crichd.mobile/assets/channels/willow.webp",
      category: channel.category || "Cricket",
      language: channel.language || "Hindi",
      quality: "1080p HD",
      plot: `Live ${channel.name} Stream`,
      is_active: true,
      sort_order: 101
    })
  });

  if (!insertRes.ok) {
    throw new Error(`Supabase INSERT HTTP ${insertRes.status}: ${(await insertRes.text()).slice(0, 250)}`);
  }
  console.log(`[Supabase] Inserted ${channel.id} (${channel.name})`);
}

async function runCycle() {
  console.log(`\n========== PROVIDER FALLBACK RUN ${new Date().toISOString()} ==========`);

  if (!PROVIDERS.some(provider => provider.enabled())) {
    console.error("No provider API key configured");
    process.exitCode = 1;
    return;
  }

  let failedChannels = 0;

  for (const channel of CHANNELS_TO_UPDATE) {
    console.log(`\n>>> ${channel.name}`);
    try {
      const result = await fetchM3u8WithFallback(channel.pageUrl);
      console.log(`Provider used: ${result.provider}`);
      console.log(`M3U8 captured (${result.streamUrl.length} chars)`);
      await updateChannelInSupabase(channel, result.streamUrl);
    } catch (err) {
      failedChannels++;
      console.error(`[${channel.name}] ${err.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  console.log(`\n========== RUN FINISHED: ${failedChannels} channel(s) failed ==========`);
  if (failedChannels > 0) process.exitCode = 1;
}

runCycle().catch(err => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
