FROM oven/bun:1-debian

# Node 20 (for npx-based MCP servers like @gongrzhe/server-gmail-autoauth-mcp)
# + git (Claude Code git operations)
# + tzdata (cron prompts assume a specific TZ)
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg git tzdata \
        procps strace lsof \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI - native binary install. Symlink into /usr/local/bin so the
# launcher is on PATH for any user; ENV keeps /root/.local/bin first for the
# auto-update mechanism to find its own assets.
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && ln -sf /root/.local/bin/claude /usr/local/bin/claude

ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /workspace

# Container runs as root so the docker-compose mount of ~/.claude -> /root/.claude
# (which carries the host's claude.ai subscription session) lines up.
CMD ["claude"]
