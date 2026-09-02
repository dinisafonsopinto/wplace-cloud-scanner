import { PNG } from 'pngjs';

// Configuration from Environment Variables
const WORKER_URL = process.env.WORKER_URL;
const START_X = parseInt(process.env.START_X, 10);
const START_Y = parseInt(process.env.START_Y, 10);
const END_X = parseInt(process.env.END_X, 10);
const END_Y = parseInt(process.env.END_Y, 10);
const RUN_DURATION_MS = (parseInt(process.env.RUN_DURATION_MINS, 10) || 20) * 60 * 1000;
const PAUSE_INTERVAL_MS = (parseInt(process.env.PAUSE_INTERVAL_MINS, 10) || 10) * 60 * 1000;
const TOTAL_CYCLES = parseInt(process.env.TOTAL_CYCLES, 10) || 1;

const TILE_SIZE = 1000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getCoords(absX, absY) {
  return {
    tileX: Math.floor(absX / TILE_SIZE),
    tileY: Math.floor(absY / TILE_SIZE),
    pixelX: ((absX % TILE_SIZE) + TILE_SIZE) % TILE_SIZE,
    pixelY: ((absY % TILE_SIZE) + TILE_SIZE) % TILE_SIZE
  };
}

async function fetchBackendTile(tileX, tileY) {
  try {
    const res = await fetch(`${WORKER_URL}/tile/${tileX}/${tileY}`);
    if (res.ok) return await res.json();
  } catch (err) {
    console.error(`Failed to fetch cache for sector (${tileX}, ${tileY}):`, err.message);
  }
  return {};
}

