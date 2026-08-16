# Rocket.Chat Antigravity CLI Bridge

This is a Dockerized API bridge that connects Rocket.Chat outgoing webhooks to the Google Antigravity CLI (`agy`). It allows you to message a bot in Rocket.Chat and have the CLI autonomously write code or execute commands inside a containerized workspace.

## Prerequisites

- Docker and Docker Compose installed
- A Rocket.Chat instance

## Setup & First Run Authentication

Before the bridge can process webhooks, you must authenticate the Antigravity CLI with your Google Pro account.

1. **Clone/Create the project structure** and navigate to this directory.
2. **Set your token:** Open `docker-compose.yml` and replace `your_secure_token_here` with a secure random string (or create a `.env` file with `ROCKETCHAT_TOKEN=...`).
3. **Start the container:**
   ```bash
   docker-compose up -d --build
   ```
4. **First Run Auth Flow:** The CLI needs to be authenticated. Run the CLI manually inside the container to trigger the headless OAuth link:
   ```bash
   docker exec -it rocketchat-agy-bridge agy
   ```
   Follow the prompts in your terminal. It will likely give you a URL to visit in your browser to authenticate. Once authenticated, the session state will be saved to the `.gemini` directory mounted as a volume. This ensures the authentication persists across container restarts.

## Configuring Rocket.Chat

1. Go to your Rocket.Chat Administration page.
2. Navigate to **Integrations** -> **New Integration** -> **Outgoing WebHook**.
3. Set the following options:
   - **Event Trigger:** Message Sent
   - **Enabled:** True
   - **Name:** AGY Bot
   - **Channel:** (Optional) Set the channel where you want the bot to listen.
   - **Trigger Words:** (Optional) e.g., `@agy` or `!agy`
   - **URLs:** `http://<your-server-ip>:8080/webhook` (Ensure this URL is reachable from your Rocket.Chat server)
   - **Token:** The same token you set as `ROCKETCHAT_TOKEN` in the `docker-compose.yml` file.
4. Save the integration.

## Usage

Once configured, simply send a message in the designated channel (or starting with the trigger word) in Rocket.Chat:

```
@agy create a python script that prints hello world
```

The server will receive the webhook, execute `agy` in the `/workspace` directory, and reply with the command output. You can access the generated files on your host machine in the `./workspace` folder.
