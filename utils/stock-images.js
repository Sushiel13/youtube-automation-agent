// Free, keyless stock images for slideshow visuals and thumbnails.
//
// Sources (no API key needed):
//   1. Openverse (openverse.org) — Creative Commons images, filtered to licenses
//      that allow commercial use and modification.
//   2. Wikimedia Commons — fallback when Openverse has nothing or is rate-limited.
//
// Every downloaded image gets a "<image>.credit.json" sidecar with title,
// creator, license and source URL, so the video can credit its images.
//
// Enabled with STOCK_IMAGES=openverse (or =on). Off by default.
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { Logger } = require('./logger');

const USER_AGENT = 'youtube-automation-agent/2.x (https://github.com/darkzOGx/youtube-automation-agent)';
const STOPWORDS = new Set(('a an and are as at be by for from how in into is it its of on or that the this to ' +
  'what when where which why will with your you our we us top best new future explained guide ' +
  'clear visual storytelling relevant explanatory introduction intro conclusion overview part ' +
  'section key tips trends predictions things ways').split(' '));

function isStockEnabled() {
  return /^(on|true|1|yes|openverse|wikimedia)$/i.test(String(process.env.STOCK_IMAGES || '').trim());
}

// "The Future of Technology: Top Trends, clear visual storytelling" -> "technology"
function keywordsFrom(text, max = 3) {
  const words = String(text || '')
    .split(',')[0]
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, max).join(' ');
}

class StockImageService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('StockImages');
    this.http = options.http || axios.create({ timeout: 20000, headers: { 'User-Agent': USER_AGENT } });
    this.used = new Set();
    this.context = '';
  }

  // Broader topic (usually the video title) used when a slide title alone finds nothing.
  setContext(text) {
    this.context = keywordsFrom(text, 3);
  }

  async searchOpenverse(query) {
    const { data } = await this.http.get('https://api.openverse.org/v1/images/', {
      params: {
        q: query,
        license_type: 'commercial,modification',
        aspect_ratio: 'wide',
        mature: false,
        page_size: 20
      }
    });
    return (data.results || [])
      .filter(r => r.url && (!r.width || r.width >= 800))
      .map(r => ({
        url: r.url,
        title: r.title || 'Untitled',
        creator: r.creator || 'Unknown',
        license: `CC ${String(r.license || '').toUpperCase()} ${r.license_version || ''}`.trim(),
        licenseUrl: r.license_url || null,
        source: r.foreign_landing_url || r.url,
        provider: 'Openverse'
      }));
  }

  async searchWikimedia(query) {
    const { data } = await this.http.get('https://commons.wikimedia.org/w/api.php', {
      params: {
        action: 'query',
        format: 'json',
        generator: 'search',
        gsrsearch: `${query} filetype:bitmap`,
        gsrnamespace: 6,
        gsrlimit: 20,
        prop: 'imageinfo',
        iiprop: 'url|size|extmetadata',
        iiurlwidth: 1920
      }
    });
    const pages = Object.values(data?.query?.pages || {});
    return pages
      .map(p => ({ p, info: p.imageinfo?.[0] }))
      .filter(({ info }) => info && info.width >= 800 && info.width >= info.height)
      .map(({ p, info }) => {
        const meta = info.extmetadata || {};
        const strip = v => String(v?.value || '').replace(/<[^>]+>/g, '').trim();
        return {
          url: info.thumburl || info.url,
          title: p.title.replace(/^File:/, ''),
          creator: strip(meta.Artist) || 'Unknown',
          license: strip(meta.LicenseShortName) || 'See source',
          licenseUrl: strip(meta.LicenseUrl) || null,
          source: info.descriptionurl || info.url,
          provider: 'Wikimedia Commons'
        };
      });
  }

  async findCandidates(query) {
    const searches = [
      ['Openverse', () => this.searchOpenverse(query)],
      ['Wikimedia', () => this.searchWikimedia(query)]
    ];
    for (const [name, run] of searches) {
      try {
        const results = (await run()).filter(r => !this.used.has(r.url));
        if (results.length) return results;
      } catch (error) {
        this.logger.warn(`${name} search failed for "${query}": ${error.response?.status || error.message}`);
      }
    }
    return [];
  }

  // Downloads one fitting image for the prompt to outputPath (.jpg). Returns the
  // path, or null when nothing usable was found.
  async fetchImage(prompt, outputPath) {
    const queries = [...new Set([
      keywordsFrom(prompt, 3),
      keywordsFrom(prompt, 1),
      [keywordsFrom(prompt, 1), this.context].filter(Boolean).join(' '),
      this.context
    ].filter(Boolean))];

    for (const query of queries) {
      const candidates = await this.findCandidates(query);
      for (const candidate of candidates.slice(0, 5)) {
        try {
          const response = await this.http.get(candidate.url, { responseType: 'arraybuffer', maxContentLength: 25 * 1024 * 1024 });
          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          // Normalise to a 1920x1080 JPEG so the slideshow always gets a clean frame.
          await sharp(Buffer.from(response.data), { failOn: 'error' })
            .rotate()
            .resize(1920, 1080, { fit: 'cover', position: 'attention' })
            .jpeg({ quality: 85 })
            .toFile(outputPath);
          this.used.add(candidate.url);
          await fs.writeFile(`${outputPath}.credit.json`, JSON.stringify({ ...candidate, query }, null, 2));
          this.logger.info(`Stock image for "${query}": "${candidate.title}" by ${candidate.creator} (${candidate.license}, ${candidate.provider})`);
          return outputPath;
        } catch (error) {
          this.logger.warn(`Skipping image ${candidate.url}: ${error.message}`);
        }
      }
    }
    this.logger.warn(`No stock image found for "${prompt}"`);
    return null;
  }
}

// Collects "<image>.credit.json" sidecars into readable credit lines.
async function readCredits(imagePaths = []) {
  const lines = [];
  for (const imagePath of imagePaths) {
    if (typeof imagePath !== 'string') continue;
    try {
      const c = JSON.parse(await fs.readFile(`${imagePath}.credit.json`, 'utf8'));
      lines.push(`"${c.title}" by ${c.creator}, ${c.license}${c.licenseUrl ? ` (${c.licenseUrl})` : ''}, via ${c.provider}: ${c.source}`);
    } catch (_error) {
      // not a stock image
    }
  }
  return [...new Set(lines)];
}

module.exports = { StockImageService, isStockEnabled, keywordsFrom, readCredits };
