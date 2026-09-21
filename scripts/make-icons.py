#!/usr/bin/env python3
"""
앱 아이콘 생성 — 스코어카드 깃발 (Night Turf)

깃발의 천이 스코어카드 칸으로 되어 있는 핀깃발. 작게 보면 깃발로,
크게 보면 칸이 읽힌다. 딥그린 바탕에 골드.

  python3 scripts/make-icons.py

출력:
  public/icon-180.png / icon-192.png / icon-512.png / icon-1024.png
  ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png

iOS 앱 아이콘은 투명도를 허용하지 않으므로 캔버스를 꽉 채워 그린다.
모서리는 iOS가 직접 마스킹하므로 둥글리지 않는다.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent

# ── Night Turf 토큰 ──────────────────────────────────────────────
TURF_DEEP = (7, 12, 9)       # #070C09  바깥
TURF_LIT = (19, 38, 27)      # #13261B  가운데
GREEN_MOUND = (23, 51, 34)   # #173322  퍼팅 그린
HOLE = (5, 9, 7)             # #050907  홀컵
GOLD_HI = (246, 219, 147)    # #F6DB93
GOLD = (232, 192, 90)        # #E8C05A
GOLD_DEEP = (168, 128, 44)   # #A8802C
RULE = (11, 20, 16)          # #0B1410  깃발 안 칸선

S = 1024          # 설계 단위
SUPER = 4         # 슈퍼샘플링 배수


def radial_ground(size):
    """작게 만들어 키우는 방식의 방사형 그라디언트 — 픽셀 루프를 피한다."""
    n = 96
    g = Image.new("RGB", (n, n))
    px = g.load()
    cx, cy, r = n * 0.5, n * 0.40, n * 0.78
    for y in range(n):
        for x in range(n):
            d = min(1.0, (((x - cx) ** 2 + (y - cy) ** 2) ** 0.5) / r)
            t = d * d  # 가운데를 넓게, 가장자리를 빠르게 떨군다
            px[x, y] = tuple(
                round(a + (b - a) * t) for a, b in zip(TURF_LIT, TURF_DEEP)
            )
    return g.resize((size, size), Image.LANCZOS)


def vgrad(box, top, bottom):
    """세로 선형 그라디언트 타일."""
    x0, y0, x1, y1 = box
    w, h = max(1, x1 - x0), max(1, y1 - y0)
    g = Image.new("RGB", (1, h))
    gp = g.load()
    for y in range(h):
        t = y / max(1, h - 1)
        gp[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    return g.resize((w, h), Image.BICUBIC)


def draw_icon(size):
    c = size / S  # 설계 단위 → 실제 픽셀
    def u(v):
        return round(v * c)

    img = radial_ground(size)

    # ── 퍼팅 그린: 부드럽게 번지는 둔덕 ──────────────────────────
    mound = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mound).ellipse(
        [u(288), u(770), u(736), u(874)], fill=255
    )
    mound = mound.filter(ImageFilter.GaussianBlur(radius=size * 0.035))
    img.paste(Image.new("RGB", (size, size), GREEN_MOUND), (0, 0), mound)

    d = ImageDraw.Draw(img)

    # ── 홀컵: 깃대가 꽂히는 자리 ────────────────────────────────
    d.ellipse([u(300), u(812), u(414), u(846)], fill=HOLE)

    # ── 깃발 천 ────────────────────────────────────────────────
    FX0, FY0, FX1, FY1 = 356, 172, 752, 476
    flag = vgrad((FX0, FY0, FX1, FY1), GOLD_HI, GOLD)
    fmask = Image.new("L", (u(FX1 - FX0), u(FY1 - FY0)), 0)
    ImageDraw.Draw(fmask).rounded_rectangle(
        [0, 0, u(FX1 - FX0) - 1, u(FY1 - FY0) - 1], radius=u(16), fill=255
    )
    img.paste(flag.resize(fmask.size, Image.LANCZOS), (u(FX0), u(FY0)), fmask)

    # ── 깃발 안 스코어카드 표 ──────────────────────────────────
    # 테두리 + 가로 줄 4행 + 왼쪽 홀 번호 열. 격자가 아니라 표로 읽혀야 한다.
    gx0, gy0 = FX0 + 52, FY0 + 42
    gx1, gy1 = FX1 - 42, FY1 - 42
    lw = max(2, u(12))
    d.rounded_rectangle(
        [u(gx0), u(gy0), u(gx1), u(gy1)], radius=u(8), outline=RULE, width=lw
    )
    for i in range(1, 4):                       # 가로 줄 → 4행
        y = gy0 + (gy1 - gy0) * i / 4
        d.line([(u(gx0), u(y)), (u(gx1), u(y))], fill=RULE, width=lw)
    xv = gx0 + (gx1 - gx0) * 0.30               # 홀 번호 열
    d.line([(u(xv), u(gy0)), (u(xv), u(gy1))], fill=RULE, width=lw)

    # ── 깃대 ───────────────────────────────────────────────────
    PX0, PY0, PX1, PY1 = 312, 172, 360, 840
    pole = vgrad((PX0, PY0, PX1, PY1), GOLD_HI, GOLD_DEEP)
    pmask = Image.new("L", (u(PX1 - PX0), u(PY1 - PY0)), 0)
    ImageDraw.Draw(pmask).rounded_rectangle(
        [0, 0, u(PX1 - PX0) - 1, u(PY1 - PY0) - 1], radius=u(20), fill=255
    )
    img.paste(pole.resize(pmask.size, Image.LANCZOS), (u(PX0), u(PY0)), pmask)

    return img


def main():
    big = draw_icon(S * SUPER)

    targets = [
        (1024, ROOT / "public/icon-1024.png"),
        (512, ROOT / "public/icon-512.png"),
        (192, ROOT / "public/icon-192.png"),
        (180, ROOT / "public/icon-180.png"),
        (1024, ROOT / "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"),
    ]
    for px, path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        out = big.resize((px, px), Image.LANCZOS).convert("RGB")
        out.save(path, "PNG", optimize=True)
        print(f"{px:>5}px  {path.relative_to(ROOT)}  ({path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
