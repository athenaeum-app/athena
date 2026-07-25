# Multi-stage build for the Athena server.
#
# Stage 1 (node): build the PWA client. Outputs into
# /build/server/client/web/ where the Go embed step picks it up.
# Stage 2 (go): build the server binary, embedding the client.
# Stage 3 (final): minimal Alpine image with just the binary and a data
# directory.
#
# See docs/adr/0002-server-bundled-pwa-client.md for the embed architecture
# and docker-compose.yml at the repo root for the env var configuration.

# --- Stage 1: build the client ---
FROM node:20-alpine AS client-build
WORKDIR /build/client

# Install deps first for better layer caching.
COPY client/package.json client/package-lock.json ./
RUN npm ci

# Copy the rest of the client source and build. The vite config outputs
# into ../server/client/web/ (relative to client/), which is
# /build/server/client/web/ here.
COPY client/ ./
RUN npm run build

# --- Stage 2: build the server ---
FROM golang:1.25-alpine AS server-build
WORKDIR /build/server

# Copy go.mod/go.sum first for layer caching.
COPY server/go.mod server/go.sum ./
RUN go mod download

# Copy the server source and the pre-built client from stage 1.
COPY server/ ./
COPY --from=client-build /build/server/client/web/ ./client/web/

# The release workflow passes the git tag through as ATHENA_VERSION so the
# running server can report which build it is (Settings -> About). An
# unlabelled build reports "dev", which is the honest answer for one.
ARG ATHENA_VERSION=dev

# Build a static binary. CGO is disabled because modernc.org/sqlite is
# pure Go (no C toolchain needed).
RUN CGO_ENABLED=0 go build \
    -ldflags="-s -w -X github.com/athenaeum-app/athena/server/internal/version.Version=${ATHENA_VERSION}" \
    -o /out/athena-server ./cmd/athena-server

# --- Stage 3: final runtime image ---
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=server-build /out/athena-server /app/athena-server

# Data directory for SQLite + uploads. Mount a volume here in production.
RUN mkdir -p /app/data
ENV DB_PATH=/app/data/athenaeum.db
ENV UPLOADS_PATH=/app/data/uploads

EXPOSE 8080
ENTRYPOINT ["/app/athena-server"]
