@echo off
title Gold Price Dashboard Runner

cd /d %~dp0

echo Clearing OBS Browser Cache...
rmdir /s /q "%APPDATA%\obs-studio\plugin_config\obs-browser\cache" 2>nul
mkdir "%APPDATA%\obs-studio\plugin_config\obs-browser\cache" 2>nul

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

echo Checking for update-data.js...
if not exist update-data.js (
  echo Please ensure update-data.js exists in the current directory.
  pause
  exit /b
)

echo Starting update-data.js...
start "Update Data" cmd /k "node update-data.js"

echo Starting server...
start "Node Server" cmd /k "node server.js"

echo Waiting for server to start...
timeout /t 10 /nobreak >nul

echo Checking server status...
curl -s http://localhost:3000 >nul
if errorlevel 1 (
  echo Server failed to start. Retrying with different port...
  start "Node Server Retry" cmd /k "node server.js --port 3001"
  set "url=http://localhost:3001/index.html"
  timeout /t 5 /nobreak >nul
) else (
  set "url=http://localhost:3000/index.html"
)

echo Opening dashboard in browser...
where chrome >nul 2>&1
if not errorlevel 1 (
  start chrome "%url%"
) else (
  start "" "%url%"
)

echo Dashboard is running. Press any key to close this window...
pause