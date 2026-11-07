FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN yarn install --frozen-lockfile --network-timeout 600000
ENV VITE_APP_SELF_HOSTED=true VITE_APP_DISABLE_SENTRY=true VITE_APP_ENABLE_TRACKING=false VITE_APP_ENABLE_ESLINT=false
RUN yarn build:app:docker

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/workspace.sqlite STATIC_DIR=/app/public
WORKDIR /app
COPY --from=build /app/excalidraw-app/build ./public
COPY server ./server
COPY excalidraw-app/workspace/mergeElements.mjs ./excalidraw-app/workspace/mergeElements.mjs
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
