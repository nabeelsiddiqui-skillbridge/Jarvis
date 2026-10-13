# Business Command AI: one image for the API (serves the built web app) and the worker.
# API:    npm start            Worker: npm run start:worker
FROM node:22-slim AS build
WORKDIR /app
# npm 10.9 can't resolve this lockfile's peer set; use the npm that generated it.
RUN npm install -g npm@11.19.1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
EXPOSE 8787
CMD ["npm", "start"]
