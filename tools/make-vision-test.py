from PIL import Image, ImageDraw
import os
os.makedirs(r"D:\dsh-English-study-workplace\data\cache", exist_ok=True)
img = Image.new("RGB", (900, 320), "white")
d = ImageDraw.Draw(img)
lines = [
    "2026-02-14  Friday  cloudy",
    "My cat knocked over the ink bottle",
    "while I was copying the novel.",
    "I had to rewrite the whole page.",
]
y = 40
for ln in lines:
    d.text((40, y), ln, fill="black")
    y += 60
p = r"D:\dsh-English-study-workplace\data\cache\vision-test.png"
img.save(p)
print("wrote", p, os.path.getsize(p), "bytes")
