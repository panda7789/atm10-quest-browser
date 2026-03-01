#!/usr/bin/env node
/**
 * ATM10 Icon Atlas Builder
 *
 * Vezme ikony z icons/ složky, vybere jen ty které se používají
 * v questech, a sestaví sprite atlas (icons_atlas.png + icons_atlas.json).
 *
 * Pro hostování: místo tisíců PNG souborů jen 2 soubory.
 *
 * Požadavky:
 *   npm install sharp
 *
 * Použití:
 *   node build_atlas.js
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

// ─── Načti quests.json a zjisti vše co potřebuje ikonu ───────────────────────
function loadManifest() {
  const manifestPath = path.join(DATA_DIR, 'icons_manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('❌ icons_manifest.json nenalezen. Nejdřív spusť extract_icons.js');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function findIconPath(id, manifest) {
  const colon = id.indexOf(':');
  if (colon === -1) return null;
  const ns   = id.slice(0, colon);
  const name = id.slice(colon + 1);
  const basename = name.split('/').pop().replace(/\.png$/, '');

  const variants = [
    id,                    // přesný klíč: "atm:textures/questpics/ae2.png"
    `${ns}:${basename}`,   // basename: "atm:ae2"
    `${ns}:${name}_item`,  // s _item suffixem
  ];
  for (const v of variants) {
    if (manifest[v]) {
      const absPath = path.join(__dirname, manifest[v].replace(/\//g, path.sep));
      if (fs.existsSync(absPath)) return absPath;
    }
  }
  return null;
}

function getUsedIds() {
  const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'quests.json'), 'utf8'));
  const taskItems  = new Set();  // malé ikony (16x16) → do atlasu
  const chapterImages = new Set();  // velké dekorativní obrázky → jako soubory

  for (const ch of data.chapters) {
    for (const q of ch.quests) {
      for (const t of (q.tasks || [])) {
        if (t.item)   taskItems.add(t.item);
        if (t.entity) taskItems.add(t.entity);
      }
    }
    for (const img of (ch.images || [])) {
      if (img.image) chapterImages.add(img.image);
    }
  }
  return { taskItems, chapterImages };
}

// ─── Sestavení atlasu pomocí sharp ───────────────────────────────────────────
async function buildAtlas(iconPaths) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.error('❌ Chybí sharp. Nainstaluj: npm install sharp');
    process.exit(1);
  }

  const TILE = 16;           // velikost každé ikony
  const COLS = 64;           // počet sloupců v atlasu
  const count = iconPaths.length;
  const rows  = Math.ceil(count / COLS);
  const W = COLS * TILE;
  const H = rows * TILE;

  console.log(`🖼️  Atlas: ${W}×${H}px, ${COLS} sloupců, ${rows} řádků, ${count} ikon`);

  // Vytvoř prázdné RGBA pozadí
  const bgBuf = Buffer.alloc(W * H * 4, 0);  // průhledný

  let base = sharp(bgBuf, { raw: { width: W, height: H, channels: 4 } });

  const composites = [];
  const manifest = {};   // "namespace:item" → { x, y } (v pixelech)

  for (let i = 0; i < iconPaths.length; i++) {
    const { id, file } = iconPaths[i];
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const left = col * TILE;
    const top  = row * TILE;

    let buf;
    try {
      // Resize na 16x16 (některé textury jsou větší — animované, HD resourcapacky)
      buf = await sharp(file)
        .resize(TILE, TILE, { kernel: 'nearest', fit: 'fill' })
        .ensureAlpha()
        .raw()
        .toBuffer();
    } catch { continue; }

    composites.push({
      input: buf,
      raw: { width: TILE, height: TILE, channels: 4 },
      left,
      top,
    });

    manifest[id] = { x: left, y: top };

    // sharp composite má limit ~5000 najednou, dávkuj
    if (composites.length >= 2000) {
      base = sharp(await base.composite(composites).raw().toBuffer(),
                   { raw: { width: W, height: H, channels: 4 } });
      composites.length = 0;
    }

    if (i % 200 === 0) process.stdout.write(`\r  Zpracováno: ${i}/${count}  `);
  }

  // Poslední dávka
  if (composites.length > 0) {
    base = sharp(await base.composite(composites).raw().toBuffer(),
                 { raw: { width: W, height: H, channels: 4 } });
  }

  process.stdout.write(`\r  Zpracováno: ${count}/${count}\n`);

  // Ulož jako PNG a WebP
  const outPng  = path.join(DATA_DIR, 'icons_atlas.png');
  const outWebp = path.join(DATA_DIR, 'icons_atlas.webp');
  const outJson = path.join(DATA_DIR, 'icons_atlas.json');

  console.log('💾 Ukládám PNG...');
  await base.clone().png({ compressionLevel: 9, palette: false }).toFile(outPng);

  console.log('💾 Ukládám WebP...');
  await base.clone().webp({ quality: 90, lossless: true }).toFile(outWebp);

  // Ulož manifest (přidej metadata pro HTML)
  const atlasManifest = {
    tile: TILE,
    cols: COLS,
    rows,
    width: W,
    height: H,
    icons: manifest,
  };
  fs.writeFileSync(outJson, JSON.stringify(atlasManifest));

  const pngSize  = (fs.statSync(outPng).size  / 1024).toFixed(0);
  const webpSize = (fs.statSync(outWebp).size / 1024).toFixed(0);
  const jsonSize = (fs.statSync(outJson).size / 1024).toFixed(0);

  console.log(`\n✅ Výsledek:`);
  console.log(`   icons_atlas.png  → ${pngSize} KB`);
  console.log(`   icons_atlas.webp → ${webpSize} KB`);
  console.log(`   icons_atlas.json → ${jsonSize} KB  (${Object.keys(manifest).length} ikon)`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const iconsDir = path.join(DATA_DIR, 'icons');
  if (!fs.existsSync(iconsDir)) {
    console.error('❌ Složka icons/ nenalezena. Nejdřív spusť extract_icons.js');
    process.exit(1);
  }

  console.log('📋 Načítám ID z quests.json...');
  const { taskItems, chapterImages } = getUsedIds();
  console.log(`   Task items/entities: ${taskItems.size}`);
  console.log(`   Chapter images:      ${chapterImages.size}`);

  console.log('\n📖 Načítám icons_manifest.json...');
  const manifest = loadManifest();
  console.log(`   Klíčů v manifestu: ${Object.keys(manifest).length}`);

  // ── Task items → do atlasu (16×16) ───────────────────
  console.log('\n🔍 Hledám ikony pro task items...');
  const found = [];
  let missingCount = 0;
  for (const id of taskItems) {
    const file = findIconPath(id, manifest);
    if (file) found.push({ id, file });
    else missingCount++;
  }
  console.log(`   Nalezeno: ${found.length}/${taskItems.size}`);
  console.log(`   Chybí:    ${missingCount}`);

  // ── Chapter images → zkopíruj jako soubory ────────────
  console.log('\n🖼️  Zpracovávám chapter images...');
  const imagesDir = path.join(DATA_DIR, 'chapter_images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const imageManifest = {};
  let imgFound = 0, imgMissing = 0;

  for (const id of chapterImages) {
    const file = findIconPath(id, manifest);
    if (!file) { imgMissing++; continue; }

    // Zachovej strukturu cesty pro URL
    const relUrl = manifest[id]
      || manifest[id.slice(id.indexOf(':') + 1).split('/').pop().replace(/\.png$/, '')];
    if (relUrl) {
      imageManifest[id] = relUrl;
      imgFound++;
    }
  }
  console.log(`   Nalezeno: ${imgFound}/${chapterImages.size}`);

  // Ulož image manifest
  fs.writeFileSync(
    path.join(DATA_DIR, 'chapter_images_manifest.json'),
    JSON.stringify(imageManifest)
  );
  console.log(`   Uloženo: chapter_images_manifest.json`);

  console.log(`\n🔨 Sestavuji atlas z ${found.length} ikon...`);
  await buildAtlas(found);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
