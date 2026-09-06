[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [int]$TimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$InstallerPath = [IO.Path]::GetFullPath($InstallerPath)
if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw "Installer does not exist: $InstallerPath"
}

$tempRoot = [IO.Path]::GetTempPath()
$traceDir = Join-Path $tempRoot 'harnessdock-logs'
$installDir = Join-Path $tempRoot 'HarnessDockOneClickSmoke'
$neutralCwd = Join-Path $tempRoot 'HarnessDockOneClickNeutralCwd'

function New-HarnessWebSession {
    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $true
    $handler.UseCookies = $true
    $handler.CookieContainer = [System.Net.CookieContainer]::new()
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(5)
    return @{ Handler = $handler; Client = $client }
}

function Close-HarnessWebSession($Session) {
    if ($null -ne $Session) {
        if ($null -ne $Session.Client) { $Session.Client.Dispose() }
        if ($null -ne $Session.Handler) { $Session.Handler.Dispose() }
    }
}

function Get-HarnessCleanUrl([string]$Url) {
    $builder = [System.UriBuilder]::new([System.Uri]$Url)
    $builder.Path = '/'
    $builder.Query = ''
    $builder.Fragment = ''
    return $builder.Uri.AbsoluteUri
}

function Test-HarnessWebHtml($Client, [string]$Url) {
    try {
        $response = $Client.GetAsync($Url).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { return $false }
        $contentType = [string]$response.Content.Headers.ContentType
        if ($contentType -and $contentType -notmatch '(?i)text/html') { return $false }
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        return $body -match '(?i)<!doctype\s+html|<html(?:\s|>)'
    }
    catch {
        Write-Host "[smoke] Harness Web probe failed: $($_.Exception.Message)"
        return $false
    }
}

Get-Process -Name 'harnessdock-tauri' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if (Test-Path $traceDir) {
    Get-ChildItem $traceDir -Filter 'startup-*.log' -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
}
Get-ChildItem $tempRoot -Directory -Filter 'harnessdock-tauri-*' -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $installDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $neutralCwd -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $installDir | Out-Null
New-Item -ItemType Directory -Path $neutralCwd | Out-Null

Write-Host "[smoke] Installing $InstallerPath"
$install = Start-Process -FilePath $InstallerPath -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
if ($install.ExitCode -ne 0) {
    throw "NSIS silent install failed with exit code $($install.ExitCode)"
}

$app = Get-ChildItem $installDir -Recurse -File -Filter 'harnessdock-tauri.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $app) {
    Get-ChildItem $installDir -Recurse -Force -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Host $_.FullName }
    throw "Installed harnessdock-tauri.exe not found under $installDir"
}

Write-Host "[smoke] Launching installed client from neutral cwd: $neutralCwd"
$hostProcess = Start-Process -FilePath $app.FullName -WorkingDirectory $neutralCwd -PassThru
$webSession = $null
try {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $content = ''
    $readyUrl = $null
    $cleanUrl = $null
    $authenticated = $false
    $healthyCleanProbes = 0

    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500

        $trace = Get-ChildItem $traceDir -Filter 'startup-*.log' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($trace) {
            $content = Get-Content $trace.FullName -Raw
            $hasRecovery = $content -match 'phase=recovery'
            $hasVisible = $content -match 'phase=primary_visible'
            if ($hasRecovery -and -not $hasVisible) {
                throw 'Installed client entered recovery before Harness Web became primary.'
            }
        }

        $ready = Get-ChildItem $tempRoot -Directory -Filter 'harnessdock-tauri-*' -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem $_.FullName -File -Filter 'ready.json' -ErrorAction SilentlyContinue } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1

        if ($ready) {
            try {
                $readyJson = Get-Content $ready.FullName -Raw | ConvertFrom-Json
                if ($readyJson.host -ne '127.0.0.1' -or [int]$readyJson.port -le 0) {
                    throw "invalid ready.json endpoint: host=$($readyJson.host) port=$($readyJson.port)"
                }
                $candidateUrl = [string]$readyJson.url
                if ($candidateUrl -ne $readyUrl) {
                    Close-HarnessWebSession $webSession
                    $webSession = New-HarnessWebSession
                    $readyUrl = $candidateUrl
                    $cleanUrl = Get-HarnessCleanUrl $readyUrl
                    $authenticated = $false
                    $healthyCleanProbes = 0
                }

                if (-not $authenticated) {
                    if (Test-HarnessWebHtml $webSession.Client $readyUrl) {
                        $authenticated = $true
                        Write-Host '[smoke] launch-token exchange passed'
                    }
                }
                elseif (Test-HarnessWebHtml $webSession.Client $cleanUrl) {
                    $healthyCleanProbes += 1
                    Write-Host "[smoke] authenticated clean-URL probe $healthyCleanProbes/2 passed"
                }
                else {
                    $healthyCleanProbes = 0
                }
            }
            catch {
                Write-Host "[smoke] ready.json not usable yet: $($_.Exception.Message)"
                $authenticated = $false
                $healthyCleanProbes = 0
            }
        }

        if (
            $content -match 'phase=runtime_ready' -and
            $content -match 'phase=webview_requested' -and
            $content -match 'phase=primary_visible' -and
            $authenticated -and
            $healthyCleanProbes -ge 2
        ) {
            Write-Host 'PASS: one-click-built Windows installer reached primary Harness Web with stable cookie-authenticated HTML'
            exit 0
        }

        if ($hostProcess.HasExited) {
            throw "HarnessDock exited before healthy primary Harness Web; exit=$($hostProcess.ExitCode)"
        }
    }

    throw "Timed out waiting for healthy primary Harness Web. readyUrl=$readyUrl authenticated=$authenticated healthyCleanProbes=$healthyCleanProbes Last trace:`n$content"
}
finally {
    Close-HarnessWebSession $webSession
    if ($hostProcess -and -not $hostProcess.HasExited) {
        taskkill /PID $hostProcess.Id /T /F | Out-Null
    }
}
