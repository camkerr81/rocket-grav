---
name: braille-iconography
description: "Strict enforcement of tactile Braille icons to replace any emoji in all documentation (README.md, specs, guides), application menu UI items, commit messages, and agent outputs."
---

# ⣏⣿ Braille Iconography Enforcement Standard

## ⠪⡕ Core Directive: Zero Emoji Policy

Whenever generating, editing, or maintaining any Markdown documentation (`README.md`, guides, design specs, release notes, commit messages, or PR summaries) and whenever building user interface menu items or telemetry displays in application code (TUI menus, Quickshell, Jetpack Compose, Rofi, Android launchers, or web dashboards):

1. **NEVER use standard or colored Unicode emojis** (e.g. 🎬, 🎙️, 🚀, 📦, ⚙️, 🐛, 💡, 📝, ⚠️, ✅, ❌, etc.).
2. **ALWAYS use the approved Braille Iconography glyphs** defined below.
3. **Use Primary 4×4 Braille Icons (`⣵⣵`, `⣘⣇`, `⠕⣀`, `⡴⢧`, `⣏⣹`)** for:
   - Section headers in Markdown (e.g., `## ⣵⣵ Media Showcase`, `## ⣘⣇ Voice Assistant`)
   - Primary application menu items (e.g., `[ ⣵⣵ ] Media Player`, `[ ⣘⣇ ] Voice Notes`, `[ ⣱⢏ ] Settings`)
4. **Use Compact 2×4 Braille Icons (`⣿`, `⣸`, `⣕`, `⡾`, `⣏`)** for:
   - Dense table cells, inline status badges, pill modifiers, and single-width telemetry indicators.

---

## ⣏⣿ Master Glyph Lookup & Replacement Table

