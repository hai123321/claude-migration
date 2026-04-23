# Claude Code Migration Tool

Migrate toàn bộ cấu hình Claude Code sang máy khác, account khác, hoặc chia sẻ với team.

---

## Nhanh chóng: 3 bước

```bash
# 1. Cài dependencies (chỉ làm một lần)
cd migration-tool && npm install

# 2. Export ở máy nguồn
node migrate-export.js --output ~/Desktop/my-claude-config.tar.gz

# 3. Import ở máy đích (copy file sang trước)
node migrate-import.js my-claude-config.tar.gz --overwrite
```

Xong. Sau đó điền lại API keys vào `~/.claude/mcp-configs/mcp-servers.json` và restart Claude Code.

---

## Những gì được migrate

| Thành phần | Mặc định | Cần flag |
|---|:---:|---|
| `settings.json` — hooks, env vars, permissions | ✅ | |
| `mcp-configs/` — MCP server definitions | ✅ | |
| `agents/` — custom sub-agents (47 agents) | ✅ | |
| `skills/` — thư viện skills (150+ skills) | ✅ | |
| `commands/` — slash commands | ✅ | |
| `rules/` — coding rules (common, typescript, web...) | ✅ | |
| `plugins/` — danh sách plugins đã cài | ✅ | |
| `ecc/` — superpowers data | ✅ | |
| `scripts/` — hook scripts | ✅ | |
| `sessions/` — lịch sử chat | ❌ | `--include-sessions` |
| `history.jsonl` — lịch sử lệnh | ❌ | `--include-history` |
| `projects/` — session data theo project | ❌ | `--include-projects` |

---

## Kịch bản sử dụng

### Chuyển sang máy mới

```bash
# Máy cũ
node migrate-export.js --output ~/Desktop/claude-config.tar.gz

# Copy file sang máy mới (AirDrop, USB, cloud...)
# Máy mới
npm install
node migrate-import.js claude-config.tar.gz --overwrite
```

### Chia sẻ config với team (không kèm secrets)

```bash
# Export — secrets tự động bị redact
node migrate-export.js --output ./team-claude-config.tar.gz

# Gửi file cho teammate
# Teammate import vào máy họ
node migrate-import.js team-claude-config.tar.gz
# Sau đó điền API keys của riêng họ
```

### Merge config từ 2 máy (giữ cả 2)

```bash
# Dùng --merge để gộp JSON thay vì ghi đè
node migrate-import.js config.tar.gz --merge
```

### Backup trước khi thay đổi lớn

```bash
node migrate-export.js --output ~/backups/claude-$(date +%Y%m%d).tar.gz
```

### Export toàn bộ (kể cả lịch sử chat)

```bash
node migrate-export.js \
  --include-sessions \
  --include-history \
  --include-projects \
  --output ~/full-backup.tar.gz
```

---

## Export — tất cả options

```
node migrate-export.js [options]

Options:
  --output <path>       Đường dẫn file output
                        (mặc định: ./claude-migration-<timestamp>.tar.gz)
  --include-sessions    Bao gồm lịch sử chat sessions
  --include-history     Bao gồm history.jsonl
  --include-projects    Bao gồm project session data
  --include-telemetry   Bao gồm telemetry data
  --no-sanitize         Không redact secrets (chỉ dùng khi transfer cùng user)
  --dry-run             Xem preview không ghi file
```

**Tính năng tự động của export:**
- Secrets (API keys, tokens, passwords) bị thay bằng `YOUR_*_HERE`
- Absolute paths (`/Users/ten/...`) thay bằng `__HOME__` — restore khi import
- Import script được đóng gói vào bundle để tiện dùng

---

## Import — tất cả options

```
node migrate-import.js <bundle.tar.gz> [options]

Options:
  --overwrite           Ghi đè file đã tồn tại (mặc định: bỏ qua conflicts)
  --merge               Merge JSON thay vì ghi đè (tốt cho MCP servers)
  --exclude <paths>     Bỏ qua một số thành phần, cách nhau bằng dấu phẩy
                        Ví dụ: --exclude sessions,history.jsonl
  --dry-run             Xem preview không ghi file
  --no-backup           Bỏ qua backup tự động
```

**Import tự động backup** `~/.claude` thành `~/.claude.backup.<timestamp>` trước khi ghi.

---

## Sau khi import

### 1. Điền lại API keys

Mở file và thay các giá trị `YOUR_*_HERE`:

```bash
# MCP server API keys
nano ~/.claude/mcp-configs/mcp-servers.json

# Env vars trong settings
nano ~/.claude/settings.json
```

Các placeholder phổ biến cần điền:

| Placeholder | Lấy ở đâu |
|---|---|
| `YOUR_GITHUB_TOKEN` | github.com → Settings → Developer settings → PAT |
| `YOUR_OPENAI_API_KEY` | platform.openai.com/api-keys |
| `YOUR_JIRA_API_TOKEN` | id.atlassian.com → Security → API tokens |
| `YOUR_ANTHROPIC_AUTH_TOKEN` | console.anthropic.com → API Keys |
| `YOUR_FIRECRAWL_KEY_HERE` | firecrawl.dev → Dashboard |

### 2. Restart Claude Code

```bash
# Tắt và mở lại Claude Code
# Hoặc trong terminal:
claude --version  # kiểm tra chạy được
```

### 3. Kiểm tra MCP

```bash
claude mcp list
```

---

## npm scripts tiện lợi

```bash
npm run export                    # Export cơ bản
npm run export:with-sessions      # Export đầy đủ (kể cả sessions)
npm run dry-run                   # Preview export
```

---

## Lưu ý bảo mật

- **Secrets luôn bị redact** khi export — không lo lộ API key khi chia sẻ bundle.
- **Sessions bị loại trừ mặc định** vì có thể chứa nội dung nhạy cảm.
- Dùng `--no-sanitize` chỉ khi transfer giữa 2 máy của cùng một người.
- Bundle tar.gz vẫn có thể chứa nội dung từ các file markdown/script — kiểm tra trước khi gửi ra ngoài.

---

## Cấu trúc project

```
migration-tool/
├── migrate-export.js    # Script export
├── migrate-import.js    # Script import
├── package.json
└── README.md
```
