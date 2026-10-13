# syntax = docker/dockerfile:1

# ANU TaskMate: a node:http + node:sqlite app, no bundler. Node runs .ts
# directly (type stripping, stable since Node 24), so there's no build step —
# this just installs prod deps and copies source. /data is the Fly volume
# (fly.toml); the sqlite file lives there so it survives a restart/redeploy.
FROM node:24.21.0-alpine

WORKDIR /app

# Pin the same pnpm version mise.toml pins for local/CI use, so the image
# installs with the exact pnpm this project is developed against rather
# than whatever corepack would otherwise resolve.
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY src ./src
COPY public ./public
COPY README.md ./README.md

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/server.ts"]
