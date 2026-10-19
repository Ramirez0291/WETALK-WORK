# 渲染检查（WP7）：用本机 PowerPoint 把 PPTX 转成 PDF 和逐页 PNG，读出每个形状的位置和文字的实际排版范围，
# 列出演示文稿用到的字体；同时列出本机安装的字体（各语言的字体名都算）。
# 结果写成 UTF-8 JSON 文件（不经控制台：路径含中文、日文时控制台编码会把它们弄乱）。
# -FontsOnly：只列本机字体（没有 PowerPoint 时用）。只读打开、不显示窗口；只写 -OutDir 与 -Result。
param(
  [string]$In = '',
  [string]$OutDir = '',
  [Parameter(Mandatory = $true)][string]$Result,
  [switch]$FontsOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Depth 10 -Compress
  [IO.File]::WriteAllText($Result, $json, (New-Object Text.UTF8Encoding $false))
}

# 本机字体：系统字体与当前用户安装的字体，每个字体族的全部语言名称
Add-Type -AssemblyName PresentationCore
$installed = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$families = @([System.Windows.Media.Fonts]::SystemFontFamilies)
$userFonts = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
if (Test-Path $userFonts) {
  try { $families += @([System.Windows.Media.Fonts]::GetFontFamilies($userFonts + '\')) } catch {}
}
foreach ($f in $families) {
  foreach ($n in $f.FamilyNames.Values) { [void]$installed.Add($n) }
  [void]$installed.Add(($f.Source -split '#')[-1])
}
$out = [ordered]@{ engine = 'powerpoint'; installed = @($installed) }
if ($FontsOnly) {
  $out['engine'] = 'fonts'
  Write-Result $out
  exit 0
}

function Shape-Info($sh) {
  $o = [ordered]@{ name = $sh.Name; type = $sh.Type; left = $sh.Left; top = $sh.Top; width = $sh.Width; height = $sh.Height }
  if ($sh.Type -eq 6) {
    $o['children'] = @(foreach ($c in $sh.GroupItems) { Shape-Info $c })
    return $o
  }
  try { $o['hasChart'] = [bool]$sh.HasChart } catch { $o['hasChart'] = $false }
  if ($sh.HasTextFrame -and $sh.TextFrame2.HasText) {
    $r = $sh.TextFrame2.TextRange
    $o['text'] = $r.Text
    $o['boundLeft'] = $r.BoundLeft; $o['boundTop'] = $r.BoundTop; $o['boundWidth'] = $r.BoundWidth; $o['boundHeight'] = $r.BoundHeight
    $o['autoSize'] = $sh.TextFrame2.AutoSize
  }
  return $o
}

$app = New-Object -ComObject PowerPoint.Application
$pres = $null
try {
  # ReadOnly、不作为无标题文档、不显示窗口
  $pres = $app.Presentations.Open($In, -1, 0, 0)
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $pdf = Join-Path $OutDir 'deck.pdf'
  $pres.SaveAs($pdf, 32)
  $w = $pres.PageSetup.SlideWidth
  $h = $pres.PageSetup.SlideHeight
  $out['version'] = $app.Version
  $out['slideWidth'] = $w
  $out['slideHeight'] = $h
  $out['pdf'] = 'deck.pdf'
  $out['fonts'] = @(foreach ($f in $pres.Fonts) { $f.Name })
  $pxW = 1600
  $pxH = [int][Math]::Round($pxW * $h / $w)
  $out['slides'] = @(foreach ($s in $pres.Slides) {
    $png = 'p{0:D2}.png' -f $s.SlideIndex
    $s.Export((Join-Path $OutDir $png), 'PNG', $pxW, $pxH)
    [ordered]@{ index = $s.SlideIndex; png = $png; shapes = @(foreach ($sh in $s.Shapes) { Shape-Info $sh }) }
  })
  Write-Result $out
} finally {
  if ($pres) { $pres.Close() }
  # 你自己开着别的演示文稿时不退出 PowerPoint
  if ($app.Presentations.Count -eq 0) { $app.Quit() }
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
