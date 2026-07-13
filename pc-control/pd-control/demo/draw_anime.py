#!/usr/bin/env python3
"""Draw anime portrait in Paint based on reference image analysis.

Key proportions extracted from reference (scaled to Paint canvas):
- Face center: (792, 500), face height ~400px
- Eyes at y~410, spaced ~110px from center
- Mouth at y~650
- White/silver hair, pale skin, dark line art style
"""
import math
import sys
import time
import requests

HOST = sys.argv[1] if len(sys.argv) > 1 else "10.211.55.4"
BASE = f"http://{HOST}:5000"
CX, CY = 792, 500  # face center on Paint canvas

s = requests.Session()

def api(endpoint, data):
    s.post(f"{BASE}/{endpoint}", json=data, timeout=10)

def drag(x1, y1, x2, y2, dur=0.004):
    api("drag", {"x1": int(x1), "y1": int(y1),
                 "x2": int(x2), "y2": int(y2), "duration": dur})

def curve(pts, sub=4):
    """Smooth polyline with subdivisions."""
    for i in range(len(pts) - 1):
        x1, y1 = pts[i]
        x2, y2 = pts[i + 1]
        for j in range(sub):
            t0, t1 = j / sub, (j + 1) / sub
            drag(x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0,
                 x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1, dur=0.003)

def ellipse(cx, cy, rx, ry, segs=40):
    pts = []
    for i in range(segs + 1):
        a = 2 * math.pi * i / segs
        pts.append((cx + rx * math.cos(a), cy + ry * math.sin(a)))
    curve(pts, sub=2)

def filled_ellipse(cx, cy, rx, ry, spacing=3):
    n = max(1, int(max(rx, ry) / spacing))
    for i in range(1, n + 1):
        r = i / n
        segs = max(12, int(2 * math.pi * max(rx, ry) * r / 5))
        ellipse(cx, cy, rx * r, ry * r, segs=segs)

# ============================================================
print("Setting bot mode for max speed...")
api("config", {"behavior": "bot"})
t0 = time.time()

# ---- 1. Face outline (anime heart/oval shape) ----
print("1. Face outline...")
face = [
    # Start at chin, go up right side
    (792, 720), (778, 714), (764, 704), (752, 690), (742, 674),
    (734, 656), (728, 636), (724, 616), (722, 596), (722, 576),
    (724, 556), (728, 536), (734, 516), (742, 498), (752, 482),
    (764, 468), (778, 458), (792, 452),
    # Forehead top
    (806, 458), (820, 468), (832, 482), (842, 498), (850, 516),
    (856, 536), (860, 556), (862, 576), (862, 596), (860, 616),
    (856, 636), (850, 656), (842, 674), (832, 690), (820, 704),
    (806, 714), (792, 720),
]
curve(face, sub=5)

# ---- 2. Neck ----
print("2. Neck...")
curve([(760, 710), (752, 760), (748, 810)], sub=3)
curve([(824, 710), (832, 760), (836, 810)], sub=3)

# ---- 3. Shoulders & body ----
print("3. Shoulders...")
curve([(748, 810), (680, 830), (580, 855), (480, 890)], sub=5)
curve([(836, 810), (904, 830), (1004, 855), (1104, 890)], sub=5)

# ---- 4. Left Eye ----
print("4. Left eye...")
LEX, LEY = 685, 415

# Upper eyelid
leye_top = [
    (650, 422), (662, 400), (678, 385), (692, 380),
    (708, 383), (722, 394), (730, 410), (734, 422),
]
curve(leye_top, sub=4)

# Lower eyelid
leye_bot = [
    (734, 422), (726, 432), (710, 438), (692, 439),
    (674, 436), (658, 430), (650, 422),
]
curve(leye_bot, sub=4)

# Double eyelid crease
curve([(652, 412), (672, 392), (694, 384), (716, 392), (732, 410)], sub=3)

# Iris
filled_ellipse(LEX + 8, LEY + 2, 16, 19, spacing=3)
ellipse(LEX + 8, LEY + 2, 16, 19, segs=36)

# Pupil
filled_ellipse(LEX + 9, LEY + 1, 8, 10, spacing=2)
ellipse(LEX + 9, LEY + 1, 8, 10, segs=24)

# Highlights
filled_ellipse(LEX + 16, LEY - 6, 6, 7, spacing=2)
filled_ellipse(LEX + 1, LEY - 2, 3, 3, spacing=1)

# Eyelashes
for dy in range(-5, 6, 2):
    drag(732, LEY + dy - 2, 742, LEY + dy + 2, dur=0.003)

# ---- 5. Right Eye ----
print("5. Right eye...")
REX, REY = 899, 415

reye_top = [
    (850, 422), (854, 410), (862, 394), (876, 383),
    (892, 380), (906, 385), (920, 400), (934, 422),
]
curve(reye_top, sub=4)

reye_bot = [
    (934, 422), (926, 430), (910, 436), (892, 438),
    (874, 434), (858, 428), (850, 422),
]
curve(reye_bot, sub=4)

curve([(852, 410), (872, 392), (894, 384), (916, 390), (932, 408)], sub=3)

filled_ellipse(REX + 8, REY + 2, 16, 19, spacing=3)
ellipse(REX + 8, REY + 2, 16, 19, segs=36)
filled_ellipse(REX + 9, REY + 1, 8, 10, spacing=2)
ellipse(REX + 9, REY + 1, 8, 10, segs=24)
filled_ellipse(REX + 16, REY - 6, 6, 7, spacing=2)
filled_ellipse(REX + 1, REY - 2, 3, 3, spacing=1)

