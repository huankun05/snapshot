# 长截图帧-帧 SSD 真值校验：对 xiyue-ls-debug 下指定会话的连续帧，
# 全列采样计算各垂直位移的 SSD，找真值谷，与匹配器接受值比对。
# 用法: python verify_ls_truth.py <会话目录> [帧前缀]
import sys, glob, os, re
import numpy as np
from PIL import Image

d = sys.argv[1] if len(sys.argv) > 1 else None
if not d or not os.path.isdir(d):
    d = os.path.join(os.environ['LOCALAPPDATA'], 'Temp', 'xiyue-ls-debug')
frames = sorted(glob.glob(os.path.join(d, 'ls_*_f*.png')))
sess = {}
for f in frames:
    m = re.search(r'(ls_\d+)_f(\d+)\.png$', f)
    if m:
        sess.setdefault(m.group(1), []).append((int(m.group(2)), f))

def gray(im):
    a = np.asarray(im.convert('L'), dtype=np.float32)
    return a

def ssd_at(a, b, s, step=2):
    # a 滚动 s 后与 b 对齐：a 上移 s → a[s:, :] vs b[:h-s, :]
    if s <= 0 or s >= a.shape[0]:
        return None
    top = a[s:, ::step]
    bot = b[:a.shape[0]-s, ::step]
    d = top - bot
    return float((d*d).mean())

for sname, fl in sorted(sess.items()):
    fl.sort()
    print(f'== {sname} == frames={[i for i,_ in fl]}')
    for (i1, f1), (i2, f2) in zip(fl, fl[1:]):
        a, b = gray(Image.open(f1)), gray(Image.open(f2))
        if a.shape != b.shape:
            print(f'  f{i1}->f{i2} shape mismatch {a.shape} vs {b.shape}')
            continue
        best = []
        for s in range(8, a.shape[0]-8):
            v = ssd_at(a, b, s)
            if v is not None:
                best.append((v, s))
        best.sort()
        top3 = ', '.join(f's={s} err={v:.1f}' for v, s in best[:3])
        print(f'  f{i1}->f{i2} h={a.shape[0]} 真值谷: {top3}')
