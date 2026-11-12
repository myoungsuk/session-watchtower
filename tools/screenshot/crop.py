# Crop the part of a full screenshot that a scene is about. Sizes are in screen pixels (the window is drawn at 2x).
import sys
from PIL import Image
src, out, scene, side = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
im = Image.open(src)
# the window may be centred on the virtual screen: drop the black margin first
im = im.crop(im.convert('L').point(lambda v: 255 if v > 8 else 0).getbbox())
W, H = im.size
left = (48 + side) * 2 + 2      # activity bar + side bar
if scene == 'side':
    box = (0, 60, left, H)
elif scene == 'explorer':        # side bar with the file Explorer, plus the start of the editor tabs
    box = (0, 60, left + 520, 60 + 760)
elif scene == 'tabs':            # side bar plus the editor tabs above the editor
    box = (0, 0, min(W, left + 1000), 1000)
elif scene == 'toasts':
    box = (W - 940, H - 640, W, H - 44)
elif scene in ('search', 'file'):
    box = (W // 2 - 640, 0, W // 2 + 640, 640)
else:                           # review, summary: the editor area
    box = (left, 60, W, H - 44)
im.crop(box).save(out)
print(out.split('/')[-1], im.crop(box).size)
