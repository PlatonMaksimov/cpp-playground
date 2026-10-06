FROM node:24-alpine

RUN apk add --no-cache g++ musl-dev

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node public ./public
COPY --chown=node:node server.js ./

RUN mkdir -p /run/cpp && chown node:node /run/cpp

ENV NODE_ENV=production \
    SOCKET_PATH=/run/cpp/compiler.sock \
    CXX=g++ \
    MAX_CONCURRENT_JOBS=2 \
    RATE_LIMIT_MAX=20

USER node

CMD ["node", "server.js"]
