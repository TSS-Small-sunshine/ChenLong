# syntax=docker/dockerfile:1

# ---------- 依赖安装阶段 ----------
FROM node:24-bookworm-slim AS deps
WORKDIR /app

# 仅安装生产依赖：devDependencies 不进入镜像，因此无需额外的本机编译工具链。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- 运行时阶段 ----------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# scripts/backup-db.js 通过 pg_dump 备份 PostgreSQL，运行时镜像需要 PostgreSQL 客户端。
# pg_dump 主版本不能低于数据库服务器主版本：compose 使用 postgres:17，这里装 PGDG 的 client 17；
# 升级数据库大版本时需同步修改下面的版本号。
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && apt-get purge -y --auto-remove curl gnupg \
  && rm -rf /var/lib/apt/lists/*

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
