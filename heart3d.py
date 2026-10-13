# -*- coding: utf-8 -*-
"""
heart3d.py —— 在终端里输出一个会旋转、会"跳动"的立体爱心。

原理简述：
  1. 用一个"隐函数"描述三维爱心（数学上著名的 3D 心形方程）；
  2. 在三维空间里采样，收集所有落在心形内部的点（体素化）；
  3. 每一帧把这些点绕竖直轴旋转，再"投影"成屏幕上的字符网格；
  4. 用 z-buffer（深度缓冲）只保留最靠前的点，并用不同密度的字符 + 颜色
     表现远近，于是平面的字符就产生了立体感。

运行方式：
    python heart3d.py

退出方式：
    按 Ctrl + C

注意：
    本文件只用到 Python 自带的标准库，不需要安装任何第三方依赖。
"""

import math
import os
import shutil
import sys
import time

# ---------------------------------------------------------------
# 字符与颜色：从"远"到"近"，字符越来越密，颜色越来越亮
# ---------------------------------------------------------------
CHARS = ":-=+*#%@"          # 8 个亮度等级，@ 最亮（离观众最近）
COLORS = [
    "\033[38;5;88m",        # 暗红
    "\033[38;5;124m",
    "\033[38;5;160m",
    "\033[38;5;196m",       # 正红
    "\033[38;5;203m",
    "\033[38;5;209m",
    "\033[38;5;213m",       # 粉色
    "\033[38;5;219m",       # 亮粉
]
RESET = "\033[0m"           # 重置颜色
HIDE_CURSOR = "\033[?25l"   # 隐藏光标，避免闪烁
SHOW_CURSOR = "\033[?25h"   # 恢复光标
CURSOR_HOME = "\033[H"      # 把光标移回左上角


def enable_ansi_on_windows():
    """在 Windows 控制台里开启 ANSI 转义支持，否则颜色会变成一堆乱码。"""
    if os.name != "nt":
        return
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)               # -11 表示标准输出
        mode = ctypes.c_uint32()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            VT_FLAG = 0x0004                              # ENABLE_VIRTUAL_TERMINAL_PROCESSING
            kernel32.SetConsoleMode(handle, mode.value | VT_FLAG)
    except Exception:
        # 开启失败也没关系：只是没有颜色，爱心照样能显示
        pass


def heart_field(x, y, z):
    """三维心形隐函数：返回值 <= 0 表示该点在心形内部，> 0 表示在外部。"""
    a = x * x + 2.25 * y * y + z * z - 1.0
    return a * a * a - x * x * z * z * z - 0.1125 * y * y * z * z * z


def build_points(resolution=44, low=-1.3, high=1.3):
    """在三维空间均匀采样，把所有落在心形内部的点收集起来。"""
    points = []
    step = (high - low) / resolution
    for i in range(resolution):
        x = low + i * step
        for j in range(resolution):
            y = low + j * step
            for k in range(resolution):
                z = low + k * step
                if heart_field(x, y, z) <= 0.0:
                    points.append((x, y, z))
    return points


def render(points, angle, pulse, width, height, radius):
    """把某个旋转角度下的所有三维点，投影到 width x height 的深度缓冲上。

    返回 depth 网格：每个格子存该点最靠前（离观众最近）的深度值；
    空着的格子存一个极小值，表示该位置没有爱心。
    """
    NOTHING = -1.0e18
    depth = [[NOTHING] * width for _ in range(height)]

    sin_a = math.sin(angle)
    cos_a = math.cos(angle)
    half_w = width / 2.0
    half_h = height / 2.0
    # 每 1 个"单位长度"对应多少列字符；0.5 是因为字符格子"高 ≈ 宽的 2 倍"，
    # 这样画出来的爱心才不会被拉长压扁。
    scale = min(half_w / radius, half_h / (radius * 0.5))

    for (x, y, z) in points:
        # 绕竖直轴（z 轴）旋转，并乘以 pulse 实现整体的"心跳"缩放
        xr = (x * cos_a - y * sin_a) * pulse
        yr = (x * sin_a + y * cos_a) * pulse
        zr = z * pulse

        col = int(round(half_w + xr * scale))
        row = int(round(half_h - zr * scale * 0.5))
        if 0 <= col < width and 0 <= row < height:
            # 深度缓冲：只保留离观众最近的那个点
            if yr > depth[row][col]:
                depth[row][col] = yr
    return depth


def to_lines(depth, y_min, y_max):
    """把深度缓冲转成一行行带颜色的字符串。"""
    lines = []
    span = (y_max - y_min) or 1.0
    full = len(CHARS) - 1
    for row in depth:
        parts = []
        current = -1           # 当前正在使用的颜色档位，-1 表示"无颜色"
        for d in row:
            if d < -1.0e17:    # 该格子没有爱心
                if current != -1:
                    parts.append(RESET)
                    current = -1
                parts.append(" ")
                continue
            level = int((d - y_min) / span * full)
            if level < 0:
                level = 0
            elif level > full:
                level = full
            if level != current:          # 只在颜色变化时才输出一次颜色码，省流量
                parts.append(COLORS[level])
                current = level
            parts.append(CHARS[level])
        if current != -1:
            parts.append(RESET)
        lines.append("".join(parts))
    return lines


def main():
    enable_ansi_on_windows()

    # 根据当前终端大小决定画布尺寸（非交互环境会拿到默认的 80 x 24）
    term = shutil.get_terminal_size()
    box_h = max(12, term.lines - 3)
    box_w = min(term.columns - 2, box_h * 2)
    if box_w < 20:
        box_w = 20
    indent = " " * max(0, (term.columns - box_w) // 2)

    sys.stdout.write("正在生成 3D 爱心，请稍等 ...\n")
    sys.stdout.flush()

    # 1) 生成心形内部的点，并做居中处理
    #    采样网格必须比画布更密，否则投影到字符网格时会"漏掉"某些列，
    #    爱心正中间就会出现一条竖直的裂缝。
    resolution = max(48, min(96, int(box_h * 2.3)))
    points = build_points(resolution)
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    zs = [p[2] for p in points]
    cx = (min(xs) + max(xs)) / 2.0
    cz = (min(zs) + max(zs)) / 2.0
    y_min, y_max = min(ys), max(ys)

    # 把爱心平移到"以旋转轴为中心"的位置
    centered = [(x - cx, y, z - cz) for (x, y, z) in points]
    # 半径按"点到旋转轴的最大距离"来取：转到侧面时投影会变宽，
    # 若只按正面宽度计算，转到 45 度左右爱心就会被画布边缘裁掉。
    r_axis = max(math.hypot(p[0], p[1]) for p in centered)
    z_max = max(abs(p[2]) for p in centered)
    radius = max(r_axis, z_max) * 1.06

    # 2) 进入动画循环
    sys.stdout.write(HIDE_CURSOR + "\033[2J")
    sys.stdout.flush()

    angle = 0.0
    start = time.time()
    caption = indent + "3D Heart  ·  按 Ctrl+C 退出\n"
    try:
        while True:
            t = time.time() - start
            pulse = 1.0 + 0.05 * math.sin(t * 6.0)        # 心跳：整体轻微缩放
            depth = render(centered, angle, pulse, box_w, box_h, radius)
            lines = to_lines(depth, y_min, y_max)

            buf = [CURSOR_HOME]
            for line in lines:
                buf.append(indent + line + "\n")
            buf.append(caption)
            buf.append(RESET)
            sys.stdout.write("".join(buf))
            sys.stdout.flush()

            angle += 0.14
            time.sleep(0.05)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write(SHOW_CURSOR + RESET + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
