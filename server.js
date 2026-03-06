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
  if (requests.length >= 60) return false;
  requests.push(now);
  rateLimitStore.set(ip, requests);
  return true;
}

// ===== PAYMENT TOKENS =====
const paymentTokens = new Set();

// ===== SERVER-SIDE USAGE TRACKING =====
const FREE_RATINGS = 3;
const PAID_RATINGS_PER_PURCHASE = 5;

function getUsageKey(req, body) {
  // Prefer userId if logged in, otherwise use IP
  if (body && body.userId) return 'user:' + body.userId;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  return 'ip:' + ip;
}

function getUsage(key) {
  if (!db.usage) db.usage = {};
  if (!db.usage[key]) db.usage[key] = { used: 0, paid: 0 };
  return db.usage[key];
}

function canUserRate(key) {
  const u = getUsage(key);
  return u.used < FREE_RATINGS + u.paid;
}

function getRemainingRatings(key) {
  const u = getUsage(key);
  return Math.max(0, FREE_RATINGS + u.paid - u.used);
}

function incrementUsage(key) {
  const u = getUsage(key);
  u.used++;
  saveDB();
}

function addPaidRatings(key) {
  const u = getUsage(key);
  u.paid += PAID_RATINGS_PER_PURCHASE;
  saveDB();
}

// ===== DATABASE (JSON file-based) =====
const DB_PATH = path.join(__dirname, 'db.json');
let db = { users: {}, dailyChallenge: null, dailyChallengeDate: null };

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
      if (!db.users) db.users = {};
      if (!db.usage) db.usage = {};
      console.log(`Database loaded: ${Object.keys(db.users).length} users`);
    }
  } catch (e) {
    console.error('Failed to load DB:', e.message);
    db = { users: {}, dailyChallenge: null, dailyChallengeDate: null };
  }
}

function saveDB() {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db), 'utf-8'); }
  catch (e) { console.error('Failed to save DB:', e.message); }
}

loadDB();

// Generate a short friend code
function generateFriendCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Get today's date as string
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ===== DAILY CHALLENGE =====
const dailyChallenges = [
  { emoji: '🛏️', title: 'Rate Your Bed Setup', prompt: 'Show us your bed/sleeping setup right now', category: 'room' },
  { emoji: '👟', title: 'Rate Your Shoes', prompt: 'Show us what you got on your feet today', category: 'outfit' },
  { emoji: '🍳', title: 'Rate Your Breakfast', prompt: 'Show us what you ate (or are eating) for breakfast', category: 'food' },
  { emoji: '📱', title: 'Rate Your Home Screen', prompt: 'Screenshot your phone home screen', category: 'other' },
  { emoji: '🎒', title: 'Rate Your Bag', prompt: 'Show us your backpack, purse, or daily carry', category: 'outfit' },
  { emoji: '🪴', title: 'Rate Your View', prompt: 'Show us the view from your window right now', category: 'other' },
  { emoji: '🚗', title: 'Rate Your Ride', prompt: 'Show us your car, bike, or whatever you drive', category: 'car' },
  { emoji: '🐾', title: 'Rate Your Pet', prompt: 'Show us your pet (or your dream pet)', category: 'pet' },
  { emoji: '🍔', title: 'Rate Your Lunch', prompt: 'Show us what you had for lunch today', category: 'food' },
  { emoji: '💇', title: 'Rate Your Hair', prompt: 'Show us your hair today — no filter', category: 'other' },
  { emoji: '🏠', title: 'Rate Your Room', prompt: 'Full room tour — show us the vibes', category: 'room' },
  { emoji: '👕', title: 'Rate Your Fit', prompt: 'Show us your outfit right now', category: 'outfit' },
  { emoji: '☕', title: 'Rate Your Coffee Order', prompt: 'Show us your go-to drink', category: 'food' },
  { emoji: '🎮', title: 'Rate Your Setup', prompt: 'Show us your gaming/desk setup', category: 'room' },
];

