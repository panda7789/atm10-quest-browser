#!/usr/bin/env node
/**
 * ATM10 Icon Extractor — v2
 * Extrahuje item/block textury z .jar souborů a vytváří chytré mapování.
 *
 * Klíčové vylepšení oproti v1:
 *  - Soubory se ukládají pod originální cestou (ne flatten) → žádné kolize jmen
 *  - Manifest obsahuje více klíčů pro jeden soubor (basename, flat, block fallback)
 *  - Hledá i v textures/block/ pro itemy které jsou bloky
 *
 * Použití:
 *   node extract_icons.js
 *   node extract_icons.js "C:\Users\JanNovak\curseforge\minecraft\Instances\All the Mods 10"
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── Najdi vanilla Minecraft jar ─────────────────────────────────────────────
function findVanillaJar(instanceDir) {
  // CurseForge ukládá verze v různých místech
  const username = process.env.USERNAME || process.env.USER || '';
  const candidates = [
    // Vedle instance je često .minecraft nebo shared data
    path.join(instanceDir, '..', '..', '..', 'Install', 'versions'),
    path.join(instanceDir, '..', '..', '..', 'install', 'versions'),
    // Standardní .minecraft lokace
    path.join(process.env.APPDATA || '', '.minecraft', 'versions'),
    path.join(process.env.HOME || '', 'Library', 'Application Support', 'minecraft', 'versions'),
    path.join(process.env.HOME || '', '.minecraft', 'versions'),
    `C:\\Users\\${username}\\AppData\\Roaming\\.minecraft\\versions`,
  ];

  for (const versionsDir of candidates) {
    if (!fs.existsSync(versionsDir)) continue;
    // Projdi všechny verze, hledej .jar soubor (ne -natives, ne forge)
    for (const ver of fs.readdirSync(versionsDir)) {
      const jar = path.join(versionsDir, ver, `${ver}.jar`);
      if (fs.existsSync(jar) && !ver.includes('forge') && !ver.includes('fabric') && !ver.includes('natives')) {
        return jar;
      }
    }
  }
  return null;
}

// ─── Najdi mods složku ────────────────────────────────────────────────────────
function findModsDir(customPath) {
  if (customPath) {
    const p = path.join(customPath, 'mods');
    if (fs.existsSync(p)) return p;
    if (fs.existsSync(customPath) && customPath.endsWith('mods')) return customPath;
    console.error(`❌ Složka nenalezena: ${customPath}`);
    process.exit(1);
  }
  const username = process.env.USERNAME || process.env.USER || '';
  const candidates = [
    `C:\\Users\\${username}\\curseforge\\minecraft\\Instances\\All the Mods 10\\mods`,
    `C:\\Users\\${username}\\Documents\\curseforge\\minecraft\\Instances\\All the Mods 10\\mods`,
    `C:\\Users\\${username}\\AppData\\Roaming\\curseforge\\minecraft\\Instances\\All the Mods 10\\mods`,
    `/Users/${username}/curseforge/minecraft/Instances/All the Mods 10/mods`,
    `/Users/${username}/Documents/curseforge/minecraft/Instances/All the Mods 10/mods`,
    `/home/${username}/curseforge/minecraft/Instances/All the Mods 10/mods`,
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) { console.log(`✅ Mods: ${p}`); return p; }
  }
  console.error('❌ Mods složka nenalezena. Zadej cestu jako argument.');
  process.exit(1);
}

// ─── ZIP parser (bez závislostí) ──────────────────────────────────────────────
function readUInt16LE(b, o) { return b[o] | (b[o+1] << 8); }
function readUInt32LE(b, o) { return (b[o] | (b[o+1]<<8) | (b[o+2]<<16) | (b[o+3]<<24)) >>> 0; }

function findEOCD(buf) {
  for (let i = buf.length - 22; i >= 0; i--)
    if (buf[i]===0x50&&buf[i+1]===0x4b&&buf[i+2]===0x05&&buf[i+3]===0x06) return i;
  return -1;
}

function parseZip(buf) {
  const eocd = findEOCD(buf);
  if (eocd === -1) return [];
  const cdOffset = readUInt32LE(buf, eocd + 16);
  const entries  = [];
  let pos = cdOffset;
  while (pos + 46 <= buf.length) {
    if (buf[pos]!==0x50||buf[pos+1]!==0x4b||buf[pos+2]!==0x01||buf[pos+3]!==0x02) break;
    const compression = readUInt16LE(buf, pos + 10);
    const compSize    = readUInt32LE(buf, pos + 20);
    const nameLen     = readUInt16LE(buf, pos + 28);
    const extraLen    = readUInt16LE(buf, pos + 30);
    const commentLen  = readUInt16LE(buf, pos + 32);
    const localOffset = readUInt32LE(buf, pos + 42);
    const name        = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.push({ name, compression, compSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractEntry(buf, entry) {
  const lh = entry.localOffset;
  if (lh + 30 > buf.length) return null;
  const nameLen  = readUInt16LE(buf, lh + 26);
  const extraLen = readUInt16LE(buf, lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const compressed = buf.slice(dataStart, dataStart + entry.compSize);
  if (entry.compression === 0) return compressed;
  if (entry.compression === 8) {
    try { return zlib.inflateRawSync(compressed); } catch { return null; }
  }
  return null;
}

// ─── Skenuj statickou složku s assety (KubeJS, resource packy, atd.) ──────────
// Prochází <assetDir>/<namespace>/textures/**/*.png a registruje je do manifestu.
// Soubory se nekopírují — rovnou se odkazují na originální cestu.
function scanStaticAssets(assetDir, itemPaths, blockPaths) {
  if (!fs.existsSync(assetDir)) {
    console.log(`   ⚠️  Složka nenalezena, přeskakuji: ${assetDir}`);
    return 0;
  }

  let count = 0;

  // Rekurzivní průchod složkou
  function walk(dir, ns, relBase) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relPath  = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, ns, relPath);
      } else if (entry.name.endsWith('.png')) {
        // relPath je např. "textures/item/foo.png" nebo "textures/item/gems/dust.png"
        const m = relPath.match(/^textures\/(items?|blocks?)\/(.+\.png)$/);
        if (!m) continue;

        const category = m[1];
        const subpath  = m[2];
        const basename = path.basename(subpath, '.png');
        const flatName = subpath.slice(0, -4).replace(/\//g, '_');

        // URL relativní k output složce projektu
        // Soubory zůstávají na originálním místě — server.js je musí servovat
        // Použijeme speciální prefix "static/" v URL a server.js dostane cestu
        // Jednodušší: zkopírujeme do icons/ stejně jako z jarů
        const iconsDir = path.join(__dirname, 'icons');
        const outFile  = path.join(iconsDir, ns, category, subpath);
        if (!fs.existsSync(outFile)) {
          fs.mkdirSync(path.dirname(outFile), { recursive: true });
          fs.copyFileSync(fullPath, outFile);
          count++;
        }

        const relUrl = `icons/${ns}/${category}/${subpath}`.replace(/\\/g, '/');
        const isItem = category === 'item' || category === 'items';
        const store  = isItem ? itemPaths : blockPaths;

        const key1 = `${ns}:${basename}`;
        const key2 = `${ns}:${flatName}`;
        if (!store[key1]) store[key1] = relUrl;
        if (flatName !== basename && !store[key2]) store[key2] = relUrl;
      }
    }
  }

  // Struktura: <assetDir>/<namespace>/textures/...
  // Ale může být i přímo <assetDir>/textures/... (bez namespace podsložky)
  for (const entry of fs.readdirSync(assetDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const ns     = entry.name;
    const texDir = path.join(assetDir, ns, 'textures');
    if (fs.existsSync(texDir)) {
      walk(texDir, ns, 'textures');
    }
  }

  return count;
}

