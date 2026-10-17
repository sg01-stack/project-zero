FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json index.html style.css ./
COPY src ./src
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8000
WORKDIR /app
COPY --from=build /app/index.html /app/style.css /app/package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY server ./server
COPY scripts/serve.mjs scripts/runtime.mjs ./scripts/
RUN chmod -R a+rX /app
USER node
EXPOSE 8000
CMD ["node", "scripts/serve.mjs"]
