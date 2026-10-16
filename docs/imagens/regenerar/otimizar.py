# Quantiza os PNGs para 256 cores (telas escuras de interface quase não perdem nada).
# Uso: python3 -I otimizar.py <pasta-entrada> <pasta-saida>
import sys, os
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
for name in sorted(os.listdir(src)):
    if not name.endswith(".png"):
        continue
    im = Image.open(os.path.join(src, name)).convert("RGB")
    q = im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    out = os.path.join(dst, name)
    q.save(out, optimize=True)
    print(f"{name}: {im.size[0]}x{im.size[1]} {os.path.getsize(out)//1024} KB")
