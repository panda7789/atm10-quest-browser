# ATM10 Quest Browser

An interactive web-based quest browser for the **All The Mods 10** modpack (and other FTB Quests modpacks).

![showcase](https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExMmc0bHJxbW11aWxrdmExbm9pcGFiZXNidzBqdGNtcWo1a2xncTNqeSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/4dGER7ZEm4L67spIER/giphy.gif)

## Features

- 🗺️ **Interactive map** — pan, zoom, navigate quest chapters
- 🎁 **Rewards display** — XP, items, random/choice loot tables
- 🔍 **Search** — full-text search across all quests and chapters
- 📖 **Wiki links** — quick links to mod wikis for known namespaces
- 🖼️ **Chapter images** — decorative background images on the quest map
- 🐛 **Kill task icons** — spawn eggs used where available, entity textures as fallback

---

## Requirements

- Python 3.8+
- Node.js 18+
- A local copy of your ATM10 (or other FTB Quests) instance

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/yourname/atm10-quest-browser.git
cd atm10-quest-browser
```

### 2. Build quest data

Point the script at your FTB Quests config folder:

```bash
python3 build_quests.py "/path/to/minecraft/instance/config/ftbquests/quests" quests.json
```

On a typical CurseForge install this is something like:
```
C:\Users\You\curseforge\minecraft\Instances\All the Mods 10\config\ftbquests\quests
```

### 3. Extract icons

This script scans all mod jars and your vanilla Minecraft jar, extracting item/block/entity textures and building a manifest file.

```bash
node extract_icons.js /path/to/instance
```

It will automatically look for the vanilla jar in common locations (`.minecraft/versions/`, CurseForge installs, etc). If it can't find it, pass the path explicitly:

```bash
node extract_icons.js /path/to/instance /path/to/.minecraft
```

**What gets extracted:**
- `icons/` — all textures (item, block, entity) from every mod jar
- `icons_manifest.json` — maps item IDs to texture paths
- `advancements_manifest.json` — maps advancement IDs to their display icons

### 5. Serve

Any static file server works. Simplest option:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

---

## License

MIT
