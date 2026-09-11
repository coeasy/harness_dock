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
$installDir = Join-Path $tempRoot 'HarnessDockInstallerSmoke'
$neutralCwd = Join-Path $tempRoot 'HarnessDockInstallerSmokeNeutralCwd'

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

function Get-InstalledProcessSnapshot([string]$Root) {
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    return @(
        Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object {
                $path = [string]$_.ExecutablePath
                -not [string]::IsNullOrWhiteSpace($path) -and
                    $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
            } |
            Select-Object ProcessId, ParentProcessId, Name, ExecutablePath
    )
}

function Write-ProcessSnapshot($Processes, [string]$Prefix) {
    foreach ($process in @($Processes)) {
        Write-Host "$Prefix pid=$($process.ProcessId) ppid=$($process.ParentProcessId) name=$($process.Name) path=$($process.ExecutablePath)"
    }
}

function Wait-InstalledProcessesGone([string]$Root, [int]$TimeoutSeconds = 10) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $remaining = @(Get-InstalledProcessSnapshot $Root)
        if ($remaining.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    $remaining = @(Get-InstalledProcessSnapshot $Root)
    Write-ProcessSnapshot $remaining '[smoke] leaked process:'
    throw "HarnessDock graceful exit left $($remaining.Count) process(es) running from $Root"
}

# Ensure a previous failed runner attempt cannot contaminate this lifecycle
# smoke. Kill the whole previous HarnessDock tree, not only its GUI parent.
Get-Process -Name 'harnessdock-tauri' -ErrorAction SilentlyContinue | ForEach-Object {
    taskkill /PID $_.Id /T /F | Out-Null
}
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
    $startupPassed = $false

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
            $startupPassed = $true
            Write-Host 'PASS: installed Windows candidate reached primary Harness Web with stable cookie-authenticated HTML'
            break
        }

        if ($hostProcess.HasExited) {
            throw "HarnessDock exited before healthy primary Harness Web; exit=$($hostProcess.ExitCode)"
        }
    }

    if (-not $startupPassed) {
        throw "Timed out waiting for healthy primary Harness Web. readyUrl=$readyUrl authenticated=$authenticated healthyCleanProbes=$healthyCleanProbes Last trace:`n$content"
    }

    # Prove this test is observing the packaged Runtime rather than merely the
    # GUI process. At least one bundled node.exe must be alive under installDir
    # before the graceful close is requested.
    $managedBeforeExit = @(Get-InstalledProcessSnapshot $installDir)
    Write-ProcessSnapshot $managedBeforeExit '[smoke] managed before exit:'
    $runtimeNodes = @($managedBeforeExit | Where-Object { $_.Name -ieq 'node.exe' })
    if ($runtimeNodes.Count -eq 0) {
        throw 'Packaged Harness Web became ready without an observable bundled node.exe Runtime process'
    }

    # CloseMainWindow sends the normal window-close request. HarnessDock must
    # route it through supervisor::request_exit, revoke the RuntimeLease, stop
    # Gateway/starting helpers, terminate the Runtime tree, wait, and only then
    # let the GUI process exit. No taskkill is allowed on the success path.
    Close-HarnessWebSession $webSession
    $webSession = $null
    $hostProcess.Refresh()
    if (-not $hostProcess.CloseMainWindow()) {
        throw 'Unable to send a normal close request to the visible HarnessDock window'
    }
    if (-not $hostProcess.WaitForExit(45000)) {
        throw 'HarnessDock did not exit through its supervised close path within 45 seconds'
    }

    Wait-InstalledProcessesGone $installDir 10
    Write-Host 'PASS: graceful HarnessDock exit left zero installed Runtime/Node/Host processes'
}
finally {
    Close-HarnessWebSession $webSession
    if ($hostProcess -and -not $hostProcess.HasExited) {
        taskkill /PID $hostProcess.Id /T /F | Out-Null
    }
    # Test failures must not contaminate the hosted runner. This cleanup is only
    # a fallback after the assertions above and cannot turn a failed graceful
    # shutdown into a passing result.
    $leftovers = @(Get-InstalledProcessSnapshot $installDir)
    foreach ($process in $leftovers) {
        taskkill /PID $process.ProcessId /T /F | Out-Null
    }
}
