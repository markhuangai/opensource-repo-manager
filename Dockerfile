FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /build
RUN npm install --global npm@12.0.2
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
RUN apt-get update \
    && apt-get install --no-install-recommends -y git ca-certificates build-essential util-linux tini procps \
    && find /var/lib/apt/lists -type f -delete \
    && install -d -m 0755 /opt/orm-runtime/bin /opt/orm/app /config /data /skills /prompts \
    && install -m 0555 /usr/local/bin/node /opt/orm-runtime/bin/node \
    && chmod 0555 /opt/orm-runtime /opt/orm-runtime/bin \
    && useradd --create-home --uid 10001 --user-group --shell /usr/sbin/nologin coding \
    && useradd --create-home --uid 10002 --user-group --shell /usr/sbin/nologin audit \
    && useradd --create-home --uid 10003 --user-group --shell /usr/sbin/nologin output-review
WORKDIR /opt/orm/app
COPY --from=build /build/package.json ./
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
RUN chmod 0555 /opt/orm/app/dist/main.js \
    && ln -s /opt/orm/app/dist/main.js /usr/local/bin/orm
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD /opt/orm-runtime/bin/node --input-type=module -e "const r = await fetch('http://127.0.0.1:8080/healthz', {signal: AbortSignal.timeout(2000)}); process.exit(r.ok ? 0 : 1)"
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/orm-runtime/bin/node", "/opt/orm/app/dist/main.js"]
