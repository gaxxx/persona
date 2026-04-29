FROM oven/bun:1-debian

# Node 20 (for npx-based MCP servers like @gongrzhe/server-gmail-autoauth-mcp)
# + git (Claude Code git operations)
# + tzdata (cron prompts assume a specific TZ)
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg git tzdata \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace

# Default to interactive Claude Code session.
# docker compose run / exec will override as needed.
CMD ["claude"]
