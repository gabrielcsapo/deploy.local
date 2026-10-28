import sys
from PIL import Image
# pair.py out.png a.png b.png ... : side-by-side at half width for quick review
ims = [Image.open(p).convert('RGB') for p in sys.argv[2:]]
ims = [im.resize((im.width // 2, im.height // 2)) for im in ims]
W = sum(im.width for im in ims) + 8 * (len(ims) - 1); H = max(im.height for im in ims)
out = Image.new('RGB', (W, H), (40, 40, 44)); x = 0
for im in ims:
    out.paste(im, (x, 0)); x += im.width + 8
out.save(sys.argv[1])
