#!/usr/bin/env node
/**
 * Standalone BBC News fetcher for Node.js panels.
 * Usage: node scripts/news.js [limit]
 *
 * The WhatsApp bot uses the same scraper from the feature media bundle.
 */
const { scrapeNews } = require('../src/features').bbcNews;

async function main() {
  const raw = Number(process.argv[2] || 10);
  const limit = Math.min(Math.max(Number.isFinite(raw) ? Math.trunc(raw) : 10, 1), 10);
  const articles = await scrapeNews(limit);

  if (!articles.length) {
    console.log(JSON.stringify({ ok: false, error: 'BBC returned no headlines.' }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({ ok: true, source: 'BBC News', articles }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exitCode = 1;
});
