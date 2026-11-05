#!/usr/bin/env python3
"""
IMAGO UNIVERSE - asset preparation pipeline.

Turns the painted source plates in `assets-src/` into a clean, metadata-rich,
runtime-ready asset library in `public/library/`.

Pipeline stages
---------------
1. Chroma key      - remove flat magenta or blue studio backdrops from object plates.
2. Unmix / despill - un-composite the backdrop colour from edge pixels and
                     suppress colour spill.
3. Refine          - alpha cleanup, de-fringe, autocrop, resize.
4. Derive          - build extra coherent assets by re-using *real painted
                     texture* (foliage chips / rock chips) extracted from the
                     hero paintings, plus colour-graded sibling collections.
5. Publish         - WebP + thumbnail + metadata into the runtime manifest.

Nothing here talks to a network service and nothing here uses generative AI at
runtime: this is a conventional, reproducible image-processing build step.

Usage:  python3 tools/prepare_assets.py [--src assets-src] [--out public/library]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# --------------------------------------------------------------------------
# colour helpers
# --------------------------------------------------------------------------

KEY = np.array([255.0, 0.0, 255.0])


def key_magenta(img: Image.Image, lo: float = 28.0, hi: float = 150.0) -> Image.Image:
    """Remove a flat magenta studio backdrop and un-mix it from the edges."""
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    # "magenta-ness": how far the pixel sits towards the R+B / low-G corner.
    m = np.minimum(r, b) - g
    t = np.clip((m - lo) / (hi - lo), 0.0, 1.0)
    t = t * t * (3.0 - 2.0 * t)  # smoothstep
    alpha = 1.0 - t

    # Un-composite: observed = obj*a + key*(1-a)  ->  obj = (observed - key*(1-a))/a
    a3 = alpha[..., None]
    safe = np.maximum(a3, 1e-3)
    obj = (rgb - KEY * (1.0 - a3)) / safe
    obj = np.clip(obj, 0, 255)

    # Residual spill suppression on solid pixels (magenta bounce light).
    solid = alpha > 0.985
    sr, sg, sb = obj[..., 0], obj[..., 1], obj[..., 2]
    spill = np.maximum(0.0, np.minimum(sr, sb) - sg) * solid
    obj[..., 0] = np.clip(sr - spill * 0.85, 0, 255)
    obj[..., 2] = np.clip(sb - spill * 0.85, 0, 255)

    alpha[alpha < 0.05] = 0.0
    alpha[alpha > 0.96] = 1.0
    out = np.dstack([obj, alpha * 255.0]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def key_blue(img: Image.Image, lo: float = 20.0, hi: float = 100.0) -> Image.Image:
    """Remove blue backdrops while preserving pink/red petals, unlike a magenta key."""
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    blue = b - np.maximum(r, g)
    t = np.clip((blue - lo) / (hi - lo), 0.0, 1.0)
    t = t * t * (3.0 - 2.0 * t)
    alpha = 1.0 - t
    a3 = alpha[..., None]
    obj = (rgb - np.array([0.0, 0.0, 255.0], dtype=np.float32) * (1.0 - a3)) / np.maximum(a3, 1e-3)
    obj = np.clip(obj, 0, 255)
    # Remove blue bounce on opaque edges without desaturating pink blossoms.
    spill = np.maximum(0.0, obj[..., 2] - np.maximum(obj[..., 0], obj[..., 1])) * (alpha > 0.985)
    obj[..., 2] = np.clip(obj[..., 2] - spill * 0.85, 0, 255)
    alpha[alpha < 0.05] = 0.0
    alpha[alpha > 0.96] = 1.0
    return Image.fromarray(np.dstack([obj, alpha * 255.0]).astype(np.uint8), "RGBA")


def clean_edges(img: Image.Image, px: int = 3) -> Image.Image:
    """Zero a hairline frame so keyed ripples never leave a faint rectangle edge."""
    if px <= 0:
        return img
    a = np.array(img)
    h, w = a.shape[:2]
    if min(h, w) <= px * 2:
        return img
    a[:px, :, 3] = 0
    a[h - px:, :, 3] = 0
    a[:, :px, 3] = 0
    a[:, w - px:, 3] = 0
    return Image.fromarray(a, "RGBA")


def crisp_alpha(img: Image.Image, cut: float = 0.25, hi: float = 0.60) -> Image.Image:
    """Harden a soft alpha matte.

    Small subjects painted against a blue sky key to a wide band of very low
    alpha haze rather than to clean edges. Ramping that band away keeps the
    antialiasing on the subject while deleting the haze around it.
    """
    a = np.asarray(img).astype(np.float32)
    al = a[..., 3] / 255.0
    a[..., 3] = np.clip((al - cut) / (hi - cut), 0, 1) * 255.0
    return Image.fromarray(a.astype(np.uint8), "RGBA")


def autocrop(img: Image.Image, pad: int = 4) -> Image.Image:
    bbox = img.getchannel("A").getbbox()
    if not bbox:
        return img
    l, t, r, b = bbox
    l = max(0, l - pad)
    t = max(0, t - pad)
    r = min(img.width, r + pad)
    b = min(img.height, b + pad)
    return img.crop((l, t, r, b))


def boat_waterline(img: Image.Image) -> Image.Image:
    """Hide the submerged hull below a gently rippling, transparent waterline.

    The line is positioned on the original painted plate so the unmodified
    source remains available, and the same silhouette is used for every palette.
    A one-pixel soft edge avoids a jagged cut when the boat is scaled.
    """
    rgba = np.array(img.convert("RGBA"), dtype=np.uint8, copy=True)
    height, width = rgba.shape[:2]
    x = np.arange(width, dtype=np.float32)
    line = height * (0.68 + 0.008 * np.sin(2 * np.pi * x / (width * 0.19))
                     + 0.003 * np.sin(2 * np.pi * x / (width * 0.083) + 0.7))
    y = np.arange(height, dtype=np.float32)[:, None]
    coverage = np.clip(line[None, :] - y + 0.5, 0.0, 1.0)
    rgba[..., 3] = np.round(rgba[..., 3].astype(np.float32) * coverage).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def fit(img: Image.Image, max_dim: int) -> Image.Image:
    if max(img.size) <= max_dim:
        return img
    s = max_dim / max(img.size)
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))),
                      Image.Resampling.LANCZOS)


def dominant_palette(img: Image.Image, n: int = 5) -> list[str]:
    small = img.convert("RGBA").resize((64, 64), Image.Resampling.BOX)
    a = np.asarray(small, dtype=np.float32)
    mask = a[..., 3] > 128
    if mask.sum() < 8:
        return ["#888888"]
    px = a[..., :3][mask]
    q = (px // 32 * 32 + 16).astype(np.uint8)
    packed = (q[:, 0].astype(np.uint32) << 16) | (q[:, 1].astype(np.uint32) << 8) | q[:, 2]
    vals, counts = np.unique(packed, return_counts=True)
    order = np.argsort(-counts)[:n]
    return ["#%06x" % int(vals[i]) for i in order]


def grade(img: Image.Image, fn: Callable[[np.ndarray], np.ndarray]) -> Image.Image:
    a = np.asarray(img.convert("RGBA"), dtype=np.float32)
    a[..., :3] = np.clip(fn(a[..., :3]), 0, 255)
    return Image.fromarray(a.astype(np.uint8), "RGBA")


def night_grade(rgb: np.ndarray) -> np.ndarray:
    """Moonlit sibling collection: cooler, darker, gently desaturated."""
    lum = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    out = lum[..., None] * 0.42 + rgb * 0.58
    out = out * np.array([0.60, 0.76, 1.02], dtype=np.float32)
    out = out * 0.66 + np.array([6.0, 12.0, 26.0], dtype=np.float32)
    return out


def autumn_foliage(rgb: np.ndarray) -> np.ndarray:
    """Shift green foliage to amber/copper while leaving stone, bark and water
    alone. A flat warm multiply would turn the stone bridge orange too, which
    reads as a colour cast rather than a season."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    green = np.clip((g - np.maximum(r, b)) / 34.0, 0, 1)
    yellowgreen = (np.clip((np.minimum(r, g) - b) / 46.0, 0, 1)
                   * np.clip((g - r + 26.0) / 52.0, 0, 1))
    mask = np.clip(np.maximum(green, yellowgreen * 0.85), 0, 1)[..., None]
    lum = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    warm = np.stack([lum * 1.30 + 34.0, lum * 0.80 + 14.0, lum * 0.32 + 4.0], axis=-1)
    return rgb * (1.0 - mask) + warm * mask


def autumn_grade(rgb: np.ndarray) -> np.ndarray:
    """Warm harvest variant used for foreground variety."""
    lum = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    out = lum[..., None] * 0.25 + rgb * 0.75
    return out * np.array([1.22, 1.02, 0.62], dtype=np.float32)


# --------------------------------------------------------------------------
# painted-texture chip extraction + procedural plant assembly
# --------------------------------------------------------------------------

