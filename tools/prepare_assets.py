#!/usr/bin/env python3
"""
IMAGO UNIVERSE - asset preparation pipeline.

Turns the painted source plates in `assets-src/` into a clean, metadata-rich,
runtime-ready asset library in `public/library/`.

Pipeline stages
---------------
1. Chroma key      - remove the flat FF00FF studio backdrop from object plates.
2. Unmix / despill - mathematically un-composite the backdrop colour from edge
                     pixels so no magenta halo survives, then suppress spill.
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
        img.save(os.path.join(self.out, rel), "WEBP", quality=90, method=6, exact=True)
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


def build(src: str, out: str) -> dict:
    p = Publisher(out)
    S = os.path.join(src, "style-fantasy")

    print("keying + refining painted plates ...")
    bg_lake = fit(load_bg(f"{S}/bg-enchanted-lake.png"), 1920)
    bg_glade = fit(load_bg(f"{S}/bg-moonlit-glade.png"), 1920)
    bg_high = fit(load_bg(f"{S}/bg-crystal-highlands.png"), 1920)
    oak = load_obj(f"{S}/mid-ancient-oak.png")
    willow = load_obj(f"{S}/mid-willow-tree.png")
    bridge = load_obj(f"{S}/mid-stone-bridge.png")
    pavilion = load_obj(f"{S}/mid-garden-pavilion.png")
    boulders = load_obj(f"{S}/mid-mossy-boulders.png")
    waterfall = load_obj(f"{S}/mid-waterfall.png")
    grass = load_obj(f"{S}/fg-grass-tuft.png")

    canopy = {"type": "canopy", "anchor": [0.5, 1.0], "canopyStart": 0.66,
              "stiffness": 0.72, "gusts": 3}
    bend = {"type": "bend", "anchor": [0.5, 1.0], "stiffness": 0.18, "gusts": 4}
    fall = {"type": "fall", "region": [0.30, 0.06, 0.42, 0.80], "speed": 1.0}

    # ---------------- style: enchanted (highly detailed fantasy) ----------
    E = "enchanted"
    for aid, name, img, cat, themes in [
        ("enchanted-lake", "Enchanted Lake Valley", bg_lake, "nature", ["forest", "water", "day"]),
        ("crystal-highlands", "Sunrise Highlands", bg_high, "fantasy", ["meadow", "dawn", "kingdom"]),
    ]:
        p.publish(Asset(f"{E}.background.{aid}", name, E, "background", cat, img,
                        themes=themes, tags=["background", "vista"], depth=0.0,
                        default_scale=1.0, animations=["cloud-drift", "water-shimmer", "parallax"],
                        rig={"type": "background"}, max_dim=1920))

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
    p.publish(Asset(f"{E}.middle.waterfall", "Forest Waterfall", E, "middle", "water", waterfall,
                    themes=["water", "forest"], tags=["waterfall", "cliff", "pool"],
                    depth=0.4, default_scale=0.5,
                    animations=["waterfall-flow", "ripple"], rig=fall, max_dim=1200))

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

    # ---------------- style: moonlit (graded sibling collection) ----------
    M = "moonlit"
    print("building moonlit sibling collection ...")
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
    for aid, name, img, cat, scale, anims, rig in [
        ("silver-oak", "Silver Oak", oak, "trees", 0.72, ["canopy-sway", "leaf-shed"], canopy),
        ("night-pavilion", "Lantern Pavilion", pavilion, "structures", 0.36, ["lantern-glow"], {}),
        ("dark-boulders", "Moonlit Boulders", boulders, "rocks", 0.24, [], {}),
    ]:
        p.publish(Asset(f"{M}.middle.{aid}", name, M, "middle", cat, grade(img, night_grade),
                        origin="graded", themes=["night", "forest"], tags=[cat, "night"],
                        depth=0.45, default_scale=scale, animations=anims, rig=rig, max_dim=1300))
    for aid, name, img, cat, scale in [
        ("night-grass", "Moonlit Grass", grass, "grass", 0.26),
        ("night-fern", "Night Fern", compose_sprig(leaf_chips, seed=31), "plants", 0.28),
        ("night-bush", "Shadow Bush", compose_bush(leaf_chips, seed=41), "plants", 0.34),
    ]:
        p.publish(Asset(f"{M}.foreground.{aid}", name, M, "foreground", cat, grade(img, night_grade),
                        origin="graded", themes=["night"], tags=[cat, "night"], depth=0.86,
                        default_scale=scale, animations=["grass-wind"], rig=bend, max_dim=1000))

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
