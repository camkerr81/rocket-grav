FROM node:22-bookworm-slim

# Install necessary prerequisites
RUN apt-get update && apt-get install -y \
    curl \
    git \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Cache-bust Antigravity CLI installation whenever upstream releases a new version
ARG AGY_CACHEBUST=1
ADD https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json /tmp/agy-manifest.json

# Install the Antigravity CLI
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

# Ensure agy is in the PATH. The install script usually puts it in ~/.local/bin or similar,
# but assuming it's available system-wide or we add it to PATH.
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# Install Node.js dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy server code, adapters, and MCP servers
COPY server.js threads.js ./
COPY adapters/ ./adapters/
COPY mcp/ ./mcp/

# Make ollama-mcp executable and globally available
RUN chmod +x ./mcp/ollama-mcp.js && ln -sf /app/mcp/ollama-mcp.js /usr/local/bin/ollama-mcp

# Install Beads issue tracker CLI and optional community MCP servers globally
RUN npm install -g @beads/bd ollama-mcp-server

# Create the workspace directory
RUN mkdir -p /workspace

# Set default working directory for the server
WORKDIR /workspace

# Start the server (using absolute path for server.js)
CMD ["node", "/app/server.js"]
