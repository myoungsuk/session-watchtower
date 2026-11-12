# Crop the left part (activity bar + side bar + left end of the status bar) out of a full screenshot.
import sys
from PIL import Image
src, out, side = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src)
# the window may be centred on the virtual screen: drop the black margin first
bbox = im.convert('L').point(lambda v: 255 if v > 8 else 0).getbbox()
im = im.crop(bbox)
w = (48 + side) * 2 + 2
im = im.crop((0, 60, w, im.height))
im.save(out); print(out.split('/')[-1], im.size)
