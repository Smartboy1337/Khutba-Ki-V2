@echo off
setlocal
cd /d "%~dp0"
title Khutbah AI - Update Release erstellen
echo.
echo ===================================================
echo        KHUTBAH AI - UPDATE VERTEILEN
 echo ===================================================
echo.
if not exist "package.json" goto :failure
where npm.cmd >nul 2>&1 || goto :failure
node.exe -e "const p=require('./package.json');if(!p.build||!p.build.publish||!p.dependencies['electron-updater'])process.exit(1);console.log('Aktuelle Projektversion:',p.version);console.log('Repository:',p.build.publish[0].owner+'/'+p.build.publish[0].repo);"
if errorlevel 1 goto :failure
echo.
echo Die Versionsnummer muss bei JEDEM neuen Update hoeher sein.
echo Beispiele: 1.1.0 -^> 1.1.1 oder 1.2.0 -^> 1.2.1
echo.
set /p NEW_VERSION=Neue Versionsnummer (leer = unveraendert, fuer Erstinstallation): 
if not "%NEW_VERSION%"=="" (
  call npm.cmd version "%NEW_VERSION%" --no-git-tag-version
  if errorlevel 1 goto :failure
)
echo.
echo TypeScript pruefen...
call npm.cmd run typecheck
if errorlevel 1 goto :failure
echo.
echo Windows-Update-Installer bauen...
call npm.cmd run package:update:win
if errorlevel 1 goto :failure
if not exist "dist-exe\latest.yml" (
  echo FEHLER: latest.yml fehlt. Update kann nicht verteilt werden.
  goto :failure
)
echo.
echo FERTIG. In dist-exe hochladen:
echo   1. Khutbah-AI-*.exe  ^(NSIS SETUP, nicht portable^)
echo   2. latest.yml
echo   3. *.blockmap ^(sofern vorhanden^)
echo.
echo GitHub Releases: Tag exakt vVERSION, z.B. v1.2.1
echo Nicht als Draft oder Prerelease lassen; veroeffentlichen!
explorer.exe "%CD%\dist-exe"
pause
exit /b 0
:failure
echo.
echo FEHLER: Bitte Konsolenausgabe pruefen.
pause
exit /b 1
