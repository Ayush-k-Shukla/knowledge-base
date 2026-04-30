import * as cheerio from 'cheerio';

async function testScrape() {
  const query = 'Node.js release date';
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  });

  const html = await response.text();
  const $ = cheerio.load(html);

  const results: any[] = [];
  $('.result').slice(0, 3).each((i, el) => {
    const title = $(el).find('.result__title').text().trim();
    const snippet = $(el).find('.result__snippet').text().trim();
    if (title && snippet) {
      results.push({ title, snippet });
    }
  });

  console.log('Results:', results);
}

testScrape().catch(console.error);
