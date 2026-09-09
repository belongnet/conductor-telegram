# OVH target: linux/amd64. Runtime is carried by this release, never the host Node.
FROM node:22-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ cmake git curl ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/whisper
RUN git init . && git remote add origin https://github.com/ggml-org/whisper.cpp.git \
 && git fetch --depth 1 origin a8d002cfd879315632a579e73f0148d06959de36 \
 && git checkout --detach FETCH_HEAD \
 && cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF \
 && cmake --build build --config Release -j 4
RUN curl --fail --location --retry 3 -o /opt/whisper/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin \
 && echo '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe  /opt/whisper/ggml-base.bin' | sha256sum -c -
WORKDIR /opt/conductor-telegram
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm run build && mkdir /release && npm pack --pack-destination /release

FROM build AS checks
ENV TELEGRAM_WHISPER_CPP_DIR=/opt/whisper TELEGRAM_WHISPER_BIN=/opt/whisper/build/bin/whisper-cli TELEGRAM_WHISPER_MODEL=/opt/whisper/ggml-base.bin
RUN npm test
RUN node scripts/cloud/linux-smoke.mjs

FROM build AS production-deps
RUN npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates libgomp1 tini \
 && rm -rf /var/lib/apt/lists/* && groupadd --gid 10001 gateway && useradd --uid 10001 --gid gateway --create-home gateway
WORKDIR /opt/conductor-telegram
COPY --from=production-deps /opt/conductor-telegram/package.json ./
COPY --from=production-deps /opt/conductor-telegram/node_modules ./node_modules
COPY --from=build /opt/conductor-telegram/dist ./dist
COPY --from=build /opt/conductor-telegram/scripts/cloud ./scripts/cloud
COPY --from=build /opt/whisper/build/bin/whisper-cli /opt/whisper/whisper-cli
COPY --from=build /opt/whisper/ggml-base.bin /opt/whisper/ggml-base.bin
COPY --from=build /release/*.tgz /opt/conductor-telegram-client.tgz
ENV NODE_ENV=production TELEGRAM_RUNTIME_MODE=cloud-only CONDUCTOR_CLOUD_BACKEND=api \
 TELEGRAM_CLOUD_REVIEW_POLICY=native DB_PATH=/var/lib/conductor-telegram/conductor-telegram.db \
 TELEGRAM_BRIDGE_FILES_DIR=/var/lib/conductor-telegram/attachments TELEGRAM_BRIDGE_HOST=0.0.0.0 TELEGRAM_BRIDGE_PORT=8787 \
 TELEGRAM_WHISPER_CPP_DIR=/opt/whisper TELEGRAM_WHISPER_BIN=/opt/whisper/whisper-cli TELEGRAM_WHISPER_MODEL=/opt/whisper/ggml-base.bin \
 TELEGRAM_BRIDGE_CLIENT_PACKAGE=/opt/conductor-telegram-client.tgz TELEGRAM_BRIDGE_BOOTSTRAP=/opt/conductor-telegram/scripts/cloud/setup-mcp.sh
USER gateway
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD ["node", "scripts/cloud/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/cli/index.js"]
CMD ["start", "--quiet", "--no-color"]
