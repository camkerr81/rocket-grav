"""
Braille Iconography: Tactile monospace Braille icons to replace colored emojis.
"""

from typing import List, Optional, Tuple
from braille_icon.catalog import ICONS, EMOJI_TO_BRAILLE, EMOJI_TO_ICON, BrailleIcon
from braille_icon.matrix import make_4x4, make_2x4, decode_braille_char, render_ascii_blueprint

__version__ = "1.0.0"
__all__ = [
    "ICONS",
    "EMOJI_TO_BRAILLE",
    "EMOJI_TO_ICON",
    "BrailleIcon",
    "get_icon",
    "replace_emojis",
    "audit_text",
    "make_4x4",
    "make_2x4",
    "decode_braille_char",
    "render_ascii_blueprint",
]


def get_icon(query: str) -> Optional[BrailleIcon]:
    """Look up a BrailleIcon by exact emoji match or keyword query."""
    # 1. Exact emoji
    if query in EMOJI_TO_ICON:
        return EMOJI_TO_ICON[query]

    # 2. Case-insensitive substring match
    q = query.strip().lower()
    for icon in ICONS:
        if q == icon.name.lower() or q in icon.name.lower():
            return icon
        for em in icon.emojis:
            if q == em.lower():
                return icon

    return None


def replace_emojis(text: str) -> Tuple[str, int]:
    """Replace all known emojis in text with their 4x4 Braille glyphs.
    
    Returns (updated_text, replacement_count).
    """
    updated = text
    count = 0
    # Process multi-char emoji variations first
    sorted_emojis = sorted(EMOJI_TO_BRAILLE.keys(), key=lambda x: len(x), reverse=True)
    for em in sorted_emojis:
        c = updated.count(em)
        if c > 0:
            updated = updated.replace(em, EMOJI_TO_BRAILLE[em])
            count += c
    return updated, count


def audit_text(text: str, ignore_code: bool = False) -> List[Tuple[int, str, str, str]]:
    """Scan text for legacy emoji violations.
    
    If ignore_code is True, ignores content inside fenced code blocks (```...```)
    and inline code backticks (`...`).

    Returns list of tuples: (line_number, emoji_found, recommended_braille, line_text)
    """
    violations = []
    lines = text.splitlines()
    sorted_emojis = sorted(EMOJI_TO_BRAILLE.keys(), key=lambda x: len(x), reverse=True)

    in_fence = False
    for line_idx, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue

        if in_fence and ignore_code:
            continue

        target_line = line
        if ignore_code:
            # Strip inline code backticks
            import re
            target_line = re.sub(r"`[^`]*`", "", line)

        for em in sorted_emojis:
            if em in target_line:
                violations.append((line_idx, em, EMOJI_TO_BRAILLE[em], line.strip()))

    return violations
