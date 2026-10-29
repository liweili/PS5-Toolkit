Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

# Background: blue gradient (PlayStation-ish)
$rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,
    [System.Drawing.Color]::FromArgb(0, 55, 145),
    [System.Drawing.Color]::FromArgb(0, 120, 215),
    [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
$g.FillRectangle($brush, $rect)
$brush.Dispose()

# Rounded inner panel
$panel = New-Object System.Drawing.Rectangle(20, 20, 216, 216)
$gPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 40
$gPath.AddArc($panel.X, $panel.Y, $radius, $radius, 180, 90)
$gPath.AddArc($panel.Right - $radius, $panel.Y, $radius, $radius, 270, 90)
$gPath.AddArc($panel.Right - $radius, $panel.Bottom - $radius, $radius, $radius, 0, 90)
$gPath.AddArc($panel.X, $panel.Bottom - $radius, $radius, $radius, 90, 90)
$gPath.CloseFigure()
$g.FillPath([System.Drawing.Brushes]::White, $gPath)

# "PS5" text - bold, blue
$font = New-Object System.Drawing.Font("Segoe UI", 72, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$rectF = New-Object System.Drawing.RectangleF(0, 0, 256, 256)
$g.DrawString("PS5", $font, [System.Drawing.Brushes]::SteelBlue, $rectF, $sf)

# Small underline accent
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(0, 120, 215), 6)
$g.DrawLine($pen, 80, 160, 176, 160)
$pen.Dispose()

$g.Dispose()

# Save as ICO - write manually to support 256x256 PNG-compressed icon
$icoPath = Join-Path $PSScriptRoot 'app.ico'

# Save PNG to memory stream
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $ms.ToArray()
$ms.Dispose()
$bmp.Dispose()

# Build ICO file header + directory entry + PNG data
$bw = New-Object System.IO.BinaryWriter([System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create))
# ICONDIR
$bw.Write([UInt16]0)       # reserved
$bw.Write([UInt16]1)       # type (1=icon)
$bw.Write([UInt16]1)       # count
# ICONDIRENTRY
$bw.Write([Byte]0)         # width (0 = 256)
$bw.Write([Byte]0)         # height (0 = 256)
$bw.Write([Byte]0)         # color count
$bw.Write([Byte]0)         # reserved
$bw.Write([UInt16]1)       # planes
$bw.Write([UInt16]32)      # bit count
$bw.Write([UInt32]$pngBytes.Length)  # size
$bw.Write([UInt32]22)      # offset (6 + 16 = 22)
# PNG data
$bw.Write($pngBytes)
$bw.Close()

Write-Host "Icon created: $icoPath" -ForegroundColor Green
Write-Host ("Size: {0:N0} bytes" -f (Get-Item $icoPath).Length)
