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
const CYCLE_DURATION_MS = Math.ceil(RUN_DURATION_MS / TOTAL_CYCLES);

const CFG_TARGET_INTERVAL = parseEnvInt(process.env.TARGET_INTERVAL, 500);
const CFG_MIN_FLOOR = parseEnvInt(process.env.MIN_FLOOR, 399);
const CFG_PAUSE_SEC_429 = parseEnvInt(process.env.PAUSE_SEC_429, 321);
const CFG_PENALTY_MS_429 = parseEnvInt(process.env.PENALTY_MS_429, 500);
const CFG_STEP_DOWN_MS = parseEnvInt(process.env.STEP_DOWN_MS, 21);
const CFG_STREAK_REQS = parseEnvInt(process.env.STREAK_REQS, 42);
const FLUSH_INTERVAL = parseEnvInt(process.env.FLUSH_INTERVAL, 1000); // Auto-save every 200 pixels

const EXPANSION_ALGORITHM = process.env.EXPANSION_ALGORITHM === 'true';
const LIMIT_EXPANSION = process.env.LIMIT_EXPANSION === 'true'; // limits the expansion to the tiles already affected by the scan
const EXPANSION_RATE = parseEnvInt(process.env.EXPANSION_RATE, 5);

const TILE_SIZE = 1000;
const LOG_INTERVAL = 200; // Log every 200 pixels

// Global Shutdown Flag
let isShuttingDown = false;
const shutdownController = new AbortController();

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

const wait = (ms, signal = null) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

async function fetchBackendTile(tileX, tileY) {
  try {
    // Append a unique timestamp to bypass Cloudflare's edge cache!
    const cacheBuster = Date.now();
    const url = `${WORKER_URL}/tile/${tileX}/${tileY}?t=${cacheBuster}`;
    
    const res = await fetch(url, { 
      // Also strictly instruct Node's internal fetch not to cache
      cache: 'no-store', 
      signal: AbortSignal.any([
        AbortSignal.timeout(15000), 
        shutdownController.signal
      ]),
    });
    
    if (res.ok) return await res.json();
  } catch (err) {
    log(`Failed to fetch cache for sector (${tileX}, ${tileY}): ${err.message}`, 'warn');
  }
  return {};
}

async function syncBackendTile(tileX, tileY, batchMap, signal = null) {
  if (Object.keys(batchMap).length === 0) return true;

  const subSectors = {};
  
  // Group the pending pixels into 100x100 chunks
  for (const [key, record] of Object.entries(batchMap)) {
    const [px, py] = key.split('_').map(Number);
    const subKey = `${Math.floor(px / 100)}_${Math.floor(py / 100)}`;
    
    if (!subSectors[subKey]) subSectors[subKey] = {};
    subSectors[subKey][key] = record;
  }

  let allSuccessful = true;

  // Send chunks sequentially to prevent Worker HTTP/Memory limits
  for (const [subKey, chunkData] of Object.entries(subSectors)) {
    try {
      const res = await fetch(`${WORKER_URL}/tile/${tileX}/${tileY}`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(chunkData),
        signal: signal ?? AbortSignal.any([AbortSignal.timeout(20000), shutdownController.signal]),
      });
      
      if (!res.ok) {
        log(`Failed to sync chunk ${subKey} for sector (${tileX}, ${tileY}): HTTP ${res.status}`, 'warn');
        allSuccessful = false;
      }
    } catch (err) {
      log(`Error syncing chunk ${subKey} for sector (${tileX}, ${tileY}): ${err.message}`, 'warn');
      allSuccessful = false;
    }

    // Give D1 time to process between chunks, respecting the abort signal
    await wait(250, signal);
  }

  // If a chunk fails, returning false keeps the whole sector in the flush queue.
  // Resending successful chunks alongside failed ones on the next loop is safe 
  // because the SQLite json_patch merge is idempotent.
  return allSuccessful;
}

