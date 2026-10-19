# 生成工坊的默认 PPTX 模板 templates/pptx/default.pptx（开发时运行一次，生成的模板随仓库提交）。
# 从 python-pptx 自带的模板出发：改成 16:9（版式里的占位符按比例横向拉宽），主题字体换成本机 Windows 自带的
# Segoe UI（西文）与微软雅黑（中文），母版的标题、正文字号改成适合分享型 PPT 的大小。
# 用法：.venv\Scripts\python.exe lib/workbench/export/make_template.py templates/pptx/default.pptx
import sys

from lxml import etree
from pptx import Presentation
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.util import Emu

A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
LATIN, EA = 'Segoe UI', 'Microsoft YaHei'

prs = Presentation()
WIDE = 12192000  # 16:9 的标准宽度（13.333 英寸，960pt），高度不变（7.5 英寸）
factor = WIDE / prs.slide_width
prs.slide_width = Emu(WIDE)
# 版式里的占位符多半继承母版的位置：先读出（含继承的）四个值，再一起写回，不能只写一半
boxes = [(sh, sh.left, sh.top, sh.width, sh.height) for owner in [prs.slide_master, *prs.slide_layouts] for sh in owner.shapes]
for sh, left, top, width, height in boxes:
    if None in (left, top, width, height):
        continue
    sh.left, sh.top, sh.width, sh.height = int(left * factor), top, int(width * factor), height

theme = prs.slide_master.part.part_related_by(RT.THEME)
root = etree.fromstring(theme.blob)
for which in ('majorFont', 'minorFont'):
    node = root.find(f'.//{A}{which}')
    node.find(f'{A}latin').set('typeface', LATIN)
    node.find(f'{A}ea').set('typeface', EA)
theme._blob = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)

styles = prs.slide_master._element.find(f'{P}txStyles')
sizes = {'titleStyle': [3600], 'bodyStyle': [2400, 2000, 1800, 1600, 1600]}
for style, levels in sizes.items():
    node = styles.find(f'{P}{style}')
    for i, sz in enumerate(levels, 1):
        lvl = node.find(f'{A}lvl{i}pPr')
        if lvl is None:
            continue
        rpr = lvl.find(f'{A}defRPr')
        if rpr is not None:
            rpr.set('sz', str(sz))

prs.save(sys.argv[1])
print('ok', sys.argv[1], [l.name for l in prs.slide_layouts])
