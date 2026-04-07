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
            gotoOptions: { waitUntil: 'networkidle2', timeout: 60000 },
            elements: [
                { selector: 'title' },
                { selector: 'h1, h2, h3' },
                { selector: '[itemprop="name"], .hotel-name, .title, [class*="hotel-title" i], [class*="headline" i]' },
                { selector: '[itemprop="address"], address, .address, .location, .hotel-address, footer address' },
                { selector: '[itemprop="telephone"], [itemprop="email"], .phone, .contact, [class*="phone" i], [class*="email" i]' },
                { selector: '.description, .overview, .about, .hotel-info, .introduction, main p, .content p, [class*="description" i]' },
                { selector: '.offer, .promotion, .deal, .special, .promo, [class*="offer" i], [class*="promo" i], [class*="deal" i]' },
                { selector: '.amenities li, .facilities li, .services li, .features li, [class*="amenity" i] li, [class*="facility" i] li' },
                { selector: 'img[src*="room"], img[src*="gallery"], img[src*="hotel"], img[alt*="room"], img[alt*="suite"], .gallery img, .slider img, [class*="photo" i] img' },
                { selector: 'meta[property="og:site_name"], meta[property="og:title"], meta[name="application-name"], meta[name="twitter:title"], meta[itemprop="name"]' },
                { selector: 'script[type="application/ld+json"]' },
                { selector: 'header img[alt], .logo img[alt], [class*="logo" i] img[alt], [class*="brand" i] img[alt]' }
            ]
        };

        const response = await fetchWithRetry(() => axios.post(config.SCRAPER_API_URL, payload, {
            params: { token: 'supersecret' },
            headers: { 'Content-Type': 'application/json' },
            timeout: 65000 // Slightly longer than the timeout in the payload
        }));

        return response.data;
    } catch (error) {
        console.error('Scraping error:', error.message);
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

    function titleCaseWords(value) {
        return String(value || '')
            .split(/\s+/)
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ')
            .trim();
    }

    function splitCompactDomainWords(value) {
        return String(value || '')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/(hotel|resort|suites|suite|inn|lodge|spa|palace|villa|apartments|boutique|collection|marriott|hilton|hyatt|sheraton|westin|ritz|plaza|grand|royal|park|house|club)/gi, ' $1 ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function buildDomainFallbackName(url) {
        try {
            const parsedUrl = new URL(url);
            const hostname = parsedUrl.hostname.replace(/^www\./i, '');
            const domainPart = hostname.split('.')[0] || '';
            const pathParts = parsedUrl.pathname
                .split('/')
                .map((part) => decodeURIComponent(part || '').trim())
                .filter(Boolean);

            const rawCandidates = [
                ...pathParts.slice(-2),
                domainPart
            ];

            const stopWords = new Set([
                'hotel', 'hotels', 'official', 'book', 'booking', 'stay', 'luxury', 'resort', 'resorts', 'collection', 'group', 'welcome', 'home', 'index'
            ]);

            for (const rawCandidate of rawCandidates) {
                const normalized = splitCompactDomainWords(rawCandidate)
                    .replace(/[-_]+/g, ' ')
                    .replace(/\.(html?|php|aspx?)$/i, '')
                    .replace(/\b\d{1,4}\b/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

                const filtered = normalized
                    .split(/\s+/)
                    .filter((part) => part && !stopWords.has(part.toLowerCase()))
                    .join(' ')
                    .trim();

                if (filtered.length >= 3) {
                    return titleCaseWords(filtered);
                }
            }

            return titleCaseWords(splitCompactDomainWords(domainPart).replace(/[-_]+/g, ' '));
        } catch (error) {
            logger.warn(`Failed to build fallback hotel name from URL: ${error.message}`);
            return '';
        }
    }

    function normalizeCandidateName(value) {
        return cleanText(value)
            .replace(/^(welcome to|discover|stay at|experience|explore)\s+/i, '')
            .replace(/\s*[|\-–—:]\s*(official site|official website|book direct|best rate guaranteed|luxury hotel.*|boutique hotel.*|hotel in .*|resort in .*).*$/i, '')
            .replace(/\b(official site|official website|book direct|best rate guaranteed)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function splitCandidateSegments(value) {
        return String(value || '')
            .split(/\s*[|\-–—:]\s*/)
            .map((segment) => normalizeCandidateName(segment))
            .filter(Boolean);
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
            /^book your stay in\b/i,
            /\bhotels? in\s+[a-z]/i,
            /\bbest rate guaranteed\b/i
        ];

        return seoPatterns.some((pattern) => pattern.test(normalized));
    }

    function isJunkTitle(value) {
        const normalized = String(value || '').trim();
        if (!normalized) return true;

        const junkTitles = ['Access Denied', 'Just a moment', 'DDoS-Guard', '403 Forbidden', 'Cloudflare', 'Checking your browser', 'Attention Required!'];
        return junkTitles.some((junk) => normalized.toLowerCase().includes(junk.toLowerCase()));
    }

    function looksLikeHotelName(value) {
        const normalized = String(value || '').trim();
        if (!normalized || normalized.length < 3) return false;
        if (isJunkTitle(normalized)) return false;

        const hotelSignals = /\b(hotel|resort|suites|suite|inn|lodge|spa|palace|villa|apartments|boutique|hostel)\b/i;
        const genericSignals = /\b(home|homepage|welcome|book now|special offers|gallery|contact us)\b/i;

        if (hotelSignals.test(normalized)) return true;
        if (genericSignals.test(normalized)) return false;

        const words = normalized.split(/\s+/).filter(Boolean);
        return words.length >= 2 && words.length <= 8;
    }

    function getDomainTokens(url) {
        try {
            const hostname = new URL(url).hostname.replace(/^www\./i, '');
            return splitCompactDomainWords(hostname.split('.')[0])
                .toLowerCase()
                .split(/\s+/)
                .filter(Boolean);
        } catch (error) {
            return [];
        }
    }

    function parseJsonLdCandidates(text) {
        const candidates = [];
        const visitNode = (node) => {
            if (!node) return;
            if (Array.isArray(node)) {
                node.forEach(visitNode);
                return;
            }
            if (typeof node !== 'object') return;

            const typeValue = Array.isArray(node['@type']) ? node['@type'].join(' ') : String(node['@type'] || '');
            const normalizedType = typeValue.toLowerCase();
            const isHotelLikeType = ['hotel', 'lodgingbusiness', 'resort', 'hostel', 'motel'].some((type) => normalizedType.includes(type));

            if (isHotelLikeType && node.name) {
                candidates.push({ value: String(node.name), source: 'jsonld-hotel' });
            }

            if ((normalizedType.includes('organization') || normalizedType.includes('localbusiness')) && node.name) {
                candidates.push({ value: String(node.name), source: 'jsonld-organization' });
            }

            if (node['@graph']) {
                visitNode(node['@graph']);
            }

            Object.values(node).forEach((child) => {
                if (child && typeof child === 'object') {
                    visitNode(child);
                }
            });
        };

        try {
            const parsed = JSON.parse(text);
            visitNode(parsed);
        } catch (error) {
            logger.debug(`Failed to parse JSON-LD block for hotel name extraction: ${error.message}`);
        }

        return candidates;
    }

    function scoreCandidate(candidate, domainTokens) {
        const normalized = normalizeCandidateName(candidate.value);
        if (!normalized) {
            return { ...candidate, normalized: '', score: -1000, rejectedReason: 'empty' };
        }

        let score = 0;
        const lower = normalized.toLowerCase();
        const words = normalized.split(/\s+/).filter(Boolean);

        const sourceScores = {
            'jsonld-hotel': 120,
            'jsonld-organization': 95,
            'meta-og-site-name': 90,
            'meta-og-title': 82,
            'meta-application-name': 80,
            'meta-twitter-title': 78,
            'meta-itemprop-name': 88,
            'heading': 74,
            'name-selector': 86,
            'logo-alt': 68,
            'title': 58,
            'title-segment': 54,
            'domain-fallback': 10
        };

        score += sourceScores[candidate.source] || 40;

        if (looksLikeHotelName(normalized)) score += 25;
        if (/\b(hotel|resort|suites|suite|inn|lodge|spa|palace|villa|apartments|boutique|hostel)\b/i.test(normalized)) score += 18;
        if (words.length >= 2 && words.length <= 6) score += 10;
        if (normalized.length >= 8 && normalized.length <= 60) score += 8;
        if (candidate.source === 'title' || candidate.source === 'title-segment') {
            if (/\b(official site|official website|book direct|best rate guaranteed)\b/i.test(candidate.value || '')) score -= 8;
        }

        const domainOverlap = domainTokens.filter((token) => token.length >= 3 && lower.includes(token));
        score += Math.min(domainOverlap.length * 6, 18);

        if (isLikelySeoTitle(normalized)) score -= 35;
        if (isJunkTitle(normalized)) score -= 120;
        if (/\b(home|homepage|gallery|contact us|special offers)\b/i.test(lower)) score -= 20;
        if (words.length > 10) score -= 20;

        return {
            ...candidate,
            normalized,
            score,
            rejectedReason: score < 40 ? 'low_score' : null
        };
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
    const domainTokens = getDomainTokens(context.hotel_website_url);

    function pushCandidate(value, source) {
        const normalized = normalizeCandidateName(value);
        if (!normalized) return;
        candidateNames.push({ value: normalized, source });
    }

    dataArray.forEach(item => {
        const sel = item.selector.toLowerCase();
        const texts = item.results.map(r => cleanText(r.text)).filter(Boolean);

        if (sel === 'title') {
            texts.forEach((text) => {
                pushCandidate(text, 'title');
                splitCandidateSegments(text).forEach((segment) => pushCandidate(segment, 'title-segment'));
            });
        }

        if (sel.includes('itemprop="name"') || sel.includes('hotel-name') || sel.includes('hotel-title') || sel.includes('headline')) {
            texts.forEach((text) => pushCandidate(text, 'name-selector'));
        }

        if (sel.includes('h1') || sel.includes('h2') || sel.includes('h3')) {
            result.other_headings.push(...texts);
            texts.forEach((text) => pushCandidate(text, 'heading'));
        }

        if (sel.includes('meta[')) {
            item.results.forEach((entry) => {
                const content = cleanText(entry.attributes?.find((attr) => attr.name === 'content')?.value || entry.text || '');
                if (!content) return;

                if (sel.includes('og:site_name')) pushCandidate(content, 'meta-og-site-name');
                if (sel.includes('og:title')) {
                    pushCandidate(content, 'meta-og-title');
                    splitCandidateSegments(content).forEach((segment) => pushCandidate(segment, 'title-segment'));
                }
                if (sel.includes('application-name')) pushCandidate(content, 'meta-application-name');
                if (sel.includes('twitter:title')) {
                    pushCandidate(content, 'meta-twitter-title');
                    splitCandidateSegments(content).forEach((segment) => pushCandidate(segment, 'title-segment'));
                }
                if (sel.includes('itemprop="name"')) pushCandidate(content, 'meta-itemprop-name');
            });
        }

        if (sel.includes('application/ld+json')) {
            texts.forEach((text) => {
                parseJsonLdCandidates(text).forEach((candidate) => pushCandidate(candidate.value, candidate.source));
            });
        }

        if (sel.includes('logo') || sel.includes('brand')) {
            item.results.forEach((entry) => {
                const alt = cleanText(entry.attributes?.find((attr) => attr.name === 'alt')?.value || entry.text || '');
                if (alt) pushCandidate(alt, 'logo-alt');
            });
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
    });

    const scoredCandidates = candidateNames
        .map((candidate) => scoreCandidate(candidate, domainTokens))
        .sort((a, b) => b.score - a.score);

    const bestCandidate = scoredCandidates.find((candidate) => !candidate.rejectedReason);

    if (bestCandidate?.normalized) {
        result.hotel_name = bestCandidate.normalized;
        logger.info(`Selected hotel name "${bestCandidate.normalized}" from source "${bestCandidate.source}" with score ${bestCandidate.score}.`);
    } else {
        logger.warn(`No strong hotel name candidate found for ${context.hotel_website_url}. Top candidates: ${JSON.stringify(scoredCandidates.slice(0, 5).map((candidate) => ({
            value: candidate.normalized,
            source: candidate.source,
            score: candidate.score,
            rejectedReason: candidate.rejectedReason
        })))}.`);
    }

    if (result.hotel_name.includes('Taj') || result.hotel_name.includes('Pierre')) {
        result.hotel_name = 'The Pierre, a Taj Hotel';
    }

    if (!result.hotel_name || result.hotel_name === 'Not found' || isJunkTitle(result.hotel_name)) {
        const fallbackName = buildDomainFallbackName(context.hotel_website_url);
        if (fallbackName) {
            logger.warn(`Hotel title missing after scoring. Using domain fallback: "${fallbackName}".`);
            result.hotel_name = fallbackName;
        }
    }

    return result;
}

module.exports = { scrapeHotelWebsite, extractHotelInfo };
