# Regenerates HarnessDock icon derivatives from the canonical brand source.
# The source app-icon.png is never overwritten: color adjustment and tight-fill
# happen on temporary working files so repeated runs are deterministic.
# Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts/regenerate-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'apps\tauri\src-tauri\icons'
$source = Join-Path $build 'app-icon.png'
$processedTmp = Join-Path $build '.app-icon-regenerated-color.png'
$normalizedTmp = Join-Path $build '.app-icon-regenerated-tightfill.png'
$normalizer = Join-Path $root 'apps\tauri\scripts\normalize-icon.mjs'

if (-not (Test-Path $source)) { throw "missing canonical icon source: $source" }
if (-not (Test-Path $normalizer)) { throw "missing icon normalizer: $normalizer" }

# Brand teal gradient (matches the splash logo) + a slightly lifted navy base.
$tealHigh = [System.Drawing.Color]::FromArgb(127, 231, 214)   # #7fe7d6
$tealLow  = [System.Drawing.Color]::FromArgb(35, 183, 160)    # #23b7a0
$bgNew    = [System.Drawing.Color]::FromArgb(12, 44, 74)      # #0c2c4a

function Process-Pixels([System.Drawing.Bitmap]$bmp) {
  for ($y = 0; $y -lt $bmp.Height; $y++) {
    for ($x = 0; $x -lt $bmp.Width; $x++) {
      $c = $bmp.GetPixel($x, $y)
      if ($c.A -lt 12) { continue }
      $lum = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
      if ($lum -ge 90) {
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
        $r = [int]($c.R * 0.3 + $bgNew.R * 0.7)
        $g = [int]($c.G * 0.3 + $bgNew.G * 0.7)
        $b = [int]($c.B * 0.3 + $bgNew.B * 0.7)
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($c.A, $r, $g, $b))
      }
    }
  }
}

function Save-ResizedPng([string]$inputPath, [int]$size, [string]$outputPath) {
  $src = New-Object System.Drawing.Bitmap($inputPath)
  $dst = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $size, $size)
  $dst.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $dst.Dispose(); $src.Dispose()
}

try {
  $bmp = New-Object System.Drawing.Bitmap($source)
  if ($bmp.PixelFormat -band [System.Drawing.Imaging.PixelFormat]::Indexed) {
    $converted = New-Object System.Drawing.Bitmap($bmp.Width, $bmp.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($converted)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($bmp, 0, 0, $bmp.Width, $bmp.Height)
    $g.Dispose(); $bmp.Dispose(); $bmp = $converted
  }
  Process-Pixels $bmp
  $bmp.Save($processedTmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

  & node $normalizer $processedTmp $normalizedTmp
  if ($LASTEXITCODE -ne 0) { throw "icon normalizer failed with exit code $LASTEXITCODE" }

  # Refresh PNG derivatives from the same tight-fill working image.
  Save-ResizedPng $normalizedTmp 32 (Join-Path $build '32x32.png')
  Save-ResizedPng $normalizedTmp 128 (Join-Path $build '128x128.png')
  Save-ResizedPng $normalizedTmp 256 (Join-Path $build '128x128@2x.png')
  Save-ResizedPng $normalizedTmp 256 (Join-Path $build 'icon.png')

  # Rebuild a multi-size Windows ICO. The normal Tauri build additionally
  # regenerates ICNS/mobile assets from the same tight-fill source.
  $icoPath = Join-Path $build 'icon.ico'
  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $pngData = @{}
  foreach ($size in $sizes) {
    $tmpPng = Join-Path $build ".app-icon-$size.tmp.png"
    Save-ResizedPng $normalizedTmp $size $tmpPng
    $pngData[$size] = [System.IO.File]::ReadAllBytes($tmpPng)
    Remove-Item -Force $tmpPng
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
    $bw.Write([byte]$b); $bw.Write([byte]$b)
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$data.Length); $bw.Write([uint32]$offset)
    $offset += $data.Length
  }
  foreach ($size in $sizes) { $bw.Write($pngData[$size]) }
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($icoPath, $ico.ToArray())
  $bw.Dispose(); $ico.Dispose()

  Write-Host "regenerated tight-fill icon derivatives from canonical source: $source"
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $processedTmp, $normalizedTmp
}
