<#
.SYNOPSIS
    Reset investigation project artifacts for a fresh run on Windows.
.DESCRIPTION
    Clears agent prompt extensions, changelog, backups, runtime loop state,
    and workspace artifacts so the next investigation starts clean.
.EXAMPLE
    .\scripts\new-project.ps1
    npm run new-project
#>

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Host "Resetting investigation project artifacts..." -ForegroundColor Cyan

foreach ($agent in @("worker", "manager")) {
    $path = Join-Path $ProjectRoot "agents\$agent\APPEND_SYSTEM.md"
    if (Test-Path $path) {
        Clear-Content $path
    }
}

$changelog = Join-Path $ProjectRoot "agents\worker\changelog.md"
if (Test-Path $changelog) {
    Clear-Content $changelog
}

$backups = Join-Path $ProjectRoot "agents\worker\backups"
if (Test-Path $backups) {
    Remove-Item -Recurse -Force $backups
}

Get-ChildItem -Path $ProjectRoot -Filter "loop-state.json" -Recurse -ErrorAction SilentlyContinue |
    Remove-Item -Force

foreach ($dir in @("logs", "output")) {
    $target = Join-Path $ProjectRoot "workspace\$dir"
    if (Test-Path $target) {
        Remove-Item -Recurse -Force $target
    }
    New-Item -ItemType Directory -Force $target | Out-Null
}

Remove-Item -Force (Join-Path $ProjectRoot "workspace\task-plan.md") -ErrorAction SilentlyContinue

Write-Host "Done. Ready for a new investigation project." -ForegroundColor Green