FROM oven/bun:1.2.2-debian

# Node 20 (for npx-based MCP servers like @gongrzhe/server-gmail-autoauth-mcp)
# + git (Claude Code git operations)
# + tzdata (cron prompts assume a specific TZ)
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg git tzdata \
        procps strace lsof \
        vim less jq htop file \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Run as bun (uid 1000), not root. Claude Code refuses --permission-mode
# bypassPermissions when uid=0, which would break the daemons that spawn
# headless `claude -p` subprocesses.
USER bun
ENV PATH="/home/bun/.local/bin:${PATH}"

# Claude Code CLI - native binary install for the bun user.
RUN curl -fsSL https://claude.ai/install.sh | bash

WORKDIR /workspace
# Auto-start the assistant loop on `docker compose up`. The loop boots
# tg-daemon + cron-daemon and self-schedules a heartbeat. For ad-hoc
# work, exec a shell - don't open a second `claude` (avoids settings/
# token races; the main loop owns this session).
CMD ["claude", "--dangerously-skip-permissions", "/assistant-loop"]