async function fetchTileImageData(tileX, tileY) {
  const url = `https://backend.wplace.live/files/s0/tiles/${tileX}/${tileY}.png`;
  const res = await fetch(url, {
    signal: AbortSignal.any([
      AbortSignal.timeout(30000), 
      shutdownController.signal
    ]),
  });
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
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([
        AbortSignal.timeout(15000), 
        shutdownController.signal
      ])
    });
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
  const runStartTime = Date.now();

  // --- EXPANSION ALGORITHM SETUP ---
  const visitedPixels = new Set();
  const expansionQueue = [];
  const expansionQueueOutsideOfLimits = [];

  async function checkNeighbors(px, py, tileDataMap, cacheMap) {
    const neighbors = [
      { nx: px, ny: py - 1 }, // Up
      { nx: px, ny: py + 1 }, // Down
      { nx: px - 1, ny: py }, // Left
      { nx: px + 1, ny: py }, // Right
      { nx: px - 1, ny: py - 1 }, // Up-Left
      { nx: px + 1, ny: py - 1 }, // Up-Right
      { nx: px - 1, ny: py + 1 }, // Down-Left
      { nx: px + 1, ny: py + 1 }, // Down-Right
      // tolerance
      { nx: px - 5, ny: py }, // Left-Left
      { nx: px + 5, ny: py }, // Right-Right
      { nx: px, ny: py - 5 }, // Up-Up
      { nx: px, ny: py + 5 }, // Down-Down
  ];
    
    for (const { nx, ny } of neighbors) {
      const key = `${nx}_${ny}`;
      if (visitedPixels.has(key)) continue;
      
      let offLimits = true;

      if (nx >= minX && nx <= maxX && ny >= minY && ny <= maxY) offLimits = false;

      if (offLimits && LIMIT_EXPANSION) {
        continue;
      }
      
      const coords = getCoords(nx, ny);
      const tileKey = `${coords.tileX}_${coords.tileY}`;
      
      // Handle LIMIT_EXPANSION logic
      if (!tileDataMap.has(tileKey)) {
        if (LIMIT_EXPANSION) continue; // Stop at pre-loaded tile boundaries
        
        // Dynamically load the new tile mapping if allowed
        try {
          log(`Dynamically loading expanded tile (${coords.tileX}, ${coords.tileY})...`);
          const [newCache, newPng] = await Promise.all([
            fetchBackendTile(coords.tileX, coords.tileY),
            fetchTileImageData(coords.tileX, coords.tileY)
          ]);
          cacheMap.set(tileKey, newCache);
          tileDataMap.set(tileKey, newPng);
        } catch (err) {
          log(`Failed to dynamically fetch tile ${tileKey}: ${err.message}`, 'warn');
          continue;
        }
      }

      const png = tileDataMap.get(tileKey);
      const neighborColor = getTilePixelColor(png, coords.pixelX, coords.pixelY);

      // Stop expanding if the pixel is empty/transparent (-1)
      if (neighborColor === -1) continue;

      const cachedPixel = cacheMap.get(tileKey)?.[`${coords.pixelX}_${coords.pixelY}`];
      if (cachedPixel && cachedPixel.c === neighborColor) continue;

      visitedPixels.add(key);
      if (offLimits) {
        expansionQueueOutsideOfLimits.push({
          x: nx, y: ny,
          tileX: coords.tileX, tileY: coords.tileY,
          pixelX: coords.pixelX, pixelY: coords.pixelY,
          currentColor: neighborColor // FIX: Pass the color down!
        });
      } else {
        expansionQueue.push({
          x: nx, y: ny,
          tileX: coords.tileX, tileY: coords.tileY,
          pixelX: coords.pixelX, pixelY: coords.pixelY,
          currentColor: neighborColor // FIX: Pass the color down!
        });
      }
    }
  }

  log(`Target Coordinates: [${minX}, ${minY}] to [${maxX}, ${maxY}] (${totalPixels} total pixels)`);
  log(`Execution Plan: ${TOTAL_CYCLES} cycle(s), max ${CYCLE_DURATION_MS / 60000}m run per cycle (${RUN_DURATION_MS / 60000}m total)`);
  log(`Pause between cycles: ${PAUSE_INTERVAL_MS}ms`);
  log(`Target interval: ${CFG_TARGET_INTERVAL}ms`);
  log(`Min floor: ${CFG_MIN_FLOOR}ms`);
  log(`429 penalty: ${CFG_PENALTY_MS_429}ms`);
  log(`429 pause: ${CFG_PAUSE_SEC_429} seconds`);
  log(`Step down: ${CFG_STEP_DOWN_MS}ms`);
  log(`Streak reqs: ${CFG_STREAK_REQS}`);
  log(`Flush interval: ${FLUSH_INTERVAL} pixels`);
  log(`Expansion algorithm: ${EXPANSION_ALGORITHM}`);
  log(`Limit expansion: ${LIMIT_EXPANSION}`);

  let minFloor = CFG_MIN_FLOOR; // don't forget learnt minimum floors

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

    let targetInterval = CFG_TARGET_INTERVAL;
    let consecutiveSuccesses = 0, scannedThisCycle = 0;
    let consecutiveSkips = 0;
    let discoveriesToFlush = {};

    let lastRequestStart = null;

    const flushToD1 = async ({ signal = null } = {}, biderctional = true) => {
      let flushCount = 0;
      const remaining = {}; // sectors that failed to sync stay queued for the next flush

      for (const [key, sector] of Object.entries(discoveriesToFlush)) {
        const keysCount = Object.keys(sector.data).length;
        if (keysCount === 0) continue;
        const ok = await syncBackendTile(sector.tx, sector.ty, sector.data, signal);
        if (ok) {
          flushCount += keysCount;
        } else {
          remaining[key] = sector;
        }
      }

      if (flushCount > 0) {
        log(`Flushed ${flushCount} pixels to D1.`, 'success');

        // Mid-scan cache update: Fetch all intersecting tiles to catch userscript discoveries.
        // Skip this during shutdown — it's not needed before exit and eats into the ~10s
        // grace period GitHub Actions gives the process to terminate after cancellation.
        if (!isShuttingDown && biderctional) {
          log(`Pulling latest cloud state...`);
          for (const { tx, ty } of intersectingTiles) {
              const updatedData = await fetchBackendTile(tx, ty);
              cloudCache.set(`${tx}_${ty}`, updatedData);
          }
        }
      }
      if (Object.keys(remaining).length > 0) {
        log(`${Object.keys(remaining).length} sector(s) failed to sync — will retry on next flush.`, 'warn');
      }
      discoveriesToFlush = remaining; // only clear sectors that actually synced
    };

    let taskIndex = 0;
    let expansionIndex = 0;
    let expansionIndexOutsideOfLimits = 0;

    // Main Scanning Loop
    while (
        (taskIndex < pendingTasks.length
          || (EXPANSION_ALGORITHM && (expansionIndex < expansionQueue.length || expansionIndexOutsideOfLimits < expansionQueueOutsideOfLimits.length)))
        && !isShuttingDown
    ) {
      const dateNow = Date.now();
      if (isShuttingDown) {
        log(`Manual cancellation detected! Halting loop...`, 'warn');
        break; 
      }
      if (dateNow - cycleStartTime >= CYCLE_DURATION_MS) {
        log(`Time window of ${CYCLE_DURATION_MS / 60000}m reached. Stopping cycle...`, 'warn');
        break;
      }
      // Global check to ensure any delays don't affect the job duration
      if (dateNow - runStartTime >= RUN_DURATION_MS) {
        log(`Time window of ${CYCLE_DURATION_MS / 60000}m reached. Stopping cycle...`, 'warn');
        break;
      }

      let task;
    
      if (taskIndex < pendingTasks.length) {
        if (EXPANSION_ALGORITHM && expansionIndex < expansionQueue.length &&dateNow % EXPANSION_RATE !== 0) { // one in 5 chance of doing expansion anyway
            task = expansionQueue[expansionIndex++];
        } else {
          task = pendingTasks[taskIndex++];
        }
      } else if (EXPANSION_ALGORITHM && expansionIndex < expansionQueue.length) {
        task = expansionQueue[expansionIndex++];
      } else if (EXPANSION_ALGORITHM && expansionIndexOutsideOfLimits < expansionQueueOutsideOfLimits.length) {
        task = expansionQueueOutsideOfLimits[expansionIndexOutsideOfLimits++];
      }

      const { x, y, tileX, tileY, pixelX, pixelY, currentColor } = task;
      const sectorKey = `${tileX}_${tileY}`;

      // MID-SCAN CHECK
      const liveCache = cloudCache.get(sectorKey)?.[`${pixelX}_${pixelY}`];
      if (liveCache && liveCache.c !== null && liveCache.c === currentColor) {
        scannedThisCycle++;
        consecutiveSkips++;

        if (EXPANSION_ALGORITHM) await checkNeighbors(x, y, pngMap, cloudCache);
        continue; 
      } else if (consecutiveSkips > 0) {
        log(`Skipped ${consecutiveSkips} pixels - already discovered by another bot/user!`);
        consecutiveSkips = 0;
      }

      let resolved = false;

      while (!resolved && !isShuttingDown) {
        const reqStart = Date.now();

        const actualCadence = lastRequestStart === null
          ? null
          : reqStart - lastRequestStart;
        
        lastRequestStart = reqStart;
        
        const res = await fetchPixelOfficial(tileX, tileY, pixelX, pixelY);
        const duration = Date.now() - reqStart;

        if (isShuttingDown) break; // might get aborted while fetching the pixel

        if (res.success) {
          scannedThisCycle++;
          consecutiveSuccesses++;

          if (!discoveriesToFlush[sectorKey]) discoveriesToFlush[sectorKey] = { tx: tileX, ty: tileY, data: {} };
          discoveriesToFlush[sectorKey].data[`${pixelX}_${pixelY}`] = { u: res.username, c: currentColor };

          if (EXPANSION_ALGORITHM) await checkNeighbors(x, y, pngMap, cloudCache);

          if (CFG_STEP_DOWN_MS > 0 && consecutiveSuccesses >= CFG_STREAK_REQS && targetInterval > minFloor) {
            targetInterval = Math.max(minFloor, targetInterval - CFG_STEP_DOWN_MS);
            consecutiveSuccesses = 0;
            log(`Speed step triggered (${CFG_STREAK_REQS})! New target: ${targetInterval}ms (Floor: ${minFloor}ms)`);
          }

          resolved = true;
          
          // Periodic Flush check
          if (scannedThisCycle % FLUSH_INTERVAL === 0) {
            log(`Checkpoint reached (${scannedThisCycle} pixels). Auto-saving...`);
            await flushToD1();
          }

          if (scannedThisCycle % LOG_INTERVAL === 0) {
            const cycleTimeRemainingMins = ((CYCLE_DURATION_MS - (Date.now() - cycleStartTime)) / 60000).toFixed(1);
            const timeRemainingMins = ((RUN_DURATION_MS - (Date.now() - runStartTime)) / 60000).toFixed(1);
            const actualCadenceText = actualCadence === null
              ? 'N/A'
              : `${actualCadence}ms`;

            log(
              `[Progress] Scanned ${scannedThisCycle}/${pendingTasks.length} pixels | ` +
              `cadence: ${targetInterval}ms (actual: ${actualCadenceText}) | ` +
              `request: ${duration}ms | ` +
              `cycle time left: ${cycleTimeRemainingMins}m | ` +
              `total time left: ${timeRemainingMins}m`
            );
          }

          const sleepRemaining = Math.max(0, targetInterval - duration);
          if (sleepRemaining > 0) await wait(sleepRemaining, shutdownController.signal);

        } else if (res.status === 429) {
          consecutiveSuccesses = 0;
          minFloor = Math.max(minFloor, targetInterval + Math.max(10, CFG_STEP_DOWN_MS));
          targetInterval += CFG_PENALTY_MS_429;
          log(`Rate limited! Learned floor: ${minFloor}ms. New target: ${targetInterval}ms. Pausing for ${CFG_PAUSE_SEC_429}s...`, 'warn');
          await flushToD1();
          await wait(CFG_PAUSE_SEC_429 * 1000, shutdownController.signal);
        } else if (res.status === 408) {
          log(`Connection Timeout. Retrying in 30s...`, 'warn');
          
          const unsavedCount = Object.values(discoveriesToFlush).reduce(
            (acc, sector) => acc + Object.keys(sector.data).length, 0
          );

          if (unsavedCount > 0.25 * FLUSH_INTERVAL) {
            log(`Too many unsaved pixels (${unsavedCount}). Flushing...`);
            await flushToD1();
          }
          await wait(30000, shutdownController.signal);
          log(`Retrying...`);
        } else {
          log(`HTTP ${res.status || 'Network Error'}. Retrying in 30s...`, 'error');
          await wait(30000, shutdownController.signal);
        }
      }
    }

    // Final end-of-cycle flush. On a normal cycle end this uses the default
    // shutdown-aware signal. On a cancellation, shutdownController.signal is
    // already aborted by now, so we give this call its own short-lived
    // timeout instead — otherwise the "emergency" flush would fail instantly
    // and every unsaved pixel from this cycle would be lost.
    await flushToD1(isShuttingDown ? { signal: AbortSignal.timeout(6000) } : {}, false);

    if (cycle < TOTAL_CYCLES && !isShuttingDown) {
      log(`Pausing for ${PAUSE_INTERVAL_MS / 60000}m before cycle ${cycle + 1}...`);
      await wait(PAUSE_INTERVAL_MS, shutdownController.signal);
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
  shutdownController.abort();
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

run().catch((err) => {
  log(`Fatal execution error: ${err.message}`, 'error');
  process.exit(1);
});