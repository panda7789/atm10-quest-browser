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
  const itemPaths  = {};  // klíč → path z textures/item/
  const blockPaths = {};  // klíč → path z textures/block/ (fallback)
  const blockModels = {}; // ns:name → první textura path (z models/block/*.json)

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
      // ── Textury ──────────────────────────────────────────────────────────────
      const m = entry.name.match(
        /^assets\/([^/]+)\/textures\/(items?|blocks?)\/(.+\.png)$/
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
              // Vezmi první texturu z "textures" objektu
              const textures = json.textures || {};
              const firstTex = Object.values(textures).find(v => typeof v === 'string' && !v.startsWith('#'));
              if (firstTex) blockModels[key] = firstTex; // např. "powah:block/magmator_face_unlit"
            } catch {}
          }
        }
      }
    }

    console.log(count > 0 ? `✓ ${count}` : '─');
  }

  // ─── Resolv block modelů → textury pro itemy bez přímé textury ──────────────
  // Příklad: "powah:magmator_basic" nemá textures/block/magmator_basic.png
  // ale má models/block/magmator_basic.json → textures.face = "powah:block/magmator_face_unlit"
  console.log(`\n🔗 Resolvuji block modely (${Object.keys(blockModels).length} modelů)...`);
  let modelResolved = 0;
  for (const [key, texRef] of Object.entries(blockModels)) {
    if (itemPaths[key] || blockPaths[key]) continue; // už má texturu

    // texRef je "ns:block/texname" nebo "ns:texname"
    const colon = texRef.indexOf(':');
    if (colon === -1) continue;
    const texNs   = texRef.slice(0, colon);
    const texPath = texRef.slice(colon + 1); // např. "block/magmator_face_unlit"

    // Hledej odpovídající PNG soubor v iconsDir
    const candidates = [
      path.join(iconsDir, texNs, texPath + '.png'),                    // icons/powah/block/magmator_face_unlit.png
      path.join(iconsDir, texNs, 'block', path.basename(texPath) + '.png'), // icons/powah/block/magmator_face_unlit.png
    ];
    let found = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) { found = c; break; }
    }
    if (!found) continue;

    const relUrl = found.replace(/\\/g, '/').replace(/.*\/icons\//, 'icons/');
    blockPaths[key] = relUrl;
    modelResolved++;
  }
  console.log(`   Doplněno z modelů: ${modelResolved}`);

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
        const m = entry.name.match(/^assets\/minecraft\/textures\/(items?|blocks?)\/(.+\.png)$/);
        if (!m) continue;
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

  // ─── Skenuj KubeJS a další statické asset složky ─────────────────────────
  const staticDirs = [
    path.join(instanceDir, 'kubejs', 'assets'),
    path.join(instanceDir, 'resourcepacks'),
  ];

  for (const staticDir of staticDirs) {
    if (!fs.existsSync(staticDir)) continue;
    console.log(`\n📁 Skenuju statické assety: ${staticDir}`);
    let staticCount = 0;

    // Projdi <staticDir>/<namespace>/textures/**/*.png
    for (const nsEntry of fs.readdirSync(staticDir, { withFileTypes: true })) {
      if (!nsEntry.isDirectory()) continue;
      const ns     = nsEntry.name;
      const texDir = path.join(staticDir, ns, 'textures');
      if (!fs.existsSync(texDir)) continue;

      // Rekurzivně projdi textures/
      const walkDir = (dir, relBase) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          const rel  = relBase ? `${relBase}/${e.name}` : e.name;
          if (e.isDirectory()) { walkDir(full, rel); continue; }
          if (!e.name.endsWith('.png')) continue;

          // rel je např. "item/foo.png" nebo "questpics/ae2.png"
          // Zkopíruj do icons/
          const outFile = path.join(iconsDir, ns, 'textures', rel);
          if (!fs.existsSync(outFile)) {
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            fs.copyFileSync(full, outFile);
            staticCount++;
          }

          const relUrl  = `icons/${ns}/textures/${rel}`.replace(/\\/g, '/');
          const basename = path.basename(rel, '.png');
          const flatName = rel.slice(0, -4).replace(/\//g, '_');

          // Klíč 1: basename "atm:bumble_title"
          if (!itemPaths[`${ns}:${basename}`]) itemPaths[`${ns}:${basename}`] = relUrl;
          // Klíč 2: flat "atm:questpics_bumblezone_bumble_title"
          if (!itemPaths[`${ns}:${flatName}`]) itemPaths[`${ns}:${flatName}`] = relUrl;
          // Klíč 3: přesná MC resource location "atm:textures/questpics/bumblezone/bumble_title.png"
          //         rel je "questpics/bumblezone/bumble_title.png" → přidáme "textures/"
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

  console.log(`\n🎉 Hotovo!`);
  console.log(`   Extrahováno:     ${totalExtracted} souborů`);
  console.log(`   Item klíče:      ${Object.keys(itemPaths).length}`);
  console.log(`   Block klíče:     ${Object.keys(blockPaths).length}`);
  console.log(`   Manifest celkem: ${Object.keys(manifest).length} klíčů`);
}

main();
