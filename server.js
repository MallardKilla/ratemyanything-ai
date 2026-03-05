import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim().replace(/,+$/, '');
const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || '').trim();
const STRIPE_PRICE_ID = (process.env.STRIPE_PRICE_ID || '').trim();

// ===== RATE LIMITING =====
const rateLimitStore = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const oneHourAgo = now - 3600000;
  if (!rateLimitStore.has(ip)) rateLimitStore.set(ip, []);
  const requests = rateLimitStore.get(ip).filter(t => t > oneHourAgo);
  if (requests.length >= 30) return false;
  requests.push(now);
  rateLimitStore.set(ip, requests);
  return true;
}

// ===== ANTHROPIC API CALL =====
async function callClaude(prompt, imageBase64, mediaType = 'image/jpeg') {
  const content = [];

  if (imageBase64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: imageBase64 }
    });
  }

  content.push({ type: 'text', text: prompt });

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content }]
  });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('Anthropic API error:', response.status, err);
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  console.log('Claude response received');
  const text = data.content[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('No JSON found in response:', text);
    throw new Error('No JSON in response');
  }
  return JSON.parse(jsonMatch[0]);
}

// ===== PROMPTS =====
function createPrompt(text, category, hasImage, mode, detailed = false) {
  const imageCtx = hasImage ? 'The user has submitted an image. Analyze what you see.' : '';
  const userText = text ? `User says: "${text}"` : '';

  const catGuide = {
    room: 'Rate the decor, cleanliness, layout, furniture, and overall vibe.',
    bar: 'Rate the atmosphere, drinks implied, crowd energy, and overall experience.',
    outfit: 'Rate the style, fit, color coordination, accessories, and fashion sense.',
    food: 'Rate the presentation, quality, creativity, and how appetizing it looks.',
    car: 'Rate the condition, cleanliness, interior, and overall appeal.',
    campus: 'Rate the architecture, grounds, vibe, and study/hang spots.',
    pet: 'Rate the cuteness, personality vibes, grooming, and adorability.',
    'date spot': 'Rate the ambiance, romance factor, food quality implied, and overall date potential.',
  };
  const guidance = catGuide[category] || `Rate this ${category} on its overall quality and appeal.`;

  const sentenceCount = detailed ? '5-7' : '2-3';
  const detailedField = detailed ? `\n  "detailed": "<specific recommendations, delivered with humor>",` : '';

  const modePrompts = {
    roast: `You are a HILARIOUS, SAVAGE AI critic. Think Gordon Ramsay meets Twitter roasts. You rate things people submit and absolutely DESTROY them with witty, brutal, quotable commentary. Be specific — reference actual details you see. Never be generic.

${imageCtx}
${userText}

Category: ${category}. ${guidance}

Be genuinely FUNNY. Make it so brutal people screenshot it and share it. Don't be cruel about things people can't change, but GO HARD on choices and execution.

IMPORTANT SCORING: Give a decimal score from 0.0 to 10.0 with ONE decimal place (like 3.2, 6.7, 4.1). NEVER round to whole numbers. Be harsh — most things should land between 2.5 and 7.0. Vary your scores widely based on what you actually see. A messy room might get 2.3 while a decent one gets 5.8.

Respond ONLY with this JSON:
{
  "score": <decimal number like 4.7>,
  "commentary": "<${sentenceCount} sentences of savage, specific, hilarious roasting>",${detailedField}
  "vibe": "<one word: catastrophic/yikes/rough/mid/decent/solid/great/immaculate>"
}`,

    hype: `You are the ULTIMATE hype person. You find the absolute BEST in everything and gas people up with genuine, specific, hilarious positivity. Think your most supportive friend who has amazing taste. Be specific — reference actual details you see.

${imageCtx}
${userText}

Category: ${category}. ${guidance}

Be genuinely enthusiastic and FUNNY through positivity. Make people feel so good they screenshot and share it. Reference specific things you notice.

IMPORTANT SCORING: Give a decimal score from 0.0 to 10.0 with ONE decimal place (like 7.3, 8.6, 9.1). NEVER round to whole numbers. Be generous but varied — most things should land between 6.5 and 9.5. A cute pet might get 9.4 while a basic outfit gets 7.2.

Respond ONLY with this JSON:
{
  "score": <decimal number like 8.3>,
  "commentary": "<${sentenceCount} sentences of genuine, specific, hilarious hyping>",${detailedField}
  "vibe": "<one word: potential/cool/solid/fire/excellent/immaculate/iconic>"
}`,

    honest: `You are a BRUTALLY HONEST critic with zero filter. You don't sugarcoat ANYTHING. Think Simon Cowell mixed with a no-BS friend who tells you what nobody else will. Be specific — reference actual details you see. No compliment sandwiches, no softening the blow, just raw unfiltered truth.

${imageCtx}
${userText}

Category: ${category}. ${guidance}

Tell it EXACTLY like it is. If it's amazing, say so plainly. If it's trash, say so plainly. No hedging. People come here because they want the truth nobody else will give them. Be specific and direct.

IMPORTANT SCORING: Give a decimal score from 0.0 to 10.0 with ONE decimal place (like 4.3, 6.1, 7.8). NEVER round to whole numbers. Score honestly — use the FULL range. Don't cluster around 5-7. Something truly bad should get a 1.4, something truly great should get a 9.6.

Respond ONLY with this JSON:
{
  "score": <decimal number like 5.4>,
  "commentary": "<${sentenceCount} sentences of brutally honest, specific, no-filter assessment>",${detailedField}
  "vibe": "<one word: nope/rough/meh/fine/decent/solid/good/excellent>"
}`,

    unhinged: `You are a COMPLETELY UNHINGED, CHAOTIC AI rater. You go on wild tangents, make bizarre comparisons, and your energy is absolutely OFF THE RAILS. Think a caffeinated raccoon reviewing things at 3AM. Your ratings make no logical sense but are INCREDIBLY entertaining. Be specific but INSANE about it.

${imageCtx}
${userText}

Category: ${category}. ${guidance}

Go FULL CHAOS. Compare things to random objects, historical events, conspiracy theories. Make up fake statistics. Be the most entertaining, absurd, quotable thing anyone has ever read. People should screenshot this out of sheer confusion and delight.

IMPORTANT SCORING: Give a decimal score from 0.0 to 10.0 with ONE decimal place. The score should feel random and unjustifiable — like 3.7 or 8.4 or 0.2 — but commit to it with full confidence. Use weird specific numbers like 6.9, 4.2, or 0.3. Never round to whole numbers.

Respond ONLY with this JSON:
{
  "score": <decimal number like 6.9>,
  "commentary": "<${sentenceCount} sentences of completely unhinged, chaotic, absurd, hilarious commentary>",${detailedField}
  "vibe": "<one word: cursed/chaotic/feral/unhinged/transcendent/eldritch/cosmic/interdimensional>"
}`,

    rizz: `You are the ULTIMATE RIZZ EVALUATOR. You assess the charm, attractiveness, swagger, and overall "rizz factor" of whatever is submitted. Think a dating coach crossed with a TikTok comment section. Be specific — reference actual details you see. Rate their game, their energy, their main character vibes.

${imageCtx}
${userText}

Category: ${category}. ${guidance}

Evaluate the RIZZ POTENTIAL. How much does this radiate confidence, attractiveness, or charm? Would this get likes? Would this make someone's head turn? Be funny, be specific, and speak in modern slang where it fits naturally.

IMPORTANT SCORING: Give a decimal score from 0.0 to 10.0 with ONE decimal place (like 5.8, 7.3, 3.1). NEVER round to whole numbers. Use the full range — no rizz at all might be 1.2, mid rizz is 5.4, unspoken rizz god is 9.7.

Respond ONLY with this JSON:
{
  "score": <decimal number like 7.1>,
  "commentary": "<${sentenceCount} sentences evaluating the rizz factor with specific, funny observations>",${detailedField}
  "vibe": "<one word: invisible/struggling/developing/mid/decent/smooth/charming/magnetic/legendary>"
}`
  };

  return modePrompts[mode] || modePrompts.roast;
}

