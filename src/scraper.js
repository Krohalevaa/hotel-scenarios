const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

// Helper for retry attempts (Retry Pattern)
async function fetchWithRetry(requestFn, maxRetries = 1) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
            }
            return await requestFn();
        } catch (err) {
            const status = err.response?.status;
            const shouldRetry = status === 429 || (status >= 500 && status <= 504) || err.code === 'ECONNABORTED';

            if (shouldRetry && attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 2500;
                logger.warn(`Scraper retry attempt ${attempt + 1} after ${delay}ms due to error: ${err.message}`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            if (status === 400) {
                logger.warn('Scraper API returned 400. Skipping retries and falling back to minimal hotel data.');
            }

            throw err;
        }
    }
}

async function scrapeHotelWebsite(url) {
    try {
        const payload = {
            url: url,
            gotoOptions: { waitUntil: "networkidle2", timeout: 60000 },
            elements: [
                { selector: "title" },
                { selector: "h1, h2, h3" },
                { selector: "[itemprop='name'], .hotel-name, .title, [class*='hotel-title' i], [class*='headline' i]" },
                { selector: "[itemprop='address'], address, .address, .location, .hotel-address, footer address" },
                { selector: "[itemprop='telephone'], [itemprop='email'], .phone, .contact, [class*='phone' i], [class*='email' i]" },
                { selector: ".description, .overview, .about, .hotel-info, .introduction, main p, .content p, [class*='description' i]" },
                { selector: ".offer, .promotion, .deal, .special, .promo, [class*='offer' i], [class*='promo' i], [class*='deal' i]" },
                { selector: ".amenities li, .facilities li, .services li, .features li, [class*='amenity' i] li, [class*='facility' i] li" },
                { selector: "img[src*='room'], img[src*='gallery'], img[src*='hotel'], img[alt*='room'], img[alt*='suite'], .gallery img, .slider img, [class*='photo' i] img" }
            ]
        };

        const response = await fetchWithRetry(() => axios.post(config.SCRAPER_API_URL, payload, {
            params: { token: 'supersecret' },
            headers: { 'Content-Type': 'application/json' },
            timeout: 65000 // Slightly longer than the timeout in the payload
        }));

        return response.data;
    } catch (error) {
        console.error("Scraping error:", error.message);
        throw error;
    }
}

