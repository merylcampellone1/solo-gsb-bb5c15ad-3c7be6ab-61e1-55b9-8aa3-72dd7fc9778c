FROM node:20-bookworm

WORKDIR /app

# 先装依赖，利用层缓存。
# build-essential/python3 作为 better-sqlite3 预编译二进制不可用时的源码编译兜底，
# 保证从空环境也能完成依赖安装。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

# 复制应用代码
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# SQLite 数据持久化目录（首次启动自动建库、初始化表结构并写入演示数据）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/allergen.db

EXPOSE 3000

CMD ["node", "server/server.js"]