for dy in range(-5, 6, 2):
    drag(850, LEY + dy + 2, 842, LEY + dy - 2, dur=0.003)

# ---- 6. Eyebrows ----
print("6. Eyebrows...")
curve([(646, 386), (670, 374), (698, 368), (722, 372), (738, 384)], sub=4)
curve([(846, 384), (862, 372), (886, 368), (914, 374), (938, 386)], sub=4)

# ---- 7. Nose ----
print("7. Nose...")
drag(786, 510, 792, 528, dur=0.004)
drag(784, 526, 792, 528, dur=0.003)

# ---- 8. Mouth ----
print("8. Mouth...")
mouth = [(752, 590), (770, 602), (792, 606), (814, 602), (832, 590)]
curve(mouth, sub=4)
curve([(770, 602), (792, 598), (814, 602)], sub=2)

# ---- 9. Hair (main outline - white/silver flowing hair) ----
print("9. Hair outline...")
hair_outline = [
    (630, 480), (618, 430), (622, 370), (640, 310), (668, 260),
    (706, 220), (752, 192), (792, 182), (832, 192), (878, 220),
    (916, 260), (944, 310), (960, 370), (964, 430), (954, 480),
]
curve(hair_outline, sub=5)

# ---- 10. Hair inner volume (layered look) ----
print("10. Hair volume...")
curve([(640, 310), (660, 340), (674, 380), (680, 420)], sub=3)
curve([(944, 310), (924, 340), (910, 380), (904, 420)], sub=3)
curve([(668, 260), (700, 280), (740, 290), (792, 292)], sub=3)
curve([(916, 260), (884, 280), (844, 290)], sub=3)

# ---- 11. Bangs (detailed forehead strands) ----
print("11. Bangs...")
# Left side bangs
curve([(670, 350), (684, 390), (692, 420), (690, 450), (696, 460)], sub=4)
curve([(696, 330), (710, 370), (716, 400), (718, 430), (722, 442)], sub=4)
# Center-left bangs
curve([(730, 310), (736, 350), (740, 390), (742, 430), (746, 456)], sub=4)
curve([(758, 302), (762, 340), (764, 380), (766, 420), (768, 452)], sub=4)
# Center bangs
curve([(792, 298), (792, 340), (792, 380), (792, 430), (792, 456)], sub=4)
# Center-right bangs
curve([(826, 302), (822, 340), (820, 380), (818, 420), (816, 452)], sub=4)
curve([(854, 310), (848, 350), (844, 390), (842, 430), (838, 456)], sub=4)
# Right side bangs
curve([(878, 330), (874, 370), (868, 400), (866, 430), (864, 442)], sub=4)
curve([(914, 350), (900, 390), (892, 420), (894, 450), (888, 460)], sub=4)

# ---- 12. Side hair (long flowing strands) ----
print("12. Side hair...")
# Left flowing strands
curve([(622, 430), (608, 480), (598, 540), (594, 600), (600, 660), (610, 710)], sub=5)
curve([(618, 370), (600, 420), (590, 480), (588, 540), (594, 590)], sub=4)
curve([(640, 310), (624, 350), (614, 400), (610, 450)], sub=3)
# Right flowing strands
curve([(962, 430), (976, 480), (986, 540), (990, 600), (984, 660), (974, 710)], sub=5)
curve([(964, 370), (982, 420), (992, 480), (994, 540), (988, 590)], sub=4)
curve([(944, 310), (960, 350), (970, 400), (974, 450)], sub=3)

# ---- 13. Hair detail / texture lines ----
print("13. Hair texture...")
for sx, sy, ex, ey, sub in [
    (660, 280, 680, 330, 2), (700, 240, 720, 300, 2),
    (740, 210, 750, 280, 2), (780, 200, 785, 270, 2),
    (820, 200, 815, 270, 2), (860, 210, 850, 280, 2),
    (900, 240, 880, 300, 2), (930, 280, 910, 330, 2),
]:
    curve([(sx, sy), (ex, ey)], sub=sub)

# Hair shine lines (silver hair characteristic)
curve([(720, 240), (750, 210), (792, 196)], sub=3)
curve([(844, 210), (874, 240), (900, 270)], sub=3)
curve([(668, 320), (696, 280), (730, 260)], sub=3)

# ---- 14. Ears ----
print("14. Ears...")
curve([(722, 556), (710, 538), (706, 520), (710, 540), (714, 556)], sub=3)
curve([(710, 525), (712, 536), (710, 545)], sub=2)
curve([(862, 556), (874, 538), (878, 520), (874, 540), (870, 556)], sub=3)
curve([(874, 525), (872, 536), (874, 545)], sub=2)

# ---- 15. Blush ----
print("15. Blush...")
for bx, by in [(650, 540), (934, 540)]:
    for dy in range(-6, 7, 2):
        drag(bx - 4, by + dy, bx + 4, by + dy, dur=0.003)

# ---- 16. Collar / Clothing ----
print("16. Collar...")
curve([(660, 790), (710, 770), (792, 756), (874, 770), (924, 790)], sub=4)
curve([(710, 770), (792, 800), (874, 770)], sub=3)
# Clothing line
curve([(704, 800), (792, 830), (880, 800)], sub=4)

# ---- 17. Collarbones ----
print("17. Collarbones...")
curve([(660, 820), (720, 840), (780, 850)], sub=3)
curve([(924, 820), (864, 840), (804, 850)], sub=3)

elapsed = time.time() - t0
print(f"\n=== Done in {elapsed:.1f}s! ===")
print(f"Screenshot: python3 -m pd_control.cli shot --host {HOST} -o /tmp/anime-drawing.png")
