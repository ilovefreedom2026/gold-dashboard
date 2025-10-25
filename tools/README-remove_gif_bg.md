Remove GIF background to transparent

This small script converts a GIF's background color (default white) to transparent while preserving animation frames and durations.

Requirements
- Python 3.8+
- Pillow

Install Pillow (PowerShell):

```powershell
python -m pip install --upgrade pip; python -m pip install Pillow
```

Usage (PowerShell):

```powershell
# exact white background
python .\tools\remove_gif_bg.py .\path\to\input.gif .\path\to\output.gif

# specify background color and tolerance
python .\tools\remove_gif_bg.py .\tools\example.gif .\tools\example_transparent.gif --bg-color 255,255,255 --tolerance 10
```

Notes
- If the GIF has anti-aliased edges blending into the background, increase `--tolerance` slightly (5-20) to remove fringes, but beware of removing similar colors inside the subject.
- The script does a per-pixel color key. For complex backgrounds, consider using more advanced tools (ffmpeg with chroma key filters) or manual frame editing.
- If you'd like, I can run the script on the attached GIF if you upload it into the workspace or tell me where it is.
