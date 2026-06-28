# 生成应用图标：圆角 ink 黑背景 + 白色 outline 终端图形居中。
# 输出 resources/icon.png（256x256）与 resources/icon.ico（多尺寸 16/32/48/64/128/256）。
# 用法：pwsh -NoProfile -File scripts/generate-icon.ps1

param(
  [int]$Master = 256
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$resDir = Join-Path $repoRoot 'resources'
if (-not (Test-Path $resDir)) { New-Item -ItemType Directory -Force -Path $resDir | Out-Null }

function New-IconBitmap {
  param([int]$Size)

  $bmp = New-Object System.Drawing.Bitmap $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  $scale = $Size / 24.0
  $ink = [System.Drawing.Color]::FromArgb(255, 23, 23, 23)        # #171717 (DESIGN ink)
  $white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

  # ── 1. 圆角 ink 黑背景：(0,0)-(24,24) rx=5.5（Big Sur 风格，约 23%） ──
  $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bgR = 5.5 * $scale * 2
  $bgSize = 24 * $scale
  $bgPath.AddArc(0, 0, $bgR, $bgR, 180, 90)
  $bgPath.AddArc($bgSize - $bgR, 0, $bgR, $bgR, 270, 90)
  $bgPath.AddArc($bgSize - $bgR, $bgSize - $bgR, $bgR, $bgR, 0, 90)
  $bgPath.AddArc(0, $bgSize - $bgR, $bgR, $bgR, 90, 90)
  $bgPath.CloseFigure()
  $bgBrush = New-Object System.Drawing.SolidBrush $ink
  $g.FillPath($bgBrush, $bgPath)
  $bgBrush.Dispose()
  $bgPath.Dispose()

  # ── 2. 白色 outline 终端图形（居中，原始 SVG 同款 viewBox 坐标） ──
  # 笔触：相对 viewBox 的 stroke-width≈2 → Size/24*2 ≈ Size*0.083
  $strokeWidth = [Math]::Max($Size * 0.07, 1.2)
  $stroke = New-Object System.Drawing.Pen $white, $strokeWidth
  $stroke.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $stroke.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $stroke.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

  # 终端框：(2.5, 4) - (21.5, 20)，rx=2.5（viewBox 24×24 内居中，上下/左右边距各 4/2.5）
  $tx = 2.5 * $scale
  $ty = 4 * $scale
  $tw = 19 * $scale
  $th = 16 * $scale
  $tr = 2.5 * $scale * 2
  $tpath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tpath.AddArc($tx, $ty, $tr, $tr, 180, 90)
  $tpath.AddArc($tx + $tw - $tr, $ty, $tr, $tr, 270, 90)
  $tpath.AddArc($tx + $tw - $tr, $ty + $th - $tr, $tr, $tr, 0, 90)
  $tpath.AddArc($tx, $ty + $th - $tr, $tr, $tr, 90, 90)
  $tpath.CloseFigure()
  $g.DrawPath($stroke, $tpath)
  $tpath.Dispose()

  # > 提示符 polyline：(6.5, 9) - (10, 12) - (6.5, 15)
  $g.DrawLine($stroke, (6.5 * $scale), (9 * $scale), (10 * $scale), (12 * $scale))
  $g.DrawLine($stroke, (10 * $scale), (12 * $scale), (6.5 * $scale), (15 * $scale))
  # 下划线 line：(12.5, 15) - (17.5, 15)
  $g.DrawLine($stroke, (12.5 * $scale), (15 * $scale), (17.5 * $scale), (15 * $scale))

  $stroke.Dispose()
  $g.Dispose()
  return $bmp
}

# 主 PNG（256）
$mainBmp = New-IconBitmap -Size $Master
$pngPath = Join-Path $resDir 'icon.png'
$mainBmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "wrote $pngPath"

# 多尺寸 ICO：16/32/48/64/128/256，每张作为 PNG 压缩塞进 ICO
$sizes = @(16, 32, 48, 64, 128, 256)
$bitmaps = @()
foreach ($s in $sizes) {
  if ($s -eq $Master) { $bitmaps += $mainBmp } else { $bitmaps += (New-IconBitmap -Size $s) }
}

$icoPath = Join-Path $resDir 'icon.ico'
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([uint16]0)               # reserved
$bw.Write([uint16]1)               # type = 1 (icon)
$bw.Write([uint16]$sizes.Count)    # count

$pngBytes = @()
foreach ($bmp in $bitmaps) {
  $tmp = New-Object System.IO.MemoryStream
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes += , $tmp.ToArray()
  $tmp.Dispose()
}

$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $bw.Write([byte]($s -band 0xFF))    # width (256 → 0)
  $bw.Write([byte]($s -band 0xFF))    # height
  $bw.Write([byte]0)                   # colors in palette
  $bw.Write([byte]0)                   # reserved
  $bw.Write([uint16]1)                 # color planes
  $bw.Write([uint16]32)                # bits per pixel
  $bw.Write([uint32]$pngBytes[$i].Length)  # size
  $bw.Write([uint32]$offset)               # offset
  $offset += $pngBytes[$i].Length
}

foreach ($bytes in $pngBytes) { $bw.Write($bytes) }

[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()
foreach ($bmp in $bitmaps) { $bmp.Dispose() }
Write-Host "wrote $icoPath"
