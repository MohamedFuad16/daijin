"""One texture language for every chart in the app.

The owner's dashboard fills every shape with a pattern rather than a colour
slab, and asked the TUI to read the same way. A terminal cannot halftone
pixels, but it has a native texture vocabulary: shade glyphs, braille dot
densities, and diagonal hatch.

The rule this is built on is the one the kept-yours styling proved: PATTERN AND
COLOUR ARE TWO CHANNELS. Every series carries both, so a reader with no colour
still tells pass from fail by texture alone, and the legend shows swatches
rather than coloured squares.

Like motion.py, this is the single source. A chart that invents its own glyphs
is a second vocabulary, and two vocabularies are no vocabulary.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Texture:
    """A series identity in two channels.

    ramp runs sparse to dense. A bar fills from its ramp so the texture reads
    as texture rather than as a single repeated character, and so density can
    carry magnitude where that helps.
    """

    name: str
    ramp: tuple[str, ...]
    cap: str
    color: str
    swatch: str
    label: str

    def glyph(self, density: float) -> str:
        """Pick a ramp step. density 0 is the sparsest, 1 the densest."""
        if not self.ramp:
            return " "
        index = int(round(max(0.0, min(1.0, density)) * (len(self.ramp) - 1)))
        return self.ramp[index]


# Shade glyphs for the solid-ish end, braille for stipple, and a real diagonal
# for hatch. Colours are distinct hues, but nothing depends on them alone.
# cap is the bar's top edge, and it is the texture's OWN densest form rather
# than a shared solid: a hatched bar capped with a block would lose the
# identity that lets a colourless reader name it.
PASS = Texture("pass", ("░", "▒", "▓"), "█", "green", "▓", "pass")
PARTIAL = Texture("partial", ("⠂", "⠒", "⠶"), "⠿", "blue", "⠿", "partial")
FAIL = Texture("fail", ("╱", "╱", "╳"), "╳", "magenta", "╱", "fail")
UNGRADED = Texture("ungraded", ("·", "·", "∙"), "•", "bright_black", "·", "not graded")
# unsubmitted is a VERDICT the engine sends, not the absence of one. An attempt
# that was never handed in and an attempt whose verdict was never recorded are
# different facts, so they do not share a swatch. Open glyphs read as "nothing
# arrived" without reading as a grade.
UNSUBMITTED = Texture("unsubmitted", ("╌", "╌", "═"), "═", "yellow", "╌", "unsubmitted")
# The neutral series, for quantities that are not outcomes: tokens, counts.
NEUTRAL = Texture("neutral", ("░", "▒", "▓"), "█", "cyan", "▒", "tokens")

TEXTURES: dict[str, Texture] = {
    t.name: t for t in (PASS, PARTIAL, FAIL, UNSUBMITTED, UNGRADED, NEUTRAL)
}

# How a verdict maps to a texture. Anything unrecognised is not graded, which
# is the honest default: an unknown verdict is not a pass.
# Locked in contract v5: pass | partial | fail | unsubmitted. A value outside
# that set falls to UNGRADED, which is the honest default because an unknown
# verdict is not a pass.
VERDICT_TEXTURE: dict[str, Texture] = {
    "pass": PASS,
    "partial": PARTIAL,
    "fail": FAIL,
    "unsubmitted": UNSUBMITTED,
}


def texture_for_verdict(verdict: object) -> Texture:
    return VERDICT_TEXTURE.get(str(verdict or "").lower(), UNGRADED)


def dither_grid(
    values: list[float],
    textures: list[Texture],
    *,
    height: int = 10,
    width: int = 3,
    gap: int = 1,
    ceiling: float | None = None,
) -> list[list[tuple[str, Texture | None]]]:
    """The bar chart as a grid of (text, texture) cells, top row first.

    One source for both consumers: the widget colours from this, and the plain
    text form below joins it. A second implementation would be a second
    vocabulary.
    """
    if not values:
        return []
    height = max(1, height)
    # A caller with a real ceiling gets bars comparable to other charts; one
    # without gets bars scaled to the tallest value, which is only comparable
    # within itself.
    top = float(ceiling) if ceiling else (max(values) or 1.0)
    filled = [max(0, min(height, round(value / top * height))) for value in values]
    grid: list[list[tuple[str, Texture | None]]] = []
    for row in range(height):
        line: list[tuple[str, Texture | None]] = []
        for index, count in enumerate(filled):
            texture = textures[index] if index < len(textures) else NEUTRAL
            top_row = height - count
            if row < top_row:
                line.append((" " * width, None))
            else:
                if row == top_row:
                    glyph = texture.cap
                else:
                    # Sparse just under the cap, densest at the baseline, so
                    # the fill reads as a gradient rather than a repeated char.
                    depth = (row - top_row - 1) / max(1, count - 2)
                    glyph = texture.glyph(depth)
                line.append((glyph * width, texture))
            line.append((" " * gap, None))
        grid.append(line)
    return grid


def dither_columns(
    values: list[float],
    textures: list[Texture],
    *,
    height: int = 10,
    width: int = 3,
    gap: int = 1,
    ceiling: float | None = None,
) -> list[str]:
    """The plain text form, for asserting the drawing without a terminal."""
    return [
        "".join(text for text, _ in row).rstrip()
        for row in dither_grid(
            values, textures, height=height, width=width, gap=gap, ceiling=ceiling
        )
    ]


def stipple_grid(
    values: list[float],
    *,
    height: int = 6,
    textures: list[Texture] | None = None,
    texture: Texture = NEUTRAL,
    min_column: int = 0,
) -> list[list[tuple[str, Texture | None]]]:
    """A line with stippled fill beneath it, as (text, texture) cells.

    Per-point textures are allowed so a verdict series carries its outcome in
    the fill, not only in a colour a reader may not have.

    min_column exists for outcome series: a fail is a real result, and drawing
    it as zero height renders it as absence, so three failed attempts read as
    three missing ones. A caller plotting quantities leaves it at 0, where a
    zero really is nothing.
    """
    if not values:
        return []
    height = max(2, height)
    top = max(values) or 1.0
    heights = [
        max(min_column, min(height, round(value / top * height))) for value in values
    ]
    grid: list[list[tuple[str, Texture | None]]] = []
    for row in range(height):
        line: list[tuple[str, Texture | None]] = []
        for index, column in enumerate(heights):
            own = textures[index] if textures and index < len(textures) else texture
            top_row = height - column
            if row < top_row:
                line.append((" ", None))
            elif row == top_row:
                line.append((own.cap, own))
            else:
                depth = (row - top_row - 1) / max(1, column - 2)
                line.append((own.glyph(depth), own))
            line.append((" ", None))
        grid.append(line)
    return grid


def stipple_area(
    values: list[float],
    *,
    height: int = 6,
    textures: list[Texture] | None = None,
    texture: Texture = NEUTRAL,
    min_column: int = 0,
) -> list[str]:
    """The plain text form of stipple_grid."""
    return [
        "".join(text for text, _ in row).rstrip()
        for row in stipple_grid(
            values, height=height, textures=textures, texture=texture, min_column=min_column
        )
    ]


def legend(textures: list[Texture]) -> str:
    """Swatches are patterns, not coloured squares.

    A legend that distinguishes its entries only by colour tells a colourless
    reader nothing, and it is the one place a chart explains itself.
    """
    return "   ".join(f"{t.swatch} {t.label}" for t in textures)