def extract_chips(img: Image.Image, count: int, size: int,
                  region: tuple[float, float, float, float] = (0.05, 0.05, 0.95, 0.6),
                  min_cover: float = 0.90, seed: int = 7,
                  green_bias: bool = False) -> list[Image.Image]:
    """Harvest fully-opaque, high-detail texture windows from a painting.

    These chips carry the *exact* brush work, palette and lighting of the hero
    artwork, so plants assembled from them stay inside the same art style.
    """
    rng = random.Random(seed)
    a = np.asarray(img.convert("RGBA"), dtype=np.float32)
    H, W = a.shape[:2]
    size = min(size, W // 3, H // 3)
    x0, y0, x1, y1 = int(region[0] * W), int(region[1] * H), int(region[2] * W), int(region[3] * H)
    cands = []
    for _ in range(900):
        x = rng.randint(x0, max(x0, x1 - size))
        y = rng.randint(y0, max(y0, y1 - size))
        win = a[y:y + size, x:x + size]
        if win.shape[0] != size or win.shape[1] != size:
            continue
        cover = float((win[..., 3] > 250).mean())
        if cover < min_cover:
            continue
        detail = float(win[..., :3].std())
        if detail < 11:
            continue
        mr, mg, mb = (float(win[..., i].mean()) for i in range(3))
        if green_bias and not (mg > mr * 1.10 and mg > mb * 0.96):
            continue
        cands.append((detail, x, y))
    if not cands:
        return [img.resize((size, size), Image.Resampling.LANCZOS)]
    cands.sort(reverse=True)
    chosen: list[tuple[int, int]] = []
    for detail, x, y in cands:
        if all((x - cx) ** 2 + (y - cy) ** 2 > (size * 0.85) ** 2 for cx, cy in chosen):
            chosen.append((x, y))
        if len(chosen) >= count:
            break
    chips = []
    for x, y in chosen:
        chip = img.crop((x, y, x + size, y + size)).convert("RGBA")
        # feather the square window into an organic blob so no seams show
        mask = Image.new("L", (size, size), 0)
        md = ImageDraw.Draw(mask)
        md.ellipse((2, 2, size - 3, size - 3), fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(size * 0.09))
        chip.putalpha(Image.fromarray(
            (np.asarray(chip.getchannel("A"), np.float32) *
             np.asarray(mask, np.float32) / 255.0).astype(np.uint8)))
        if green_bias:
            arr = np.asarray(chip, np.float32)
            arr[..., :3] = np.clip(arr[..., :3] * np.array([0.86, 1.0, 0.95]), 0, 255)
            chip = Image.fromarray(arr.astype(np.uint8), "RGBA")
        chips.append(chip)
    return chips


def _paste(base: Image.Image, chip: Image.Image, cx: float, cy: float,
           size: float, angle: float, bright: float = 1.0, flip: bool = False):
    if size < 3:
        return
    c = chip.resize((max(2, int(size)), max(2, int(size))), Image.Resampling.LANCZOS)
    if flip:
        c = c.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if bright != 1.0:
        arr = np.asarray(c, np.float32)
        arr[..., :3] = np.clip(arr[..., :3] * bright, 0, 255)
        c = Image.fromarray(arr.astype(np.uint8), "RGBA")
    c = c.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
    base.alpha_composite(c, (int(cx - c.width / 2), int(cy - c.height / 2)))


def compose_bush(chips: list[Image.Image], seed: int = 3,
                 w: int = 900, h: int = 640) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    # back-to-front mound of painted foliage
    for i in range(120):
        u = rng.random()
        ang = math.pi * (0.06 + 0.88 * rng.random())
        rad = 0.18 + 0.82 * math.sqrt(u)
        cx = w * 0.5 + math.cos(ang) * rad * w * 0.44
        cy = h * 0.94 - math.sin(ang) * rad * h * 0.80
        depth = 1.0 - (cy / h)
        size = rng.uniform(0.13, 0.25) * w * (0.80 + 0.40 * depth)
        bright = 0.52 + 0.62 * depth + rng.uniform(-0.06, 0.06)
        _paste(img, rng.choice(chips), cx, cy, size,
               rng.uniform(-35, 35), bright, rng.random() < 0.5)
    return autocrop(img, 6)


def compose_sprig(chips: list[Image.Image], seed: int = 11,
                  w: int = 800, h: int = 760) -> Image.Image:
    """Arching fronds of painted foliage - a fern-like undergrowth plant."""
    rng = random.Random(seed)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    fronds = 13
    for f in range(fronds):
        spread = (f / (fronds - 1) - 0.5) * 2.0
        bend = spread * 0.60
        length = h * rng.uniform(0.62, 0.95) * (1.0 - 0.22 * abs(spread))
        pts = []
        for s in np.linspace(0, 1, 26):
            x = w * 0.5 + bend * (s ** 1.7) * w * 0.46
            y = h * 0.98 - s * length
            pts.append((float(x), float(y)))
        for i in range(len(pts) - 1):
            wdt = max(1.5, 7.0 * (1 - i / len(pts)))
            shade = int(46 + 40 * (i / len(pts)))
            d.line([pts[i], pts[i + 1]], fill=(shade, shade + 40, shade + 12, 255), width=int(wdt))
        for i in range(2, len(pts), 2):
            s = i / len(pts)
            size = (0.15 - 0.10 * s) * w
            for side in (-1, 1):
                _paste(img, rng.choice(chips),
                       pts[i][0] + side * size * 0.34, pts[i][1],
                       size, side * (28 + 26 * s), 0.66 + 0.5 * s, side < 0)
    return autocrop(img, 6)


def compose_ground_cover(chips: list[Image.Image], seed: int = 21,
                         w: int = 1100, h: int = 420) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for i in range(95):
        cx = rng.uniform(0.04, 0.96) * w
        cy = h * (0.42 + 0.55 * rng.random() ** 0.7)
        size = rng.uniform(0.09, 0.19) * w * (0.7 + 0.6 * (cy / h))
        _paste(img, rng.choice(chips), cx, cy, size,
               rng.uniform(-40, 40), 0.55 + 0.6 * (cy / h), rng.random() < 0.5)
    return autocrop(img, 6)


def _soft_ellipse(size: int, color, softness: float = 0.35) -> Image.Image:
    y, x = np.mgrid[0:size, 0:size]
    cx = cy = (size - 1) / 2
    r = np.sqrt(((x - cx) / (size / 2)) ** 2 + ((y - cy) / (size / 2)) ** 2)
    a = np.clip((1.0 - r) / softness, 0, 1) ** 1.2
    arr = np.zeros((size, size, 4), np.uint8)
    arr[..., 0], arr[..., 1], arr[..., 2] = color
    arr[..., 3] = (a * 255).astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


def compose_flowers(chips: list[Image.Image], seed: int = 5,
                    w: int = 820, h: int = 900) -> Image.Image:
    """Wildflower cluster: painted foliage base + hand-shaded blossoms."""
    rng = random.Random(seed)
    S = 2  # supersample
    img = Image.new("RGBA", (w * S, h * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    petals = [(206, 226, 255), (244, 248, 255), (246, 206, 224), (222, 214, 255)]
    stems = []
    for i in range(11):
        base_x = w * (0.30 + 0.40 * rng.random())
        top_x = base_x + rng.uniform(-0.20, 0.20) * w
        top_y = h * rng.uniform(0.10, 0.46)
        pts = []
        for s in np.linspace(0, 1, 22):
            x = base_x + (top_x - base_x) * (s ** 1.6) + math.sin(s * 3.1 + i) * w * 0.018
            y = h * 0.99 - s * (h * 0.99 - top_y)
            pts.append((x * S, y * S))
        for k in range(len(pts) - 1):
            wdt = max(2, int((6.5 - 3.4 * k / len(pts)) * S))
            g = int(74 + 52 * k / len(pts))
            d.line([pts[k], pts[k + 1]], fill=(int(g * 0.55), g, int(g * 0.62), 255), width=wdt)
        stems.append((pts, top_x * S, top_y * S))
    # painted leaves along the lower stems
    for pts, _, _ in stems:
        for k in range(2, 12, 3):
            size = rng.uniform(0.07, 0.13) * w * S
            _paste(img, rng.choice(chips), pts[k][0], pts[k][1], size,
                   rng.uniform(-50, 50), rng.uniform(0.7, 1.05), rng.random() < 0.5)
    # blossoms
    for pts, tx, ty in stems:
        col = rng.choice(petals)
        n = rng.choice([5, 5, 6])
        pr = rng.uniform(0.030, 0.048) * w * S
        bloom = Image.new("RGBA", (int(pr * 6), int(pr * 6)), (0, 0, 0, 0))
        bc = bloom.width / 2
        for p in range(n):
            ang = 2 * math.pi * p / n + rng.uniform(-0.1, 0.1)
            petal = _soft_ellipse(int(pr * 2.1), col, 0.55)
            petal = petal.resize((int(pr * 2.3), int(pr * 1.35)), Image.Resampling.LANCZOS)
            petal = petal.rotate(math.degrees(ang), resample=Image.Resampling.BICUBIC, expand=True)
            bloom.alpha_composite(petal, (int(bc + math.cos(ang) * pr * 0.85 - petal.width / 2),
                                          int(bc + math.sin(ang) * pr * 0.85 - petal.height / 2)))
        core = _soft_ellipse(int(pr * 1.25), (255, 236, 168), 0.7)
        bloom.alpha_composite(core, (int(bc - core.width / 2), int(bc - core.height / 2)))
        img.alpha_composite(bloom, (int(tx - bc), int(ty - bc)))
    img = img.resize((w, h), Image.Resampling.LANCZOS)
    return autocrop(img, 6)


def compose_pebbles(chips: list[Image.Image], seed: int = 9,
                    w: int = 1000, h: int = 460) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for i in range(22):
        cx = rng.uniform(0.10, 0.90) * w
        size = rng.uniform(0.09, 0.24) * w
        cy = h * 0.92 - size * 0.34 - rng.uniform(0, 0.10) * h
        _paste(img, rng.choice(chips), cx, cy, size,
               rng.uniform(-25, 25), rng.uniform(0.72, 1.12), rng.random() < 0.5)
    return autocrop(img, 6)


def grass_clump(src: Image.Image, x0: float, x1: float, mirror: bool = False) -> Image.Image:
    w, h = src.size
    crop = src.crop((int(x0 * w), 0, int(x1 * w), h))
    # soften the vertical cut so the clump reads as its own plant
    a = np.asarray(crop.getchannel("A"), np.float32)
    ramp = np.ones_like(a)
    fade = max(2, int(crop.width * 0.10))
    ramp[:, :fade] *= np.linspace(0, 1, fade)[None, :]
    ramp[:, -fade:] *= np.linspace(1, 0, fade)[None, :]
    crop.putalpha(Image.fromarray((a * ramp).astype(np.uint8)))
    if mirror:
        crop = crop.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    return autocrop(crop, 4)


# --------------------------------------------------------------------------
# publishing
# --------------------------------------------------------------------------

@dataclass
class Asset:
    id: str
    name: str
    style: str
    layer: str
    category: str
    image: Image.Image
    themes: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    origin: str = "painted"
    depth: float = 0.5
    ground: float = 1.0
    default_scale: float = 0.4
    animations: list[str] = field(default_factory=list)
    rig: dict = field(default_factory=dict)
    variants: list[str] = field(default_factory=list)
    notes: str = ""
    max_dim: int = 1200
    quality: int = 90


class Publisher:
    def __init__(self, out: str):
        self.out = out
        self.entries: list[dict] = []
        os.makedirs(out, exist_ok=True)

    def publish(self, a: Asset) -> dict:
        img = fit(a.image, a.max_dim)
        folder = os.path.join(self.out, a.style)
        os.makedirs(os.path.join(folder, "thumbs"), exist_ok=True)
        fname = a.id.split(".")[-1] + ".webp"
        rel = f"{a.style}/{fname}"
        img.save(os.path.join(self.out, rel), "WEBP", quality=a.quality, method=6, exact=True)
        thumb = fit(img.copy(), 256)
        thumb.save(os.path.join(folder, "thumbs", fname), "WEBP", quality=82, method=6, exact=True)
        alpha = img.getchannel("A")
        has_alpha = alpha.getextrema()[0] < 250
        entry = {
            "id": a.id,
            "name": a.name,
            "style": a.style,
            "layer": a.layer,
            "category": a.category,
            "themes": a.themes,
            "tags": a.tags,
            "origin": a.origin,
            "file": rel,
            "thumb": f"{a.style}/thumbs/{fname}",
            "format": "image/webp",
            "width": img.width,
            "height": img.height,
            "alpha": has_alpha,
            "depth": a.depth,
            "groundContact": a.ground,
            "perspective": "eye-level",
            "lighting": "upper-left",
            "palette": dominant_palette(img),
            "defaultScale": a.default_scale,
            "placement": {"grounded": a.layer != "background", "minDepth": 0.15, "maxDepth": 0.9},
            "animations": a.animations,
            "rig": a.rig,
            "variants": a.variants,
            "notes": a.notes,
            "bytes": os.path.getsize(os.path.join(self.out, rel)),
        }
        self.entries.append(entry)
        return entry


def load_bg(path: str) -> Image.Image:
    return Image.open(path).convert("RGB").convert("RGBA")


def load_obj(path: str) -> Image.Image:
    return autocrop(key_magenta(Image.open(path)))


def publish_garden_structures(p: Publisher, src: str, style: str, label: str, transform=None):
    """Publish individually placeable garden features, with matching palette siblings."""
    folder = os.path.join(src, "style-fantasy")
    seasonal = ["night"] if style == "moonlit" else (["autumn"] if style == "autumn" else [])
    for aid, filename, name, themes, tags, scale, notes in [
        ("fairy-mushroom-cottage", "mid-fairy-mushroom-cottage.png", "Fairy Mushroom Cottage",
         ["fairy", "forest"], ["fairy", "mushroom", "cottage", "woodland"], 0.38,
         "A detailed mushroom-roof cottage with painted warm windows; independently placeable."),
        ("japanese-garden-bridge", "mid-japanese-garden-bridge.png", "Japanese-Inspired Garden Bridge",
         ["japanese", "garden", "water"], ["japanese", "bridge", "garden", "wood"], 0.30,
         "An arched timber garden bridge with transparent openings between its rails."),
        ("norse-stone-well", "mid-norse-stone-well.png", "Norse-Inspired Stone Well",
         ["norse", "forest", "garden"], ["norse", "well", "stone", "wood"], 0.32,
         "A carved wooden well with a mossy stone base; independently placeable."),
    ]:
        image = autocrop(key_magenta(Image.open(os.path.join(folder, filename)), lo=20, hi=100))
        p.publish(Asset(f"{style}.middle.{aid}", f"{label}{name}", style, "middle", "decorations",
                        grade(image, transform) if transform else image,
                        origin="graded" if transform else "painted", themes=themes + seasonal,
                        tags=tags, depth=0.56, default_scale=scale, animations=[], rig={},
                        notes=notes, max_dim=1400))


def publish_new_blooms(p: Publisher, src: str, style: str, label: str, transform=None):
    """Publish high-detail, independently placeable flowers in each look."""
    folder = os.path.join(src, "style-fantasy")
    seasonal = ["night"] if style == "moonlit" else (["autumn"] if style == "autumn" else [])
    bend = {"type": "bend", "anchor": [0.5, 1.0], "stiffness": 0.18, "gusts": 4}
    for aid, name, themes, tags, scale in [
        ("scarlet-dahlias", "Scarlet Dahlias", ["garden", "meadow"], ["dahlia", "red", "flower", "botanical", "close-up"], 0.33),
        ("golden-sunflowers", "Golden Sunflowers", ["garden", "meadow"], ["sunflower", "yellow", "flower", "botanical", "close-up"], 0.36),
        ("white-orchids", "White Moth Orchids", ["garden", "meditation"], ["orchid", "white", "flower", "botanical", "close-up"], 0.34),
        ("tulips", "Garden Tulips", ["garden", "meadow"], ["tulip", "red", "yellow", "flower", "botanical", "close-up"], 0.33),
        ("daffodils", "Daffodils", ["garden", "meadow"], ["daffodil", "yellow", "spring", "flower", "botanical", "close-up"], 0.33),
        ("cosmos", "Cosmos Spray", ["garden", "meadow"], ["cosmos", "pink", "flower", "botanical", "close-up"], 0.30),
    ]:
        # Blue rather than magenta key preserves the saturated scarlet petals
        # and the soft pink in the orchid's throat.
        image = clean_edges(autocrop(key_blue(Image.open(os.path.join(folder, f"fg-{aid}.png")))))
        p.publish(Asset(f"{style}.foreground.{aid}", f"{label}{name}", style, "foreground", "flowers",
                        grade(image, transform) if transform else image,
                        origin="graded" if transform else "painted", themes=themes + seasonal,
                        tags=tags, depth=0.91, default_scale=scale, animations=["stem-bend"], rig=bend,
                        notes="Detailed painted flowers for close-up use; stem bending is optional.",
                        max_dim=1600, quality=95))


def publish_creatures(p: Publisher, src: str, style: str, label: str, transform=None):
    """Publish independently placeable animals, each with its own motion."""
    folder = os.path.join(src, "style-fantasy")
    seasonal = ["night"] if style == "moonlit" else (["autumn"] if style == "autumn" else [])
    for aid, name, layer, themes, tags, scale, anim, notes in [
        ("white-stag", "White Stag", "middle", ["forest", "meadow", "fairy"],
         ["stag", "deer", "animal", "wildlife", "woodland"], 0.40, "creature-breathe",
         "A pale forest stag; breathing and a slow weight shift are optional."),
        ("red-fox", "Red Fox", "foreground", ["forest", "meadow"],
         ["fox", "animal", "wildlife", "woodland"], 0.30, "creature-breathe",
         "A sitting red fox; breathing and a slow weight shift are optional."),
        ("mute-swans", "Mute Swans", "middle", ["water", "garden"],
         ["swan", "bird", "animal", "water", "wildlife"], 0.42, "swim",
         "A pair of swans with their reflections; drifting on the current is optional."),
        ("koi-fish", "Koi Fish", "foreground", ["water", "garden", "japanese", "chinese"],
         ["koi", "fish", "animal", "pond", "water"], 0.34, "swim",
         "Koi seen from above; place them over water. Swimming is optional."),
        ("butterflies", "Butterflies", "foreground", ["meadow", "garden"],
         ["butterfly", "insect", "animal", "wildlife", "swarm"], 0.26, "flutter",
         "A loose group of butterflies in flight. Fluttering is optional."),
        ("great-owl", "Great Owl", "middle", ["forest", "fairy"],
         ["owl", "bird", "animal", "wildlife", "nocturnal"], 0.30, "creature-breathe",
         "A perched owl; breathing and a slow weight shift are optional."),
        ("rabbit", "Brown Rabbit", "foreground", ["meadow", "forest"],
         ["rabbit", "bunny", "animal", "wildlife"], 0.22, "creature-breathe",
         "A rabbit listening in the grass; breathing is optional."),
        ("red-squirrel", "Red Squirrel", "foreground", ["forest", "meadow"],
         ["squirrel", "animal", "wildlife", "woodland"], 0.22, "creature-breathe",
         "An alert red squirrel; breathing is optional."),
        ("mallard-ducks", "Mallard Ducks", "middle", ["water", "garden"],
         ["duck", "mallard", "bird", "animal", "water"], 0.34, "swim",
         "A drake and a hen; drifting on the current is optional."),
        ("hedgehog", "Hedgehog", "foreground", ["forest", "garden"],
         ["hedgehog", "animal", "wildlife", "woodland"], 0.18, "creature-breathe",
         "A hedgehog in the grass; breathing is optional."),
        ("deer-fawn", "Deer Fawn", "middle", ["forest", "meadow"],
         ["fawn", "deer", "animal", "wildlife", "young"], 0.32, "creature-breathe",
         "A fawn lying in long grass; breathing is optional."),
        ("moor-frog", "Moor Frog", "foreground", ["water", "garden"],
         ["frog", "amphibian", "animal", "pond", "wildlife"], 0.16, "creature-breathe",
         "A pond frog; breathing is optional."),
        ("songbird-flock", "Songbird Flock", "middle", ["forest", "meadow", "water", "garden"],
         ["birds", "flock", "flight", "animal", "sky"], 0.30, "flutter",
         "A scattered flock in flight; wing beats and drift are optional."),
    ]:
        # Blue key: every one of these subjects is warm or white, so a blue
        # backdrop separates cleanly without eating into fur, feathers or scales.
        plate = Image.open(os.path.join(folder, f"{'mid' if layer == 'middle' else 'fg'}-{aid}.png"))
        image = clean_edges(autocrop(key_blue(plate)))
        # Birds painted against an open sky key to a haze rather than to edges.
        if aid == "songbird-flock":
            image = crisp_alpha(image)
        p.publish(Asset(f"{style}.{layer}.{aid}", f"{label}{name}", style, layer, "creatures",
                        grade(image, transform) if transform else image,
                        origin="graded" if transform else "painted", themes=themes + seasonal,
                        tags=tags, depth=0.88 if layer == "foreground" else 0.60,
                        default_scale=scale, animations=[anim], rig={}, notes=notes,
                        max_dim=1500, quality=94))


def build(src: str, out: str) -> dict:
    p = Publisher(out)
    S = os.path.join(src, "style-fantasy")

    print("keying + refining painted plates ...")
    bg_lake = fit(load_bg(f"{S}/bg-enchanted-lake.png"), 1920)
    bg_glade = fit(load_bg(f"{S}/bg-moonlit-glade.png"), 1920)
    bg_high = fit(load_bg(f"{S}/bg-crystal-highlands.png"), 1920)
    bg_hollow = fit(load_bg(f"{S}/bg-forest-hollow.png"), 1920)
    bg_autumn = fit(load_bg(f"{S}/bg-autumn-river.png"), 1920)
    bg_fairy = fit(load_bg(f"{S}/bg-fairy-court.png"), 1920)
    bg_norse = fit(load_bg(f"{S}/bg-norse-worldtree.png"), 1920)
    bg_chinese = fit(load_bg(f"{S}/bg-chinese-mist-mountains.png"), 1920)
    bg_japanese = fit(load_bg(f"{S}/bg-japanese-moon-garden.png"), 1920)
    bg_observatory = fit(load_bg(f"{S}/bg-celestial-observatory.png"), 1920)
    bg_waterside = fit(load_bg(f"{S}/bg-mythic-waterside.png"), 1920)
    bg_lotus = fit(load_bg(f"{S}/bg-lotus-sanctuary.png"), 1920)
    lotus_pavilion = autocrop(key_magenta(Image.open(f"{S}/mid-lotus-meditation-pavilion.png"), lo=20, hi=100))
    lotus_flowers = autocrop(key_blue(Image.open(f"{S}/fg-lotus-flowers.png")))
    moon_gate = autocrop(key_magenta(Image.open(f"{S}/mid-chinese-moon-gate.png"), lo=20, hi=100))
    stone_lantern = autocrop(key_magenta(Image.open(f"{S}/mid-japanese-stone-lantern.png"), lo=20, hi=100))
    dragon_boat = autocrop(boat_waterline(key_magenta(Image.open(f"{S}/mid-norse-dragon-boat.png"), lo=20, hi=100)))
    # These plates have slightly desaturated magenta at their edges.
    lantern_bridge = autocrop(key_magenta(Image.open(f"{S}/mid-lantern-bridge.png"), lo=20, hi=100))
    river_reeds = autocrop(key_magenta(Image.open(f"{S}/fg-river-reeds.png"), lo=20, hi=100))
    celestial_arch = load_obj(f"{S}/mid-celestial-ruins.png")
    # This painted plate's backdrop is less saturated near its edges; a
    # tighter key removes that spill without leaving a translucent rectangle.
    starflowers = autocrop(key_magenta(Image.open(f"{S}/fg-starflowers.png"), lo=20, hi=80))
    foxgloves = autocrop(key_magenta(Image.open(f"{S}/fg-woodland-foxgloves.png"), lo=20, hi=80))
    wild_roses = load_obj(f"{S}/fg-wild-roses.png")
    anemones = autocrop(key_magenta(Image.open(f"{S}/fg-woodland-anemones.png"), lo=20, hi=100))
    # Blue studio plates preserve the saturated red and pink petals that a
    # magenta key would mistakenly erase.
    poppies = autocrop(key_blue(Image.open(f"{S}/fg-wild-poppies.png")))
    peonies = autocrop(key_blue(Image.open(f"{S}/fg-rose-peonies.png")))
    irises = autocrop(key_blue(Image.open(f"{S}/fg-golden-irises.png")))
    oak = load_obj(f"{S}/mid-ancient-oak.png")
    willow = load_obj(f"{S}/mid-willow-tree.png")
    bridge = load_obj(f"{S}/mid-stone-bridge.png")
    pavilion = load_obj(f"{S}/mid-garden-pavilion.png")
    boulders = load_obj(f"{S}/mid-mossy-boulders.png")
    waterfall = load_obj(f"{S}/mid-waterfall.png")
    lounge_window = load_obj(f"{S}/fg-lounge-window.png")
    room_hearth = load_obj(f"{S}/fg-room-hearth-nook.png")
    room_window_seat = load_obj(f"{S}/fg-room-window-seat.png")
    stone_fireplace = autocrop(key_magenta(Image.open(f"{S}/fg-stone-fireplace.png"), lo=20, hi=100))
    coffee_cup = autocrop(key_magenta(Image.open(f"{S}/fg-coffee-cup.png"), lo=20, hi=100))
    modern_room = load_obj(f"{S}/fg-room-modern-penthouse.png")
    future_room = load_obj(f"{S}/fg-room-future-observatory.png")
    modern_sofa = load_obj(f"{S}/fg-modern-sectional.png")
    future_chair = load_obj(f"{S}/fg-future-lounge-chair.png")
    modern_fireplace = load_obj(f"{S}/fg-modern-fireplace.png")
    timber_room = load_obj(f"{S}/fg-room-timber-greatroom.png")
    oak_lounge = load_obj(f"{S}/fg-room-oak-window-lounge.png")
    brick_timber_room = load_obj(f"{S}/fg-room-asymmetric-brick-timber.png")
    oak_door = load_obj(f"{S}/fg-contemporary-oak-door.png")
    oak_chair = load_obj(f"{S}/fg-contemporary-oak-chair.png")
    oak_table = load_obj(f"{S}/fg-contemporary-oak-table.png")
    oak_bookshelf = load_obj(f"{S}/fg-oak-bookshelf.png")
    indoor_plant = load_obj(f"{S}/fg-indoor-plant.png")
    oak_floor_lamp = load_obj(f"{S}/fg-oak-floor-lamp.png")
    fairy_mushrooms = load_obj(f"{S}/fg-fae-mushroom-cluster.png")
    norse_frost_pine = load_obj(f"{S}/fg-norse-frost-pine.png")
    chinese_peach = load_obj(f"{S}/fg-chinese-peach-blossoms.png")
    japanese_moon_moss = load_obj(f"{S}/fg-japanese-moon-moss.png")
    fairy_tree = load_obj(f"{S}/mid-fairy-tree.png")
    norse_stones = load_obj(f"{S}/mid-norse-rune-stones.png")
    chinese_pavilion = load_obj(f"{S}/mid-chinese-pavilion.png")
    japanese_torii = load_obj(f"{S}/mid-japanese-torii-gate.png")
    grass = load_obj(f"{S}/fg-grass-tuft.png")

    canopy = {"type": "canopy", "anchor": [0.5, 1.0], "canopyStart": 0.66,
              "stiffness": 0.72, "gusts": 3}
    bend = {"type": "bend", "anchor": [0.5, 1.0], "stiffness": 0.18, "gusts": 4}
    fall = {"type": "fall", "region": [0.16, 0.10, 0.68, 0.85], "speed": 1.0}

    # Three matching layers from original celestial observatory plates.
    # Publish each palette together so its visual identity survives style changes.
    def publish_observatory(style: str, label: str, transform=None):
        def plate(img):
            return grade(img, transform) if transform else img

        origin = "graded" if transform else "painted"
        seasonal = ["night"] if style == "moonlit" else (["autumn"] if style == "autumn" else [])
        p.publish(Asset(f"{style}.background.celestial-observatory", f"{label}Celestial Observatory Garden",
                        style, "background", "fantasy", plate(bg_observatory), origin=origin,
                        themes=["observatory", "celestial", "garden"] + seasonal,
                        tags=["background", "vista", "stars", "observatory"], depth=0.0, default_scale=1.0,
                        animations=["cloud-drift", "parallax"], rig={"type": "background"}, max_dim=1920))
        p.publish(Asset(f"{style}.middle.celestial-arch", f"{label}Celestial Astrolabe Arch",
                        style, "middle", "landmarks", plate(celestial_arch), origin=origin,
                        themes=["observatory", "celestial", "ruins"] + seasonal,
                        tags=["arch", "astrolabe", "moon", "stars"], depth=0.54, default_scale=0.43,
                        animations=[], rig={}, max_dim=1300))
        p.publish(Asset(f"{style}.foreground.starflowers", f"{label}Starflower Cluster",
                        style, "foreground", "flowers", plate(starflowers), origin=origin,
                        themes=["observatory", "celestial", "garden"] + seasonal,
                        tags=["flowers", "stars", "moss"], depth=0.89, default_scale=0.3,
                        animations=["stem-bend"], rig=bend, max_dim=1100))

    def publish_waterside(style: str, label: str, transform=None):
        def plate(img):
            return grade(img, transform) if transform else img

        origin = "graded" if transform else "painted"
        seasonal = ["autumn"] if style == "autumn" else []
        p.publish(Asset(f"{style}.background.mythic-waterside", f"{label}Moonlit Waterside",
                        style, "background", "fantasy", plate(bg_waterside), origin=origin,
                        themes=["waterside", "water", "night"] + seasonal,
                        tags=["river", "moon", "lanterns", "vista"], depth=0, default_scale=1,
                        animations=["water-shimmer", "cloud-drift", "parallax"],
                        rig={"type": "background", "region": [0.0, 0.83, 1.0, 0.17], "autoplay": True}, max_dim=1920))
        p.publish(Asset(f"{style}.middle.lantern-bridge", f"{label}Lantern Bridge",
                        style, "middle", "structures", plate(lantern_bridge), origin=origin,
                        themes=["waterside", "water", "lanterns"] + seasonal,
                        tags=["bridge", "lantern", "moon"], depth=0.52, default_scale=0.42,
                        animations=["lantern-glow"], rig={}, max_dim=1300))
        p.publish(Asset(f"{style}.foreground.river-reeds", f"{label}River Reeds",
                        style, "foreground", "plants", plate(river_reeds), origin=origin,
                        themes=["waterside", "water", "reeds"] + seasonal,
                        tags=["reeds", "cattails", "river"], depth=0.89, default_scale=0.3,
                        animations=["grass-wind"], rig=bend, max_dim=1100))

    def publish_lotus_sanctuary(style: str, label: str, transform=None):
        def plate(img):
            return grade(img, transform) if transform else img

        origin = "graded" if transform else "painted"
        seasonal = ["night"] if style == "moonlit" else (["autumn"] if style == "autumn" else [])
        p.publish(Asset(f"{style}.background.lotus-sanctuary", f"{label}Lotus Sanctuary Lake",
                        style, "background", "fantasy", plate(bg_lotus), origin=origin,
                        themes=["lotus-sanctuary", "water", "meditation", "garden"] + seasonal,
                        tags=["lake", "meditation", "mountains", "mist", "sunrise"], depth=0, default_scale=1,
                        animations=["water-shimmer", "cloud-drift", "parallax"],
                        rig={"type": "background", "region": [0.0, 0.71, 1.0, 0.29], "autoplay": True}, max_dim=1920))
        p.publish(Asset(f"{style}.middle.lotus-pavilion", f"{label}Timber Meditation Pavilion",
                        style, "middle", "structures", plate(lotus_pavilion), origin=origin,
                        themes=["lotus-sanctuary", "meditation", "garden"] + seasonal,
                        tags=["pavilion", "timber", "modern", "meditation"], depth=0.52, default_scale=0.35,
                        animations=[], rig={}, notes="Independently placeable contemporary timber pavilion.", max_dim=1400))
        p.publish(Asset(f"{style}.foreground.lotus-flowers", f"{label}Lotus Blossoms and Leaves",
                        style, "foreground", "flowers", plate(lotus_flowers), origin=origin,
                        themes=["lotus-sanctuary", "meditation", "garden"] + seasonal,
                        tags=["lotus", "pink", "flowers", "botanical", "close-up"], depth=0.9, default_scale=0.33,
                        animations=["stem-bend"], rig=bend,
                        notes="Detailed pink lotus blossoms, bud and leaves; full source detail retained.",
                        max_dim=1600, quality=95))

    def publish_cultural_details(style: str, label: str, transform=None):
        origin = "graded" if transform else "painted"
        seasonal = ["night"] if style == "moonlit" else (["autumn"] if style == "autumn" else [])
        for aid, name, image, themes, tags, scale, anims, rig, notes in [
            ("chinese-moon-gate", "Chinese-Inspired Moon Gate", moon_gate,
             ["chinese", "garden"], ["gate", "round", "stone", "garden"], 0.42, [], {},
             "A placeable moon gate with a transparent circular opening onto the scene."),
            ("japanese-stone-lantern", "Japanese-Inspired Stone Lantern", stone_lantern,
             ["japanese", "garden"], ["lantern", "stone", "moss", "light"], 0.31, ["lantern-glow"], {"autoplay": True},
             "A placeable carved garden lantern with a gently pulsing glow."),
            ("norse-dragon-boat", "Norse-Inspired Dragon Boat", dragon_boat,
             ["norse", "water"], ["boat", "dragon", "wood", "water"], 0.26, ["float"], {"autoplay": True},
             "A placeable wooden dragon boat with a transparent, wavy waterline and gentle floating motion."),
        ]:
            p.publish(Asset(f"{style}.middle.{aid}", f"{label}{name}", style, "middle", "decorations",
                            grade(image, transform) if transform else image, origin=origin,
                            themes=themes + seasonal, tags=tags, depth=0.56, default_scale=scale,
                            animations=anims, rig=rig, notes=notes, max_dim=1400))

    def publish_closeup_flowers(style: str, label: str, transform=None):
        origin = "graded" if transform else "painted"
        seasonal = ["night"] if style == "moonlit" else (["autumn"] if style == "autumn" else [])
        for aid, name, img, themes, tags, scale in [
            ("woodland-foxgloves", "Woodland Foxgloves", foxgloves, ["forest", "garden"],
             ["foxglove", "flowers", "botanical", "close-up"], 0.37),
            ("wild-roses", "Wild Rose Cluster", wild_roses, ["garden", "meadow"],
             ["rose", "flowers", "botanical", "close-up"], 0.29),
            ("woodland-anemones", "Woodland Anemones", anemones, ["forest", "meadow"],
             ["anemone", "flowers", "botanical", "close-up"], 0.32),
            ("wild-poppies", "Scarlet Wild Poppies", poppies, ["meadow", "garden"],
             ["poppy", "red", "flowers", "botanical", "close-up"], 0.33),
            ("rose-peonies", "Rose Peonies", peonies, ["garden", "blossom"],
             ["peony", "pink", "flowers", "botanical", "close-up"], 0.30),
            ("golden-irises", "Golden Irises", irises, ["garden", "water"],
             ["iris", "gold", "flowers", "botanical", "close-up"], 0.34),
        ]:
            image = grade(img, transform) if transform else img
            p.publish(Asset(f"{style}.foreground.{aid}", f"{label}{name}", style, "foreground", "flowers",
                            image, origin=origin, themes=themes + seasonal, tags=tags,
                            depth=0.91, default_scale=scale, animations=["stem-bend"], rig=bend,
                            notes="Detailed painted foreground flowers; full source resolution retained.",
                            max_dim=1600, quality=95))

    def publish_interiors(style: str, label: str, transform=None):
        def plate(img):
            return grade(img, transform) if transform else img

        origin = "graded" if transform else "painted"
        for aid, name, image, region, steam_region in [
            ("hearth-reading-room", "Hearth Reading Room", room_hearth, [0.165, 0.66, 0.085, 0.14], [0.91, 0.73, 0.045, 0.16]),
            ("window-seat-room", "Window Seat Room", room_window_seat, [0.755, 0.515, 0.10, 0.19], [0.64, 0.77, 0.045, 0.16]),
        ]:
            p.publish(Asset(f"{style}.foreground.{aid}", f"{label}{name}", style, "foreground", "interiors",
                            plate(image), origin=origin, themes=["interior", "lounge", "window", "fireplace"],
                            tags=["room", "window", "living room", "hearth"], depth=0.98, default_scale=0.82,
                            animations=["hearth-fire"], rig={"type": "window-overlay", "region": region,
                                                               "steamRegion": steam_region, "autoplay": True},
                            notes="Transparent window reveals the world; the fireplace and coffee steam animate automatically.",
                            max_dim=1400))
        for aid, name, image, themes, tags in [
            ("modern-penthouse", "Modern Penthouse View", modern_room, ["modern", "interior", "window"],
             ["modern", "penthouse", "large windows", "living room"]),
            ("future-sky-lounge", "Futuristic Sky Lounge", future_room, ["futuristic", "interior", "window"],
             ["future", "modern", "large windows", "lounge"]),
        ]:
            p.publish(Asset(f"{style}.foreground.{aid}", f"{label}{name}", style, "foreground", "interiors",
                            plate(image), origin=origin, themes=themes, tags=tags, depth=0.98, default_scale=0.82,
                            animations=[], rig={"type": "window-overlay"},
                            notes="A high-ceiling room overlay with a transparent panoramic window onto the composed world.",
                            max_dim=1400))
        p.publish(Asset(f"{style}.foreground.timber-great-room", f"{label}Contemporary Timber Great Room",
                        style, "foreground", "interiors", plate(timber_room), origin=origin,
                        themes=["interior", "window", "contemporary", "timber"],
                        tags=["modern", "wood beams", "wooden door", "tile floor", "fireplace"],
                        depth=0.98, default_scale=0.82, animations=["hearth-fire"],
                        rig={"type": "window-overlay", "region": [0.082, 0.68, 0.07, 0.10], "autoplay": True},
                        notes="Present-day tiled great room with varnished beams, an animated fireplace and a transparent window.",
                        max_dim=1400))
        p.publish(Asset(f"{style}.foreground.oak-window-lounge", f"{label}Contemporary Oak Window Lounge",
                        style, "foreground", "interiors", plate(oak_lounge), origin=origin,
                        themes=["interior", "window", "contemporary", "timber"],
                        tags=["modern", "oak beams", "wooden door", "tile floor", "lounge"],
                        depth=0.98, default_scale=0.82, animations=[], rig={"type": "window-overlay"},
                        notes="Present-day oak-beam room with tiled floor and a transparent window onto the composed world.",
                        max_dim=1400))
        p.publish(Asset(f"{style}.foreground.brick-timber-corner-room", f"{label}Asymmetric Brick and Timber Room",
                        style, "foreground", "interiors", plate(brick_timber_room), origin=origin,
                        themes=["interior", "window", "contemporary", "timber"],
                        tags=["modern", "brick", "wood beams", "slanted roof", "corner windows", "tile floor"],
                        depth=0.98, default_scale=0.82, animations=[], rig={"type": "window-overlay"},
                        notes="Asymmetric brick-and-wood room with a sloping roof and two transparent windows on adjacent walls.",
                        max_dim=1400))
        for aid, name, image, themes, tags, scale in [
            ("modern-sectional", "Modern Modular Sectional", modern_sofa, ["interior", "modern"],
             ["modern", "sofa", "furniture", "sectional"], 0.22),
            ("future-lounge-chair", "Futuristic Lounge Chair", future_chair, ["interior", "futuristic"],
             ["future", "modern", "chair", "furniture"], 0.25),
            ("contemporary-oak-door", "Contemporary Oak Door", oak_door, ["interior", "modern", "timber"],
             ["door", "wood", "oak", "modern"], 0.40),
            ("contemporary-oak-chair", "Contemporary Oak Lounge Chair", oak_chair, ["interior", "modern", "timber"],
             ["chair", "wood", "oak", "modern", "furniture"], 0.24),
            ("contemporary-oak-table", "Contemporary Oak Coffee Table", oak_table, ["interior", "modern", "timber"],
             ["table", "wood", "oak", "coffee", "furniture"], 0.16),
            ("oak-bookshelf", "Contemporary Oak Bookshelf", oak_bookshelf, ["interior", "modern", "timber"],
             ["shelves", "books", "wood", "oak", "furniture"], 0.38),
            ("indoor-fig", "Potted Fiddle-Leaf Fig", indoor_plant, ["interior", "modern", "plant"],
             ["plant", "pot", "foliage", "green", "decor"], 0.35),
            ("oak-floor-lamp", "Contemporary Oak Floor Lamp", oak_floor_lamp, ["interior", "modern", "timber"],
             ["lamp", "wood", "oak", "lighting", "decor"], 0.38),
        ]:
            p.publish(Asset(f"{style}.foreground.{aid}", f"{label}{name}", style, "foreground", "interiors",
                            plate(image), origin=origin, themes=themes, tags=tags, depth=0.99, default_scale=scale,
                            animations=[], rig={}, notes="Independent placeable contemporary interior object.", max_dim=1400))
        p.publish(Asset(f"{style}.foreground.modern-fireplace", f"{label}Modern Linear Fireplace", style,
                        "foreground", "interiors", plate(modern_fireplace), origin=origin,
                        themes=["interior", "modern", "fireplace"], tags=["modern", "fireplace", "fire", "linear"],
                        depth=0.96, default_scale=0.25, animations=["hearth-fire"],
                        rig={"type": "hearth", "region": [0.20, 0.45, 0.58, 0.25], "autoplay": True},
                        notes="Placeable contemporary fireplace with a locally animated painted fire.", max_dim=1400))
        p.publish(Asset(f"{style}.foreground.stone-fireplace", f"{label}Stone Fireplace", style,
                        "foreground", "interiors", plate(stone_fireplace), origin=origin,
                        themes=["interior", "fireplace", "hearth"], tags=["fireplace", "fire", "stone"],
                        depth=0.96, default_scale=0.35, animations=["hearth-fire"],
                        rig={"type": "hearth", "region": [0.40, 0.49, 0.20, 0.29], "autoplay": True},
                        notes="Placeable stone fireplace with a locally animated painted fire.", max_dim=1400))
        p.publish(Asset(f"{style}.foreground.coffee-cup", f"{label}Steaming Coffee Cup", style,
                        "foreground", "interiors", plate(coffee_cup), origin=origin,
                        themes=["interior", "coffee", "comfort"], tags=["cup", "coffee", "steam", "table"],
                        depth=0.99, default_scale=0.12, animations=["coffee-steam"],
                        rig={"type": "steam", "region": [0.47, 0.14, 0.40, 0.85], "autoplay": True},
                        notes="Placeable cup with soft animated steam rising from the coffee.", max_dim=1200))

    # ---------------- style: enchanted (highly detailed fantasy) ----------
    E = "enchanted"
    publish_observatory(E, "")
    publish_waterside(E, "")
    publish_lotus_sanctuary(E, "")
    publish_cultural_details(E, "")
    publish_garden_structures(p, src, E, "")
    publish_closeup_flowers(E, "")
    publish_new_blooms(p, src, E, "")
    publish_creatures(p, src, E, "")
    publish_interiors(E, "")
    # `region` marks the water so the shimmer mesh stays off the sky and the
    # foliage. Plates without one fall back to a bottom-of-frame mask.
    for aid, name, img, cat, themes, rig in [
        ("enchanted-lake", "Enchanted Lake Valley", bg_lake, "nature",
         ["forest", "water", "day"], {"type": "background"}),
        ("crystal-highlands", "Sunrise Highlands", bg_high, "fantasy",
         ["meadow", "dawn", "kingdom"], {"type": "background"}),
        ("forest-hollow", "Sunlit Forest Hollow", bg_hollow, "nature",
         ["forest", "water", "day"],
         {"type": "background", "region": [0.26, 0.56, 0.54, 0.26]}),
        ("fairy-court", "Fairy Court Glade", bg_fairy, "fantasy",
         ["fairy", "forest", "water"], {"type": "background", "region": [0.0, 0.76, 1.0, 0.24]}),
        ("norse-worldtree", "Norse Worldtree Fjord", bg_norse, "fantasy",
         ["norse", "worldtree", "night"], {"type": "background"}),
        ("chinese-mist-mountains", "Chinese-Inspired Mist Mountains", bg_chinese, "fantasy",
         ["chinese", "mountains", "mist"], {"type": "background"}),
        ("japanese-moon-garden", "Japanese Moon Garden", bg_japanese, "fantasy",
         ["japanese", "moon", "garden"], {"type": "background"}),
    ]:
        p.publish(Asset(f"{E}.background.{aid}", name, E, "background", cat, img,
                        themes=themes, tags=["background", "vista"], depth=0.0,
                        default_scale=1.0, animations=["cloud-drift", "water-shimmer", "parallax"],
                        rig=rig, max_dim=1920))

    p.publish(Asset(f"{E}.middle.ancient-oak", "Ancient Oak", E, "middle", "trees", oak,
                    themes=["forest", "enchanted"], tags=["tree", "oak", "hero"],
                    depth=0.45, default_scale=0.72,
                    animations=["canopy-sway", "leaf-shed"], rig=canopy, max_dim=1400))
    p.publish(Asset(f"{E}.middle.weeping-willow", "Weeping Willow", E, "middle", "trees", willow,
                    themes=["forest", "water"], tags=["tree", "willow"],
                    depth=0.45, default_scale=0.62,
                    animations=["canopy-sway", "leaf-shed"], rig=canopy, max_dim=1300))
    p.publish(Asset(f"{E}.middle.stone-bridge", "Mossy Stone Bridge", E, "middle", "structures", bridge,
                    themes=["garden", "water"], tags=["bridge", "structure"],
                    depth=0.5, default_scale=0.42, animations=[], rig={}, max_dim=1200))
    p.publish(Asset(f"{E}.middle.garden-pavilion", "Elven Garden Pavilion", E, "middle", "structures", pavilion,
                    themes=["garden", "kingdom"], tags=["gazebo", "structure", "lantern"],
                    depth=0.5, default_scale=0.36, animations=["lantern-glow"], rig={}, max_dim=1100))
    p.publish(Asset(f"{E}.middle.mossy-boulders", "Mossy Boulders", E, "middle", "rocks", boulders,
                    themes=["forest", "water"], tags=["rock", "stone"],
                    depth=0.6, default_scale=0.24, animations=[], rig={}, max_dim=1000))
    p.publish(Asset(f"{E}.middle.waterfall", "Grand Forest Waterfall", E, "middle", "water", waterfall,
                    themes=["water", "forest"], tags=["waterfall", "cliff", "pool", "cascade"],
                    depth=0.42, default_scale=0.66,
                    animations=["waterfall-flow", "ripple"], rig=fall, max_dim=1300))
    p.publish(Asset(f"{E}.middle.fairy-tree", "Fae Court Willow", E, "middle", "trees", fairy_tree,
                    themes=["fairy", "forest", "enchanted"], tags=["fairy", "willow", "glowing tree"],
                    depth=0.43, default_scale=0.76, animations=["canopy-sway"], rig=canopy, max_dim=1500))
    p.publish(Asset(f"{E}.middle.norse-rune-stones", "Norse-Inspired Rune Stones", E, "middle", "landmarks", norse_stones,
                    themes=["norse", "worldtree", "runes"], tags=["standing stones", "runes", "mythic landmark"],
                    depth=0.56, default_scale=0.38, animations=[], rig={}, max_dim=1200))
    p.publish(Asset(f"{E}.middle.chinese-pavilion", "Mountain Lantern Pavilion", E, "middle", "landmarks", chinese_pavilion,
                    themes=["chinese", "mountains", "lanterns"], tags=["pavilion", "lantern", "mythic landmark"],
                    depth=0.55, default_scale=0.43, animations=[], rig={}, max_dim=1300))
    p.publish(Asset(f"{E}.middle.japanese-torii", "Moon Garden Torii Gate", E, "middle", "landmarks", japanese_torii,
                    themes=["japanese", "moon", "garden"], tags=["torii", "gate", "mythic landmark"],
                    depth=0.54, default_scale=0.42, animations=[], rig={}, max_dim=1200))

    # ---------------- foreground: painted grass + derived plant assembly --
    p.publish(Asset(f"{E}.foreground.grass-tuft", "Lush Grass Tuft", E, "foreground", "grass", grass,
                    themes=["meadow", "forest"], tags=["grass", "ground"],
                    depth=0.85, default_scale=0.26, animations=["grass-wind"], rig=bend,
                    variants=[f"{E}.foreground.grass-golden", f"{E}.foreground.grass-clump"],
                    max_dim=1000))
    p.publish(Asset(f"{E}.foreground.grass-clump", "Grass Clump (narrow)", E, "foreground", "grass",
                    grass_clump(grass, 0.06, 0.52), origin="derived",
                    themes=["meadow"], tags=["grass", "small"], depth=0.88, default_scale=0.18,
                    animations=["grass-wind"], rig=bend, max_dim=800))
    p.publish(Asset(f"{E}.foreground.grass-sweep", "Grass Sweep (mirrored)", E, "foreground", "grass",
                    grass_clump(grass, 0.48, 0.98, mirror=True), origin="derived",
                    themes=["meadow"], tags=["grass", "wide"], depth=0.9, default_scale=0.3,
                    animations=["grass-wind"], rig=bend, max_dim=900))
    p.publish(Asset(f"{E}.foreground.grass-golden", "Golden Harvest Grass", E, "foreground", "grass",
                    grade(grass, autumn_grade), origin="derived",
                    themes=["autumn", "meadow"], tags=["grass", "warm"], depth=0.86,
                    default_scale=0.24, animations=["grass-wind"], rig=bend, max_dim=900))

    print("assembling plants from painted foliage chips ...")
    leaf_chips = extract_chips(oak, 16, max(64, oak.width // 8),
                               region=(0.30, 0.06, 0.96, 0.62), seed=17, green_bias=True)
    rock_chips = extract_chips(boulders, 10, max(64, boulders.width // 5),
                               region=(0.05, 0.05, 0.95, 0.95), seed=23)
    print(f"  harvested {len(leaf_chips)} foliage chips, {len(rock_chips)} rock chips")

    p.publish(Asset(f"{E}.foreground.wildflowers", "Wildflower Cluster", E, "foreground", "flowers",
                    compose_flowers(leaf_chips, seed=5), origin="composed",
                    themes=["garden", "meadow"], tags=["flowers", "blossom"], depth=0.84,
                    default_scale=0.3, animations=["stem-bend"], rig=bend, max_dim=1000))
    p.publish(Asset(f"{E}.foreground.fern-sprig", "Woodland Fern", E, "foreground", "plants",
                    compose_sprig(leaf_chips, seed=11), origin="composed",
                    themes=["forest"], tags=["fern", "undergrowth"], depth=0.86,
                    default_scale=0.28, animations=["stem-bend"], rig=bend, max_dim=950))
    p.publish(Asset(f"{E}.foreground.leafy-bush", "Leafy Bush", E, "foreground", "plants",
                    compose_bush(leaf_chips, seed=3), origin="composed",
                    themes=["forest", "garden"], tags=["bush", "shrub"], depth=0.8,
                    default_scale=0.34, animations=["grass-wind"], rig=bend, max_dim=1000))
    p.publish(Asset(f"{E}.foreground.ground-ivy", "Ground Ivy Trail", E, "foreground", "ground",
                    compose_ground_cover(leaf_chips, seed=21), origin="composed",
                    themes=["forest"], tags=["ivy", "groundcover"], depth=0.93,
                    default_scale=0.4, animations=["grass-wind"], rig=bend, max_dim=1100))
    p.publish(Asset(f"{E}.foreground.pebble-scatter", "Pebble Scatter", E, "foreground", "ground",
                    compose_pebbles(rock_chips, seed=9), origin="composed",
                    themes=["water", "path"], tags=["stones", "gravel", "ground"], depth=0.94,
                    default_scale=0.32, animations=[], rig={}, max_dim=1000))
    p.publish(Asset(f"{E}.foreground.fae-mushrooms", "Fae Lantern Mushrooms", E, "foreground", "plants", fairy_mushrooms,
                    themes=["fairy", "forest", "enchanted"], tags=["mushrooms", "glow", "woodland"],
                    depth=0.9, default_scale=0.3, animations=["grass-wind"], rig=bend, max_dim=1100))
    p.publish(Asset(f"{E}.foreground.norse-frost-pine", "Frost-Kissed Juniper", E, "foreground", "plants", norse_frost_pine,
                    themes=["norse", "night", "winter"], tags=["pine", "frost", "juniper"],
                    depth=0.9, default_scale=0.3, animations=["grass-wind"], rig=bend, max_dim=1100))
    p.publish(Asset(f"{E}.foreground.chinese-peach-blossoms", "Peach Blossom Garden Cluster", E, "foreground", "flowers", chinese_peach,
                    themes=["chinese", "garden", "flowers"], tags=["peach blossom", "flowers", "garden"],
                    depth=0.88, default_scale=0.32, animations=["stem-bend"], rig=bend, max_dim=1100))
    p.publish(Asset(f"{E}.foreground.japanese-moon-moss", "Moon Garden Moss and Sakura", E, "foreground", "flowers", japanese_moon_moss,
                    themes=["japanese", "moon", "garden"], tags=["sakura", "moss", "stepping stones"],
                    depth=0.89, default_scale=0.3, animations=["stem-bend"], rig=bend, max_dim=1100))
    p.publish(Asset(f"{E}.foreground.lounge-window", "Lounge Window View", E, "foreground", "interiors",
                    lounge_window, themes=["interior", "lounge", "window"],
                    tags=["room", "window", "living room", "view frame"], depth=0.98,
                    default_scale=0.82, animations=[], rig={"type": "window-overlay"},
                    notes="Transparent window opening reveals the current composed scene behind this foreground room overlay.",
                    max_dim=1400))

    # ---------------- style: moonlit (graded sibling collection) ----------
    M = "moonlit"
    print("building moonlit sibling collection ...")
    publish_observatory(M, "Moonlit ", night_grade)
    publish_waterside(M, "Silver ", night_grade)
    publish_lotus_sanctuary(M, "Moonlit ", night_grade)
    publish_cultural_details(M, "Moonlit ", night_grade)
    publish_garden_structures(p, src, M, "Moonlit ", night_grade)
    publish_closeup_flowers(M, "Moonlit ", night_grade)
    publish_new_blooms(p, src, M, "Moonlit ", night_grade)
    publish_creatures(p, src, M, "Moonlit ", night_grade)
    publish_interiors(M, "Moonlit ", night_grade)
    p.publish(Asset(f"{M}.background.moonlit-glade", "Moonlit Forest Glade", M, "background", "night",
                    bg_glade, themes=["night", "forest", "celestial"], tags=["moon", "night"],
                    depth=0.0, default_scale=1.0,
                    animations=["cloud-drift", "water-shimmer", "parallax"],
                    rig={"type": "background"}, max_dim=1920))
    p.publish(Asset(f"{M}.background.night-valley", "Night Lake Valley", M, "background", "night",
                    grade(bg_lake, night_grade), origin="graded",
                    themes=["night", "water"], tags=["lake", "night"], depth=0.0, default_scale=1.0,
                    animations=["cloud-drift", "water-shimmer", "parallax"],
                    rig={"type": "background"}, max_dim=1920))
    for aid, name, img, themes, tags, rig in [
        ("fairy-court", "Moonlit Fairy Court Glade", bg_fairy, ["fairy", "forest", "water", "night"],
         ["background", "vista", "fairy", "night"], {"type": "background", "region": [0.0, 0.76, 1.0, 0.24]}),
        ("norse-worldtree", "Moonlit Norse Worldtree Fjord", bg_norse, ["norse", "worldtree", "night"],
         ["background", "vista", "norse", "night"], {"type": "background"}),
        ("chinese-mist-mountains", "Moonlit Chinese-Inspired Mist Mountains", bg_chinese, ["chinese", "mountains", "mist", "night"],
         ["background", "vista", "chinese", "night"], {"type": "background"}),
        ("japanese-moon-garden", "Moonlit Japanese Moon Garden", bg_japanese, ["japanese", "moon", "garden", "night"],
         ["background", "vista", "japanese", "night"], {"type": "background"}),
    ]:
        p.publish(Asset(f"{M}.background.{aid}", name, M, "background", "fantasy", grade(img, night_grade),
                        origin="graded", themes=themes, tags=tags, depth=0.0, default_scale=1.0,
                        animations=["cloud-drift", "parallax"] + (["water-shimmer"] if "water" in themes else []),
                        rig=rig, max_dim=1920))
    for aid, name, img, cat, scale, anims, rig in [
        ("silver-oak", "Silver Oak", oak, "trees", 0.72, ["canopy-sway", "leaf-shed"], canopy),
        ("night-pavilion", "Lantern Pavilion", pavilion, "structures", 0.36, ["lantern-glow"], {}),
        ("dark-boulders", "Moonlit Boulders", boulders, "rocks", 0.24, [], {}),
        ("moonlit-waterfall", "Moonlit Waterfall", waterfall, "water", 0.66, ["waterfall-flow", "ripple"], fall),
    ]:
        p.publish(Asset(f"{M}.middle.{aid}", name, M, "middle", cat, grade(img, night_grade),
                        origin="graded", themes=["night", "forest"] + (["water"] if cat == "water" else []),
                        tags=[cat, "night"] + (["waterfall", "cascade"] if cat == "water" else []),
                        depth=0.45, default_scale=scale, animations=anims, rig=rig, max_dim=1300))
    for aid, name, img, cat, scale, themes, tags, anims, rig in [
        ("fairy-tree", "Moonlit Fae Court Willow", fairy_tree, "trees", 0.76,
         ["fairy", "forest", "enchanted", "night"], ["fairy", "willow", "night"], ["canopy-sway"], canopy),
        ("norse-rune-stones", "Moonlit Norse Rune Stones", norse_stones, "landmarks", 0.38,
         ["norse", "worldtree", "runes", "night"], ["standing stones", "runes", "night"], [], {}),
        ("chinese-pavilion", "Moonlit Mountain Lantern Pavilion", chinese_pavilion, "landmarks", 0.43,
         ["chinese", "mountains", "lanterns", "night"], ["pavilion", "lantern", "night"], [], {}),
        ("japanese-torii", "Moonlit Moon Garden Torii Gate", japanese_torii, "landmarks", 0.42,
         ["japanese", "moon", "garden", "night"], ["torii", "gate", "night"], [], {}),
    ]:
        p.publish(Asset(f"{M}.middle.{aid}", name, M, "middle", cat, grade(img, night_grade),
                        origin="graded", themes=themes, tags=tags, depth=0.54, default_scale=scale,
                        animations=anims, rig=rig, max_dim=1400))
    for aid, name, img, cat, scale in [
        ("night-grass", "Moonlit Grass", grass, "grass", 0.26),
        ("night-fern", "Night Fern", compose_sprig(leaf_chips, seed=31), "plants", 0.28),
        ("night-bush", "Shadow Bush", compose_bush(leaf_chips, seed=41), "plants", 0.34),
    ]:
        p.publish(Asset(f"{M}.foreground.{aid}", name, M, "foreground", cat, grade(img, night_grade),
                        origin="graded", themes=["night"], tags=[cat, "night"], depth=0.86,
                        default_scale=scale, animations=["grass-wind"], rig=bend, max_dim=1000))
    for aid, name, img, cat, scale, themes, tags, anim in [
        ("fae-mushrooms", "Moonlit Fae Lantern Mushrooms", fairy_mushrooms, "plants", 0.3,
         ["fairy", "forest", "enchanted", "night"], ["mushrooms", "glow", "night"], "grass-wind"),
        ("norse-frost-pine", "Moonlit Frost-Kissed Juniper", norse_frost_pine, "plants", 0.3,
         ["norse", "night", "winter"], ["pine", "frost", "night"], "grass-wind"),
        ("chinese-peach-blossoms", "Moonlit Peach Blossom Garden Cluster", chinese_peach, "flowers", 0.32,
         ["chinese", "garden", "flowers", "night"], ["peach blossom", "flowers", "night"], "stem-bend"),
        ("japanese-moon-moss", "Moonlit Garden Moss and Sakura", japanese_moon_moss, "flowers", 0.3,
         ["japanese", "moon", "garden", "night"], ["sakura", "moss", "night"], "stem-bend"),
    ]:
        p.publish(Asset(f"{M}.foreground.{aid}", name, M, "foreground", cat, grade(img, night_grade),
                        origin="graded", themes=themes, tags=tags, depth=0.89, default_scale=scale,
                        animations=[anim], rig=bend, max_dim=1200))
    p.publish(Asset(f"{M}.foreground.lounge-window", "Moonlit Lounge Window View", M, "foreground", "interiors",
                    grade(lounge_window, night_grade), origin="graded",
                    themes=["interior", "lounge", "window", "night"],
                    tags=["room", "window", "living room", "view frame", "night"], depth=0.98,
                    default_scale=0.82, animations=[], rig={"type": "window-overlay"},
                    notes="Transparent window opening reveals the current composed scene behind this foreground room overlay.",
                    max_dim=1400))

    # ---------------- style: autumn (graded sibling collection) -------------
    A = "autumn"
    print("building autumn sibling collection ...")
    publish_observatory(A, "Autumn ", autumn_foliage)
    publish_waterside(A, "Autumn ", autumn_foliage)
    publish_lotus_sanctuary(A, "Autumn ", autumn_foliage)
    publish_cultural_details(A, "Autumn ", autumn_foliage)
    publish_garden_structures(p, src, A, "Autumn ", autumn_foliage)
    publish_closeup_flowers(A, "Autumn ", autumn_foliage)
    publish_new_blooms(p, src, A, "Autumn ", autumn_foliage)
    publish_creatures(p, src, A, "Autumn ", autumn_foliage)
    publish_interiors(A, "Autumn ", autumn_foliage)
    autumn_rig = {"type": "background", "region": [0.0, 0.68, 1.0, 0.32]}
    p.publish(Asset(f"{A}.background.autumn-river", "Autumn River Valley", A, "background", "nature",
                    bg_autumn, themes=["forest", "water", "autumn", "day"],
                    tags=["background", "vista", "river"], depth=0.0, default_scale=1.0,
                    animations=["cloud-drift", "water-shimmer", "parallax"],
                    rig=autumn_rig, max_dim=1920))
    p.publish(Asset(f"{A}.background.harvest-hollow", "Harvest Woodland Hollow", A, "background", "nature",
                    grade(bg_hollow, autumn_foliage), origin="graded",
                    themes=["forest", "autumn", "day"], tags=["background", "vista", "forest"],
                    depth=0.0, default_scale=1.0,
                    animations=["cloud-drift", "water-shimmer", "parallax"],
                    rig={"type": "background", "region": [0.26, 0.56, 0.54, 0.26]}, max_dim=1920))
    for aid, name, img, themes, tags, rig in [
        ("fairy-court", "Autumn Fairy Court Glade", bg_fairy, ["fairy", "forest", "water", "autumn"],
         ["background", "vista", "fairy", "autumn"], {"type": "background", "region": [0.0, 0.76, 1.0, 0.24]}),
        ("norse-worldtree", "Autumn Norse Worldtree Fjord", bg_norse, ["norse", "worldtree", "autumn"],
         ["background", "vista", "norse", "autumn"], {"type": "background"}),
        ("chinese-mist-mountains", "Autumn Chinese-Inspired Mist Mountains", bg_chinese, ["chinese", "mountains", "mist", "autumn"],
         ["background", "vista", "chinese", "autumn"], {"type": "background"}),
        ("japanese-moon-garden", "Autumn Japanese Moon Garden", bg_japanese, ["japanese", "moon", "garden", "autumn"],
         ["background", "vista", "japanese", "autumn"], {"type": "background"}),
    ]:
        p.publish(Asset(f"{A}.background.{aid}", name, A, "background", "fantasy", grade(img, autumn_foliage),
                        origin="graded", themes=themes, tags=tags, depth=0.0, default_scale=1.0,
                        animations=["cloud-drift", "parallax"] + (["water-shimmer"] if "water" in themes else []),
                        rig=rig, max_dim=1920))
    for aid, name, img, cat, scale, anims, rig in [
        ("amber-oak", "Amber Oak", oak, "trees", 0.72, ["canopy-sway", "leaf-shed"], canopy),
        ("copper-willow", "Copper Willow", willow, "trees", 0.66, ["canopy-sway"], canopy),
        ("harvest-bridge", "Harvest Stone Bridge", bridge, "structures", 0.5, [], {}),
        ("autumn-boulders", "Autumn Boulders", boulders, "rocks", 0.24, [], {}),
        ("autumn-waterfall", "Autumn Waterfall", waterfall, "water", 0.66, ["waterfall-flow", "ripple"], fall),
    ]:
        p.publish(Asset(f"{A}.middle.{aid}", name, A, "middle", cat, grade(img, autumn_foliage),
                        origin="graded", themes=["forest", "autumn"] + (["water"] if cat == "water" else []),
                        tags=[cat, "autumn"] + (["waterfall", "cascade"] if cat == "water" else []),
                        depth=0.45, default_scale=scale, animations=anims, rig=rig, max_dim=1300))
    for aid, name, img, cat, scale, themes, tags, anims, rig in [
        ("fairy-tree", "Autumn Fae Court Willow", fairy_tree, "trees", 0.76,
         ["fairy", "forest", "enchanted", "autumn"], ["fairy", "willow", "autumn"], ["canopy-sway"], canopy),
        ("norse-rune-stones", "Autumn Norse Rune Stones", norse_stones, "landmarks", 0.38,
         ["norse", "worldtree", "runes", "autumn"], ["standing stones", "runes", "autumn"], [], {}),
        ("chinese-pavilion", "Autumn Mountain Lantern Pavilion", chinese_pavilion, "landmarks", 0.43,
         ["chinese", "mountains", "lanterns", "autumn"], ["pavilion", "lantern", "autumn"], [], {}),
        ("japanese-torii", "Autumn Moon Garden Torii Gate", japanese_torii, "landmarks", 0.42,
         ["japanese", "moon", "garden", "autumn"], ["torii", "gate", "autumn"], [], {}),
    ]:
        p.publish(Asset(f"{A}.middle.{aid}", name, A, "middle", cat, grade(img, autumn_foliage),
                        origin="graded", themes=themes, tags=tags, depth=0.54, default_scale=scale,
                        animations=anims, rig=rig, max_dim=1400))
    for aid, name, img, cat, scale, anims in [
        ("autumn-grass", "Autumn Grass", grass, "grass", 0.26, ["grass-wind"]),
        ("autumn-fern", "Bracken Fern", compose_sprig(leaf_chips, seed=11), "plants", 0.28, ["stem-bend"]),
        ("autumn-bush", "Copper Bush", compose_bush(leaf_chips, seed=3), "plants", 0.34, ["grass-wind"]),
        ("fallen-ivy", "Fallen Ivy Trail", compose_ground_cover(leaf_chips, seed=21), "ground", 0.4, ["grass-wind"]),
    ]:
        p.publish(Asset(f"{A}.foreground.{aid}", name, A, "foreground", cat, grade(img, autumn_foliage),
                        origin="graded", themes=["autumn", "forest"], tags=[cat, "autumn"], depth=0.86,
                        default_scale=scale, animations=anims, rig=bend, max_dim=1000))
    for aid, name, img, cat, scale, themes, tags, anim in [
        ("fae-mushrooms", "Autumn Fae Lantern Mushrooms", fairy_mushrooms, "plants", 0.3,
         ["fairy", "forest", "enchanted", "autumn"], ["mushrooms", "glow", "autumn"], "grass-wind"),
        ("norse-frost-pine", "Autumn Frost-Kissed Juniper", norse_frost_pine, "plants", 0.3,
         ["norse", "autumn", "winter"], ["pine", "frost", "autumn"], "grass-wind"),
        ("chinese-peach-blossoms", "Autumn Peach Blossom Garden Cluster", chinese_peach, "flowers", 0.32,
         ["chinese", "garden", "flowers", "autumn"], ["peach blossom", "flowers", "autumn"], "stem-bend"),
        ("japanese-moon-moss", "Autumn Garden Moss and Sakura", japanese_moon_moss, "flowers", 0.3,
         ["japanese", "moon", "garden", "autumn"], ["sakura", "moss", "autumn"], "stem-bend"),
    ]:
        p.publish(Asset(f"{A}.foreground.{aid}", name, A, "foreground", cat, grade(img, autumn_foliage),
                        origin="graded", themes=themes, tags=tags, depth=0.89, default_scale=scale,
                        animations=[anim], rig=bend, max_dim=1200))
    p.publish(Asset(f"{A}.foreground.autumn-pebbles", "Autumn Pebble Scatter", A, "foreground", "ground",
                    grade(compose_pebbles(rock_chips, seed=9), autumn_foliage), origin="graded",
                    themes=["water", "path", "autumn"], tags=["stones", "ground"], depth=0.94,
                    default_scale=0.32, animations=[], rig={}, max_dim=1000))
    p.publish(Asset(f"{A}.foreground.lounge-window", "Harvest Lounge Window View", A, "foreground", "interiors",
                    grade(lounge_window, autumn_foliage), origin="graded",
                    themes=["interior", "lounge", "window", "autumn"],
                    tags=["room", "window", "living room", "view frame", "autumn"], depth=0.98,
                    default_scale=0.82, animations=[], rig={"type": "window-overlay"},
                    notes="Transparent window opening reveals the current composed scene behind this foreground room overlay.",
                    max_dim=1400))

    # ---------------- style registry --------------------------------------
    styles = [
        {
            "id": E,
            "name": "Enchanted Realms",
            "subtitle": "Highly detailed fantasy",
            "description": "Rich painterly fantasy artwork: emerald and teal foliage, warm amber "
                           "key light from the upper left, crisp silhouettes and detailed texture.",
            "swatches": ["#123a2e", "#2f7d55", "#8fc27a", "#e8c07a", "#f6e7c6"],
            "lighting": "upper-left",
            "reference": {
                "background": f"{E}.background.enchanted-lake",
                "tree": f"{E}.middle.ancient-oak",
                "structure": f"{E}.middle.garden-pavilion",
                "plant": f"{E}.foreground.wildflowers",
                "ground": f"{E}.foreground.pebble-scatter",
            },
            "complete": True,
        },
        {
            "id": M,
            "name": "Moonlit Reverie",
            "subtitle": "Nocturnal fantasy",
            "description": "The same painting technique art-directed for night: cool silver-blue "
                           "key light, deep indigo shadows and reduced saturation. Every asset in "
                           "this collection is graded identically so the scene stays coherent.",
            "swatches": ["#0a1430", "#1d3a63", "#4f7fae", "#9fc4e8", "#e6f0ff"],
            "lighting": "upper-right",
            "reference": {
                "background": f"{M}.background.moonlit-glade",
                "tree": f"{M}.middle.silver-oak",
                "structure": f"{M}.middle.night-pavilion",
                "plant": f"{M}.foreground.night-fern",
                "ground": f"{M}.foreground.night-grass",
            },
            "complete": True,
        },
        {
            "id": A,
            "name": "Harvest Season",
            "subtitle": "Autumnal fantasy",
            "description": "The same painterly technique art-directed for autumn: foliage shifted "
                           "to amber, copper and rust while stone, bark and water keep their "
                           "natural colour, under the same warm upper-left key light.",
            "swatches": ["#3a2412", "#7d4a1e", "#c8862f", "#e8b45c", "#f7e3bd"],
            "lighting": "upper-left",
            "reference": {
                "background": f"{A}.background.autumn-river",
                "tree": f"{A}.middle.amber-oak",
                "structure": f"{A}.middle.harvest-bridge",
                "plant": f"{A}.foreground.autumn-fern",
                "ground": f"{A}.foreground.autumn-grass",
            },
            "complete": True,
        },
    ]

    manifest = {
        "schema": "imago.asset-library/1",
        "generatedBy": "tools/prepare_assets.py",
        "styles": styles,
        "assets": p.entries,
    }
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)

    total = sum(e["bytes"] for e in p.entries)
    by_layer: dict[str, int] = {}
    for e in p.entries:
        by_layer[e["layer"]] = by_layer.get(e["layer"], 0) + 1
    print(f"published {len(p.entries)} assets, {total/1e6:.1f} MB")
    print("  by layer:", by_layer)
    return {"count": len(p.entries), "bytes": total, "byLayer": by_layer}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="assets-src")
    ap.add_argument("--out", default="public/library")
    args = ap.parse_args()
    build(args.src, args.out)
