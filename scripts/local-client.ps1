[CmdletBinding()]
param(
    [ValidateSet('quick', 'build', 'smoke')]
    [string]$Mode = 'quick',

    [switch]$Install,
    [switch]$Clean,
    [switch]$SkipTests,
    [switch]$NoLaunch,
    [switch]$CloseAfterSmoke,
    [int]$TimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $ScriptDir '..'))
$CargoManifest = Join-Path $RepoRoot 'apps\tauri\src-tauri\Cargo.toml'
$LogDir = Join-Path $RepoRoot '.local-logs'
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$TranscriptPath = Join-Path $LogDir "local-client-$Timestamp.log"

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    Write-Host "> $FilePath $($Arguments -join ' ')"
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
    }
}

function Resolve-RequiredCommand([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "Required command '$Name' was not found on PATH."
    }
    return $command.Source
}

function Stop-ExistingHarnessDock {
    $processes = @(Get-Process -Name 'harnessdock-tauri' -ErrorAction SilentlyContinue)
    if ($processes.Count -eq 0) {
        return
    }

    Write-Step 'Stopping an existing HarnessDock process so this run tests the newly built binary'
    $processes | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

function Get-CargoTargetDirectory([string]$CargoPath, [string]$ManifestPath) {
    $metadataText = & $CargoPath metadata --format-version 1 --no-deps --manifest-path $ManifestPath
    if ($LASTEXITCODE -ne 0) {
        throw 'cargo metadata failed while resolving the Tauri target directory.'
    }
    $metadata = $metadataText | ConvertFrom-Json
    return [string]$metadata.target_directory
}

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
        if (-not $response.IsSuccessStatusCode) {
            return $false
        }
        $contentType = [string]$response.Content.Headers.ContentType
        if ($contentType -and $contentType -notmatch '(?i)text/html') {
            return $false
        }
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        return $body -match '(?i)<!doctype\s+html|<html(?:\s|>)'
    }
    catch {
        return $false
    }
}

function Invoke-PackagedStartupSmoke(
    [string]$InstallerPath,
    [int]$Timeout,
    [switch]$CloseWhenDone
) {
    $tempRoot = [IO.Path]::GetTempPath()
    $traceDir = Join-Path $tempRoot 'harnessdock-logs'

    if (Test-Path $traceDir) {
        Get-ChildItem $traceDir -Filter 'startup-*.log' -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }

    Get-ChildItem $tempRoot -Directory -Filter 'harnessdock-tauri-*' -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

    $installDir = Join-Path $tempRoot 'HarnessDockLocalSmoke'
    Remove-Item $installDir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $installDir | Out-Null

    Write-Step "Installing the freshly built NSIS package into $installDir"
    $install = Start-Process -FilePath $InstallerPath -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
    if ($install.ExitCode -ne 0) {
        throw "NSIS silent install failed with exit code $($install.ExitCode)."
    }

    $app = Get-ChildItem $installDir -Recurse -File -Filter 'harnessdock-tauri.exe' |
        Select-Object -First 1
    if (-not $app) {
        throw "Installed harnessdock-tauri.exe was not found under $installDir."
    }

    $neutralCwd = Join-Path $tempRoot 'HarnessDockLocalNeutralCwd'
    Remove-Item $neutralCwd -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $neutralCwd | Out-Null

    Stop-ExistingHarnessDock
    Write-Step 'Launching the installed client and verifying Harness Web startup'
    $hostProcess = Start-Process -FilePath $app.FullName -WorkingDirectory $neutralCwd -PassThru
    $webSession = $null
    $passed = $false

    try {
        $deadline = (Get-Date).AddSeconds($Timeout)
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
                    throw 'Client entered recovery before Harness Web became primary.'
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
                        throw 'ready.json contains an invalid loopback endpoint.'
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
                            Write-Host '[smoke] Harness Web launch-token exchange passed.'
                        }
                    }
                    elseif (Test-HarnessWebHtml $webSession.Client $cleanUrl) {
                        $healthyCleanProbes += 1
                        Write-Host "[smoke] Harness Web clean-URL probe $healthyCleanProbes/2 passed."
                    }
                    else {
                        $healthyCleanProbes = 0
                    }
                }
                catch {
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
                $passed = $true
                Write-Host '`nPASS: local packaged client reached primary Harness Web and served stable authenticated HTML.' -ForegroundColor Green
                Write-Host "Installed test binary: $($app.FullName)"
                Write-Host "HarnessDock PID: $($hostProcess.Id)"
                break
            }

            if ($hostProcess.HasExited) {
                throw "HarnessDock exited before healthy primary Harness Web; exit=$($hostProcess.ExitCode)."
            }
        }

        if (-not $passed) {
            throw "Timed out after $Timeout seconds waiting for healthy primary Harness Web. Last startup trace:`n$content"
        }
    }
    finally {
        Close-HarnessWebSession $webSession
        if ($hostProcess -and -not $hostProcess.HasExited -and ((-not $passed) -or $CloseWhenDone)) {
            taskkill /PID $hostProcess.Id /T /F | Out-Null
        }
    }
}

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Start-Transcript -Path $TranscriptPath -Append | Out-Null

