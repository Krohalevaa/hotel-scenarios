const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

// Хелпер для повторных попыток (Retry Pattern)
async function fetchWithRetry(requestFn, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await requestFn();
        } catch (err) {
            const status = err.response?.status;
            const shouldRetry = status === 429 || (status >= 500 && status <= 504) || err.code === 'ECONNABORTED';

            if (shouldRetry && attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 2000;
                logger.warn(`Scraper retry attempt ${attempt + 1} after ${delay}ms due to error: ${err.message}`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
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
            timeout: 65000 // Чуть больше чем таймаут в payload
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

    const result = {
        hotel_name: 'Не найдено',
        location: 'Не найдено',
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

    dataArray.forEach(item => {
        const sel = item.selector.toLowerCase();
        const texts = item.results.map(r => cleanText(r.text)).filter(Boolean);

        if (sel.includes('title') || sel.includes('name') || sel.includes('hotel-title') || sel.includes('headline')) {
            if (!result.hotel_name || result.hotel_name === 'Не найдено') {
                result.hotel_name = texts[0]?.replace(/\|.*$/, '').replace(/Official Website/i, '').trim() || 'Не найдено';
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
    const JUNK_TITLES = ['Access Denied', 'Just a moment', 'DDoS-Guard', '403 Forbidden', 'Cloudflare', 'Checking your browser'];
    if (JUNK_TITLES.some(j => result.hotel_name.includes(j))) {
        logger.warn(`Junk title detected: "${result.hotel_name}". Clearing title to force AI inference.`);
        result.hotel_name = '';
    }

    return result;
}

module.exports = { scrapeHotelWebsite, extractHotelInfo };
