#!/usr/bin/env python3
"""
ATM10 Quest Builder
Parsuje SNBT soubory z FTB Quests a generuje quests.json pro webovou aplikaci.

Použití:
  python3 build_quests.py <cesta_k_quests_složce> [výstupní_soubor.json]

Příklad:
  python3 build_quests.py "./AllTheMods ATM-10 main config-ftbquests_quests" quests.json
"""

import os
import re
import json
import sys
from pathlib import Path


# ─── SNBT PARSER ──────────────────────────────────────────────────────────────

def unescape(s):
    """Odescapuje SNBT string.
    V souborech jsou newliny jako \\\\n (4 znaky) nebo \\n (2 znaky).
    """
    s = s.replace('\\\\n', '\n')
    s = s.replace('\\n', '\n')
    s = s.replace('\\"', '"')
    s = s.replace('\\\\', '\\')
    s = s.replace('\\t', '\t')
    return s


def parse_string_value(s):
    """Parsuje quoted string ze SNBT."""
    s = s.strip()
    if s.startswith('"') and s.endswith('"'):
        return unescape(s[1:-1])
    return s


def extract_blocks(text, open_char='{', close_char='}'):
    """Extrahuje top-level bloky ohraničené open_char/close_char."""
    blocks = []
    depth = 0
    start = -1
    for i, c in enumerate(text):
        if c == open_char:
            if depth == 0:
                start = i
            depth += 1
        elif c == close_char:
            depth -= 1
            if depth == 0 and start != -1:
                blocks.append(text[start+1:i])
                start = -1
    return blocks


def extract_list_strings(text):
    """Extrahuje stringy z SNBT list syntaxe ["...", "..."]."""
    result = []
    pattern = re.compile(r'"((?:[^"\\]|\\.)*)"')
    for m in pattern.finditer(text):
        result.append(unescape(m.group(1)))
    return result


def get_field_str(block, field):
    """Vrátí hodnotu string fieldu z SNBT bloku."""
    m = re.search(rf'\b{re.escape(field)}\s*:\s*"((?:[^"\\]|\\.)*)"', block)
    if m:
        return unescape(m.group(1))
    return None


def get_field_num(block, field):
    """Vrátí číslo z SNBT fieldu (podporuje Ld, d, L suffix)."""
    m = re.search(rf'\b{re.escape(field)}\s*:\s*([-\d.]+)[dLlf]?', block)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            return None
    return None


def get_inline_list(block, field):
    """Vrátí obsah list fieldu jako string."""
    # Hledáme field: [ ... ]
    m = re.search(rf'\b{re.escape(field)}\s*:\s*\[', block)
    if not m:
        return ''
    start = m.end() - 1  # pozice [
    depth = 0
    for i in range(start, len(block)):
        if block[i] == '[':
            depth += 1
        elif block[i] == ']':
            depth -= 1
            if depth == 0:
                return block[start+1:i]
    return ''


def get_list_of_blocks(block, field):
    """Vrátí list bloků z fieldu jako list stringů."""
    content = get_inline_list(block, field)
    return extract_blocks(content)


# ─── PARSER QUESTŮ ────────────────────────────────────────────────────────────

def parse_task(block):
    """Parsuje jeden task blok."""
    task_type = get_field_str(block, 'type') or 'item'
    task = {'type': task_type}

    if task_type == 'item':
        # item může být string nebo nested block { id: ..., components: { ... } }
        item_m = re.search(r'\bitem\s*:\s*\{', block)
        if item_m:
            # Najdi celý nested blok včetně vnořených {}
            start = item_m.end() - 1
            depth, end = 0, start
            for i in range(start, len(block)):
                if block[i] == '{': depth += 1
                elif block[i] == '}':
                    depth -= 1
                    if depth == 0: end = i; break
            item_block = block[start+1:end]

            item_id = get_field_str(item_block, 'id')
            count = get_field_num(item_block, 'count')
            task['item'] = item_id or ''
            if count and count > 1:
                task['count'] = int(count)
            # Smart filter — parsuj items ze filter stringu
            if item_id == 'ftbfiltersystem:smart_filter':
                filter_m = re.search(r'"ftbfiltersystem:filter"\s*:\s*"([^"]+)"', item_block)
                if filter_m:
                    items = re.findall(r'\bitem\(([^)]+)\)', filter_m.group(1))
                    if items:
                        seen = set()
                        task['filter_items'] = [x for x in items if not (x in seen or seen.add(x))]
        else:
            item_str = get_field_str(block, 'item')
            if item_str:
                task['item'] = item_str

    elif task_type == 'kill':
        entity = get_field_str(block, 'entity')
        if entity:
            task['entity'] = entity
        value = get_field_num(block, 'value')
        if value and value > 1:
            task['count'] = int(value)

    elif task_type == 'advancement':
        adv = get_field_str(block, 'advancement')
        if adv:
            task['advancement'] = adv

    elif task_type == 'biome':
        biome = get_field_str(block, 'biome')
        if biome:
            task['biome'] = biome

    elif task_type == 'dimension':
        dim = get_field_str(block, 'dimension')
        if dim:
            task['dimension'] = dim

    elif task_type == 'structure':
        structure = get_field_str(block, 'structure')
        if structure:
            task['structure'] = structure

    return task


