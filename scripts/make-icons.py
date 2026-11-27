"""Generate the extension icon set (16/32/48/128 px) with Pillow.

Design: rounded square, indigo→blue gradient, white radar mark.
Run:  python scripts/make-icons.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw

SIZE = 1024
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "icons")
TARGETS = (16, 32, 48, 128)

TOP = (99, 132, 255)
BOTTOM = (37, 62, 190)
RADIUS = 228


def gradient(size: int) -> Image.Image:
    image = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(image)
    for y in range(size):
        ratio = y / max(1, size - 1)
        color = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * ratio) for i in range(3))
        draw.line([(0, y), (size, y)], fill=color)
    return image


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def build() -> Image.Image:
    base = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    base.paste(gradient(SIZE), (0, 0), rounded_mask(SIZE, RADIUS))

    overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    center = SIZE / 2
    # Outer halo ring
    r_outer = 372
    draw.ellipse(
        [center - r_outer, center - r_outer, center + r_outer, center + r_outer],
        outline=(255, 255, 255, 90),
        width=34,
    )
    # Main ring
    r_main = 258
    draw.ellipse(
        [center - r_main, center - r_main, center + r_main, center + r_main],
        outline=(255, 255, 255, 235),
        width=52,
    )
    # Cardinal ticks
    tick_inner, tick_outer, tick_width = 300, 408, 44
    for (x1, y1, x2, y2) in (
        (center, center - tick_outer, center, center - tick_inner),
        (center, center + tick_inner, center, center + tick_outer),
        (center - tick_outer, center, center - tick_inner, center),
        (center + tick_inner, center, center + tick_outer, center),
    ):
        draw.line([(x1, y1), (x2, y2)], fill=(255, 255, 255, 220), width=tick_width)
    # Center dot
    r_dot = 96
    draw.ellipse(
        [center - r_dot, center - r_dot, center + r_dot, center + r_dot], fill=(255, 255, 255, 255)
    )

    base.alpha_composite(overlay)
    return base


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    master = build()
    for size in TARGETS:
        master.resize((size, size), Image.LANCZOS).save(
            os.path.join(OUT_DIR, f"icon{size}.png"), "PNG", optimize=True
        )
        print(f"wrote icon{size}.png")


if __name__ == "__main__":
    main()
