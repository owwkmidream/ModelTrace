"""生成 ModelTrace 应用图标。

与网页版顶栏的 brand mark 保持一致：主色 #2563EB 圆角方块 + 白色 "MT" 字样。
输出多尺寸 .ico，供 exe 与开始菜单项使用。
"""

from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

PRIMARY = (0x25, 0x63, 0xEB, 255)
WHITE = (0xFF, 0xFF, 0xFF, 255)

HERE = Path(__file__).resolve().parent
TARGET = HERE / "app.ico"


def find_font(size: int) -> ImageFont.FreeTypeFont:
    """找一个能画粗体字母的字体，优先用系统自带的中性无衬线粗体。"""
    candidates = [
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\msyhbd.ttc",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def render(size: int) -> Image.Image:
    # 4 倍超采样后缩小，得到平滑的圆角与字形边缘
    scale = 4
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # 圆角方块。圆角半径取边长的 18%，接近网页版 6px/29px 的比例
    radius = int(canvas * 0.18)
    draw.rounded_rectangle([0, 0, canvas - 1, canvas - 1], radius=radius, fill=PRIMARY)

    # 居中绘制 MT
    text = "MT"
    font = find_font(int(canvas * 0.42))
    box = draw.textbbox((0, 0), text, font=font)
    width = box[2] - box[0]
    height = box[3] - box[1]
    draw.text(
        ((canvas - width) / 2 - box[0], (canvas - height) / 2 - box[1]),
        text,
        font=font,
        fill=WHITE,
    )

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [render(size) for size in sizes]
    frames[-1].save(TARGET, format="ICO", sizes=[(s, s) for s in sizes])
    print(f"已生成 {TARGET}（{', '.join(str(s) for s in sizes)}）")


if __name__ == "__main__":
    main()