function getDailyChallenge() {
  const today = todayStr();
  if (db.dailyChallengeDate === today && db.dailyChallenge) {
    return db.dailyChallenge;
  }
  // Pick based on day of year for consistency
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  const challenge = dailyChallenges[dayOfYear % dailyChallenges.length];
  db.dailyChallenge = challenge;
  db.dailyChallengeDate = today;
  saveDB();
  return challenge;
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
function parseBody(req, maxSize = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) { reject(new Error('Body too large')); req.destroy(); return; }
      data += chunk;
    });
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
  const urlPath = req.url.split('?')[0];
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'frontend.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // Health check
  if (req.method === 'GET' && urlPath === '/api/health') {
    return sendJSON(res, 200, { status: 'ok' });
  }

  // ===== USAGE CHECK (server-side paywall) =====
  if (req.method === 'POST' && urlPath === '/api/usage') {
    try {
      const body = await parseBody(req);
      const key = getUsageKey(req, body);
      const usage = getUsage(key);
      return sendJSON(res, 200, {
        used: usage.used,
        paid: usage.paid,
        free: FREE_RATINGS,
        remaining: getRemainingRatings(key),
        canRate: canUserRate(key)
      });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Usage check failed' });
    }
  }

  // ===== RECORD PAYMENT (server-side, token-verified) =====
  if (req.method === 'POST' && urlPath === '/api/record-payment') {
    try {
      const body = await parseBody(req);
      const token = body.token;
      if (!token || !paymentTokens.has(token)) {
        return sendJSON(res, 403, { error: 'Invalid or expired payment token' });
      }
      // Consume the token (one-time use)
      paymentTokens.delete(token);
      const key = getUsageKey(req, body);
      addPaidRatings(key);
      return sendJSON(res, 200, {
        remaining: getRemainingRatings(key),
        canRate: canUserRate(key)
      });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Payment record failed' });
    }
  }

  // ===== USER SIGNUP =====
  if (req.method === 'POST' && urlPath === '/api/signup') {
    try {
      const body = await parseBody(req);
      const username = (body.username || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (!username || username.length < 2 || username.length > 20) {
        return sendJSON(res, 400, { error: 'Username must be 2-20 chars (letters, numbers, underscores)' });
      }
      // Check if taken
      const existing = Object.values(db.users).find(u => u.username === username);
      if (existing) {
        return sendJSON(res, 409, { error: 'Username taken! Try another one.' });
      }
      // Create new user
      const userId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const friendCode = generateFriendCode();
      db.users[userId] = {
        id: userId,
        username: username,
        friendCode: friendCode,
        friends: [],
        ratings: [],
        dailyRatings: {},
        avgScore: 0,
        totalRatings: 0,
        createdAt: Date.now()
      };

      // Transfer IP usage to user account so they can't double-dip free ratings
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      const ipKey = 'ip:' + ip;
      const userKey = 'user:' + userId;
      if (db.usage && db.usage[ipKey]) {
        db.usage[userKey] = { ...db.usage[ipKey] };
      }

      saveDB();
      return sendJSON(res, 200, { userId, username, friendCode });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Signup failed' });
    }
  }

  // ===== LOGIN (return to existing account) =====
  if (req.method === 'POST' && urlPath === '/api/login') {
    try {
      const body = await parseBody(req);
      const username = (body.username || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (!username) return sendJSON(res, 400, { error: 'Enter a username' });
      const user = Object.values(db.users).find(u => u.username === username);
      if (!user) return sendJSON(res, 404, { error: 'Username not found. Want to sign up?' });

      // Merge any IP usage into user account (take the higher used count)
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      const ipKey = 'ip:' + ip;
      const userKey = 'user:' + user.id;
      if (!db.usage) db.usage = {};
      const ipUsage = db.usage[ipKey] || { used: 0, paid: 0 };
      const userUsage = db.usage[userKey] || { used: 0, paid: 0 };
      db.usage[userKey] = { used: Math.max(ipUsage.used, userUsage.used), paid: Math.max(ipUsage.paid, userUsage.paid) };
      saveDB();

      return sendJSON(res, 200, { userId: user.id, username: user.username, friendCode: user.friendCode });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Login failed' });
    }
  }

  // ===== GET USER PROFILE =====
  if (req.method === 'GET' && urlPath.startsWith('/api/user/')) {
    const userId = urlPath.split('/api/user/')[1];
    const user = db.users[userId];
    if (!user) return sendJSON(res, 404, { error: 'User not found' });
    return sendJSON(res, 200, {
      username: user.username,
      friendCode: user.friendCode,
      friendCount: user.friends.length,
      avgScore: user.avgScore,
      totalRatings: user.totalRatings,
      recentRatings: (user.ratings || []).slice(0, 10)
    });
  }

  // ===== ADD FRIEND =====
  if (req.method === 'POST' && urlPath === '/api/add-friend') {
    try {
      const body = await parseBody(req);
      const { userId, friendCode } = body;
      const user = db.users[userId];
      if (!user) return sendJSON(res, 404, { error: 'User not found' });

      const code = (friendCode || '').trim().toUpperCase();
      const friend = Object.values(db.users).find(u => u.friendCode === code);
      if (!friend) return sendJSON(res, 404, { error: 'No user with that friend code' });
      if (friend.id === userId) return sendJSON(res, 400, { error: "That's your own code!" });
      if (user.friends.includes(friend.id)) return sendJSON(res, 400, { error: 'Already friends!' });

      // Two-way friendship
      user.friends.push(friend.id);
      friend.friends.push(userId);
      saveDB();
      return sendJSON(res, 200, { message: `Added ${friend.username}!`, friend: { username: friend.username, id: friend.id } });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to add friend' });
    }
  }

  // ===== GET FRIENDS LIST =====
  if (req.method === 'GET' && urlPath.startsWith('/api/friends/')) {
    const userId = urlPath.split('/api/friends/')[1];
    const user = db.users[userId];
    if (!user) return sendJSON(res, 404, { error: 'User not found' });
    const friends = user.friends.map(fid => {
      const f = db.users[fid];
      if (!f) return null;
      return {
        id: f.id, username: f.username, avgScore: f.avgScore,
        totalRatings: f.totalRatings,
        lastRating: (f.ratings || [])[0] || null
      };
    }).filter(Boolean);
    return sendJSON(res, 200, { friends });
  }

  // ===== FRIENDS FEED =====
  if (req.method === 'GET' && urlPath.startsWith('/api/feed/')) {
    const userId = urlPath.split('/api/feed/')[1];
    const user = db.users[userId];
    if (!user) return sendJSON(res, 404, { error: 'User not found' });

    // Collect recent ratings from friends + self
    const allPeople = [userId, ...user.friends];
    let feed = [];
    for (const pid of allPeople) {
      const p = db.users[pid];
      if (!p) continue;
      const ratings = (p.ratings || []).slice(0, 5).map(r => ({
        ...r, userId: p.id, username: p.username
      }));
      feed = feed.concat(ratings);
    }
    // Sort by timestamp desc
    feed.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return sendJSON(res, 200, { feed: feed.slice(0, 30) });
  }

  // ===== DAILY CHALLENGE =====
  if (req.method === 'GET' && urlPath === '/api/daily') {
    const challenge = getDailyChallenge();
    return sendJSON(res, 200, { challenge, date: todayStr() });
  }

  // ===== DASHBOARD / LEADERBOARD =====
  if (req.method === 'GET' && urlPath.startsWith('/api/dashboard/')) {
    const userId = urlPath.split('/api/dashboard/')[1];
    const user = db.users[userId];
    if (!user) return sendJSON(res, 404, { error: 'User not found' });

    // User stats
    const today = todayStr();
    const todayRatings = (user.ratings || []).filter(r => {
      if (!r.timestamp) return false;
      return new Date(r.timestamp).toISOString().split('T')[0] === today;
    });
    const didDailyChallenge = !!(user.dailyRatings && user.dailyRatings[today]);

    // Friends leaderboard (by avg score)
    const allPeople = [userId, ...user.friends];
    const leaderboard = allPeople.map(pid => {
      const p = db.users[pid];
      if (!p) return null;
      return {
        id: p.id, username: p.username,
        avgScore: p.avgScore, totalRatings: p.totalRatings,
        isYou: pid === userId
      };
    }).filter(Boolean).sort((a, b) => b.avgScore - a.avgScore);

    return sendJSON(res, 200, {
      username: user.username,
      friendCode: user.friendCode,
      friendCount: user.friends.length,
      avgScore: user.avgScore,
      totalRatings: user.totalRatings,
      todayCount: todayRatings.length,
      didDailyChallenge,
      leaderboard,
      recentRatings: (user.ratings || []).slice(0, 5)
    });
  }

  // ===== SAVE RATING (attach to user) =====
  if (req.method === 'POST' && urlPath === '/api/save-rating') {
    try {
      const body = await parseBody(req);
      const { userId, score, commentary, vibe, mode, category, isDaily } = body;
      const user = db.users[userId];
      if (!user) return sendJSON(res, 200, { saved: false }); // Silent fail if no user

      const ratingEntry = {
        score: parseFloat(score),
        commentary: (commentary || '').slice(0, 300),
        vibe: vibe || '',
        mode: mode || 'roast',
        category: category || 'other',
        timestamp: Date.now(),
        isDaily: !!isDaily
      };

      if (!user.ratings) user.ratings = [];
      user.ratings.unshift(ratingEntry);
      if (user.ratings.length > 50) user.ratings = user.ratings.slice(0, 50);

      // Update stats
      user.totalRatings = (user.totalRatings || 0) + 1;
      const allScores = user.ratings.map(r => r.score).filter(s => !isNaN(s));
      user.avgScore = allScores.length > 0 ? Math.round((allScores.reduce((a, b) => a + b, 0) / allScores.length) * 10) / 10 : 0;

      // Track daily challenge
      if (isDaily) {
        if (!user.dailyRatings) user.dailyRatings = {};
        user.dailyRatings[todayStr()] = ratingEntry;
      }

      saveDB();
      return sendJSON(res, 200, { saved: true });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to save rating' });
    }
  }

  // Rate endpoint
  if (req.method === 'POST' && (urlPath === '/api/rate' || urlPath === '/api/rate-detailed')) {
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

      // Server-side paywall enforcement
      const usageKey = getUsageKey(req, body);
      if (!canUserRate(usageKey)) {
        return sendJSON(res, 403, { error: 'No ratings remaining. Purchase more to continue!', paywall: true, remaining: 0 });
      }

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

      const detailed = urlPath === '/api/rate-detailed';
      const prompt = createPrompt(text, category || 'other', !!image, mode, detailed);
      const result = await callClaude(prompt, imageBase64, mediaType);

      // Increment usage on success
      incrementUsage(usageKey);
      result.remaining = getRemainingRatings(usageKey);

      return sendJSON(res, 200, result);
    } catch (err) {
      console.error('Error:', err.message);
      return sendJSON(res, 500, { error: err.message || 'Something went wrong' });
    }
  }

  // Battle endpoint
  if (req.method === 'POST' && urlPath === '/api/battle') {
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

      // Server-side paywall enforcement
      const usageKey = getUsageKey(req, body);
      if (!canUserRate(usageKey)) {
        return sendJSON(res, 403, { error: 'No ratings remaining. Purchase more to continue!', paywall: true, remaining: 0 });
      }

      if (!image1 || !image2) return sendJSON(res, 400, { error: 'Two images required for battle mode' });
      if (!['roast', 'hype', 'honest', 'unhinged', 'rizz'].includes(mode)) return sendJSON(res, 400, { error: 'Invalid mode' });

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

      // Increment usage on success
      incrementUsage(usageKey);
      const battleResult = JSON.parse(jsonMatch[0]);
      battleResult.remaining = getRemainingRatings(usageKey);

      return sendJSON(res, 200, battleResult);
    } catch (err) {
      console.error('Battle error:', err.message);
      return sendJSON(res, 500, { error: err.message || 'Battle failed' });
    }
  }

  // Stripe Checkout
  if (req.method === 'POST' && urlPath === '/api/create-checkout') {
    if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID) {
      return sendJSON(res, 500, { error: 'Payments not configured' });
    }

    try {
      const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null) || `http://localhost:${PORT}`;
      // Generate a one-time payment token to prevent fake payment URLs
      const payToken = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      paymentTokens.add(payToken);
      // Auto-expire token after 30 minutes
      setTimeout(() => paymentTokens.delete(payToken), 30 * 60 * 1000);

      const stripeBody = new URLSearchParams({
        'payment_method_types[]': 'card',
        'line_items[0][price]': STRIPE_PRICE_ID,
        'line_items[0][quantity]': '1',
        'mode': 'payment',
        'success_url': origin + '/?payment=success&token=' + payToken,
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