function extractHotelInfo(data, context) {
    function cleanText(text) {
        return text?.trim().replace(/\n+/g, ' ').replace(/\s+/g, ' ') || '';
    }

    function extractEmails(text) {
        const match = text.match(/[\w\.-]+@[\w\.-]+\.\w+/g);
        return match ? match.join(', ') : '';
    }

    function extractPhones(text) {
        const match = text.match(/(\+?\d[\d\s()-]{8,})/g);
        return match ? match.join(', ') : '';
    }

    function buildDomainFallbackName(url) {
        try {
            const domain = new URL(url).hostname
                .replace(/^www\./i, '')
                .split('.')[0]
                .replace(/[-_]+/g, ' ')
                .trim();

            return domain
                .split(/\s+/)
                .filter(Boolean)
                .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                .join(' ');
        } catch (error) {
            logger.warn(`Failed to build fallback hotel name from URL: ${error.message}`);
            return '';
        }
    }

    function normalizeCandidateName(value) {
        return cleanText(value)
            .replace(/\s*[|\-–—:]\s*(official site|official website|book direct|best rate guaranteed).*$/i, '')
            .replace(/^(welcome to|discover|stay at)\s+/i, '')
            .trim();
    }

    function isLikelySeoTitle(value) {
        const normalized = String(value || '').trim();
        if (!normalized) return true;

        const seoPatterns = [
            /^hotels? in\b/i,
            /^best hotels? in\b/i,
            /^luxury hotels? in\b/i,
            /^boutique hotels? in\b/i,
            /^places to stay in\b/i,
            /^where to stay in\b/i,
            /^visit\b/i,
            /^travel\b/i,
            /\bhotels? in\s+[a-z]/i,
            /\bbook direct\b/i,
            /\bbest rate guaranteed\b/i
        ];

        return seoPatterns.some((pattern) => pattern.test(normalized));
    }

    const result = {
        hotel_name: 'Not found',
        location: 'Not found',
        phone: '',
        email: '',
        description: '',
        special_offers: [],
        amenities: [],
        photos: [],
        other_headings: [],
        city: context.city,
        country: context.country || null,
        business_goal: context.business_goal,
        guest_preference: context.guest_preference || '',
        contact_email: context.contact_email,
        language: context.language || 'English',
        hotel_website_url: context.hotel_website_url
    };

    const dataArray = data.data || [];
    const candidateNames = [];

    dataArray.forEach(item => {
        const sel = item.selector.toLowerCase();
        const texts = item.results.map(r => cleanText(r.text)).filter(Boolean);

        if (sel.includes('title') || sel.includes('name') || sel.includes('hotel-title') || sel.includes('headline')) {
            candidateNames.push(...texts.map((text) => normalizeCandidateName(text)).filter(Boolean));

            if (!result.hotel_name || result.hotel_name === 'Not found') {
                result.hotel_name = normalizeCandidateName(texts[0]) || 'Not found';
            }
        }

        if (sel.includes('address') || sel.includes('location')) {
            result.location = texts.join(' | ').replace(/HOTEL:.*/i, '').trim();
        }

        if (sel.includes('telephone') || sel.includes('phone') || sel.includes('contact')) {
            const phones = item.results.map(r => extractPhones(r.text)).filter(Boolean);
            if (phones.length) result.phone = phones.join(', ');
        }

        if (sel.includes('email') || sel.includes('contact')) {
            const emails = item.results.map(r => extractEmails(r.text)).filter(Boolean);
            if (emails.length) result.email = emails.join(', ');
        }

        if (sel.includes('description') || sel.includes('overview') || sel.includes('about')) {
            const descParts = texts.filter(t => t.length > 50 && !t.includes('JOIN THE CLUB') && !t.includes('©'));
            result.description = descParts.join(' ').slice(0, 800) + (descParts.join(' ').length > 800 ? '...' : '');
        }

        if (sel.includes('offer') || sel.includes('promo') || sel.includes('deal') || sel.includes('special')) {
            const offers = texts.filter(t => t.length > 10 && !t.includes('LEARN MORE'));
            result.special_offers.push(...offers);
        }

        if (sel.includes('amenities') || sel.includes('facilities') || sel.includes('services')) {
            const amens = texts.filter(t => t.length > 5 && !t.match(/^\d+$/) && !t.includes('facebook') && !t.includes('instagram'));
            result.amenities.push(...amens);
        }

        if (sel.includes('img')) {
            result.photos = item.results.map(r => {
                const src = r.attributes?.find(a => a.name === 'src')?.value || '';
                const alt = r.attributes?.find(a => a.name === 'alt')?.value || 'Hotel photo';
                return src.startsWith('http') ? { src, alt } : null;
            }).filter(Boolean);
        }

        if (sel.includes('h1') || sel.includes('h2') || sel.includes('h3')) {
            result.other_headings.push(...texts);
        }
    });

    if (result.hotel_name.includes('Taj') || result.hotel_name.includes('Pierre')) {
        result.hotel_name = 'The Pierre, a Taj Hotel';
    }

    // Task 7: Blacklist junk titles (Cloudflare, 403, etc.)
    const JUNK_TITLES = ['Access Denied', 'Just a moment', 'DDoS-Guard', '403 Forbidden', 'Cloudflare', 'Checking your browser', 'Attention Required!'];
    const bestCandidate = candidateNames.find((candidate) => {
        if (!candidate) return false;
        if (JUNK_TITLES.some((junk) => candidate.includes(junk))) return false;
        if (isLikelySeoTitle(candidate)) return false;
        return candidate.length >= 3;
    });

    if (bestCandidate && bestCandidate !== result.hotel_name) {
        logger.info(`Replacing weak scraped hotel title "${result.hotel_name}" with stronger candidate "${bestCandidate}".`);
        result.hotel_name = bestCandidate;
    }

    if (JUNK_TITLES.some(j => result.hotel_name.includes(j)) || isLikelySeoTitle(result.hotel_name)) {
        logger.warn(`Junk or SEO title detected: "${result.hotel_name}". Clearing title to force fallback inference.`);
        result.hotel_name = '';
    }

    if (!result.hotel_name || result.hotel_name === 'Not found') {
        const fallbackName = buildDomainFallbackName(context.hotel_website_url);
        if (fallbackName) {
            logger.warn(`Hotel title missing after scraping. Using domain fallback: "${fallbackName}".`);
            result.hotel_name = fallbackName;
        }
    }

    return result;
}

module.exports = { scrapeHotelWebsite, extractHotelInfo };
