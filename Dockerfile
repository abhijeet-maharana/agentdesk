FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY widget ./widget
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# ffmpeg turns WhatsApp voice replies into OGG Opus voice notes.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
USER node
EXPOSE 8080
# Mount your config at /app/agentdesk.config.yaml (and your prompt file next to it).
CMD ["node", "dist/index.js"]
