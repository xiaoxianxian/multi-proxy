#!/bin/bash
set -e

echo "=== Proxy Rebuild - Local Deployment ==="
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "[ERROR] Docker is not installed. Please install Docker first."
    echo "  macOS: brew install --cask docker"
    echo "  Linux: curl -fsSL https://get.docker.com | sh"
    exit 1
fi

echo "[OK] Docker is installed: $(docker --version)"

# Check Docker Compose
if command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
elif docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
else
    echo "[ERROR] Docker Compose is not installed."
    exit 1
fi

echo "[OK] Docker Compose is available: $COMPOSE_CMD"
echo ""

# Build and start
echo "[INFO] Building and starting all services..."
$COMPOSE_CMD up -d --build

echo ""
echo "[INFO] Waiting for services to initialize..."
sleep 8

echo ""
echo "=== Services Started ==="
echo ""
echo "  Manager Dashboard:  http://localhost:18792"
echo "  Codex Proxy:        http://localhost:18790"
echo "  Hermes Proxy:       http://localhost:18793"
echo "  Cursor Proxy:       http://localhost:18794"
echo ""
echo "View logs: $COMPOSE_CMD logs -f"
echo "Stop all:  $COMPOSE_CMD down"
echo ""

# Open browser
if command -v open &> /dev/null; then
    open "http://localhost:18792"
elif command -v xdg-open &> /dev/null; then
    xdg-open "http://localhost:18792"
elif command -v firefox &> /dev/null; then
    firefox "http://localhost:18792"
else
    echo "[INFO] Could not auto-open browser. Please visit: http://localhost:18792"
fi
