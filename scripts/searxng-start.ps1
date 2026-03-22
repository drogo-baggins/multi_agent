<#
.SYNOPSIS
    SearXNG コンテナ起動スクリプト (Windows PowerShell)
.DESCRIPTION
    JSON API を有効にした SearXNG コンテナを起動します。
    Docker Desktop (推奨) または Podman を使用します。
.PARAMETER Force
    既に起動中でもコンテナを再作成します
.EXAMPLE
    .\scripts\searxng-start.ps1
    .\scripts\searxng-start.ps1 -Force
#>
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$SEARXNG_CONTAINER = "searxng"
$SEARXNG_PORT = "8888:8080"
$SEARXNG_IMAGE = "docker.io/searxng/searxng"
$MAX_WAIT = 30

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir
$SettingsFile = Join-Path $ProjectRoot "searxng_settings.yml"

function Find-ContainerRuntime {
    foreach ($cmd in @("podman", "docker")) {
        if (Get-Command $cmd -ErrorAction SilentlyContinue) {
            & $cmd info *>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                return $cmd
            }
        }
    }
    return $null
}

$Runtime = Find-ContainerRuntime

if (-not $Runtime) {
    Write-Host "X podman も docker もインストールされていません" -ForegroundColor Red
    Write-Host "  https://docker.com または https://podman.io からインストールしてください"
    exit 1
}

Write-Host "SearXNG 起動スクリプト (runtime: $Runtime)" -ForegroundColor Cyan
Write-Host ("=" * 56)

if (-not (Test-Path $SettingsFile)) {
    Write-Host "X 設定ファイルが見つかりません: $SettingsFile" -ForegroundColor Red
    Write-Host "  プロジェクトルートから実行してください"
    exit 1
}

Write-Host "[OK] 設定ファイル: $SettingsFile" -ForegroundColor Green

function Test-ContainerExists {
    $names = & $Runtime ps -a --format '{{.Names}}' 2>$null
    return ($names -split "`n" | Where-Object { $_.Trim() -eq $SEARXNG_CONTAINER }).Count -gt 0
}

function Test-ContainerRunning {
    $names = & $Runtime ps --format '{{.Names}}' 2>$null
    return ($names -split "`n" | Where-Object { $_.Trim() -eq $SEARXNG_CONTAINER }).Count -gt 0
}

if ((Test-ContainerRunning) -and (-not $Force)) {
    Write-Host "[OK] SearXNG コンテナは既に起動中です" -ForegroundColor Green
    Write-Host "  再作成するには: $($MyInvocation.MyCommand.Definition) -Force"

    Write-Host ""
    Write-Host "JSON API 確認中..." -ForegroundColor Cyan
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:8888/search?q=test&format=json" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        Write-Host "[OK] JSON API 正常動作中" -ForegroundColor Green
        exit 0
    }
    catch {
        Write-Host "WARNING: JSON API が応答しません。-Force で再作成を推奨します" -ForegroundColor Yellow
        exit 1
    }
}

if (Test-ContainerExists) {
    Write-Host ""
    Write-Host "既存コンテナをクリーンアップ..." -ForegroundColor Yellow
    & $Runtime stop $SEARXNG_CONTAINER 2>$null | Out-Null
    & $Runtime rm $SEARXNG_CONTAINER 2>$null | Out-Null
    Write-Host "[OK] クリーンアップ完了" -ForegroundColor Green
}

Write-Host ""
Write-Host "SearXNG コンテナを起動中..." -ForegroundColor Cyan

$SettingsMount = "${SettingsFile}:/etc/searxng/settings.yml:ro"

& $Runtime run -d `
    --name $SEARXNG_CONTAINER `
    -p $SEARXNG_PORT `
    -v $SettingsMount `
    $SEARXNG_IMAGE

if ($LASTEXITCODE -ne 0) {
    Write-Host "X コンテナの起動に失敗しました" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] コンテナ作成完了" -ForegroundColor Green

Write-Host ""
Write-Host "起動待機中..." -ForegroundColor Cyan

$ready = $false
for ($i = 1; $i -le $MAX_WAIT; $i++) {
    try {
        Invoke-WebRequest -Uri "http://localhost:8888/" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
        $ready = $true
        break
    }
    catch {
        Write-Host "  待機中... ($i/$MAX_WAIT)" -NoNewline
        Write-Host "`r" -NoNewline
        Start-Sleep -Seconds 1
    }
}

if (-not $ready) {
    Write-Host ""
    Write-Host "X SearXNG の起動がタイムアウトしました (${MAX_WAIT}秒)" -ForegroundColor Red
    Write-Host ""
    Write-Host "ログ:"
    & $Runtime logs $SEARXNG_CONTAINER 2>&1 | Select-Object -Last 20
    exit 1
}

Write-Host "[OK] SearXNG が応答しています" -ForegroundColor Green

Write-Host ""
Write-Host "JSON API を検証中..." -ForegroundColor Cyan
Start-Sleep -Seconds 2

try {
    $response = Invoke-WebRequest -Uri "http://localhost:8888/search?q=test&format=json" -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    $body = $response.Content

    if ($body -match '"results"') {
        Write-Host "[OK] JSON API 正常動作" -ForegroundColor Green
        Write-Host ""
        Write-Host ("=" * 56)
        Write-Host "SearXNG 起動完了" -ForegroundColor Green
        Write-Host ""
        Write-Host "  URL:      http://localhost:8888"
        Write-Host "  JSON API: http://localhost:8888/search?q=test&format=json"
        Write-Host "  停止:     .\scripts\searxng-stop.ps1"
    }
    else {
        Write-Host "WARNING: JSON API が正常に応答していません" -ForegroundColor Yellow
        Write-Host "  レスポンス: $($body.Substring(0, [Math]::Min(200, $body.Length)))"
        Write-Host ""
        Write-Host "  設定ファイルの search.formats に json が含まれているか確認してください"
        exit 1
    }
}
catch {
    Write-Host "WARNING: JSON API に接続できません: $_" -ForegroundColor Yellow
    exit 1
}
