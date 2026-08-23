@echo off
setlocal

echo === Proxy Rebuild - Local Deployment ===
echo.

REM Check Docker
docker --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Docker is not installed. Please install Docker Desktop for Windows first.
    pause
    exit /b 1
)
echo [OK] Docker is installed:
docker --version
echo.

REM Check Docker Compose
docker compose version >nul 2>&1
if %errorlevel% equ 0 (
    set COMPOSE_CMD=docker compose
) else (
    docker-compose --version >nul 2>&1
    if %errorlevel% equ 0 (
        set COMPOSE_CMD=docker-compose
    ) else (
        echo [ERROR] Docker Compose is not installed.
        pause
        exit /b 1
    )
)

echo [OK] Docker Compose is available: %COMPOSE_CMD%
echo.

REM Build and start
echo [INFO] Building and starting all services...
%COMPOSE_CMD% up -d --build

echo.
echo [INFO] Waiting for services to initialize...
timeout /t 8 /nobreak >nul

echo.
echo === Services Started ===
echo.
echo   Manager Dashboard:  http://localhost:18792
echo   Codex Proxy:        http://localhost:18790
echo   Hermes Proxy:       http://localhost:18793
echo   Cursor Proxy:       http://localhost:18794
echo.
echo   View logs: %COMPOSE_CMD% logs -f
echo   Stop all:  %COMPOSE_CMD% down
echo.

REM Open browser
start "" "http://localhost:18792"

echo [OK] Browser opened.
pause
