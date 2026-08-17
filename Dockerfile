FROM node:22-bullseye-slim

# Install necessary prerequisites
RUN apt-get update && apt-get install -y \
    curl \
    git \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install the Antigravity CLI
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

# Ensure agy is in the PATH. The install script usually puts it in ~/.local/bin or similar,
# but assuming it's available system-wide or we add it to PATH.
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# Install Node.js dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Install Python dependencies for quota script
RUN pip3 install pexpect

# Copy server code and scripts
COPY server.js scrape_agy_quota.py ./

# Create the workspace directory
RUN mkdir -p /workspace

# Set default working directory for the server
WORKDIR /workspace

# Start the server (using absolute path for server.js)
CMD ["node", "/app/server.js"]
