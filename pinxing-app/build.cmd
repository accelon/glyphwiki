@echo off
rem ============================================================================
rem  build.cmd -- ASCII-only entry point for the build.
rem
rem  WHY THIS EXISTS (do not translate this file, keep it pure ASCII):
rem
rem  build.ps1 has Chinese comments and messages. Windows PowerShell 5.1 reads
rem  a .ps1 as ANSI/GBK when it has NO UTF-8 BOM; the Chinese bytes then get
rem  mangled and break string terminators, producing a confusing
rem  "Missing closing '}' in statement block" error that has nothing to do
rem  with the actual problem. Editors usually do NOT preserve the BOM, so every
rem  edit of build.ps1 risks that failure.
rem
rem  This wrapper re-adds the BOM before invoking build.ps1. It is written in
rem  pure ASCII on purpose: cmd.exe reads .cmd files as ANSI too, so Chinese
rem  text here would break *this* file the same way.
rem
rem  USAGE (same args as build.ps1):
rem    build.cmd            build
rem    build.cmd -Test      run vet + test first
rem    build.cmd -Dev       dev build (DevTools enabled)
rem    build.cmd -Run       build then run
rem ============================================================================
setlocal
set "PS1=%~dp0build.ps1"
if not exist "%PS1%" (
  echo build.cmd: cannot find "%PS1%"
  exit /b 2
)

powershell -NoProfile -Command "$p='%PS1%'; $b=[IO.File]::ReadAllBytes($p); if (-not ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)) { $t=[IO.File]::ReadAllText($p, (New-Object Text.UTF8Encoding($false))); [IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($true))); Write-Host 'build.cmd: build.ps1 had no UTF-8 BOM; added it' }"
if errorlevel 1 (
  echo build.cmd: failed to check/fix the BOM on build.ps1
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
exit /b %ERRORLEVEL%
