---
description: "Guidelines for utilizing the local Ollama MCP server for lightweight task offloading."
---

# Local Ollama MCP Integration

You have access to a local Ollama instance via the `ollama-mcp` MCP server tools:
- `ask_ollama`: Ask local Ollama (e.g. `qwen3:8b`, `qwen3.5:4b`, `phi4-mini:latest`) quick questions or offload lightweight subtasks.
- `run`: Run completions on a local model.
- `chat_completion`: Multi-turn chat completion.
- `list_models`: Check which models are available on the local instance.

Whenever you have subtasks that involve:
1. Fast summarization of large texts or logs
2. Drafting commit messages or documentation outlines
3. Brainstorming or formatting JSON/regex
4. Repetitive lightweight evaluations

You can invoke `ask_ollama` on `ollama-mcp` to offload processing to the local LAN GPU without incurring external API latency or token limits.
