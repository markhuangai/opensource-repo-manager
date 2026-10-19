FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /build
RUN npm install --global npm@12.0.2
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
ARG TARGETARCH
RUN apt-get update && apt-get install --no-install-recommends -y curl ca-certificates \
    && case "$TARGETARCH" in \
      amd64) mise_arch=x64; mise_sha=7af2e3d798e9ddec142f5a968a18c3f33aa68d19aa8a4111302d4c7d04feb6fa ;; \
      arm64) mise_arch=arm64; mise_sha=9a58b5b72e58ed66f38d6d2550c2f6279d8c39884574c389a39a9c441a5580b9 ;; \
      *) exit 1 ;; \
    esac \
    && curl --fail --silent --show-error --location "https://github.com/jdx/mise/releases/download/v2026.10.9/mise-v2026.10.9-linux-${mise_arch}.tar.gz" --output /build/mise.tar.gz \
    && printf '%s  /build/mise.tar.gz\n' "$mise_sha" | sha256sum --check - \
    && tar -xzf /build/mise.tar.gz -C /build \
    && chmod 0555 /build/mise/bin/mise
RUN case "$TARGETARCH" in \
      amd64) leaks_arch=x64; leaks_sha=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;; \
      arm64) leaks_arch=arm64; leaks_sha=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;; \
      *) exit 1 ;; \
    esac \
    && curl --fail --silent --show-error --location "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_${leaks_arch}.tar.gz" --output /build/gitleaks.tar.gz \
    && printf '%s  /build/gitleaks.tar.gz\n' "$leaks_sha" | sha256sum --check - \
    && tar -xzf /build/gitleaks.tar.gz -C /build gitleaks \
    && chmod 0555 /build/gitleaks

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
RUN apt-get update \
    && apt-get install --no-install-recommends -y git ca-certificates build-essential util-linux tini procps \
    && find /var/lib/apt/lists -type f -delete \
    && install -d -m 0755 /opt/orm-runtime/bin /opt/orm/app /config /data /skills /prompts \
    && install -m 0555 /usr/local/bin/node /opt/orm-runtime/bin/node \
    && cp -R /etc/apt /opt/orm-runtime/apt \
    && printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod 0555 /usr/sbin/policy-rc.d \
    && chmod 0555 /opt/orm-runtime /opt/orm-runtime/bin \
    && useradd --create-home --uid 10001 --user-group --shell /usr/sbin/nologin coding \
    && useradd --create-home --uid 10002 --user-group --shell /usr/sbin/nologin audit \
    && useradd --create-home --uid 10003 --user-group --shell /usr/sbin/nologin output-review \
    && chown root:root /home/coding /home/audit /home/output-review \
    && chmod 0555 /home/coding /home/audit /home/output-review
WORKDIR /opt/orm/app
COPY --from=build /build/package.json ./
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY --from=build /build/mise/bin/mise /opt/orm-runtime/bin/mise
COPY --from=build --chown=0:0 /build/gitleaks /opt/orm-runtime/bin/gitleaks
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD /opt/orm-runtime/bin/node --input-type=module -e "const r = await fetch('http://127.0.0.1:8080/healthz', {signal: AbortSignal.timeout(2000)}); process.exit(r.ok ? 0 : 1)"
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/orm-runtime/bin/node", "/opt/orm/app/dist/main.js"]
