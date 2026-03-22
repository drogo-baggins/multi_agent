<#
.SYNOPSIS
    SearXNG コンテナ停止スクリプト (Windows PowerShell)
.DESCRIPTION
    SearXNG コンテナを停止・削除します。
    Docker Desktop または Podman を使用します。
.PARAMETER Keep
    コンテナを停止のみ行い、削除しません
.EXAMPLE
    .\scripts\searxng-stop.ps1
    .\scripts\searxng-stop.ps1 -Keep
#>
param(
    [switch]$Keep
)

$ErrorActionPreference = "Stop"

$SEARXNG_CONTAINER = "searxng"

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
    exit 1
}

Write-Host "SearXNG 停止スクリプト (runtime: $Runtime)" -ForegroundColor Cyan
Write-Host ("=" * 56)

function Test-ContainerExists {
    $names = & $Runtime ps -a --format '{{.Names}}' 2>$null
    return ($names -split "`n" | Where-Object { $_.Trim() -eq $SEARXNG_CONTAINER }).Count -gt 0
}

function Test-ContainerRunning {
    $names = & $Runtime ps --format '{{.Names}}' 2>$null
    return ($names -split "`n" | Where-Object { $_.Trim() -eq $SEARXNG_CONTAINER }).Count -gt 0
}

if (-not (Test-ContainerExists)) {
    Write-Host "SearXNG コンテナは存在しません" -ForegroundColor Yellow
    exit 0
}

if (Test-ContainerRunning) {
    Write-Host "コンテナを停止中..." -ForegroundColor Yellow
    & $Runtime stop $SEARXNG_CONTAINER
    Write-Host "[OK] 停止完了" -ForegroundColor Green
}
else {
    Write-Host "コンテナは既に停止しています" -ForegroundColor Yellow
}

if (-not $Keep) {
    Write-Host "コンテナを削除中..." -ForegroundColor Yellow
    & $Runtime rm $SEARXNG_CONTAINER
    Write-Host "[OK] 削除完了" -ForegroundColor Green
}
else {
    Write-Host "--Keep が指定されたため、コンテナは保持されます" -ForegroundColor Yellow
    Write-Host "  再起動: $Runtime start $SEARXNG_CONTAINER"
}

Write-Host ""
Write-Host ("=" * 56)
Write-Host "[OK] 完了" -ForegroundColor Green
