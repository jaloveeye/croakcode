#!/usr/bin/env python3
"""Generates sprites/treefrog.json, the default usage-panel avatar (20x18 pixels)."""
import json
import os

pal = {
    "K": "#17301b",  # outline
    "G": "#5cc94a", "g": "#3a9a35", "L": "#a6e88a",  # green body, shade, highlight
    "B": "#e9f2c8",  # belly
    "W": "#ffffff", "P": "#121212",  # eye white, pupil
    "T": "#f2b440",  # toe pads
    "M": "#1e5a22",  # mouth
    "Z": "#a8d8ff",  # sleep z
    "Q": "#ffb347",  # question mark, dizzy pupils
    # Spots: body green normally, black in auto mode (see "modes").
    "s": "#5cc94a",
    "V": "#ffe14d",  # lightning bolt, drawn only in auto mode
    "R": "#ff3b30",  # alert exclamation mark
}

EYES = {
    "open":  ["..KWWWK......KWWWK..", ".KWWPWWK....KWWPWWK.", ".KWWPWWKKKKKKWWPWWK."],
    "left":  ["..KWWWK......KWWWK..", ".KWPWWWK....KWPWWWK.", ".KWPWWWKKKKKKWPWWWK."],
    "right": ["..KWWWK......KWWWK..", ".KWWWPWK....KWWWPWK.", ".KWWWPWKKKKKKWWWPWK."],
    "blink": ["..KGGGK......KGGGK..", ".KGKKKGK....KGKKKGK.", ".KGGGGGKKKKKKGGGGGK."],
    "dizzyA": ["..KWWWK......KWWWK..", ".KWQWWWK....KWWWQWK.", ".KWWWQWKKKKKKWQWWWK."],
    "dizzyB": ["..KWWWK......KWWWK..", ".KWWWQWK....KWQWWWK.", ".KWQWWWKKKKKKWWWQWK."],
}
TOP = "...KKK........KKK..."
HEAD = [
    ".KGWWWGGGGGGGGWWWGK.",
    "KGGGGsGGGssGGGsGGGGK",
    "KGLGGGGsGGGGsGGGGLGK",
    "KGGMGsGGGGGGGGsGMGGK",
    ".KGGMMMMMMMMMMMMGGK.",
]
THROAT = {"flat": "..KGGGGGGGGGGGGGGK..", "puff": "..KGBBBBBBBBBBBBGK.."}
BODY = [
    ".KgsGKBBBBBBBBKGsgK.",
    "KgsGGKBBBBBBBBKGGsgK",
    "KgsGKBBBBBBBBBBKGsgK",
    ".KgGsKBBBBBBBBKsGgK.",
]
FEET_SIT = ["KTTgGGKKKKKKKKGGgTTK", "KTKTK..........KTKTK"]
FEET_JUMP = ["..KgGKKKKKKKKKKGgK..", ".KTgK..........KgTK.", "KTTK............KTTK"]
BLANK = "." * 20


def frog(eyes="open", throat="flat", pose="sit", overlay=()):
    body = [TOP] + EYES[eyes] + HEAD + [THROAT[throat]] + BODY
    if pose == "sit":
        rows = [BLANK, BLANK] + body + FEET_SIT
    elif pose == "crouch":
        # Squashed one row lower before the jump.
        rows = [BLANK, BLANK, BLANK] + body[:-1] + FEET_SIT
    else:  # jump: one row higher than sitting, legs hanging
        rows = [BLANK] + body + FEET_JUMP
    assert len(rows) == 18, (pose, len(rows))
    grid = [list(r) for r in rows]
    for y, x, ch in overlay:
        grid[y][x] = ch
    return ["".join(r) for r in grid]


ZZZ = [(0, 16, "Z"), (0, 17, "Z"), (0, 18, "Z"), (1, 17, "Z"), (2, 16, "Z"), (2, 17, "Z"), (2, 18, "Z")]
QMARK = [(0, 17, "Q"), (0, 18, "Q"), (1, 19, "Q"), (2, 18, "Q"), (3, 18, "Q"), (5, 18, "Q")]
# Red exclamation mark: something was blocked.
BANG = [(0, 17, "R"), (0, 18, "R"), (1, 17, "R"), (1, 18, "R"), (2, 17, "R"), (2, 18, "R"), (3, 17, "R"), (3, 18, "R"), (5, 17, "R"), (5, 18, "R")]

# Between the eyes, clear of the head in every pose.
BOLT = [(0, 11), (1, 10), (1, 11), (2, 9), (2, 10), (3, 10)]

frames = [
    frog(),                                    # 0 sit
    frog(eyes="blink"),                        # 1 blink
    frog(throat="puff"),                       # 2 throat puff
    frog(eyes="left"),                         # 3 look left
    frog(eyes="right"),                        # 4 look right
    frog(pose="crouch"),                       # 5 crouch
    frog(pose="jump"),                         # 6 jump
    frog(eyes="blink", overlay=ZZZ),           # 7 sleep
    frog(eyes="blink", overlay=ZZZ[:4]),       # 8 sleep, small z
    frog(eyes="dizzyA"),                       # 9 dizzy
    frog(eyes="dizzyB"),                       # 10 dizzy
    frog(overlay=QMARK),                       # 11 ask
    frog(overlay=BANG),                        # 12 alert: sits up with the mark
    frog(pose="crouch", eyes="blink"),         # 13 alert: flinches, mark off
]
for i, f in enumerate(frames):
    for y, r in enumerate(f):
        assert len(r) == 20, (i, y, r, len(r))
        assert all(c == "." or c in pal for c in r), (i, y, r)

sprite = {
    "name": "treefrog",
    "width": 20,
    "height": 18,
    "palette": pal,
    "frames": frames,
    "animations": {
        "idle": {"fps": 2, "sequence": [0, 0, 2, 0, 0, 1]},
        "think": {"fps": 3, "sequence": [3, 0, 4, 0]},
        "run": {"fps": 8, "sequence": [0, 5, 6, 5]},
        "sleep": {"fps": 1, "sequence": [7, 8]},
        "dizzy": {"fps": 5, "sequence": [9, 10]},
        "ask": {"fps": 2, "sequence": [11, 0]},
        "alert": {"fps": 3, "sequence": [12, 12, 13]},
    },
    # Auto approval: a poison-dart look that says "careful": orange body,
    # black spots and a lightning bolt between the eyes.
    "modes": {
        "auto": {
            "palette": {"G": "#ff7a1a", "g": "#c9501a", "L": "#ffc08a", "M": "#5a1e08", "s": "#141414"},
            "overlay": [[y, x, "V"] for y, x in BOLT],
        }
    },
}
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sprites", "treefrog.json")
with open(out, "w") as f:
    json.dump(sprite, f, indent=1)
print(out, len(frames), "frames")
