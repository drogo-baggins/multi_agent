<#
.SYNOPSIS
    調査プロジェクトをリセットして新規調査の準備をする (Windows PowerShell)
.DESCRIPTION
    APPEND_SYSTEM.md・changelog.md・バックアップ・ループ状態・
    workspace 成果物をクリアし、次の調査が白紙の状態から始められるようにする。
.EXAMPLE
    .\scripts\new-project.ps1
    npm run new-project
#>

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Host "調査プロジェクトをリセットしています..." -ForegroundColor Cyan

# Blank out agent system prompt extensions
foreach ($agent in @("worker", "manager")) {
    $path = Join-Path $ProjectRoot "agents\$agent\APPEND_SYSTEM.md"
    if (Test-Path $path) {
        Clear-Content $path
    }
}

# Clear worker changelog
$changelog = Join-Path $ProjectRoot "agents\worker\changelog.md"
if (Test-Path $changelog) {
    Clear-Content $changelog
}

# Remove worker backups
$backups = Join-Path $ProjectRoot "agents\worker\backups"
if (Test-Path $backups) {
    Remove-Item -Recurse -Force $backups
}

# Remove runtime loop state
Get-ChildItem -Path $ProjectRoot -Filter "loop-state.json" -Recurse -ErrorAction SilentlyContinue |
    Remove-Item -Force

# Clear workspace artifacts (logs, output)
foreach ($dir in @("logs", "output")) {
    $target = Join-Path $ProjectRoot "workspace\$dir"
    if (Test-Path $target) {
        Remove-Item -Recurse -Force $target
    }
    New-Item -ItemType Directory -Force $target | Out-Null
}

Write-Host "完了。新しい調査プロジェクトを開始できます。" -ForegroundColor Green
