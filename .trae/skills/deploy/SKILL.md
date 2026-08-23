---
name: "deploy"
description: "Deploy project locally by running deploy-local.sh or deploy-local.bat. Invoke when user says '部署验收', '本地启动', or asks to deploy/run the project locally. Auto-creates missing scripts, docker-compose.yml, and repairs failed startups."
---

# Deploy Local

Automatically deploy the project locally using Docker Compose. This skill handles the full lifecycle: check prerequisites, create missing files, start services, verify health, and repair failures.

## Trigger Conditions

Invoke this skill when the user says any of the following (in Chinese or English):
- "部署验收"
- "本地启动"
- "deploy locally"
- "run locally"
- "start locally"

## Workflow

### Step 1: Check for deploy script

Look for `deploy-local.sh` (Unix/Linux/macOS) or `deploy-local.bat` (Windows) in the project root.

- **If found**: Proceed to Step 3 (run the script).
- **If not found**: Continue to Step 2.

### Step 2: Create deploy script (if missing)

2.1. Check if `docker-compose.yml` exists in the project root.

2.2. **If `docker-compose.yml` does NOT exist or is incomplete**:
   - Analyze the project to identify all services (frontend, backend, database, cache, etc.).
   - Determine the tech stack for each service (Node.js, Python, Java, Go, etc.) and their dependencies.
   - Identify the database(s) used (PostgreSQL, MySQL, MongoDB, Redis, SQLite, etc.) and create dedicated services for them.
   - Generate a complete `docker-compose.yml` with:
     - All service definitions with correct build contexts or image references
     - Proper port mappings (host:container)
     - Named volumes for persistent data (databases, uploads, etc.)
     - A shared bridge network
     - Environment variable configuration via `.env` files or inline
     - Health checks and `depends_on` with `condition: service_healthy` where applicable
   - Save the file to the project root.

2.3. **If `docker-compose.yml` exists and is valid** (contains frontend, backend, and database services):
   - Proceed to the next step.

2.4. Create the deploy script:
   - **macOS/Linux** → `deploy-local.sh`
   - **Windows** → `deploy-local.bat`

   The script must:
   - Check that Docker is installed and running
   - Check that Docker Compose is available (supports both `docker compose` and `docker-compose`)
   - Run `docker-compose up -d --build` to start all services
   - Wait ~10 seconds for services to initialize
   - Attempt to auto-open the browser to `http://localhost:5173`
   - Print service URLs and useful commands (logs, stop)

2.5. **After creating the script, re-run Step 1** (check for deploy script again) to proceed with execution.

### Step 3: Run the deploy script

- **macOS/Linux**: `bash deploy-local.sh`
- **Windows**: `deploy-local.bat`

### Step 4: Wait for services to fully start

After the script completes, wait an additional 5-10 seconds for all services to be fully ready. Then verify:

1. Check that Docker containers are running: `docker-compose ps` or `docker ps`
2. Optionally perform a health check by sending an HTTP request to `http://localhost:5173` (or the appropriate port if different).

### Step 5: Handle outcomes

**If all services start successfully:**
- Output the following message:

```
本地部署完成，请访问 http://localhost:5173 进行验收
```

**If services fail to start:**
1. Read the Docker logs: `docker-compose logs --tail=50`
2. Analyze the error and attempt automatic repair:
   - **Missing `.env` file**: Create a `.env.example` or `.env` with default/placeholder values
   - **Port conflict**: Suggest changing the host port mapping
   - **Build failure**: Check for missing dependencies, syntax errors, or incorrect Dockerfile paths
   - **Database connection failure**: Verify service names in connection strings match docker-compose service definitions
   - **Image pull failure**: Check network/Docker Hub accessibility
3. After attempting a fix, run `docker-compose up -d --build` again.
4. If the second attempt succeeds, output the success message.
5. If the second attempt also fails, or if the error cannot be automatically fixed:
   - Display the error details to the user
   - Provide specific recommendations for manual intervention
   - Ask the user to evaluate and decide on next steps

## Notes

- The deploy script auto-detects `docker compose` vs `docker-compose` command availability.
- The default frontend URL is `http://localhost:5173`, but adjust if the project uses a different port.
- Docker Desktop must be running before invoking this skill.
- Named volumes preserve data across container restarts and rebuilds.
- If `docker-compose.yml` uses `build:` contexts, ensure the Dockerfiles exist and are correct.
