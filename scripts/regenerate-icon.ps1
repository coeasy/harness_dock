# Regenerates the HarnessDock app icons from the brand source: brightens and
# cyan-izes the existing logo (white/dark -> teal gradient), then rebuilds the
# multi-size .ico. Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts/regenerate-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'apps\tauri\src-tauri\icons'
$sources = @(
  (Join-Path $build 'app-icon.png')
)

# Brand teal gradient (matches the splash logo) + a slightly lifted navy base.
$tealHigh = [System.Drawing.Color]::FromArgb(127, 231, 214)   # #7fe7d6
$tealLow  = [System.Drawing.Color]::FromArgb(35, 183, 160)    # #23b7a0
$bgNew    = [System.Drawing.Color]::FromArgb(12, 44, 74)      # #0c2c4a (lifted navy-teal)

function Process-Pixels([System.Drawing.Bitmap]$bmp) {
  for ($y = 0; $y -lt $bmp.Height; $y++) {
    for ($x = 0; $x -lt $bmp.Width; $x++) {
      $c = $bmp.GetPixel($x, $y)
      if ($c.A -lt 12) { continue } # keep transparency
      $lum = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
      if ($lum -ge 90) {
        # Logo strokes: map brightness onto the teal gradient, keep a white
        # specular on the very brightest so the mark still reads.
        $t = [Math]::Min(1, [Math]::Max(0, ($lum - 90) / 165))
        if ($lum -ge 235) {
          $r = [int](255 * 0.45 + $tealHigh.R * 0.55)
          $g = [int](255 * 0.45 + $tealHigh.G * 0.55)
          $b = [int](255 * 0.45 + $tealHigh.B * 0.55)
        } else {
          $r = [int]($tealLow.R + ($tealHigh.R - $tealLow.R) * $t)
          $g = [int]($tealLow.G + ($tealHigh.G - $tealLow.G) * $t)
          $b = [int]($tealLow.B + ($tealHigh.B - $tealLow.B) * $t)
        }
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($c.A, $r, $g, $b))
      } else {
        # Dark background: lift slightly toward the teal-tinted navy.
        $r = [int]($c.R * 0.3 + $bgNew.R * 0.7)
        $g = [int]($c.G * 0.3 + $bgNew.G * 0.7)
        $b = [int]($c.B * 0.3 + $bgNew.B * 0.7)
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($c.A, $r, $g, $b))
      }
    }
  }
}

foreach ($src in $sources) {
  if (-not (Test-Path $src)) { Write-Host "skip missing: $src"; continue }
  $bmp = New-Object System.Drawing.Bitmap($src)
  # Indexed (palette) formats cannot use SetPixel; convert to 32bpp ARGB first.
  if ($bmp.PixelFormat -band [System.Drawing.Imaging.PixelFormat]::Indexed) {
    $converted = New-Object System.Drawing.Bitmap($bmp.Width, $bmp.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($converted)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($bmp, 0, 0, $bmp.Width, $bmp.Height)
    $g.Dispose()
    $bmp.Dispose()
    $bmp = $converted
    Write-Host "converted indexed -> 32bpp: $src"
  }
  Process-Pixels $bmp
  # GDI+ cannot save back to the same path it loaded from; go via a temp file.
  $tmp = "$src.regenerated.tmp"
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Move-Item -Force $tmp $src
  Write-Host "processed: $src"
}

# ---- rebuild a multi-size .ico from the processed 256px source ----
$src256 = Join-Path $build 'app-icon.png'
$icoPath = Join-Path $build 'icon.ico'
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngData = @{}
foreach ($size in $sizes) {
  $src = New-Object System.Drawing.Bitmap($src256)
  $dst = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($src, 0, 0, $size, $size)
  $ms = New-Object System.IO.MemoryStream
  $dst.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngData[$size] = $ms.ToArray()
  $ms.Dispose(); $g.Dispose(); $dst.Dispose(); $src.Dispose()
}

$count = $sizes.Count
$headerSize = 6 + 16 * $count
$ico = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ico)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$count)
$offset = $headerSize
foreach ($size in $sizes) {
  $data = $pngData[$size]
  $b = if ($size -eq 256) { 0 } else { $size }
  $bw.Write([byte]$b)                     # width (0 = 256)
  $bw.Write([byte]$b)                     # height
  $bw.Write([byte]0)                      # palette
  $bw.Write([byte]0)                      # reserved
  $bw.Write([uint16]1)                    # color planes
  $bw.Write([uint16]32)                   # bpp
  $bw.Write([uint32]$data.Length)         # bytes in resource
  $bw.Write([uint32]$offset)              # image offset
  $offset += $data.Length
}
foreach ($size in $sizes) { $bw.Write($pngData[$size]) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $ico.ToArray())
$bw.Dispose(); $ico.Dispose()
Write-Host "rebuilt: $icoPath ($count sizes)"

# also refresh icon.png (256 alias used by docs)
$iconPng = Join-Path $build 'icon.png'
if (Test-Path $iconPng) {
  Copy-Item $src256 $iconPng -Force
  Write-Host "synced: $iconPng"
}
Write-Host 'done'
