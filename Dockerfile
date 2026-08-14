# ============================================================
# forum-server（Fastify + Prisma，端口 3001）
# 多阶段构建：编译阶段保留完整源码；运行阶段只保留编译产物，
# 不包含 src/ 下的 .ts 源码。
# ============================================================

# ---- 构建阶段 ----
FROM node:22-alpine AS build
WORKDIR /app

# 时区 + 原生模块编译兜底（argon2 无 musl 预编译时走 node-gyp）
RUN sed -i "s@http://dl-cdn.alpinelinux.org/@https://repo.huaweicloud.com/@g" /etc/apk/repositories
RUN apk add --no-cache python3 make g++ tzdata
ENV TZ=Asia/Shanghai

# 项目用 pnpm（pnpm-workspace.yaml 的 allowBuilds 控制原生依赖构建）
# 默认切华为云源（本机国内构建快）；CI 用 --build-arg NPM_REGISTRY 覆盖为官方源
ARG NPM_REGISTRY=https://mirrors.huaweicloud.com/repository/npm/
RUN npm config set registry ${NPM_REGISTRY}
RUN npm install -g pnpm@11

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# prisma.config.ts 里 env('DATABASE_URL') 会在加载配置时解析；generate 不连库，给占位值即可（运行时走真实 env）
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" npx prisma generate && pnpm run build

# ---- 运行阶段 ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai

COPY --from=build /app /app
# 删除源码：只留编译产物 dist/ + 依赖 node_modules/（含生成的 prisma client），镜像内不再有 .ts 源码
RUN rm -rf src prisma.config.ts

# 卷挂载目标：帖子图片运行时写入目录（docker-compose 挂载 ./data/uploads）
RUN mkdir -p public/uploads

EXPOSE 3001
CMD ["node", "dist/index.js"]
