FROM node:20-alpine

WORKDIR /app

# 无第三方依赖：先拷贝源码与脚本
COPY package.json server.mjs ./
COPY public ./public
COPY scripts ./scripts
COPY test ./test

# 镜像构建阶段即执行页面构建（产出 dist/，服务优先提供构建产物）
RUN node scripts/build.mjs

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080

CMD ["node", "server.mjs"]
