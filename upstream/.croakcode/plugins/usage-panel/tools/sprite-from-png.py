#!/usr/bin/env python3
"""Convert a PNG sprite sheet into a usage-panel sprite JSON.

The sheet holds frames of equal size, read left to right, then top to bottom.
Each pixel becomes one sprite pixel; two pixel rows share one terminal row, so
a 24x24 frame takes 24 columns and 12 rows of the sidebar. Keep frames at most
32 pixels wide; the sidebar is about 40 columns wide.

Example:
  sprite-from-png.py hero.png --frame 32x32 --width 24 --name hero \\
      --anim idle=0,0,0,1@2 --anim think=2,3@4 --anim run=4,5,6,7@8 \\
      --anim sleep=8@1 --anim dizzy=9,10@6 --anim ask=11@2 \\
      --out ../sprites/hero.json

Animations: idle, think and run are required; sleep, dizzy and ask are optional.
Without --anim flags every animation plays all frames.
"""
import argparse
import json
import string
import sys

from PIL import Image

# Palette characters; "." is reserved for transparency.
CHARS = string.ascii_letters + string.digits + "!#$%&*+-:;<=>?@^_~"


def parse_frame(value):
    w, h = value.lower().split("x")
    return int(w), int(h)


def parse_anim(value):
    name, rest = value.split("=", 1)
    seq, _, fps = rest.partition("@")
    return name, {"fps": float(fps or 4), "sequence": [int(i) for i in seq.split(",")]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sheet")
    ap.add_argument("--frame", required=True, type=parse_frame, help="frame size, e.g. 32x32")
    ap.add_argument("--count", type=int, help="number of frames to read (default: all)")
    ap.add_argument("--width", type=int, help="resize frames to this width (nearest neighbour)")
    ap.add_argument("--colors", type=int, default=48, help="maximum palette size (default 48)")
    ap.add_argument("--alpha", type=int, default=128, help="alpha below this is transparent")
    ap.add_argument("--anim", action="append", type=parse_anim, default=[])
    ap.add_argument("--name", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if args.colors > len(CHARS):
        sys.exit(f"--colors must be at most {len(CHARS)}")

    sheet = Image.open(args.sheet).convert("RGBA")
    fw, fh = args.frame
    cols, rows = sheet.width // fw, sheet.height // fh
    total = cols * rows if args.count is None else args.count
    if total < 1 or total > cols * rows:
        sys.exit(f"sheet {sheet.width}x{sheet.height} holds {cols * rows} frames of {fw}x{fh}")

    frames = []
    for i in range(total):
        x, y = (i % cols) * fw, (i // cols) * fh
        frame = sheet.crop((x, y, x + fw, y + fh))
        if args.width and args.width != fw:
            height = max(1, round(fh * args.width / fw))
            frame = frame.resize((args.width, height), Image.NEAREST)
        frames.append(frame)

    w, h = frames[0].size
    # Two pixel rows per terminal row: pad an odd height with a transparent row.
    padded_h = h + (h % 2)

    # Quantize all frames together so they share one palette.
    strip = Image.new("RGBA", (w * len(frames), h))
    for i, f in enumerate(frames):
        strip.paste(f, (i * w, 0))
    alpha = strip.getchannel("A")
    rgb = strip.convert("RGB")
    opaque = sorted({rgb.getpixel((x, y)) for x in range(rgb.width) for y in range(rgb.height) if alpha.getpixel((x, y)) >= args.alpha})
    if len(opaque) > args.colors:
        rgb = rgb.quantize(colors=args.colors, method=Image.Quantize.MEDIANCUT).convert("RGB")

    palette = {}
    index = {}
    out_frames = []
    for i in range(len(frames)):
        rows_out = []
        for y in range(padded_h):
            row = []
            for x in range(w):
                if y >= h or alpha.getpixel((i * w + x, y)) < args.alpha:
                    row.append(".")
                    continue
                color = "#%02x%02x%02x" % rgb.getpixel((i * w + x, y))
                if color not in index:
                    ch = CHARS[len(index)]
                    index[color] = ch
                    palette[ch] = color
                row.append(index[color])
            rows_out.append("".join(row))
        out_frames.append(rows_out)

    every = {"fps": 4, "sequence": list(range(len(frames)))}
    animations = {"idle": every, "think": every, "run": {"fps": 8, "sequence": every["sequence"]}}
    for name, anim in args.anim:
        if name not in ("idle", "think", "run", "sleep", "dizzy", "ask"):
            sys.exit(f"unknown animation {name}")
        bad = [i for i in anim["sequence"] if i < 0 or i >= len(frames)]
        if bad:
            sys.exit(f"animation {name}: frame index {bad[0]} is out of range 0..{len(frames) - 1}")
        animations[name] = anim

    sprite = {"name": args.name, "width": w, "height": padded_h, "palette": palette, "frames": out_frames, "animations": animations}
    with open(args.out, "w") as fh_out:
        json.dump(sprite, fh_out, indent=1)
    print(f"{args.out}: {len(frames)} frames, {w}x{padded_h} px, {len(palette)} colors, {w} cols x {padded_h // 2} rows")


if __name__ == "__main__":
    main()