def parse_chapter_images(text):
    """Parsuje images: [] blok na úrovni kapitoly."""
    images = []
    # Najdi images: [ ... ] na depth 1 (1 tab)
    m = re.search(r'^\timages\s*:\s*\[', text, re.MULTILINE)
    if not m:
        return images
    start = m.end() - 1
    depth = 0
    end = start
    for i in range(start, len(text)):
        if text[i] == '[': depth += 1
        elif text[i] == ']':
            depth -= 1
            if depth == 0: end = i; break

    content = text[start+1:end]
    for block in extract_blocks(content):
        img_ref = get_field_str(block, 'image')
        x       = get_field_num(block, 'x')
        y       = get_field_num(block, 'y')
        w       = get_field_num(block, 'width')
        h       = get_field_num(block, 'height')
        rot     = get_field_num(block, 'rotation')
        if img_ref and x is not None and y is not None:
            images.append({
                'image': img_ref,
                'x': x, 'y': y,
                'w': w or 1.0,
                'h': h or 1.0,
                'rotation': rot or 0.0,
            })
    return images


def parse_chapter_file(filepath):
    """Parsuje jeden .snbt chapter soubor. Vrátí dict s chapter metadaty a questy."""
    with open(filepath, encoding='utf-8') as f:
        text = f.read()

    # Odstraň Windows line endings
    text = text.replace('\r\n', '\n').replace('\r', '\n')

    chapter = {}

    # ID kapitoly — je na úrovni 1 tab (ne uvnitř nested bloku)
    chapter_id_m = re.search(r'^\t?id\s*:\s*"([0-9A-Fa-f]+)"', text, re.MULTILINE)
    chapter['id'] = chapter_id_m.group(1) if chapter_id_m else ''

    # Filename
    chapter['filename'] = Path(filepath).stem

    # Group ID
    group_m = re.search(r'^\t?group\s*:\s*"([0-9A-Fa-f]+)"', text, re.MULTILINE)
    chapter['group'] = group_m.group(1) if group_m else ''

    # Order index
    order_m = re.search(r'^\t?order_index\s*:\s*(\d+)', text, re.MULTILINE)
    chapter['order'] = int(order_m.group(1)) if order_m else 999

    # Default quest shape
    shape_m = re.search(r'default_quest_shape\s*:\s*"([^"]+)"', text)
    chapter['default_shape'] = shape_m.group(1) if shape_m else 'rsquare'

    # Icon (jen string form)
    icon_m = re.search(r'^\bicon\s*:\s*"([^"]+)"', text, re.MULTILINE)
    chapter['icon'] = icon_m.group(1) if icon_m else ''

    # Dekorativní obrázky na mapě
    chapter['images'] = parse_chapter_images(text)

    # Parsuj questy — najdi sekci quests: [...]
    quests_m = re.search(r'\bquests\s*:\s*\[', text)
    chapter['quests'] = []

    if quests_m:
        # Najdi celý quests list
        bracket_start = quests_m.end() - 1
        depth = 0
        end = bracket_start
        for i in range(bracket_start, len(text)):
            if text[i] == '[':
                depth += 1
            elif text[i] == ']':
                depth -= 1
                if depth == 0:
                    end = i
                    break

        quests_content = text[bracket_start+1:end]
        quest_blocks = extract_blocks(quests_content)

        for qblock in quest_blocks:
            quest = parse_quest_block(qblock, chapter['default_shape'])
            if quest:
                chapter['quests'].append(quest)

    return chapter


