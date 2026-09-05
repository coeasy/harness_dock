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

function Test-Node([string]$Exe) {
    if (-not (Test-Path $Exe)) { return $false }
    & $Exe (Join-Path $ScriptDir 'node-version-check.cjs') *> $null
    return $LASTEXITCODE -eq 0
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
    $expected = Get-ExpectedHash $BaseUrl
    New-Item -ItemType Directory -Path $DownloadDir -Force | Out-Null

    $needsDownload = $true
    if (Test-Path $Archive) {
        $current = (Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash.ToLowerInvariant()
        $needsDownload = $current -ne $expected
    }

    if ($needsDownload) {
        $partial = "$Archive.partial"
        Remove-Item $partial -Force -ErrorAction SilentlyContinue
        Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$ArchiveName" -OutFile $partial -TimeoutSec 180
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            Remove-Item $partial -Force -ErrorAction SilentlyContinue
            throw "Node archive SHA-256 mismatch: expected $expected, got $actual"
        }
        Move-Item -Force $partial $Archive
    }

    Remove-Item $NodeHome -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $ToolRoot -Force | Out-Null
    Expand-Archive -LiteralPath $Archive -DestinationPath $ToolRoot -Force

    if (-not (Test-Node $NodeExe)) {
        throw "Portable Node was extracted but failed the HarnessDock Node version gate: $NodeExe"
    }
}

New-Item -ItemType Directory -Path $ToolRoot -Force | Out-Null
if (-not (Test-Node $NodeExe)) {
    $sources = @(
        "https://nodejs.org/dist/v$Version",
        "https://npmmirror.com/mirrors/node/v$Version"
    )
    $lastError = $null
    foreach ($source in $sources) {
        try {
            Install-FromMirror $source
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
