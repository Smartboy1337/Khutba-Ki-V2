@echo off
setlocal
cd /d "%~dp0"
title Khutbah AI - Auto Update einrichten
echo.
echo =======================================================
echo     KHUTBAH AI - AUTO UPDATE EINRICHTEN
 echo =======================================================
echo.
if not exist "package.json" goto :wrongfolder
if not exist "src\main\index.ts" goto :wrongfolder
where node.exe >nul 2>&1 || goto :nonode
where npm.cmd >nul 2>&1 || goto :nonode
echo GitHub-Repository muss PUBLIC sein. Den Quellcode musst du nicht hochladen.
echo.
set /p GH_OWNER=GitHub-Benutzername / Organisation: 
set /p GH_REPO=Repository-Name fuer Releases: 
if "%GH_OWNER%"=="" goto :failure
if "%GH_REPO%"=="" goto :failure
call node.exe "scripts\auto-update-einrichten.cjs" "%GH_OWNER%" "%GH_REPO%"
if errorlevel 1 goto :failure
echo.
echo [1/2] Neue Abhaengigkeit installieren...
call npm.cmd install
if errorlevel 1 goto :failure
echo.
echo [2/2] TypeScript pruefen...
call npm.cmd run typecheck
if errorlevel 1 goto :failure
echo.
echo FERTIG. Die Auto-Update-Funktion ist im Quellcode eingebaut.
echo Erstelle jetzt mit RELEASE_ERSTELLEN.bat den ersten NSIS-Installer.
pause
exit /b 0
:wrongfolder
echo FEHLER: Lege alle Dateien dieser ZIP in den Projektordner neben package.json.
goto :failure
:nonode
echo FEHLER: Node.js / npm nicht gefunden.
:failure
echo.
echo Ein Fehler ist aufgetreten. Pruefe die Ausgabe und die Sicherung.
pause
exit /b 1
