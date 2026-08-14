FROM node:20-alpine
WORKDIR /app

# 时区 + 原生模块编译兜底（argon2 无 musl 预编译时走 node-gyp）
RUN apk add --no-cache python3 make g++ tzdata
ENV TZ=Asia/Shanghai

# 项目用 pnpm（pnpm-workspace.yaml 的 allowBuilds 控制原生依赖构建）
RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# prisma.config.ts 里 env('DATABASE_URL') 会在加载配置时解析；generate 不连库，给占位值即可（运行时走真实 env）
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" npx prisma generate && pnpm run build

# 卷挂载目标：帖子图片运行时写入目录（docker-compose 挂载 ./data/uploads）
RUN mkdir -p public/uploads

EXPOSE 3001
CMD ["node", "dist/index.js"]