def parse_quest_block(block, default_shape):
    """Parsuje jeden quest blok."""
    # ID questu (2 taby deep v originálu, ale extract_blocks to ořízne)
    id_m = re.search(r'^\s*id\s*:\s*"([0-9A-Fa-f]+)"', block, re.MULTILINE)
    if not id_m:
        return None

    quest = {
        'id': id_m.group(1),
    }

    # Pozice
    x = get_field_num(block, 'x')
    y = get_field_num(block, 'y')
    quest['x'] = x if x is not None else 0.0
    quest['y'] = y if y is not None else 0.0

    # Shape a size
    shape = get_field_str(block, 'shape')
    quest['shape'] = shape if shape else default_shape
    size = get_field_num(block, 'size')
    quest['size'] = size if size else 1.0

    # Dependencies
    deps_content = get_inline_list(block, 'dependencies')
    deps = re.findall(r'"([0-9A-Fa-f]+)"', deps_content)
    if deps:
        quest['deps'] = deps

    # Invisible
    if re.search(r'\binvisible\s*:\s*true\b', block):
        quest['invisible'] = True

    # Icon — může být string nebo blok { id: "..." }
    icon_str = re.search(r'^\s*icon\s*:\s*"([^"]+)"', block, re.MULTILINE)
    if icon_str:
        quest['icon'] = icon_str.group(1)
    else:
        icon_block = re.search(r'^\s*icon\s*:\s*\{[^}]*\bid\s*:\s*"([^"]+)"', block, re.MULTILINE | re.DOTALL)
        if icon_block:
            quest['icon'] = icon_block.group(1)

    # Tasks
    task_blocks = get_list_of_blocks(block, 'tasks')
    tasks = []
    for tb in task_blocks:
        task = parse_task(tb)
        if task.get('type') not in ('xp', 'xp_levels', 'random', 'loot', 'choice'):
            tasks.append(task)
    if tasks:
        quest['tasks'] = tasks

    return quest


# ─── LANG PARSER ──────────────────────────────────────────────────────────────

def parse_lang_chapter_file(filepath):
    """
    Parsuje lang soubor. Vrátí dict:
    {
      quest_id: { title, subtitle, desc }
    }
    """
    with open(filepath, encoding='utf-8') as f:
        text = f.read()
    text = text.replace('\r\n', '\n').replace('\r', '\n')

    data = {}

    # quest.HEXID.title: "..."
    for m in re.finditer(r'quest\.([0-9A-Fa-f]+)\.title\s*:\s*"((?:[^"\\]|\\.)*)"', text):
        qid = m.group(1)
        if qid not in data:
            data[qid] = {}
        data[qid]['title'] = unescape(m.group(2))

    # quest.HEXID.quest_subtitle: "..."
    for m in re.finditer(r'quest\.([0-9A-Fa-f]+)\.quest_subtitle\s*:\s*"((?:[^"\\]|\\.)*)"', text):
        qid = m.group(1)
        if qid not in data:
            data[qid] = {}
        data[qid]['subtitle'] = unescape(m.group(2))

    # quest.HEXID.quest_desc: ["...", "...", ...]
    for m in re.finditer(r'quest\.([0-9A-Fa-f]+)\.quest_desc\s*:\s*\[', text):
        qid = m.group(1)
        # Najdi celý list
        start = m.end() - 1
        depth = 0
        end = start
        for i in range(start, len(text)):
            if text[i] == '[':
                depth += 1
            elif text[i] == ']':
                depth -= 1
                if depth == 0:
                    end = i
                    break
        list_content = text[start+1:end]
        strings = extract_list_strings(list_content)
        if qid not in data:
            data[qid] = {}
        data[qid]['desc'] = strings

    return data


def parse_chapter_titles(lang_dir):
    """Parsuje chapter.snbt pro tituly kapitol."""
    titles = {}
    chapter_file = os.path.join(lang_dir, 'chapter.snbt')
    if not os.path.exists(chapter_file):
        return titles

    with open(chapter_file, encoding='utf-8') as f:
        text = f.read()
    text = text.replace('\r\n', '\n').replace('\r', '\n')

    for m in re.finditer(r'chapter\.([0-9A-Fa-f]+)\.title\s*:\s*"((?:[^"\\]|\\.)*)"', text):
        titles[m.group(1)] = unescape(m.group(2))

    return titles