| Semantic Category | Concept / Role | Forbidden Emoji | Primary Braille (4×4) | Compact Braille (2×4) | Header Syntax Example |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **Media & Audio** | Media / Film Placard | 🎬 | `⣵⣵` | `⣿` | `## ⣵⣵ Media Player` |
| | Voice / Microphone | 🎙️ 🎤 | `⣘⣇` | `⣸` | `## ⣘⣇ Voice Assistant` |
| | Audio / Speaker / Sound | 🔊 🔈 | `⡷⣏` | `⡷` | `## ⡷⣏ Audio Engine` |
| | Music / Audio Track | 🎵 🎶 | `⣠⡏` | `⣼` | `## ⣠⡏ Music Library` |
| | Camera / Video Stream | 📹 📷 | `⡿⢷` | `⡿` | `## ⡿⢷ Video Stream` |
| | Play Action | ▶️ | `⡷⠆` | `⡷` | `[ ⡷⠆ ] Play` |
| | Pause Action | ⏸️ | `⡇⡇` | `⡇` | `[ ⡇⡇ ] Pause` |
| | Stop Action | ⏹️ | `⣿⣿` | `⣿` | `[ ⣿⣿ ] Stop` |
| | Record Action | ⏺️ | `⢾⡷` | `⢾` | `[ ⢾⡷ ] Record` |
| **Docs & Knowledge** | Documentation / Book | 📖 📚 | `⣏⣿` | `⣏` | `## ⣏⣿ Documentation` |
| | Document / Specs File | 📄 📝 | `⣟⣳` | `⣟` | `## ⣟⣳ Overview & Specs` |
| | Concept / Vision / Idea | 💡 🧠 | `⠪⡕` | `⢺` | `## ⠪⡕ Philosophy` |
| | Checklist / Task List | 📋 ☑️ | `⡞⣗` | `⡞` | `## ⡞⣗ Requirements` |
| | Folder / Directory | 📁 📂 | `⣟⣲` | `⣗` | `## ⣟⣲ Project Structure` |
| | Archive / Bundles | 🗄️ 🗃️ | `⣯⣽` | `⣯` | `## ⣯⣽ Archive & Bundles` |
| | Changelog / History | 📜 🕒 | `⣏⣛` | `⣏` | `## ⣏⣛ Changelog` |
| | Roadmap / Milestones | 🧭 🗺️ | `⣟⣓` | `⣟` | `## ⣟⣓ Roadmap` |
| **Dev & Code** | Code / Implementation | 💻 ⌨️ | `⢎⡱` | `⢎` | `## ⢎⡱ Implementation` |
| | Terminal / Shell (`>_`) | 🐚 📟 | `⠕⣀` | `⣕` | `## ⠕⣀ CLI Commands` |
| | Settings / Configuration | ⚙️ 🎛️ | `⣱⢏` | `⢾` | `## ⣱⢏ Configuration` |
| | Tools / Toolchain | 🛠️ 🔧 | `⠙⢦` | `⢑` | `## ⠙⢦ Toolchain & Build` |
| | Bug / Defect / Issue | 🐛 🪲 | `⡵⢮` | `⡵` | `## ⡵⢮ Known Issues` |
| | Testing / QA / Flask | 🧪 🔬 | `⣠⣇` | `⣼` | `## ⣠⣇ Test Suite` |
| | Rocket / Deployment | 🚀 🛸 | `⡴⢧` | `⡾` | `## ⡴⢧ Quickstart & Launch`|
| | Package / Distribution | 📦 🎁 | `⣏⣹` | `⣏` | `## ⣏⣹ Packages` |
| | Branch / Git / VCS | 🌿 🔀 | `⡔⠇` | `⡔` | `## ⡔⠇ Git Workflow` |
| | Database / Storage | 🗄️ 💾 | `⡯⢽` | `⡯` | `## ⡯⢽ Persistence` |
| | Cloud / Infrastructure | ☁️ 🌐 | `⠾⠷` | `⠾` | `## ⠾⠷ Cloud Infrastructure`|
| | Container / Docker | 🐳 🚢 | `⢾⢷` | `⢾` | `## ⢾⢷ Container Runtime` |
| | API / Interface Nodes | 🔌 🌐 | `⠕⠪` | `⢎` | `## ⠕⠪ API Endpoints` |
| **Status & Alerts** | Success / Done / Passed | ✅ ✔️ | `⢄⠎` | `⢔` | `## ⢄⠎ Verification Passed`|
| | Error / Failed / Fault | ❌ ✖️ | `⡱⢎` | `⡱` | `## ⡱⢎ Error Diagnostics` |
| | Warning / Caution | ⚠️ 🚨 | `⢘⡃` | `⢘` | `## ⢘⡃ Caution & Warnings`|
| | Information / Notice | ℹ️ 💡 | `⢨⡅` | `⢨` | `## ⢨⡅ Important Notice` |
| | Question / FAQ / Help | ❓ ❔ | `⢩⠃` | `⢹` | `## ⢩⠃ FAQ` |
| | Star / Highlight / Key | ⭐ 🌟 | `⡺⢗` | `⡺` | `## ⡺⢗ Key Highlights` |
| | Fire / Hotfix / Urgent | 🔥 ⚡ | `⢴⡷` | `⢶` | `## ⢴⡷ Hotfixes` |
| | Lightning / Performance | ⚡ 🏎️ | `⢴⠃` | `⢔` | `## ⢴⠃ Performance` |
| | Security / Padlock | 🔒 🛡️ | `⣮⣵` | `⣼` | `## ⣮⣵ Security & Auth` |
| | Key / Secrets / Vault | 🔑 🎟️ | `⠊⢵` | `⠪` | `## ⠊⢵ Credentials` |
| | Sync / Loop / Cycle | 🔄 🔁 | `⣎⣱` | `⣎` | `## ⣎⣱ Synchronization` |
| **UI & Telemetry** | Home / Dashboard | 🏠 🏛️ | `⣞⣳` | `⣞` | `## ⣞⣳ Dashboard Home` |
| | Search / Query / Find | 🔍 🔎 | `⠪⢕` | `⠪` | `## ⠪⢕ Global Search` |
| | User / Profile / Account | 👤 👥 | `⡼⢧` | `⡼` | `## ⡼⢧ User Management` |
| | Chat / Discussion | 💬 🗨️ | `⡯⠽` | `⡯` | `## ⡯⠽ Community & Chat` |
| | Notification / Bell | 🔔 📢 | `⠾⡷` | `⢾` | `## ⠾⡷ Notifications` |
| | External Link / Reference| 🔗 ↗️ | `⡪⢕` | `⡪` | `## ⡪⢕ External Links` |
| | Download / Inbound | 📥 ⬇️ | `⣚⣗` | `⣚` | `[ ⣚⣗ ] Download` |
| | Upload / Outbound | 📤 ⬆️ | `⣲⣗` | `⣲` | `[ ⣲⣗ ] Upload` |
| | Mobile / Handheld | 📱 📲 | `⢏⡹` | `⢏` | `## ⢏⡹ Mobile Architecture`|
| | Desktop / Screen | 🖥️ 💻 | `⣫⣝` | `⣫` | `## ⣫⣝ Desktop View` |
| | Network / WiFi | 📶 🌐 | `⣠⣾` | `⣴` | `## ⣠⣾ Connectivity` |
| | Battery / Power State | 🔋 ⚡ | `⣾⣷` | `⣾` | `Status: [ ⣾⣷ ] 98%` |
| | Theme / Appearance | 🎨 🖌️ | `⢞⡷` | `⢞` | `## ⢞⡷ Theme Selector` |
| | Clock / Timer | ⏱️ 🕒 | `⢎⡣` | `⢎` | `Status: [ ⢎⡣ ] 12:00:00` |

---

## ⠕⣀ CLI Commands & Verification

Use the `braille-icon` tool to audit and clean files:

```bash
# Check any file for legacy emoji violations:
braille-icon check README.md

# Automatically replace all legacy emojis with Braille icons:
braille-icon replace README.md

# Look up an icon:
braille-icon lookup rocket
```
