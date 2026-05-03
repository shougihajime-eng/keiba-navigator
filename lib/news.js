"use strict";
const { fetchUrl, getCache, setCache } = require("./fetch");

const TTL_MS = 10 * 60 * 1000;

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
          .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function extractTag(block, tag) {
  const re = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + tag + ">", "i");
  const m = block.match(re);
  if (!m) return null;
  let s = m[1].trim().replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
  return decodeEntities(s);
}

function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    items.push({
      title:      extractTag(block, "title"),
      link:       extractTag(block, "link"),
      pubDate:    extractTag(block, "pubDate"),
      sourceName: extractTag(block, "source") || null,
    });
  }
  return items;
}

async function fetchNews(query = "競馬") {
  const key = "news:" + query;
  const cached = getCache(key, TTL_MS);
  if (cached) return cached;
  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=ja&gl=JP&ceid=JP:ja";
  try {
    const r = await fetchUrl(url);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const items = parseRss(r.body).slice(0, 12);
    const data = {
      ok: true,
      fetchedAt: new Date().toISOString(),
      source: "Google News RSS (news.google.com)",
      items,
    };
    setCache(key, data);
    return data;
  } catch (e) {
    return { ok: false, error: String(e.message || e), source: "Google News RSS" };
  }
}

module.exports = { fetchNews };
