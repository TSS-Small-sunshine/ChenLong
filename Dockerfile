# syntax=docker/dockerfile:1

# ---------- 依赖构建阶段 ----------
FROM node:24-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 优先使用预编译二进制；无对应平台时回退本地编译（构建阶段装编译工具，不进运行时镜像）
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- 运行时阶段 ----------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/chenlong.db
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM

# 健康检查与 /api/health 一致；容器内自带 node，无需额外安装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(function (r) { process.exit(r.ok ? 0 : 1) }).catch(function () { process.exit(1) })"

CMD ["node", "server/app.js"]