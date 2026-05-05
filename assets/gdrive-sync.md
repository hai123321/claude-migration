# gdrive-sync

Đồng bộ cấu hình Claude Code với Google Drive tự động.

## Slash Commands

- `/gdrive-push` — Upload config lên Google Drive ngay bây giờ
- `/gdrive-pull` — Download và merge config từ Google Drive
- `/gdrive-sync` — Tự động sync theo timestamp (push hoặc pull)
- `/gdrive-status` — Xem trạng thái đồng bộ (local vs remote)
- `/gdrive-uninstall` — Gỡ cài đặt plugin khỏi Claude Code

## Mô tả

Plugin này tích hợp Claude Code với Google Drive để tự động đồng bộ toàn bộ cấu hình:

**Tự động (sau khi cài hooks):**
- Khi bắt đầu session: pull config mới nhất từ Drive về local
- Khi kết thúc session: push config local lên Drive

**Thủ công (slash commands):**
- Gõ `/gdrive-sync` trong chat Claude để sync ngay lập tức
- Gõ `/gdrive-status` để kiểm tra trạng thái

## Dữ liệu được đồng bộ

- `settings.json` — Cài đặt, hooks, biến môi trường
- `mcp-configs/` — Cấu hình MCP servers
- `agents/` — Custom sub-agents
- `skills/` — Skills library
- `commands/` — Slash commands
- `rules/` — Coding rules
- `memory/` — Global memory files

**Không đồng bộ:** API keys (được redact), token xác thực, lịch sử chat (trừ khi chọn).

## Cài đặt lần đầu

```bash
npm install -g claude-gdrive-sync
claude-gdrive-sync setup
```

## Lệnh CLI

```bash
claude-gdrive-sync setup      # Wizard cài đặt
claude-gdrive-sync push       # Upload lên Drive
claude-gdrive-sync pull       # Download từ Drive
claude-gdrive-sync sync       # Auto-sync
claude-gdrive-sync status     # Trạng thái
claude-gdrive-sync uninstall  # Gỡ cài đặt
```