// ===== BATTLE PROMPT =====
function createBattlePrompt(text, category, mode) {
  const modeStyles = {
    roast: 'Be SAVAGE and hilarious. Destroy both items but pick a winner.',
    hype: 'Be SUPER positive about both but pick the one that slaps harder.',
    honest: 'Be brutally honest about both. No sugarcoating.',
    unhinged: 'Go COMPLETELY UNHINGED comparing these two. Absolute chaos.',
    rizz: 'Evaluate the rizz/charm of both and crown the rizz champion.'
  };
  const style = modeStyles[mode] || modeStyles.roast;

  return `You are the ULTIMATE head-to-head battle judge. Two items have been submitted for a showdown. ${style}

The user submitted TWO images for a head-to-head battle.
Category: ${category}
${text ? `User says: "${text}"` : ''}

IMPORTANT: Give each item a decimal score from 0.0 to 10.0 with ONE decimal place. Pick a clear WINNER. Be specific about what you see in EACH image. Make it dramatic and entertaining — this should be screenshot-worthy.

Respond ONLY with this JSON:
{
  "score1": <decimal score for first item>,
  "score2": <decimal score for second item>,
  "commentary1": "<2-3 sentences about item 1>",
  "commentary2": "<2-3 sentences about item 2>",
  "winner": <1 or 2>,
  "verdict": "<one dramatic sentence declaring the winner and why>",
  "vibe1": "<one word vibe for item 1>",
  "vibe2": "<one word vibe for item 2>"
}`;
}

