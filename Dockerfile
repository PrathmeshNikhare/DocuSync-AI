# Reference image for the private-network deployment (docs/10, D-014).
# `build` has all dependencies and runs migrations as a one-shot job; `runtime`
# has production dependencies only and never receives the owner database URL.
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# An explicit list, not `COPY . .`: nothing else in the checkout (keys, password
# files, dumps, local env files) can reach an image layer (security-check L-1).
COPY tsconfig.json next.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN npm run build

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/.next ./.next
COPY next.config.ts ./
COPY src/lib/security-headers.ts ./src/lib/security-headers.ts
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
