// Keyless daily news picker for "general awareness" videos.
//
// Each run picks ONE fresh story, rotating through categories so the channel
// covers entertainment, world/breaking news, AI, gold prices and major
// accidents/disasters in turn. Stories come from public RSS feeds of established
// publishers (no API key). The article text is fetched so the script can be
// written ONLY from reported facts; the source links go into the description.
//
// Gold uses live numbers: spot price from gold-api.com and USD->INR from
// open.er-api.com (both free, keyless), plus the latest gold headline for context.
//
// History (data/news-history.json) prevents covering the same story twice.
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { Logger } = require('./logger');

const USER_AGENT = 'Mozilla/5.0 (compatible; youtube-automation-agent news reader; +https://github.com/darkzOGx/youtube-automation-agent)';

const CATEGORIES = {
  entertainment: {
    label: 'Entertainment',
    feeds: [
      'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
      'https://www.theguardian.com/culture/rss',
      'https://www.aljazeera.com/xml/rss/all.xml'
    ],
    match: /\b(film|movie|actor|actress|singer|music|album|tour|celebrit|award|oscar|grammy|emmy|bollywood|hollywood|netflix|series|show|star|festival|box office|concert|band|tv|television)\b/i
  },
  world: {
    label: 'World news',
    feeds: [
      'https://feeds.bbci.co.uk/news/world/rss.xml',
      'https://www.aljazeera.com/xml/rss/all.xml',
      'https://www.theguardian.com/world/rss'
    ]
  },
  ai: {
    label: 'AI news',
    feeds: [
      'https://www.theguardian.com/technology/artificialintelligenceai/rss',
      'https://techcrunch.com/category/artificial-intelligence/feed/',
      'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
      'https://feeds.bbci.co.uk/news/technology/rss.xml'
    ],
    match: /\b(ai|a\.i\.|artificial intelligence|chatbot|openai|anthropic|claude|gemini|chatgpt|llm|machine learning|deepmind|nvidia|copilot|robot)\b/i
  },
  gold: {
    label: 'Gold price',
    feeds: [
      'https://www.theguardian.com/business/gold/rss',
      'https://feeds.bbci.co.uk/news/business/rss.xml'
    ],
    match: /\bgold\b/i
  },
  disasters: {
    label: 'Accidents and disasters',
    feeds: [
      'https://feeds.bbci.co.uk/news/world/rss.xml',
      'https://www.aljazeera.com/xml/rss/all.xml',
      'https://www.theguardian.com/world/rss'
    ],
    match: /\b(crash|crashes|accident|collision|derail|earthquake|quake|flood|floods|wildfire|fire|blaze|explosion|blast|landslide|cyclone|hurricane|typhoon|storm|tsunami|collapse|capsize|sinks|stampede|disaster|eruption|volcano)\b/i
  }
};

// Stories about crimes, allegations or sexual violence carry real defamation
// risk when a small AI model summarises them, so they are skipped by default.
// Override with NEWS_EXCLUDE (a regex) or NEWS_EXCLUDE=none.
const DEFAULT_EXCLUDE = '\\b(rape|raped|sexual|sex abuse|abuse|assault|harass|paedophil|pedophil|grooming|molest|murder|stabb|shooting|shot dead|charged|accused|alleged|allegation|convicted|guilty|sentenced|jailed|prison|trial|court|lawsuit|sued|arrest|terror|suicide|self-harm)\\w*';
// The article body only has to avoid the most sensitive subjects; words like
// "police" or "children" appear in ordinary disaster reports.
const BODY_EXCLUDE = /\b(rape|raped|sexual (?:assault|abuse|misconduct)|sex abuse|paedophil|pedophil|molest|grooming|suicide)\w*/i;
// Theme images for news slides/thumbnails: objects and scenes, not people, so a
// real person is never shown next to a story they have nothing to do with.
const NEWS_IMAGE_THEMES = {
  entertainment: ['cinema projector', 'stage lights', 'film reel', 'concert stage lights', 'theater curtain'],
  world: ['globe', 'world map', 'newspaper', 'city skyline night', 'earth from space'],
  ai: ['circuit board', 'computer chip', 'server room', 'data center', 'robot arm'],
  gold: ['gold bars', 'gold coins', 'gold bullion', 'stock market chart', 'gold nugget'],
  disasters: ['emergency lights', 'ambulance', 'storm clouds', 'rescue helicopter', 'warning sign']
};

