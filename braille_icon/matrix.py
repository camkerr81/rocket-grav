"""
Braille Matrix Geometry and Encoding Engine.

Converts 4x4 (2-cell) and 2x4 (1-cell) binary dot matrices into standard
Unicode Braille Patterns (U+2800..U+28FF).
"""

from typing import List, Tuple

# Standard Unicode Braille dot bit weights:
# Col 0: dot 1 (0x01), dot 2 (0x02), dot 3 (0x04), dot 7 (0x40)
# Col 1: dot 4 (0x08), dot 5 (0x10), dot 6 (0x20), dot 8 (0x80)
DOT_WEIGHTS = [
    [(1, 0x01), (4, 0x08)],
    [(2, 0x02), (5, 0x10)],
    [(3, 0x04), (6, 0x20)],
    [(7, 0x40), (8, 0x80)],
]


def make_4x4(r0: str, r1: str, r2: str, r3: str) -> str:
    """Generate a 2-cell 4x4 Braille glyph from four 4-character strings."""
    rows = [r.replace(" ", "") for r in (r0, r1, r2, r3)]
    for idx, r in enumerate(rows):
        if len(r) != 4:
            raise ValueError(f"Row {idx} must be exactly 4 characters, got '{r}'")

    dots1 = 0
    dots2 = 0
    for r in range(4):
        # Cell 1 (cols 0, 1)
        if rows[r][0] in ("#", "o", "x", "X", "1", "●"):
            dots1 |= DOT_WEIGHTS[r][0][1]
        if rows[r][1] in ("#", "o", "x", "X", "1", "●"):
            dots1 |= DOT_WEIGHTS[r][1][1]
        # Cell 2 (cols 2, 3)
        if rows[r][2] in ("#", "o", "x", "X", "1", "●"):
            dots2 |= DOT_WEIGHTS[r][0][1]
        if rows[r][3] in ("#", "o", "x", "X", "1", "●"):
            dots2 |= DOT_WEIGHTS[r][1][1]

    return chr(0x2800 + dots1) + chr(0x2800 + dots2)


def make_2x4(r0: str, r1: str, r2: str, r3: str) -> str:
    """Generate a 1-cell 2x4 Braille glyph from four 2-character strings."""
    rows = [r.replace(" ", "") for r in (r0, r1, r2, r3)]
    for idx, r in enumerate(rows):
        if len(r) != 2:
            raise ValueError(f"Row {idx} must be exactly 2 characters, got '{r}'")

    dots = 0
    for r in range(4):
        if rows[r][0] in ("#", "o", "x", "X", "1", "●"):
            dots |= DOT_WEIGHTS[r][0][1]
        if rows[r][1] in ("#", "o", "x", "X", "1", "●"):
            dots |= DOT_WEIGHTS[r][1][1]

    return chr(0x2800 + dots)


def decode_braille_char(ch: str) -> List[List[int]]:
    """Decode a single Braille character into a 4x2 grid of bits (0 or 1)."""
    val = ord(ch) - 0x2800
    if not (0 <= val <= 0xFF):
        raise ValueError(f"Character '{ch}' is not a valid Unicode Braille pattern.")

    d = [(val >> i) & 1 for i in range(8)]
    # [row 0..3][col 0..1]
    return [
        [d[0], d[3]],
        [d[1], d[4]],
        [d[2], d[5]],
        [d[6], d[7]],
    ]


def render_ascii_blueprint(glyph: str) -> str:
    """Render a Braille glyph into an ASCII dot preview."""
    grids = [decode_braille_char(c) for c in glyph]
    lines = []
    for r in range(4):
        row_str = "  ".join("".join("●" if cell[r][c] else "·" for c in range(2)) for cell in grids)
        lines.append(row_str)
    return "\n".join(lines)
