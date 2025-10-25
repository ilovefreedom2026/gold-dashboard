@echo off
title Gold Price Dashboard Runner

cd /d %~dp0

echo Checking for node_modules...
if not exist node_modules (
  echo Installing dependencies...
  call npm install || (
    echo Failed to install dependencies. Please install Node.js from https://nodejs.org and run 'npm install' manually.
    pause
    exit /b
  )
)

echo Checking for Node.js...
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Please install Node.js from https://nodejs.org and try again.
  pause
  exit /b
)

echo Checking for server.js...
if not exist server.js (
  echo Please ensure server.js exists in the current directory.
  pause
  exit /b
)

echo Checking for index.html...
if not exist index.html (
  echo Please ensure index.html exists in the current directory.
  pause
  exit /b
)

echo Starting server...
start "Node Server" cmd /k "node server.js"

echo Waiting for server to start...
timeout /t 10 /nobreak >nul

echo Opening dashboard in browser...
rem Try Chrome first, if not present fall back to default browser
where chrome >nul 2>&1
if not errorlevel 1 (
  start chrome "file:///%CD%/index.html"
) else (
  start "" "%CD%\\index.html"
)

echo Dashboard is running. Press any key to close this window...
pause