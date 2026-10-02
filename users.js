import fs from 'fs';
import { PNG } from 'pngjs';

function parseEnvInt(val, fallback) {
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const START_X = parseInt(process.env.START_X, 10);
const START_Y = parseInt(process.env.START_Y, 10);
const END_X = parseInt(process.env.END_X, 10);
const END_Y = parseInt(process.env.END_Y, 10);
const ZONE_NAME = process.env.ZONE_NAME || 'default';
const STATE_FILE = `state-${ZONE_NAME}.json`;

// Run for 5.5 hours to safely avoid the 6-hour GitHub Actions hard kill
const RUN_DURATION_MS = parseEnvInt(process.env.RUN_DURATION_MINS, 330) * 60 * 1000; 

const CFG_TARGET_INTERVAL = parseEnvInt(process.env.TARGET_INTERVAL, 500);
const CFG_MIN_FLOOR = parseEnvInt(process.env.MIN_FLOOR, 399);
const CFG_PAUSE_SEC_429 = parseEnvInt(process.env.PAUSE_SEC_429, 321);
const CFG_PENALTY_MS_429 = parseEnvInt(process.env.PENALTY_MS_429, 500);
const CFG_STEP_DOWN_MS = parseEnvInt(process.env.STEP_DOWN_MS, 21);
const CFG_STREAK_REQS = parseEnvInt(process.env.STREAK_REQS, 42);

const TILE_SIZE = 1000;
let isShuttingDown = false;
const shutdownController = new AbortController();

function log(msg, type = 'info') {
  const ts = new Date().toISOString().substring(11, 19);
  const prefix = `[${ts}] [${ZONE_NAME}]`;
  if (type === 'warn' || type === 'error') console.error(`${prefix} ⚠️ ${msg}`);
  else if (type === 'success') console.log(`${prefix} ✅ ${msg}`);
  else console.log(`${prefix} ℹ️ ${msg}`);
}

function getCoords(absX, absY) {
  return {
    tileX: Math.floor(absX / TILE_SIZE),
    tileY: Math.floor(absY / TILE_SIZE),
    pixelX: ((absX % TILE_SIZE) + TILE_SIZE) % TILE_SIZE,
    pixelY: ((absY % TILE_SIZE) + TILE_SIZE) % TILE_SIZE
  };
}

const wait = (ms, signal = null) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const onAbort = () => { clearTimeout(timer); resolve(); };
  const timer = setTimeout(() => {
    if (signal) signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

// --- Image Caching to Prevent OOM Errors ---
const tileCache = new Map();
async function getTileImage(tileX, tileY) {
  const key = `${tileX}_${tileY}`;
  if (tileCache.has(key)) return tileCache.get(key);

  // Keep max 4 tiles in memory to prevent memory leaks over a 5.5 hour run
  if (tileCache.size >= 4) {
    const firstKey = tileCache.keys().next().value;
    tileCache.delete(firstKey);
  }

  log(`Downloading tile map (${tileX}, ${tileY}) to filter blank pixels...`);
  const url = `https://backend.wplace.live/files/s0/tiles/${tileX}/${tileY}.png?t=${Date.now()}`;
  
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Tile HTTP ${res.status}`);
  
  const arrayBuffer = await res.arrayBuffer();
  const png = PNG.sync.read(Buffer.from(arrayBuffer));
  tileCache.set(key, png);
  return png;
}

function isPixelBlank(png, pixelX, pixelY) {
  const idx = (pixelY * TILE_SIZE + pixelX) * 4;
  return png.data[idx + 3] === 0; // Alpha channel is 0 (Transparent)
}

// --- Official API Request ---
async function fetchPixelOfficial(tileX, tileY, pixelX, pixelY) {
  const url = `https://backend.wplace.live/s0/pixel/${tileX}/${tileY}?x=${pixelX}&y=${pixelY}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([AbortSignal.timeout(15000), shutdownController.signal])
    });
    if (res.ok) {
      const data = await res.json();
      return { 
        success: true, 
        username: data?.paintedBy?.name || 'Blank / Unknown',
        discordId: data?.paintedBy?.id || null
      };
    }
    return { success: false, status: res.status };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return { success: false, status: 408 };
    return { success: false, status: 0 };
  }
}

