[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $ScriptDir '..'))
$Versions = Get-Content (Join-Path $ScriptDir 'versions.json') -Raw | ConvertFrom-Json
$Version = [string]$Versions.node
$ArchiveName = "node-v$Version-win-x64.zip"
$ToolRoot = Join-Path $RepoRoot '.local-tools'
$NodeHome = Join-Path $ToolRoot "node-v$Version-win-x64"
$NodeExe = Join-Path $NodeHome 'node.exe'
$PathFile = Join-Path $ToolRoot 'node-home.txt'
$DownloadDir = Join-Path $RepoRoot '.local-cache\node'
$Archive = Join-Path $DownloadDir $ArchiveName
$ChecksumBaseUrl = "https://nodejs.org/dist/v$Version"

function Test-Node([string]$Exe) {
    if (-not (Test-Path $Exe)) { return $false }
    $actual = (& $Exe -p 'process.versions.node' 2>$null | Out-String).Trim()
    return $LASTEXITCODE -eq 0 -and $actual -eq $Version
}

function Get-ExpectedHash([string]$BaseUrl) {
    $sumsUrl = "$BaseUrl/SHASUMS256.txt"
    $text = (Invoke-WebRequest -UseBasicParsing -Uri $sumsUrl -TimeoutSec 30).Content
    foreach ($line in ($text -split "`r?`n")) {
        if ($line -match '^([a-fA-F0-9]{64})\s+\*?(.+)$' -and $Matches[2].Trim() -eq $ArchiveName) {
            return $Matches[1].ToLowerInvariant()
        }
    }
    throw "No SHA-256 entry for $ArchiveName in $sumsUrl"
}

function Install-FromMirror([string]$BaseUrl) {
    Write-Host "[bootstrap-node] source: $BaseUrl"
    # The archive mirror is not a trust root. Always obtain the checksum
    # manifest from the canonical Node.js distribution host so a mirror cannot
    # replace both the archive and the expected digest.
    $expected = Get-ExpectedHash $ChecksumBaseUrl
    New-Item -ItemType Directory -Path $DownloadDir -Force | Out-Null

    $needsDownload = $true
    if (Test-Path $Archive) {
        $current = (Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash.ToLowerInvariant()
        $needsDownload = $current -ne $expected
    }

    if ($needsDownload) {
        $partial = "$Archive.partial-$PID"
        Remove-Item $partial -Force -ErrorAction SilentlyContinue
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$ArchiveName" -OutFile $partial -TimeoutSec 180
            $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash.ToLowerInvariant()
            if ($actual -ne $expected) {
                throw "Node archive SHA-256 mismatch: expected $expected, got $actual"
            }
            Move-Item -Force $partial $Archive
        }
        finally {
            Remove-Item $partial -Force -ErrorAction SilentlyContinue
        }
    }

    Remove-Item $NodeHome -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $ToolRoot -Force | Out-Null
    Expand-Archive -LiteralPath $Archive -DestinationPath $ToolRoot -Force

    if (-not (Test-Node $NodeExe)) {
        throw "Portable Node was extracted but does not match the pinned Node $Version exactly: $NodeExe"
    }
}

New-Item -ItemType Directory -Path $ToolRoot -Force | Out-Null
if (-not (Test-Node $NodeExe)) {
    if ($env:NODE_DOWNLOAD_BASES) {
        $sources = @($env:NODE_DOWNLOAD_BASES -split '\s+' | Where-Object { $_ -and $_.Trim() })
    }
    else {
        $sources = @(
            "https://nodejs.org/dist/v$Version",
            "https://npmmirror.com/mirrors/node/v$Version"
        )
    }
    if ($sources.Count -eq 0) {
        throw 'NODE_DOWNLOAD_BASES was set but contained no usable mirror URLs.'
    }

    $lastError = $null
    foreach ($source in $sources) {
        try {
            Install-FromMirror $source.TrimEnd('/')
            $lastError = $null
            break
        }
        catch {
            $lastError = $_
            Write-Warning "Node source failed: $source - $($_.Exception.Message)"
        }
    }
    if ($lastError) { throw $lastError }
}

Set-Content -LiteralPath $PathFile -Value $NodeHome -Encoding ASCII
Write-Host "[bootstrap-node] portable Node ready: $NodeHome"