const DEFAULT_ROTATION = ['entertainment', 'world', 'ai', 'gold', 'disasters'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…' };

function decode(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z0-9#]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function stripTags(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]).trim() : '';
}

// Parses RSS <item> and Atom <entry> blocks.
function parseFeed(xml, feedUrl = '') {
  const items = [];
  const publisher = (() => {
    try { return publisherName(new URL(feedUrl).hostname.replace(/^(www|feeds)\./, '')); } catch (_e) { return ''; }
  })();
  const blocks = String(xml).match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  for (const block of blocks) {
    let link = tag(block, 'link');
    if (!link || /^\s*$/.test(link)) {
      const href = block.match(/<link[^>]*href="([^"]+)"/i);
      link = href ? decode(href[1]) : '';
    }
    const title = stripTags(tag(block, 'title'));
    const summary = stripTags(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content'));
    const dateText = tag(block, 'pubDate') || tag(block, 'updated') || tag(block, 'published') || tag(block, 'dc:date');
    const published = dateText ? new Date(dateText) : null;
    if (title && /^https?:\/\//.test(link.trim())) {
      items.push({
        title,
        link: link.trim(),
        summary,
        published: published && !isNaN(published) ? published.toISOString() : null,
        publisher
      });
    }
  }
  return items;
}

// Pulls readable paragraphs out of an article page.
function extractArticleText(html, maxChars = 5000) {
  const cleaned = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside|figure|form)[\s\S]*?<\/\1>/gi, ' ');
  const paragraphs = (cleaned.match(/<p[\s>][\s\S]*?<\/p>/gi) || [])
    .map(stripTags)
    .filter(p => p.length > 60)
    .filter(p => !/(cookie|subscribe|newsletter|sign up|all rights reserved|follow us|click here|advertisement|getty images|copyright ©)/i.test(p));
  const unique = [...new Set(paragraphs)];
  let text = '';
  for (const p of unique) {
    if ((text + '\n' + p).length > maxChars) break;
    text += (text ? '\n' : '') + p;
  }
  return text;
}

const PUBLISHER_NAMES = {
  'bbci.co.uk': 'BBC News', 'bbc.co.uk': 'BBC News', 'bbc.com': 'BBC News',
  'theguardian.com': 'The Guardian', 'aljazeera.com': 'Al Jazeera',
  'techcrunch.com': 'TechCrunch', 'theverge.com': 'The Verge'
};
function publisherName(host) {
  return PUBLISHER_NAMES[host] || host;
}

