# syntax=docker/dockerfile:1
# Multi-stage: build the React client, then ship only the server + built
# static assets. Express serves both the API and client/dist on one port.

# ---- Stage 1: build the client (Vite) ----
FROM node:22-alpine AS client-build
WORKDIR /build
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- Stage 2: runtime (Express serves API + static) ----
FROM node:22-alpine
WORKDIR /app
# Keep the repo-relative layout: server/index.js expects ../client/dist
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/index.js ./server/index.js
COPY --from=client-build /build/dist ./client/dist

# Run as the non-root user built into the node image (app listens on 8787)
USER node
WORKDIR /app/server

ENV PORT=8787
EXPOSE 8787
CMD ["node", "index.js"]
