FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# The runner download is pinned to the official Linux amd64 release and checksum.
RUN test "$(dpkg --print-architecture)" = amd64 \
    && apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl --fail --location --retry 3 \
      https://gitea.com/gitea/runner/releases/download/v5.2.3/gitea-runner-5.2.3-linux-amd64 \
      --output /usr/local/bin/gitea-runner \
    && echo 'a59771ec177280ebf8203da4aa9d6f8e1f72d19c2f47e9237de34fe44888faa9  /usr/local/bin/gitea-runner' | sha256sum --check \
    && chmod 755 /usr/local/bin/gitea-runner \
    && mkdir -p /data /home/node/.cache /opt/hostedtoolcache \
    && chown -R node:node /data /home/node/.cache /opt/hostedtoolcache

COPY config.yaml /etc/gitea-runner/config.yaml
COPY --chmod=755 entrypoint.sh /usr/local/bin/runner-entrypoint
ENV RUNNER_TOOL_CACHE=/opt/hostedtoolcache
ENV AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache
USER node
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/runner-entrypoint"]
CMD ["daemon"]
