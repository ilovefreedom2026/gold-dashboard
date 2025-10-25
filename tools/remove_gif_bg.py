#!/usr/bin/env python3
"""remove_gif_bg.py

Make the background of an animated GIF transparent by keying out a color (default white).
Preserves frame durations and disposal where possible.

Usage:
  python remove_gif_bg.py input.gif output.gif [--bg-color R,G,B] [--tolerance N]

Requires: Pillow
  pip install Pillow

"""
import sys
import os
from PIL import Image, ImageChops
import argparse


def parse_color(s):
    parts = s.split(",")
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("Color must be R,G,B")
    return tuple(int(p) for p in parts)


def main():
    parser = argparse.ArgumentParser(description="Make GIF background transparent by color keying.")
    parser.add_argument("input", help="input gif path")
    parser.add_argument("output", help="output gif path")
    parser.add_argument("--bg-color", default="255,255,255", type=parse_color,
                        help="background color to remove as R,G,B (default 255,255,255)")
    parser.add_argument("--tolerance", type=int, default=0,
                        help="tolerance for color matching (0 exact match). Higher tolerances remove near colors.")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"Input file not found: {args.input}")
        sys.exit(2)

    bg = args.bg_color
    tol = args.tolerance

    im = Image.open(args.input)
    frames = []
    durations = []
    disposals = []

    try:
        while True:
            frame = im.convert("RGBA")
            datas = frame.getdata()
            newData = []
            for item in datas:
                r,g,b,a = item
                if abs(r - bg[0]) <= tol and abs(g - bg[1]) <= tol and abs(b - bg[2]) <= tol:
                    newData.append((255,255,255,0))
                else:
                    newData.append((r,g,b,a))
            frame.putdata(newData)
            frames.append(frame)
            durations.append(im.info.get('duration', 100))
            disposals.append(im.disposal_method if hasattr(im, 'disposal_method') else None)
            im.seek(im.tell() + 1)
    except EOFError:
        pass

    if not frames:
        print("No frames loaded from GIF")
        sys.exit(3)

    # Save frames as animated GIF with transparency
    frames[0].save(
        args.output,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        disposal=2,
        transparency=0,
        optimize=False,
    )

    print(f"Saved transparent GIF to: {args.output}")

if __name__ == '__main__':
    main()