def parse_group_titles(lang_dir):
    """Parsuje chapter_group.snbt pro tituly skupin."""
    titles = {}
    group_file = os.path.join(lang_dir, 'chapter_group.snbt')
    if not os.path.exists(group_file):
        return titles

    with open(group_file, encoding='utf-8') as f:
        text = f.read()
    text = text.replace('\r\n', '\n').replace('\r', '\n')

    for m in re.finditer(r'chapter_group\.([0-9A-Fa-f]+)\.title\s*:\s*"((?:[^"\\]|\\.)*)"', text):
        titles[m.group(1)] = unescape(m.group(2))

    return titles


# ─── HLAVNÍ LOGIKA ────────────────────────────────────────────────────────────

def strip_mc(s):
    """Odstraní Minecraft color kódy."""
    return re.sub(r'&.', '', s)


def build_quests_json(root_dir):
    """Hlavní funkce — projde všechny soubory a vrátí výsledný JSON."""
    chapters_dir = os.path.join(root_dir, 'chapters')
    lang_dir = os.path.join(root_dir, 'lang', 'en_us')
    lang_chapters_dir = os.path.join(lang_dir, 'chapters')

    print(f"📂 Chapters: {chapters_dir}")
    print(f"📂 Lang: {lang_dir}")

    # Načti tituly kapitol a skupin
    chapter_titles = parse_chapter_titles(lang_dir)
    group_titles = parse_group_titles(lang_dir)

    print(f"✅ Chapter titles: {len(chapter_titles)}")
    print(f"✅ Group titles: {len(group_titles)}")

    chapters = []
    total_quests = 0

    snbt_files = sorted([f for f in os.listdir(chapters_dir) if f.endswith('.snbt')])
    print(f"\n🔄 Zpracovávám {len(snbt_files)} kapitol...")

    for filename in snbt_files:
        filepath = os.path.join(chapters_dir, filename)

        # Parse struktury
        chapter = parse_chapter_file(filepath)

        # Přidej title z lang
        chapter['title'] = chapter_titles.get(chapter['id'], filename.replace('_', ' ').replace('.snbt', ''))
        chapter['title_plain'] = strip_mc(chapter['title'])

        # Přidej group title
        chapter['group_title'] = group_titles.get(chapter['group'], '')

        # Parse lang pro questy
        lang_file = os.path.join(lang_chapters_dir, filename)
        lang_data = {}
        if os.path.exists(lang_file):
            lang_data = parse_lang_chapter_file(lang_file)

        # Merge lang data do questů
        for quest in chapter['quests']:
            qid = quest['id']
            lang = lang_data.get(qid, {})
            if lang.get('title'):
                quest['title'] = lang['title']
                quest['title_plain'] = strip_mc(lang['title'])
            else:
                # Fallback — zkus z tasků
                tasks = quest.get('tasks', [])
                if tasks and tasks[0].get('item'):
                    item = tasks[0]['item'].split(':')[-1].replace('_', ' ').title()
                    quest['title'] = item
                    quest['title_plain'] = item
                elif tasks and tasks[0].get('entity'):
                    entity = tasks[0]['entity'].split(':')[-1].replace('_', ' ').title()
                    quest['title'] = 'Kill ' + entity
                    quest['title_plain'] = 'Kill ' + entity
                else:
                    quest['title'] = f'Quest {qid[:8]}'
                    quest['title_plain'] = quest['title']

            if lang.get('subtitle'):
                quest['subtitle'] = lang['subtitle']

            if lang.get('desc'):
                quest['desc'] = lang['desc']

        total_quests += len(chapter['quests'])

        # Odstraň nepotřebná pole z výstupu
        del chapter['default_shape']

        print(f"  ✓ {chapter['title_plain'][:40]:<40} {len(chapter['quests']):>4} questů")
        chapters.append(chapter)

    # Seřaď podle order_index, pak title
    chapters.sort(key=lambda c: (c.get('order', 999), c.get('title_plain', '')))

    print(f"\n✅ Celkem: {len(chapters)} kapitol, {total_quests} questů")

    return {
        'chapters': chapters,
        'meta': {
            'total_chapters': len(chapters),
            'total_quests': total_quests,
        }
    }


# ─── ENTRY POINT ──────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    root_dir = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else 'quests.json'

    if not os.path.isdir(root_dir):
        print(f"❌ Složka nenalezena: {root_dir}")
        sys.exit(1)

    data = build_quests_json(root_dir)

    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

    size_kb = os.path.getsize(output_file) / 1024
    print(f"\n💾 Uloženo: {output_file} ({size_kb:.0f} KB)")
