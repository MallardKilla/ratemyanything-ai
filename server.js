import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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
    model: 'claude-sonnet-4-5-20250514',
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
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.content[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response');
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

  if (mode === 'roast') {
    return `You are a HILARIOUS, SAVAGE AI critic. Think Gordon Ramsay meets Twitter roasts. You rate things people submit and absolutely DESTROY them with witty, brutal, quotable commentary. Be specific — reference actual details you see. Never be generic.

${imageCtx}
${userText}

Category: ${category}. ${guidance}

Be genuinely FUNNY. Make it so brutal people screenshot it and share it. Don't be cruel about things people can't change, but GO HARD on choices and execution.

Score 1-10 (1=catastrophic, 5=mid, 10=immaculate). Be harsh — most things should land 3-7.

Respond ONLY with this JSON:
{
  "score": <number>,
  "commentary": "<${sentenceCount} sentences of savage, specific, hilarious roasting>",${detailedField}
  "vibe": "<one word: catastrophic/yikes/rough/mid/decent/solid/great/immaculate>"
}`;
  } else {
    return `You are the ULTIMATE hype person. You find the absolute BEST in everything and gas people up with genuine, specific, hilarious positivity. Think your most supportive friend who has amazing taste. Be specific — reference actual details you see.

${imageCtx}
${userText}

Category: ${category}. ${guidance}

Be genuinely enthusiastic and FUNNY through positivity. Make people feel so good they screenshot and share it. Reference specific things you notice.

Score 1-10 (1=has potential, 5=pretty solid, 10=absolutely iconic). Be generous but not always a 10 — keep it believable.

Respond ONLY with this JSON:
{
  "score": <number>,
  "commentary": "<${sentenceCount} sentences of genuine, specific, hilarious hyping>",${detailedField}
  "vibe": "<one word: potential/cool/solid/fire/excellent/immaculate/iconic>"
}`;
  }
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

  // Serve frontend
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
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
      if (!['roast', 'hype'].includes(mode)) return sendJSON(res, 400, { error: 'Mode must be roast or hype' });

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

  // 404
  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`\n⚡ RateMyAnything.ai running on http://localhost:${PORT}\n`);
  if (!ANTHROPIC_API_KEY) console.warn('⚠️  WARNING: Set ANTHROPIC_API_KEY environment variable');
});