// ─── Najdi statické asset složky automaticky ──────────────────────────────────
function findStaticAssetDirs(modsDir) {
  // Odvod instanci složku z mods/ cesty (jdi o úroveň výš)
  const instanceDir = path.dirname(modsDir);
  const candidates = [
    path.join(instanceDir, 'kubejs', 'assets'),
    path.join(instanceDir, 'resourcepacks'),
  ];
  return candidates.filter(p => fs.existsSync(p));
}


function main() {
  const modsDir     = findModsDir(process.argv[2]);
  const instanceDir = path.dirname(modsDir);
  const iconsDir    = path.join(__dirname, 'icons');
  fs.mkdirSync(iconsDir, { recursive: true });

  const jars = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')).sort();
  console.log(`📦 ${jars.length} jar souborů\n`);

  // manifest: "namespace:item_name" → relativní URL k PNG
  // Pro každý klíč ukládáme [itemPath, blockPath] — item má prioritu
  const itemPaths  = {};
  const blockPaths = {};
  const blockModels = {};
  const geoModels  = {}; // ns:name → { u, v, size } UV souřadnice hlavy

  let totalExtracted = 0;

  for (let i = 0; i < jars.length; i++) {
    const jarPath = path.join(modsDir, jars[i]);
    process.stdout.write(`[${String(i+1).padStart(3)}/${jars.length}] ${jars[i].slice(0,55).padEnd(55)} `);

    let buf;
    try { buf = fs.readFileSync(jarPath); }
    catch { console.log('⚠️'); continue; }

    const entries = parseZip(buf);
    let count = 0;

    for (const entry of entries) {
      // ── Textury item/block ────────────────────────────────────────────────────
      const m = entry.name.match(
        /^(?:common\/src\/main\/resources\/)?assets\/([^/]+)\/textures\/(items?|blocks?)\/(.+\.png)$/
      );
      if (m) {
        const ns       = m[1];
        const category = m[2];
        const subpath  = m[3];

        const outFile = path.join(iconsDir, ns, category, subpath);
        if (!fs.existsSync(outFile)) {
          const data = extractEntry(buf, entry);
          if (!data) continue;
          fs.mkdirSync(path.dirname(outFile), { recursive: true });
          fs.writeFileSync(outFile, data);
          totalExtracted++;
          count++;
        }

        const relUrl  = `icons/${ns}/${category}/${subpath}`.replace(/\\/g, '/');
        const basename = path.basename(subpath, '.png');
        const flatName = subpath.slice(0, -4).replace(/\//g, '_');
        const store   = (category === 'item' || category === 'items') ? itemPaths : blockPaths;
        if (!store[`${ns}:${basename}`]) store[`${ns}:${basename}`] = relUrl;
        if (flatName !== basename && !store[`${ns}:${flatName}`]) store[`${ns}:${flatName}`] = relUrl;
        continue;
      }

      // ── Block model JSONy — pro itemy bez přímé textury (např. magmator_basic) ─
      const mj = entry.name.match(/^assets\/([^/]+)\/models\/block\/(.+\.json)$/);
      if (mj) {
        const ns   = mj[1];
        const name = path.basename(mj[2], '.json');
        const key  = `${ns}:${name}`;
        if (!blockModels[key]) {
          const data = extractEntry(buf, entry);
          if (data) {
            try {
              const json = JSON.parse(data.toString('utf8'));
              const tex = json.textures || {};
              const resolve = (names) => {
                for (const n of names) {
                  const v = tex[n];
                  if (v && typeof v === 'string' && !v.startsWith('#')) return v;
                }
                return null;
              };
              const top   = resolve(['top', 'top_face', 'up', 'cap', 'end', 'all']);
              const side  = resolve(['side', 'side_face', 'texture', 'all', 'wall']);
              const front = resolve(['front', 'face', 'front_face', 'south', 'north', 'side']);
              const first = top || side || front ||
                Object.values(tex).find(v => typeof v === 'string' && !v.startsWith('#'));
              if (first) {
                blockModels[key] = { top: top||first, side: side||first, front: front||first };
              }
            } catch {}
          }
        }
      }

      // ── Entity textury ────────────────────────────────────────────────────────
      const me = entry.name.match(
        /^(?:common\/src\/main\/resources\/)?assets\/([^/]+)\/textures\/entity\/(.+\.png)$/
      );
      if (me) {
        const ns      = me[1];
        const subpath = me[2];
        const outFile = path.join(iconsDir, ns, 'entity', subpath);
        if (!fs.existsSync(outFile)) {
          const data = extractEntry(buf, entry);
          if (data) {
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            fs.writeFileSync(outFile, data);
            totalExtracted++;
            count++;
          }
        }
        const relUrl   = `icons/${ns}/entity/${subpath}`.replace(/\\/g, '/');
        const basename = path.basename(subpath, '.png');
        const flatName = subpath.slice(0, -4).replace(/\//g, '_');
        // Entity klíče — nepřepisuj existující item/block texturu
        if (!itemPaths[`${ns}:${basename}`] && !blockPaths[`${ns}:${basename}`]) {
          blockPaths[`${ns}:${basename}`] = relUrl;
        }
        if (flatName !== basename && !itemPaths[`${ns}:${flatName}`] && !blockPaths[`${ns}:${flatName}`]) {
          blockPaths[`${ns}:${flatName}`] = relUrl;
        }
      }

      // ── GeckoLib geo JSONy — UV souřadnice hlavy entity ───────────────────────
      const mg = entry.name.match(
        /^(?:common\/src\/main\/resources\/)?assets\/([^/]+)\/geo\/(?:entity\/)?(.+\.json)$/
      );
      if (mg && !geoModels[`${mg[1]}:${path.basename(mg[2], '.json')}`]) {
        const data = extractEntry(buf, entry);
        if (data) {
          try {
            const geo = JSON.parse(data.toString('utf8'));
            const ns  = mg[1];
            const name = path.basename(mg[2], '.json');
            const key  = `${ns}:${name}`;
            // GeckoLib format: bones[] → cubes[] → uv
            // Najdi bone "head" nebo první bone s UV
            const bones = geo?.minecraft?.bones || geo?.bones || [];
            const headBone = bones.find(b =>
              /head|skull|face/i.test(b.name)
            ) || bones[0];
            if (headBone?.cubes?.length) {
              const cube = headBone.cubes[0];
              const uv = cube.uv;
              if (Array.isArray(uv)) {
                geoModels[key] = { u: uv[0], v: uv[1], size: cube.size || [8,8,8] };
              } else if (uv && typeof uv === 'object') {
                // Format: { north: {uv, uv_size}, ... }
                const face = uv.north || uv.south || Object.values(uv)[0];
                if (face?.uv) geoModels[key] = { u: face.uv[0], v: face.uv[1], size: face.uv_size || [8,8] };
              }
            }
          } catch {}
        }
      }
    }

    console.log(count > 0 ? `✓ ${count}` : '─');
  }

  // ─── Vanilla Minecraft jar ────────────────────────────────────────────────
  // Minecraft textury nejsou v mods/ ale v .minecraft/versions/
  const vanillaJar = findVanillaJar(instanceDir);
  if (vanillaJar) {
    console.log(`\n🎮 Vanilla jar: ${path.basename(vanillaJar)}`);
    let buf;
    try { buf = fs.readFileSync(vanillaJar); } catch { buf = null; }
    if (buf) {
      const entries = parseZip(buf);
      let count = 0;
      for (const entry of entries) {
        // Textury
        const m = entry.name.match(/^assets\/minecraft\/textures\/(items?|blocks?)\/(.+\.png)$/);
        if (m) {
          const category = m[1];
          const subpath  = m[2];
          const outFile  = path.join(iconsDir, 'minecraft', category, subpath);
          if (!fs.existsSync(outFile)) {
            const data = extractEntry(buf, entry);
            if (!data) continue;
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            fs.writeFileSync(outFile, data);
            totalExtracted++;
            count++;
          }
          const relUrl   = `icons/minecraft/${category}/${subpath}`.replace(/\\/g, '/');
          const basename = path.basename(subpath, '.png');
          const flatName = subpath.slice(0, -4).replace(/\//g, '_');
          const isItem   = category === 'item' || category === 'items';
          const store    = isItem ? itemPaths : blockPaths;
          if (!store[`minecraft:${basename}`]) store[`minecraft:${basename}`] = relUrl;
          if (flatName !== basename && !store[`minecraft:${flatName}`]) store[`minecraft:${flatName}`] = relUrl;
          continue;
        }

        // Block model JSONy (pro vanilla bloky jako snow_block → snow textura)
        const mj = entry.name.match(/^assets\/minecraft\/models\/block\/(.+\.json)$/);
        if (mj) {
          const name = path.basename(mj[1], '.json');
          const key  = `minecraft:${name}`;
          if (!blockModels[key]) {
            const data = extractEntry(buf, entry);
            if (data) {
              try {
                const json = JSON.parse(data.toString('utf8'));
                const tex = json.textures || {};
                const resolve = (names) => {
                  for (const n of names) {
                    const v = tex[n];
                    if (v && typeof v === 'string' && !v.startsWith('#')) return v;
                  }
                  return null;
                };
                const top   = resolve(['top', 'end', 'all', 'up']);
                const side  = resolve(['side', 'texture', 'all', 'wall']);
                const front = resolve(['front', 'face', 'south', 'north', 'side']);
                const first = top || side || front ||
                  Object.values(tex).find(v => typeof v === 'string' && !v.startsWith('#'));
                if (first) blockModels[key] = { top: top||first, side: side||first, front: front||first };
              } catch {}
            }
          }
        }
      }
      console.log(`   Extrahováno: ${count} vanilla textur`);
      console.log(`   Manifest klíčů minecraft: item=${Object.keys(itemPaths).filter(k=>k.startsWith('minecraft:')).length}, block=${Object.keys(blockPaths).filter(k=>k.startsWith('minecraft:')).length}`);
      // Ověř konkrétní problematické klíče
      const testKeys = ['minecraft:bee_nest','minecraft:honeycomb_block','minecraft:stone'];
      for (const k of testKeys) {
        console.log(`   ${k}: item=${itemPaths[k]||'—'} block=${blockPaths[k]||'—'}`);
      }
    }
  } else {
    console.log('\n⚠️  Vanilla jar nenalezen — minecraft: textury nebudou dostupné');
    console.log('   Hledej v: .minecraft/versions/<verze>/<verze>.jar');
  }

  // ─── Resolv block modelů → textury pro itemy bez přímé textury ──────────────
  // Příklad: "powah:magmator_basic" nemá textures/block/magmator_basic.png
  // ale má models/block/magmator_basic.json → textures.face = "powah:block/magmator_face_unlit"
  console.log(`\n🔗 Resolvuji block modely (${Object.keys(blockModels).length} modelů)...`);
  let modelResolved = 0;

  function resolveTexRef(texRef) {
    if (!texRef) return null;
    const colon = texRef.indexOf(':');
    if (colon === -1) return null;
    const texNs   = texRef.slice(0, colon);
    const texPath = texRef.slice(colon + 1);
    const candidates = [
      path.join(iconsDir, texNs, texPath + '.png'),
      path.join(iconsDir, texNs, 'block', path.basename(texPath) + '.png'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c.replace(/\\/g, '/').replace(/.*\/icons\//, 'icons/');
      }
    }
    return null;
  }

  for (const [key, faces] of Object.entries(blockModels)) {
    if (itemPaths[key]) continue; // má item texturu — přeskoč

    const topUrl   = resolveTexRef(faces.top);
    const sideUrl  = resolveTexRef(faces.side);
    const frontUrl = resolveTexRef(faces.front);
    const anyUrl   = topUrl || sideUrl || frontUrl;
    if (!anyUrl) continue;

    // Hlavní klíč → top textura (fallback pro starý kód)
    if (!blockPaths[key]) blockPaths[key] = anyUrl;

    // Tři plochy pod klíči s # suffixem
    if (topUrl)   blockPaths[`${key}#top`]   = topUrl;
    if (sideUrl)  blockPaths[`${key}#side`]  = sideUrl;
    if (frontUrl) blockPaths[`${key}#front`] = frontUrl;

    modelResolved++;
  }
  console.log(`   Doplněno z modelů: ${modelResolved}`);

  // ─── GeckoLib geo modely → UV souřadnice hlavy ───────────────────────────────
  console.log(`\n🦎 GeckoLib geo modely: ${Object.keys(geoModels).length}`);
  let geoResolved = 0;
  for (const [key, uv] of Object.entries(geoModels)) {
    const entityUrl = blockPaths[key];
    if (!entityUrl || !entityUrl.includes('/entity/')) continue;
    blockPaths[`${key}#head_uv`] = JSON.stringify(uv);
    geoResolved++;
  }
  console.log(`   Doplněno UV: ${geoResolved}`);

  // ─── Skenuj KubeJS a další statické asset složky ─────────────────────────
  const staticDirs = [
    path.join(instanceDir, 'kubejs', 'assets'),
    path.join(instanceDir, 'resourcepacks'),
  ];

  for (const staticDir of staticDirs) {
    if (!fs.existsSync(staticDir)) continue;
    console.log(`\n📁 Skenuju statické assety: ${staticDir}`);
    let staticCount = 0;

    for (const nsEntry of fs.readdirSync(staticDir, { withFileTypes: true })) {
      if (!nsEntry.isDirectory()) continue;
      const ns     = nsEntry.name;
      const texDir = path.join(staticDir, ns, 'textures');
      if (!fs.existsSync(texDir)) continue;

      const walkDir = (dir, relBase) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          const rel  = relBase ? `${relBase}/${e.name}` : e.name;
          if (e.isDirectory()) { walkDir(full, rel); continue; }
          if (!e.name.endsWith('.png')) continue;

          const outFile = path.join(iconsDir, ns, 'textures', rel);
          if (!fs.existsSync(outFile)) {
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            fs.copyFileSync(full, outFile);
            staticCount++;
          }

          const relUrl   = `icons/${ns}/textures/${rel}`.replace(/\\/g, '/');
          const basename = path.basename(rel, '.png');
          const flatName = rel.slice(0, -4).replace(/\//g, '_');

          if (!itemPaths[`${ns}:${basename}`]) itemPaths[`${ns}:${basename}`] = relUrl;
          if (!itemPaths[`${ns}:${flatName}`]) itemPaths[`${ns}:${flatName}`] = relUrl;
          const mcKey = `${ns}:textures/${rel}`;
          if (!itemPaths[mcKey]) itemPaths[mcKey] = relUrl;
        }
      };
      walkDir(texDir, '');
    }
    console.log(`   Zkopírováno: ${staticCount} souborů`);
  }

  // Sestavení manifestu: item textura má přednost, block jako fallback
  const manifest = Object.assign({}, blockPaths, itemPaths);

  fs.writeFileSync(
    path.join(__dirname, 'icons_manifest.json'),
    JSON.stringify(manifest)
  );

  // ─── Advancement JSONy → mapa advancement_id → item_id ───────────────────────
  console.log(`\n🏆 Parsuju advancement JSONy...`);
  const advMap = {};

  const allJarPaths = [
    ...fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')).map(f => path.join(modsDir, f)),
    ...(findVanillaJar(instanceDir) ? [findVanillaJar(instanceDir)] : []),
  ];

  for (const jarPath of allJarPaths) {
    let buf;
    try { buf = fs.readFileSync(jarPath); } catch { continue; }
    const entries = parseZip(buf);
    for (const entry of entries) {
      const m = entry.name.match(
        /^(?:common\/src\/main\/resources\/)?data\/([^/]+)\/advancements\/(.+\.json)$/
      );
      if (!m) continue;
      const ns  = m[1];
      const rel = m[2].slice(0, -5);
      const key = `${ns}:${rel}`;
      if (advMap[key]) continue;
      const data = extractEntry(buf, entry);
      if (!data) continue;
      try {
        const json = JSON.parse(data.toString('utf8'));
        const itemId = json?.display?.icon?.id || json?.display?.icon?.item;
        if (itemId) advMap[key] = itemId;
        // Debug: loguj pokud klíč odpovídá hledaným
        if (key.includes('dragon_egg') || key.includes('enchant_item') || key.includes('apotheosis')) {
          console.log(`   [adv] ${key} → ${itemId || '(žádná ikona)'}`);
        }
      } catch {}
    }
  }

  fs.writeFileSync(
    path.join(__dirname, 'advancements_manifest.json'),
    JSON.stringify(advMap)
  );

  console.log(`   Advancement → item mapování: ${Object.keys(advMap).length} záznamů`);

  console.log(`\n🎉 Hotovo!`);
  console.log(`   Extrahováno:     ${totalExtracted} souborů`);
  console.log(`   Item klíče:      ${Object.keys(itemPaths).length}`);
  console.log(`   Block klíče:     ${Object.keys(blockPaths).length}`);
  console.log(`   Manifest celkem: ${Object.keys(manifest).length} klíčů`);
}

main();
