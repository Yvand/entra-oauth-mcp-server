# syntax=docker/dockerfile:1

# ---- Build stage -------------------------------------------------------------
# devDependencies (typescript) are required to compile, so they are installed here
# and deliberately left behind in the runtime stage.
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage -----------------------------------------------------------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# node:20-alpine ships a non-root "node" user (uid 1000); run as it.
USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
