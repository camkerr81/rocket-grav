---
description: "Rule: Never use emojis in responses, documentation, UI items, or code. Always use tactile Braille icons."
always_on: true
---

# ⣏⣿ Rule: Zero Emoji Policy & Tactile Braille Iconography

1. **NEVER use standard or colored Unicode emojis** (e.g. 🎬, 🎙️, 🚀, 📦, ⚙️, 🐛, 💡, 📝, ⚠️, ✅, ❌, etc.) in any responses, explanations, documentation, commit messages, or code output.
2. **ALWAYS use approved Braille Iconography glyphs** defined in the `braille-iconography` skill:
   - Primary 4×4 Braille: `⣵⣵` (Media), `⣘⣇` (Voice), `⠕⣀` (Terminal), `⡴⢧` (Deploy/Launch), `⣏⣹` (Package), `⣏⣿` (Docs)
   - Status / Alerts: `⢄⠎` (Success/Done), `⡱⢎` (Error/Failed), `⢘⡃` (Caution/Warning), `⢨⡅` (Info/Notice), `⣮⣵` (Security/Padlock)
   - UI / Action: `⠪⢕` (Search), `⡯⠽` (Chat), `⡼⢧` (User), `⢞⡷` (Theme), `⢴⠃` (Lightning/Ollama)
3. Audit any file with `braille-icon check <file>` and fix with `braille-icon replace <file>`.
