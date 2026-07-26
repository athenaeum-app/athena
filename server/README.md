# Athena Server

Go backend for the athenaeum project. Serves the REST API at `/api/v1/` and the embedded PWA client at `/`. Uses SQLite as its database.

## Building

```bash
# Build the client first (outputs into server/web/)
cd ../client && npm install && npm run build

# Build the server
cd ../server && go build -o athena-server ./cmd/athena-server
```

## Running

```bash
./athena-server
```

The server listens on `:8080` by default. The PWA is available at `http://localhost:8080/`, the API at `http://localhost:8080/api/v1/`.

## Configuration

All settings are configurable via environment variables. See `docker-compose.yml` at the repo root for the full list.