try {
    Set-Location $RepoRoot
    if (-not (Test-Path (Join-Path $RepoRoot 'package.json'))) {
        throw "package.json was not found under $RepoRoot."
    }

    Write-Host "HarnessDock local client runner"
    Write-Host "Repository : $RepoRoot"
    Write-Host "Mode       : $Mode"
    Write-Host "Log        : $TranscriptPath"

    # Local build tooling still needs pnpm/cargo. We intentionally do not run
    # node-version-check.cjs or bootstrap.mjs here: this fast path reuses the
    # developer environment and the already bundled Harness Runtime.
    $pnpm = Resolve-RequiredCommand 'pnpm.cmd'
    $cargo = Resolve-RequiredCommand 'cargo.exe'

    if ($Install -or -not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
        Write-Step 'Installing workspace dependencies'
        Invoke-Native $pnpm @('install', '--frozen-lockfile', '--prefer-offline')
    }
    else {
        Write-Host '[deps] node_modules exists; skipping pnpm install. Use -Install to refresh it.'
    }

    if ($Clean) {
        Write-Step 'Cleaning the Rust target directory'
        Invoke-Native $cargo @('clean', '--manifest-path', $CargoManifest)
    }

    switch ($Mode) {
        'quick' {
            if ($NoLaunch) {
                throw '-NoLaunch is not applicable to -Mode quick. Use -Mode build for build-only.'
            }
            Stop-ExistingHarnessDock
            Write-Step 'Starting fast incremental Tauri development build'
            Write-Host 'This compiles the changed Rust/JS pieces and opens HarnessDock automatically.'
            Invoke-Native $pnpm @('--filter', '@dsh/tauri', 'tauri:dev')
        }

        'build' {
            Write-Step 'Building the release client'
            $buildArgs = @('scripts/build.mjs', '--skip-install')
            if ($SkipTests) { $buildArgs += '--skip-tests' }
            Invoke-Native (Resolve-RequiredCommand 'node.exe') $buildArgs

            $targetDir = Get-CargoTargetDirectory $cargo $CargoManifest
            $installer = Get-ChildItem $targetDir -Recurse -File -Filter '*setup.exe' -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
            if ($installer) {
                Write-Host "Build output: $($installer.FullName)" -ForegroundColor Green
            }
            else {
                Write-Host "Build completed. Cargo target directory: $targetDir" -ForegroundColor Green
            }

            if (-not $NoLaunch) {
                Write-Host 'Build-only mode does not run an unpackaged release binary. Use -Mode smoke to install and launch the exact NSIS package.'
            }
        }

        'smoke' {
            Write-Step 'Building the release client for packaged startup smoke'
            $buildArgs = @('scripts/build.mjs', '--skip-install')
            if ($SkipTests) { $buildArgs += '--skip-tests' }
            Invoke-Native (Resolve-RequiredCommand 'node.exe') $buildArgs

            $targetDir = Get-CargoTargetDirectory $cargo $CargoManifest
            $installer = Get-ChildItem $targetDir -Recurse -File -Filter '*setup.exe' -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
            if (-not $installer) {
                throw "Tauri build succeeded, but no NSIS *setup.exe was found under $targetDir."
            }

            Write-Host "Built installer: $($installer.FullName)"
            if ($NoLaunch) {
                Write-Host '-NoLaunch requested; packaged startup smoke was skipped.'
            }
            else {
                Invoke-PackagedStartupSmoke -InstallerPath $installer.FullName -Timeout $TimeoutSeconds -CloseWhenDone:$CloseAfterSmoke
            }
        }
    }
}
catch {
    Write-Host "`nFAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    Set-Location $RepoRoot
    try { Stop-Transcript | Out-Null } catch { }
}