async function syncBackendTile(tileX, tileY, batchMap) {
  if (Object.keys(batchMap).length === 0) return;
  try {
    const res = await fetch(`${WORKER_URL}/tile/${tileX}/${tileY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batchMap)
    });
    if (!res.ok) console.error(`Failed to sync sector (${tileX}, ${tileY}): HTTP ${res.status}`);
  } catch (err) {
    console.error(`Error syncing sector (${tileX}, ${tileY}):`, err.message);
  }
}

async function fetchTileImageData(tileX, tileY) {
  const url = `https://backend.wplace.live/files/s0/tiles/${tileX}/${tileY}.png`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tile HTTP ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return PNG.sync.read(Buffer.from(arrayBuffer));
}

function getTilePixelColor(png, pixelX, pixelY) {
  const idx = (pixelY * TILE_SIZE + pixelX) * 4;
  const a = png.data[idx + 3];
  if (a === 0) return -1;
  const r = png.data[idx];
  const g = png.data[idx + 1];
  const b = png.data[idx + 2];
  return (r << 16) | (g << 8) | b;
}

async function fetchPixelOfficial(tileX, tileY, pixelX, pixelY) {
  const url = `https://backend.wplace.live/s0/pixel/${tileX}/${tileY}?x=${pixelX}&y=${pixelY}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const data = await res.json();
      return { success: true, username: data?.paintedBy?.name || 'Blank / Unknown' };
    }
    return { success: false, status: res.status };
  } catch (err) {
    return { success: false, status: 0 };
  }
}

async function run() {
  const minX = Math.min(START_X, END_X);
  const maxX = Math.max(START_X, END_X);
  const minY = Math.min(START_Y, END_Y);
  const maxY = Math.max(START_Y, END_Y);
  const totalPixels = (maxX - minX + 1) * (maxY - minY + 1);

  console.log(`Target: [${minX}, ${minY}] to [${maxX}, ${maxY}] (${totalPixels} total pixels)`);
  console.log(`Execution plan: ${TOTAL_CYCLES} cycle(s), max ${RUN_DURATION_MS / 60000}m run per cycle`);

  for (let cycle = 1; cycle <= TOTAL_CYCLES; cycle++) {
    console.log(`\n================== STARTING CYCLE ${cycle}/${TOTAL_CYCLES} ==================`);
    const cycleStartTime = Date.now();

    // 1. Identify Intersecting Tiles
    const minTileX = Math.floor(minX / TILE_SIZE);
    const maxTileX = Math.floor(maxX / TILE_SIZE);
    const minTileY = Math.floor(minY / TILE_SIZE);
    const maxTileY = Math.floor(maxY / TILE_SIZE);

    const intersectingTiles = [];
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        intersectingTiles.push({ tx, ty });
      }
    }

    // 2. Ingest D1 Cache & Sector PNGs
    console.log(`Fetching D1 cache and tile images for ${intersectingTiles.length} sector(s)...`);
    const cloudCache = new Map();
    const pngMap = new Map();

    for (const { tx, ty } of intersectingTiles) {
      const sectorKey = `${tx}_${ty}`;
      const cachedTile = await fetchBackendTile(tx, ty);
      cloudCache.set(sectorKey, cachedTile);

      try {
        const png = await fetchTileImageData(tx, ty);
        pngMap.set(sectorKey, png);
      } catch (err) {
        console.warn(`Could not load PNG for (${tx}, ${ty}): ${err.message}`);
      }
    }

    // 3. Diff Queue Generation
    const pendingTasks = [];
    let instantMatches = 0;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const { tileX, tileY, pixelX, pixelY } = getCoords(x, y);
        const sectorKey = `${tileX}_${tileY}`;
        const localKey = `${pixelX}_${pixelY}`;
        const cached = cloudCache.get(sectorKey)?.[localKey];
        const png = pngMap.get(sectorKey);

        const currentColor = png ? getTilePixelColor(png, pixelX, pixelY) : null;

        if (cached && cached.c !== null && currentColor !== null && cached.c === currentColor) {
          instantMatches++;
        } else {
          pendingTasks.push({ x, y, tileX, tileY, pixelX, pixelY, currentColor });
        }
      }
    }

    console.log(`Diff Summary: ${instantMatches} static pixels resolved. ${pendingTasks.length} pending queries.`);

    if (pendingTasks.length === 0) {
      console.log(`Area fully mapped! No further cycles needed.`);
      break;
    }

    // 4. Cadence-Paced Scanning
    let targetInterval = 450;
    let minFloor = 150;
    const streakReqs = 30;
    let consecutiveSuccesses = 0;
    const discoveriesToFlush = {};

    let scannedThisCycle = 0;
    let timeExpired = false;

    for (const task of pendingTasks) {
      if (Date.now() - cycleStartTime >= RUN_DURATION_MS) {
        console.log(`Time window of ${RUN_DURATION_MS / 60000}m reached for this cycle.`);
        timeExpired = true;
        break;
      }

      const { x, y, tileX, tileY, pixelX, pixelY, currentColor } = task;
      const sectorKey = `${tileX}_${tileY}`;
      let resolved = false;

      while (!resolved) {
        const reqStart = Date.now();
        const res = await fetchPixelOfficial(tileX, tileY, pixelX, pixelY);
        const duration = Date.now() - reqStart;

        if (res.success) {
          scannedThisCycle++;
          consecutiveSuccesses++;

          const record = { u: res.username, c: currentColor };
          if (!discoveriesToFlush[sectorKey]) discoveriesToFlush[sectorKey] = { tx: tileX, ty: tileY, data: {} };
          discoveriesToFlush[sectorKey].data[`${pixelX}_${pixelY}`] = record;

          if (consecutiveSuccesses >= streakReqs && targetInterval > minFloor) {
            targetInterval = Math.max(minFloor, targetInterval - 10);
            consecutiveSuccesses = 0;
          }

          resolved = true;
          const sleepRemaining = Math.max(0, targetInterval - duration);
          if (sleepRemaining > 0) await wait(sleepRemaining);

          if (scannedThisCycle % 25 === 0) {
            console.log(`[Cycle ${cycle}] Scanned ${scannedThisCycle} pixels (cadence: ${targetInterval}ms)...`);
          }
        } else if (res.status === 429) {
          console.warn(`[Cycle ${cycle}] Rate limited (429)! Backing off for 65s...`);
          consecutiveSuccesses = 0;
          minFloor = targetInterval + 10;
          targetInterval += 100;
          await wait(65000);
        } else {
          console.warn(`[Cycle ${cycle}] HTTP ${res.status || 'Network Error'}. Retrying in 3s...`);
          await wait(3000);
        }
      }
    }

    // 5. Commit Discoveries to D1 Worker
    console.log(`Flushing discoveries to Cloudflare D1...`);
    for (const sector of Object.values(discoveriesToFlush)) {
      await syncBackendTile(sector.tx, sector.ty, sector.data);
    }
    console.log(`Flushed ${scannedThisCycle} scanned pixels to D1.`);

    // 6. Interval Pause Between Cycles
    if (cycle < TOTAL_CYCLES && timeExpired) {
      console.log(`Pausing for ${PAUSE_INTERVAL_MS / 60000}m before cycle ${cycle + 1}...`);
      await wait(PAUSE_INTERVAL_MS);
    }
  }

  console.log('\nAll requested cycles completed successfully.');
}

run().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});