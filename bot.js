import { PNG } from 'pngjs';

function parseEnvInt(val, fallback) {
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const WORKER_URL = process.env.WORKER_URL;
const START_X = parseInt(process.env.START_X, 10);
const START_Y = parseInt(process.env.START_Y, 10);
const END_X = parseInt(process.env.END_X, 10);
const END_Y = parseInt(process.env.END_Y, 10);

const RUN_DURATION_MS = parseEnvInt(process.env.RUN_DURATION_MINS, 20) * 60 * 1000;
const PAUSE_INTERVAL_MS = parseEnvInt(process.env.PAUSE_INTERVAL_SECS, 10) * 1000;
const TOTAL_CYCLES = parseEnvInt(process.env.TOTAL_CYCLES, 1);

const CFG_TARGET_INTERVAL = parseEnvInt(process.env.TARGET_INTERVAL, 500);
const CFG_MIN_FLOOR = parseEnvInt(process.env.MIN_FLOOR, 399);
const CFG_PAUSE_SEC_429 = parseEnvInt(process.env.PAUSE_SEC_429, 321);
const CFG_PENALTY_MS_429 = parseEnvInt(process.env.PENALTY_MS_429, 500);
const CFG_STEP_DOWN_MS = parseEnvInt(process.env.STEP_DOWN_MS, 21);
const CFG_STREAK_REQS = parseEnvInt(process.env.STREAK_REQS, 42);
const FLUSH_INTERVAL = parseEnvInt(process.env.STREAK_REQS, 1000); // Auto-save every 200 pixels

const TILE_SIZE = 1000;
const LOG_INTERVAL = 200; // Log every 200 pixels

// Global Shutdown Flag
let isShuttingDown = false;

function log(msg, type = 'info') {
  const ts = new Date().toISOString().substring(11, 19);
  const prefix = `[${ts}]`;
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchBackendTile(tileX, tileY) {
  try {
    // Append a unique timestamp to bypass Cloudflare's edge cache!
    const cacheBuster = Date.now();
    const url = `${WORKER_URL}/tile/${tileX}/${tileY}?t=${cacheBuster}`;
    
    const res = await fetch(url, { 
      // Also strictly instruct Node's internal fetch not to cache
      cache: 'no-store', 
      signal: AbortSignal.timeout(15000) 
    });
    
    if (res.ok) return await res.json();
  } catch (err) {
    log(`Failed to fetch cache for sector (${tileX}, ${tileY}): ${err.message}`, 'warn');
  }
  return {};
}

async function syncBackendTile(tileX, tileY, batchMap) {
  if (Object.keys(batchMap).length === 0) return;
  try {
    const res = await fetch(`${WORKER_URL}/tile/${tileX}/${tileY}`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(batchMap),
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) log(`Failed to sync sector (${tileX}, ${tileY}): HTTP ${res.status}`, 'warn');
  } catch (err) {
    log(`Error syncing sector (${tileX}, ${tileY}): ${err.message}`, 'warn');
  }
}

async function fetchTileImageData(tileX, tileY) {
  const url = `https://backend.wplace.live/files/s0/tiles/${tileX}/${tileY}.png`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Tile HTTP ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return PNG.sync.read(Buffer.from(arrayBuffer));
}

function getTilePixelColor(png, pixelX, pixelY) {
  const idx = (pixelY * TILE_SIZE + pixelX) * 4;
  if (png.data[idx + 3] === 0) return -1;
  return (png.data[idx] << 16) | (png.data[idx + 1] << 8) | png.data[idx + 2];
}

async function fetchPixelOfficial(tileX, tileY, pixelX, pixelY) {
  const url = `https://backend.wplace.live/s0/pixel/${tileX}/${tileY}?x=${pixelX}&y=${pixelY}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const data = await res.json();
      return { success: true, username: data?.paintedBy?.name || 'Blank / Unknown' };
    }
    return { success: false, status: res.status };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return { success: false, status: 408 };
    return { success: false, status: 0 };
  }
}

async function run() {
  const minX = Math.min(START_X, END_X);
  const maxX = Math.max(START_X, END_X);
  const minY = Math.min(START_Y, END_Y);
  const maxY = Math.max(START_Y, END_Y);
  const totalPixels = (maxX - minX + 1) * (maxY - minY + 1);

  log(`Target Coordinates: [${minX}, ${minY}] to [${maxX}, ${maxY}] (${totalPixels} total pixels)`);
  log(`Execution Plan: ${TOTAL_CYCLES} cycle(s), max ${RUN_DURATION_MS / 60000}m run per cycle`);

  for (let cycle = 1; cycle <= TOTAL_CYCLES; cycle++) {
    if (isShuttingDown) break;
    log(`================== STARTING CYCLE ${cycle}/${TOTAL_CYCLES} ==================`);
    const cycleStartTime = Date.now();

    const minTileX = Math.floor(minX / TILE_SIZE), maxTileX = Math.floor(maxX / TILE_SIZE);
    const minTileY = Math.floor(minY / TILE_SIZE), maxTileY = Math.floor(maxY / TILE_SIZE);

    const intersectingTiles = [];
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) intersectingTiles.push({ tx, ty });
    }

    log(`Fetching D1 cache and tile images for ${intersectingTiles.length} sector(s)...`);
    const cloudCache = new Map(), pngMap = new Map();

    for (const { tx, ty } of intersectingTiles) {
      cloudCache.set(`${tx}_${ty}`, await fetchBackendTile(tx, ty));
      try { pngMap.set(`${tx}_${ty}`, await fetchTileImageData(tx, ty)); } 
      catch (err) { log(`Could not load PNG for (${tx}, ${ty}): ${err.message}`, 'warn'); }
    }

    const pendingTasks = [];
    let instantMatches = 0;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const { tileX, tileY, pixelX, pixelY } = getCoords(x, y);
        const sectorKey = `${tileX}_${tileY}`;
        const cached = cloudCache.get(sectorKey)?.[`${pixelX}_${pixelY}`];
        const currentColor = pngMap.has(sectorKey) ? getTilePixelColor(pngMap.get(sectorKey), pixelX, pixelY) : null;

        if (cached && cached.c !== null && currentColor !== null && cached.c === currentColor) {
          instantMatches++;
        } else {
          pendingTasks.push({ x, y, tileX, tileY, pixelX, pixelY, currentColor });
        }
      }
    }

    log(`Diff Summary: ${instantMatches} static pixels resolved. ${pendingTasks.length} pending queries.`, 'success');
    if (pendingTasks.length === 0) break;

    let targetInterval = CFG_TARGET_INTERVAL, minFloor = CFG_MIN_FLOOR;
    let consecutiveSuccesses = 0, scannedThisCycle = 0;
    let consecutiveSkips = 0;
    let discoveriesToFlush = {};

    const flushToD1 = async () => {
      let flushCount = 0;
      for (const sector of Object.values(discoveriesToFlush)) {
        const keysCount = Object.keys(sector.data).length;
        if (keysCount > 0) {
          await syncBackendTile(sector.tx, sector.ty, sector.data);
          flushCount += keysCount;
        }
      }
      
      if (flushCount > 0) {
        log(`Flushed ${flushCount} pixels to D1. Pulling latest cloud state...`, 'success');
        
        // Mid-scan cache update: Fetch all intersecting tiles to catch userscript discoveries
        for (const { tx, ty } of intersectingTiles) {
            const updatedData = await fetchBackendTile(tx, ty);
            cloudCache.set(`${tx}_${ty}`, updatedData);
        }
      }
      discoveriesToFlush = {}; // Reset queue after flush
    };

    // Main Scanning Loop
    for (const task of pendingTasks) {
      if (isShuttingDown) {
        log(`Manual cancellation detected! Halting loop...`, 'warn');
        break; 
      }
      if (Date.now() - cycleStartTime >= RUN_DURATION_MS) {
        log(`Time window of ${RUN_DURATION_MS / 60000}m reached. Stopping queries...`, 'warn');
        break;
      }

      const { tileX, tileY, pixelX, pixelY, currentColor } = task;
      const sectorKey = `${tileX}_${tileY}`;

      // MID-SCAN CHECK: Did another bot/user discover this since the cycle started?
      const liveCache = cloudCache.get(sectorKey)?.[`${pixelX}_${pixelY}`];
      if (liveCache && liveCache.c !== null && liveCache.c === currentColor) {
          // Skip the Wplace API call entirely!
          scannedThisCycle++;
          consecutiveSkips++;
          continue; 
      } else if (consecutiveSkips > 0) {
        consecutiveSkips = 0;
        log(`Skipped ${consecutiveSkips} pixels - already discovered by another bot/user!`);
        continue;
      }

      let resolved = false;

      while (!resolved && !isShuttingDown) {
        const reqStart = Date.now();
        const res = await fetchPixelOfficial(tileX, tileY, pixelX, pixelY);
        const duration = Date.now() - reqStart;

        if (res.success) {
          scannedThisCycle++;
          consecutiveSuccesses++;

          if (!discoveriesToFlush[sectorKey]) discoveriesToFlush[sectorKey] = { tx: tileX, ty: tileY, data: {} };
          discoveriesToFlush[sectorKey].data[`${pixelX}_${pixelY}`] = { u: res.username, c: currentColor };

          if (CFG_STEP_DOWN_MS > 0 && consecutiveSuccesses >= CFG_STREAK_REQS && targetInterval > minFloor) {
            targetInterval = Math.max(minFloor, targetInterval - CFG_STEP_DOWN_MS);
            consecutiveSuccesses = 0;
            log(`Speed step triggered! New target: ${targetInterval}ms (Floor: ${minFloor}ms)`);
          }

          resolved = true;
          
          // Periodic Flush check
          if (scannedThisCycle % FLUSH_INTERVAL === 0) {
            log(`Checkpoint reached (${scannedThisCycle} pixels). Auto-saving...`);
            await flushToD1();
          }

          if (scannedThisCycle % LOG_INTERVAL === 0) {
            const timeRemainingMins = ((RUN_DURATION_MS - (Date.now() - cycleStartTime)) / 60000).toFixed(1);
            log(`[Progress] Scanned ${scannedThisCycle}/${pendingTasks.length} pixels | cadence: ${targetInterval}ms | time left: ${timeRemainingMins}m`);
          }

          const sleepRemaining = Math.max(0, targetInterval - duration);
          if (sleepRemaining > 0) await wait(sleepRemaining);

        } else if (res.status === 429) {
          consecutiveSuccesses = 0;
          minFloor = Math.max(minFloor, targetInterval + Math.max(10, CFG_STEP_DOWN_MS));
          targetInterval += CFG_PENALTY_MS_429;
          log(`Rate limited! Learned floor: ${minFloor}ms. Pausing for ${CFG_PAUSE_SEC_429}s...`, 'warn');
          await wait(CFG_PAUSE_SEC_429 * 1000);
        } else if (res.status === 408) {
          log(`Connection Timeout. Retrying in 30s...`, 'warn');
          await wait(30000);
        } else {
          log(`HTTP ${res.status || 'Network Error'}. Retrying in 30s...`, 'error');
          await wait(30000);
        }
      }
    }

    // Final end-of-cycle flush
    await flushToD1();

    if (cycle < TOTAL_CYCLES && !isShuttingDown) {
      log(`Pausing for ${PAUSE_INTERVAL_MS / 60000}m before cycle ${cycle + 1}...`);
      await wait(PAUSE_INTERVAL_MS);
    }
  }

  log('Execution finished cleanly.', 'success');
  process.exit(0);
}

// Graceful Cancellation Traps
const handleShutdown = () => {
  if (isShuttingDown) return; // Prevent double-triggering
  log('Received cancel signal (SIGINT/SIGTERM) from GitHub! Initiating emergency flush...', 'warn');
  isShuttingDown = true;
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

run().catch((err) => {
  log(`Fatal execution error: ${err.message}`, 'error');
  process.exit(1);
});