// --- State Management ---
function loadState(minX, minY) {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      log(`Restored state! Resuming from X:${data.resumeX}, Y:${data.resumeY}. Found ${Object.keys(data.users).length} users so far.`);
      return data;
    } catch (err) {
      log(`Failed to parse state file: ${err.message}. Starting fresh.`, 'warn');
    }
  }
  return { users: {}, resumeX: minX, resumeY: minY, completed: false, pixelsScanned: 0 };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function run() {
  const minX = Math.min(START_X, END_X);
  const maxX = Math.max(START_X, END_X);
  const minY = Math.min(START_Y, END_Y);
  const maxY = Math.max(START_Y, END_Y);
  const runStartTime = Date.now();

  const state = loadState(minX, minY);
  
  if (state.completed) {
    log(`Sector is already fully scanned! Exiting.`, 'success');
    process.exit(0);
  }

  let targetInterval = CFG_TARGET_INTERVAL;
  let minFloor = CFG_MIN_FLOOR;
  let consecutiveSuccesses = 0;
  
  const startY = Math.max(minY, state.resumeY);

  for (let y = startY; y <= maxY; y++) {
    // If we are on the row we resumed from, start at resumeX, otherwise start at the left edge
    const startX = (y === state.resumeY) ? Math.max(minX, state.resumeX) : minX;

    for (let x = startX; x <= maxX; x++) {
      if (isShuttingDown) break;

      // Graceful timeout limit
      if (Date.now() - runStartTime >= RUN_DURATION_MS) {
        log(`5.5 hour limit reached. Saving state to yield runner...`, 'warn');
        isShuttingDown = true;
        break;
      }

      const { tileX, tileY, pixelX, pixelY } = getCoords(x, y);

      // 1. Skip Blank Pixels Using the Image Map
      try {
        const png = await getTileImage(tileX, tileY);
        if (isPixelBlank(png, pixelX, pixelY)) {
          state.resumeX = x;
          state.resumeY = y;
          state.pixelsScanned++;
          continue; // Instantly move to next pixel
        }
      } catch (err) {
        log(`Failed to load tile image to verify pixel (${x}, ${y}): ${err.message}. Assuming painted to be safe.`, 'warn');
      }

      // 2. Fetch API for painted pixels
      let resolved = false;
      const reqStart = Date.now();

      while (!resolved && !isShuttingDown) {
        const res = await fetchPixelOfficial(tileX, tileY, pixelX, pixelY);
        const duration = Date.now() - reqStart;

        if (res.success) {
          consecutiveSuccesses++;
          resolved = true;
          
          if (res.username !== 'Blank / Unknown') {
            const key = res.discordId || res.username;
            if (!state.users[key]) {
              state.users[key] = { username: res.username, discordId: res.discordId, pixels_painted: 0 };
            }
            state.users[key].pixels_painted++;
          }

          if (CFG_STEP_DOWN_MS > 0 && consecutiveSuccesses >= CFG_STREAK_REQS && targetInterval > minFloor) {
            targetInterval = Math.max(minFloor, targetInterval - CFG_STEP_DOWN_MS);
          }

          const sleepRemaining = Math.max(0, targetInterval - duration);
          if (sleepRemaining > 0) await wait(sleepRemaining, shutdownController.signal);

        } else if (res.status === 429) {
          consecutiveSuccesses = 0;
          minFloor = Math.max(minFloor, targetInterval + Math.max(10, CFG_STEP_DOWN_MS));
          targetInterval += CFG_PENALTY_MS_429;
          log(`Rate limited! Pausing for ${CFG_PAUSE_SEC_429}s...`, 'warn');
          await wait(CFG_PAUSE_SEC_429 * 1000, shutdownController.signal);
        } else {
          log(`HTTP ${res.status}. Retrying in 10s...`, 'error');
          consecutiveSuccesses = 0;
          targetInterval += Math.ceil(CFG_STEP_DOWN_MS);
          await wait(10000, shutdownController.signal);
        }
      }

      // Update checkpoint pointer
      state.resumeX = x;
      state.resumeY = y;
      state.pixelsScanned++;

      if (state.pixelsScanned % 1000 === 0) {
        log(`Scanned ${state.pixelsScanned} pixels. Found ${Object.keys(state.users).length} users so far.`);
        saveState(state); // Safety save
      }
    }
    if (isShuttingDown) break;
  }

  // If we naturally exited the loops without a shutdown flag, we are completely done.
  if (!isShuttingDown) {
    state.completed = true;
    log(`Sector completely scanned!`, 'success');
  }

  saveState(state);
  
  // Format output for artifacts
  const finalArray = Object.values(state.users).sort((a, b) => b.pixels_painted - a.pixels_painted);
  fs.writeFileSync(`users-${ZONE_NAME}.json`, JSON.stringify(finalArray, null, 2));
  
  log('Clean exit.', 'success');
  process.exit(0);
}

process.on('SIGINT', () => { isShuttingDown = true; shutdownController.abort(); });
process.on('SIGTERM', () => { isShuttingDown = true; shutdownController.abort(); });

run().catch((err) => {
  log(`Fatal error: ${err.message}`, 'error');
  process.exit(1);
});