// ===== REQUEST HANDLER =====
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // Serve frontend (handle /, /index.html, and /?payment=success/cancel)
  const urlPath = req.url.split('?')[0];
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'frontend.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // Health check
  if (req.method === 'GET' && req.url === '/api/health') {
    return sendJSON(res, 200, { status: 'ok' });
  }

  // Rate endpoint
  if (req.method === 'POST' && (req.url === '/api/rate' || req.url === '/api/rate-detailed')) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!checkRateLimit(ip)) {
      return sendJSON(res, 429, { error: 'Rate limit exceeded. Try again in an hour.' });
    }

    if (!ANTHROPIC_API_KEY) {
      return sendJSON(res, 500, { error: 'API key not configured' });
    }

    try {
      const body = await parseBody(req);
      const { image, text, mode, category } = body;

      if (!image && !text) return sendJSON(res, 400, { error: 'Provide an image or text' });
      if (!['roast', 'hype', 'honest', 'unhinged', 'rizz'].includes(mode)) return sendJSON(res, 400, { error: 'Invalid mode' });

      let imageBase64 = image;
      let mediaType = 'image/jpeg';
      if (image && image.includes(',')) {
        const parts = image.split(',');
        imageBase64 = parts[1];
        const mime = parts[0].match(/data:([^;]+)/);
        if (mime) mediaType = mime[1];
      }

      const detailed = req.url === '/api/rate-detailed';
      const prompt = createPrompt(text, category || 'other', !!image, mode, detailed);
      const result = await callClaude(prompt, imageBase64, mediaType);
      return sendJSON(res, 200, result);
    } catch (err) {
      console.error('Error:', err.message);
      return sendJSON(res, 500, { error: err.message || 'Something went wrong' });
    }
  }

  // Battle endpoint - two images head-to-head
  if (req.method === 'POST' && req.url === '/api/battle') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!checkRateLimit(ip)) {
      return sendJSON(res, 429, { error: 'Rate limit exceeded. Try again in an hour.' });
    }
    if (!ANTHROPIC_API_KEY) {
      return sendJSON(res, 500, { error: 'API key not configured' });
    }

    try {
      const body = await parseBody(req);
      const { image1, image2, text, mode, category } = body;
      if (!image1 || !image2) return sendJSON(res, 400, { error: 'Two images required for battle mode' });
      if (!['roast', 'hype', 'honest', 'unhinged', 'rizz'].includes(mode)) return sendJSON(res, 400, { error: 'Invalid mode' });

      // Parse both images
      let img1Base64 = image1, img2Base64 = image2;
      let media1 = 'image/jpeg', media2 = 'image/jpeg';
      if (image1.includes(',')) {
        const parts = image1.split(',');
        img1Base64 = parts[1];
        const mime = parts[0].match(/data:([^;]+)/);
        if (mime) media1 = mime[1];
      }
      if (image2.includes(',')) {
        const parts = image2.split(',');
        img2Base64 = parts[1];
        const mime = parts[0].match(/data:([^;]+)/);
        if (mime) media2 = mime[1];
      }

      const prompt = createBattlePrompt(text, category || 'other', mode);

      // Send both images to Claude
      const content = [
        { type: 'text', text: 'ITEM 1 (first image):' },
        { type: 'image', source: { type: 'base64', media_type: media1, data: img1Base64 } },
        { type: 'text', text: 'ITEM 2 (second image):' },
        { type: 'image', source: { type: 'base64', media_type: media2, data: img2Base64 } },
        { type: 'text', text: prompt }
      ];

      const apiBody = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content }]
      });

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: apiBody
      });

      if (!response.ok) {
        const err = await response.text();
        console.error('Anthropic API error:', response.status, err);
        throw new Error(`Anthropic API error ${response.status}: ${err}`);
      }

      const data = await response.json();
      const textResp = data.content[0]?.text || '';
      const jsonMatch = textResp.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      return sendJSON(res, 200, JSON.parse(jsonMatch[0]));
    } catch (err) {
      console.error('Battle error:', err.message);
      return sendJSON(res, 500, { error: err.message || 'Battle failed' });
    }
  }

  // Stripe Checkout - create session
  if (req.method === 'POST' && req.url === '/api/create-checkout') {
    if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID) {
      return sendJSON(res, 500, { error: 'Payments not configured' });
    }

    try {
      const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null) || `http://localhost:${PORT}`;
      const stripeBody = new URLSearchParams({
        'payment_method_types[]': 'card',
        'line_items[0][price]': STRIPE_PRICE_ID,
        'line_items[0][quantity]': '1',
        'mode': 'payment',
        'success_url': origin + '/?payment=success',
        'cancel_url': origin + '/?payment=cancel'
      }).toString();

      const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + STRIPE_SECRET_KEY,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: stripeBody
      });

      const session = await stripeRes.json();
      if (!stripeRes.ok) {
        console.error('Stripe error:', session);
        return sendJSON(res, 500, { error: session.error?.message || 'Stripe error' });
      }

      return sendJSON(res, 200, { url: session.url });
    } catch (err) {
      console.error('Checkout error:', err.message);
      return sendJSON(res, 500, { error: 'Checkout failed' });
    }
  }

  // 404
  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`\n⚡ RateMyAnything.ai running on http://localhost:${PORT}\n`);
  if (!ANTHROPIC_API_KEY) console.warn('⚠️  WARNING: Set ANTHROPIC_API_KEY environment variable');
});