function normalizeTitle(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

class NewsService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('NewsService');
    this.http = options.http || axios.create({ timeout: 20000, headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, maxRedirects: 5 });
    this.historyPath = options.historyPath || path.join(__dirname, '..', 'data', 'news-history.json');
    this.maxAgeHours = Number(process.env.NEWS_MAX_AGE_HOURS || 48);
    this.rotation = String(process.env.NEWS_CATEGORIES || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(c => CATEGORIES[c]);
    if (!this.rotation.length) this.rotation = DEFAULT_ROTATION;
    const exclude = String(process.env.NEWS_EXCLUDE ?? '').trim();
    this.exclude = /^none$/i.test(exclude) ? null : new RegExp(exclude || DEFAULT_EXCLUDE, 'i');
  }

  async loadHistory() {
    try {
      return JSON.parse(await fs.readFile(this.historyPath, 'utf8'));
    } catch (_e) {
      return { stories: [], lastCategoryIndex: -1 };
    }
  }

  async saveHistory(history) {
    await fs.mkdir(path.dirname(this.historyPath), { recursive: true });
    history.stories = history.stories.slice(-500);
    await fs.writeFile(this.historyPath, JSON.stringify(history, null, 2));
  }

  isCovered(history, item) {
    const t = normalizeTitle(item.title);
    return history.stories.some(s => s.link === item.link || s.normTitle === t);
  }

  async fetchFeed(url) {
    try {
      const { data } = await this.http.get(url, { responseType: 'text' });
      return parseFeed(data, url);
    } catch (error) {
      this.logger.warn(`Feed failed ${url}: ${error.response?.status || error.message}`);
      return [];
    }
  }

  async fetchArticle(url) {
    try {
      const { data } = await this.http.get(url, { responseType: 'text' });
      return extractArticleText(data);
    } catch (error) {
      this.logger.warn(`Article fetch failed ${url}: ${error.response?.status || error.message}`);
      return '';
    }
  }

  async candidates(categoryKey, history) {
    const category = CATEGORIES[categoryKey];
    const cutoff = Date.now() - this.maxAgeHours * 3600 * 1000;
    const all = (await Promise.all(category.feeds.map(f => this.fetchFeed(f)))).flat();
    const seen = new Set();
    return all
      .filter(i => !category.match || category.match.test(`${i.title} ${i.summary}`))
      .filter(i => !i.published || new Date(i.published).getTime() >= cutoff)
      .filter(i => !this.exclude || !this.exclude.test(`${i.title} ${i.summary}`))
      // Skip live blogs, video-only pages, quizzes and opinion pieces: poor fact sources.
      .filter(i => !/\b(live|watch|quiz|video|podcast|opinion|letters?|crossword|in pictures|photos)\b/i.test(i.title) && !/\/(live|video|av|videos|podcasts?|commentisfree|crosswords)\//i.test(i.link))
      .filter(i => !this.isCovered(history, i))
      .filter(i => {
        const k = normalizeTitle(i.title);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
  }

  async goldMarketFacts() {
    const facts = [];
    const sources = [];
    try {
      const { data: gold } = await this.http.get('https://api.gold-api.com/price/XAU');
      const usdPerOz = Number(gold.price);
      if (usdPerOz > 0) {
        const updated = gold.updatedAt || gold.updated_at || new Date().toISOString();
        facts.push(`International spot gold price: US$${usdPerOz.toFixed(2)} per troy ounce (as of ${updated}).`);
        sources.push({ url: 'https://gold-api.com', title: 'Gold spot price (gold-api.com)', publisher: 'gold-api.com' });
        try {
          const { data: fx } = await this.http.get('https://open.er-api.com/v6/latest/USD');
          const inr = Number(fx?.rates?.INR);
          if (inr > 0) {
            const per10g = usdPerOz / 31.1035 * 10 * inr;
            facts.push(`Exchange rate: 1 US dollar = ${inr.toFixed(2)} Indian rupees (open.er-api.com, ${fx.time_last_update_utc || 'latest'}).`);
            facts.push(`Converted spot value: about ₹${Math.round(per10g).toLocaleString('en-IN')} per 10 grams of 24-carat gold, BEFORE Indian import duty, GST and jeweller margins (so shop prices in India are higher).`);
            sources.push({ url: 'https://open.er-api.com', title: 'USD to INR exchange rate', publisher: 'open.er-api.com' });
          }
        } catch (error) {
          this.logger.warn(`FX lookup failed: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Gold price lookup failed: ${error.message}`);
    }
    return { facts, sources };
  }

  // Returns { category, label, topic, facts, sources } or null.
  async pickStory() {
    const history = await this.loadHistory();
    const start = (history.lastCategoryIndex + 1) % this.rotation.length;

    for (let step = 0; step < this.rotation.length; step++) {
      const index = (start + step) % this.rotation.length;
      const key = this.rotation[index];
      const category = CATEGORIES[key];
      this.logger.info(`News: trying category "${category.label}"`);

      const items = await this.candidates(key, history);
      let story = null;

      for (const item of items.slice(0, 6)) {
        const text = await this.fetchArticle(item.link);
        if (this.exclude && BODY_EXCLUDE.test(text)) {
          this.logger.info(`News: skipping "${item.title}" (article covers crime/allegations)`);
          continue;
        }
        if (text.length >= 600 || (key === 'gold' && item.summary)) {
          story = { item, text };
          break;
        }
        this.logger.info(`News: skipping "${item.title}" (article text not readable)`);
      }

      let market = { facts: [], sources: [] };
      if (key === 'gold') {
        market = await this.goldMarketFacts();
        if (!market.facts.length && !story) continue;
        // A gold video still works from live prices alone when there is no fresh headline.
      } else if (!story) {
        continue;
      }

      const sources = [];
      const factBlocks = [];
      if (market.facts.length) factBlocks.push(`LIVE MARKET DATA:\n${market.facts.join('\n')}`);
      if (story) {
        factBlocks.push(`REPORTED ARTICLE — "${story.item.title}" (${story.item.publisher}, ${story.item.published || 'recent'}):\n${story.text || story.item.summary}`);
        sources.push({ url: story.item.link, title: story.item.title, publisher: story.item.publisher, published: story.item.published });
      }
      sources.push(...market.sources);

      const topic = key === 'gold'
        ? `Gold price update today${story ? `: ${story.item.title}` : ''}`
        : story.item.title;

      history.lastCategoryIndex = index;
      if (story) {
        history.stories.push({
          link: story.item.link,
          normTitle: normalizeTitle(story.item.title),
          title: story.item.title,
          category: key,
          coveredAt: new Date().toISOString()
        });
      } else {
        history.stories.push({ link: `gold:${new Date().toISOString().slice(0, 10)}`, normTitle: `gold ${new Date().toISOString().slice(0, 10)}`, title: topic, category: key, coveredAt: new Date().toISOString() });
      }
      await this.saveHistory(history);

      this.logger.info(`News: picked [${category.label}] ${topic}`);
      return {
        category: key,
        label: category.label,
        topic: topic.slice(0, 180),
        facts: factBlocks.join('\n\n').slice(0, 6000),
        sources
      };
    }

    this.logger.warn('News: no usable story found in any category');
    return null;
  }
}

function isNewsMode() {
  return /^(on|true|1|yes)$/i.test(String(process.env.NEWS_MODE || '').trim());
}

function newsImageThemes(categoryLabelOrKey) {
  const key = Object.keys(CATEGORIES).find(k => k === categoryLabelOrKey || CATEGORIES[k].label === categoryLabelOrKey);
  return key ? NEWS_IMAGE_THEMES[key] : null;
}

module.exports = { NewsService, isNewsMode, parseFeed, extractArticleText, newsImageThemes, CATEGORIES };
