"""The DAIJIN wordmark, drawn in the same texture vocabulary as the charts.

The dither language IS the brand here, so the wordmark is built from the same
glyph ramps the bars and the radar use rather than from a separate decorative
font. That makes the intro and the data one visual system, and it means the
wordmark obeys the same rule everything else does: SHAPE CARRIES IT, colour
only reinforces. Rendered to a colourless terminal the letters still read,
because the letterforms are the signal and the ramp is texture inside them.

The font is a 5x7 mask per letter. Small enough to hold in the file, large
enough that the letterforms survive a terminal cell's aspect ratio.
"""

from __future__ import annotations

from typing import Iterable, Sequence

from .texture import NEUTRAL, Texture

# 5 wide, 7 tall. "#" is inside the letter, space is outside.
BLOCK_FONT: dict[str, tuple[str, ...]] = {
    "D": (
        "####.",
        "#...#",
        "#...#",
        "#...#",
        "#...#",
        "#...#",
        "####.",
    ),
    "A": (
        ".###.",
        "#...#",
        "#...#",
        "#####",
        "#...#",
        "#...#",
        "#...#",
    ),
    "I": (
        "#####",
        "..#..",
        "..#..",
        "..#..",
        "..#..",
        "..#..",
        "#####",
    ),
    "J": (
        "#####",
        "...#.",
        "...#.",
        "...#.",
        "...#.",
        "#..#.",
        ".##..",
    ),
    "N": (
        "#...#",
        "##..#",
        "#.#.#",
        "#.#.#",
        "#.#.#",
        "#..##",
        "#...#",
    ),
}

GLYPH_HEIGHT = 7
GLYPH_WIDTH = 5
LETTER_GAP = 1


def _density(column: int, row: int, width: int, height: int) -> float:
    """A diagonal gradient across the whole wordmark.

    Density rising left to right makes the mark read as dithered rather than
    as a solid slab, and it is the same gradient idea the bars use, so the eye
    that has learned one has learned the other.
    """
    if width <= 1 and height <= 1:
        return 1.0
    span = max(1, (width - 1) + (height - 1))
    return (column + row) / span


def wordmark_lines(
    text: str = "DAIJIN",
    *,
    texture: Texture = NEUTRAL,
    reveal: int | None = None,
) -> list[str]:
    """Draw text as block letters filled with the texture's ramp.

    reveal limits how many COLUMNS of the finished mark are drawn, which is how
    the staged entrance works: the same pure function produces every frame, so
    the animation cannot drift from the final image.
    """
    letters = [BLOCK_FONT[ch] for ch in text.upper() if ch in BLOCK_FONT]
    if not letters:
        return []
    width = len(letters) * GLYPH_WIDTH + (len(letters) - 1) * LETTER_GAP
    limit = width if reveal is None else max(0, min(width, reveal))

    lines: list[str] = []
    for row in range(GLYPH_HEIGHT):
        cells: list[str] = []
        column = 0
        for index, mask in enumerate(letters):
            if index:
                cells.append(" " * LETTER_GAP)
                column += LETTER_GAP
            for x, cell in enumerate(mask[row]):
                if column + x >= limit:
                    cells.append(" ")
                    continue
                cells.append(
                    texture.glyph(_density(column + x, row, width, GLYPH_HEIGHT))
                    if cell == "#"
                    else " "
                )
            column += GLYPH_WIDTH
        lines.append("".join(cells).rstrip())
    return lines


def wordmark_width(text: str = "DAIJIN") -> int:
    count = len([ch for ch in text.upper() if ch in BLOCK_FONT])
    return count * GLYPH_WIDTH + max(0, count - 1) * LETTER_GAP


def mask_of(lines: Sequence[str], width: int | None = None) -> list[str]:
    """Recover the on/off mask from rendered lines.

    A test that compares this against BLOCK_FONT checks the LETTERFORMS
    survived the texture, which is the property a colourless reader depends on.
    Asserting the glyphs alone would pass for a rectangle.
    """
    span = width or max((len(line) for line in lines), default=0)
    return ["".join("#" if ch != " " else "." for ch in line.ljust(span)) for line in lines]


def expected_mask(text: str = "DAIJIN") -> list[str]:
    """The font's own mask, gaps included, in the form mask_of returns."""
    letters = [BLOCK_FONT[ch] for ch in text.upper() if ch in BLOCK_FONT]
    return [
        ("." * LETTER_GAP).join(mask[row] for mask in letters)
        for row in range(GLYPH_HEIGHT)
    ]


def reveal_steps(text: str = "DAIJIN", steps: int = 6) -> Iterable[int]:
    """Column counts for a staged entrance, ending on the full width."""
    width = wordmark_width(text)
    if steps <= 1:
        return [width]
    return [round(width * (index + 1) / steps) for index in range(steps)]


# The small form. The full mark is 35 columns and seven rows, which is right
# for an intro and wrong for a header, so this is the same object at a size a
# header can hold: three rows, the same ramp, the same left-to-right density
# gradient, so it reads as the mark rather than as different branding.
SMALL_FONT: dict[str, tuple[str, ...]] = {
    "D": ("##.", "#.#", "##."),
    "A": ("###", "#.#", "#.#"),
    "I": ("###", ".#.", "###"),
    "J": ("###", ".#.", "##."),
    "N": ("#.#", "###", "#.#"),
}

SMALL_HEIGHT = 3
SMALL_WIDTH = 3


def small_wordmark_lines(text: str = "DAIJIN", *, texture: Texture = NEUTRAL) -> list[str]:
    """Three-row wordmark for a header."""
    letters = [SMALL_FONT[ch] for ch in text.upper() if ch in SMALL_FONT]
    if not letters:
        return []
    width = len(letters) * SMALL_WIDTH + (len(letters) - 1) * LETTER_GAP
    lines: list[str] = []
    for row in range(SMALL_HEIGHT):
        cells: list[str] = []
        column = 0
        for index, mask in enumerate(letters):
            if index:
                cells.append(" " * LETTER_GAP)
                column += LETTER_GAP
            for x, cell in enumerate(mask[row]):
                cells.append(
                    texture.glyph(_density(column + x, row, width, SMALL_HEIGHT))
                    if cell == "#"
                    else " "
                )
            column += SMALL_WIDTH
        lines.append("".join(cells).rstrip())
    return lines


def small_wordmark_width(text: str = "DAIJIN") -> int:
    count = len([ch for ch in text.upper() if ch in SMALL_FONT])
    return count * SMALL_WIDTH + max(0, count - 1) * LETTER_GAP


def header_mark(available: int, text: str = "DAIJIN") -> list[str]:
    """The widest form that FITS, degrading rather than wrapping.

    A wrapped wordmark is not a smaller wordmark, it is a broken one, so a
    terminal too narrow for the three-row mark gets the plain word and a
    terminal too narrow for that gets nothing at all. Returning nothing is a
    real answer: a header is not worth a broken mark.
    """
    if available >= small_wordmark_width(text):
        return small_wordmark_lines(text)
    if available >= len(text):
        return [text.upper()]
    return []
