# claude-wechat-bridge

将微信 ClawBot 消息桥接到 Claude Code，在微信上直接和 Claude 对话。

```
微信 (iOS ClawBot) → iLink API → bridge daemon → Claude Agent SDK → Claude Code
```

## 特性

- 🔗 **微信 ClawBot 接入** — 通过官方 iLink API 收发消息
- ⚡ **Session 保活** — V2 Agent SDK 持久 session，后续消息零冷启动
- 💬 **Typing 指示** — 智能延迟发送，避免快回复时残留
- 🧠 **上下文注入** — 可选注入 SOUL.md/MEMORY.md 等人格/记忆文件
- 🎛️ **斜杠命令** — `/new` `/model` `/status` `/help`
- 🔄 **错误恢复** — session 异常自动重建
- 🗣️ **语音支持** — 自动使用微信的语音转文字

## 前置要求

- Node.js >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 已安装
- [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 可用（通过 claude-to-im 插件或全局安装）
- 微信 iOS 最新版 + ClawBot 功能已开启

## 快速开始

### 1. 下载

```bash
git clone https://github.com/xiangyingchang/claude-wechat-bridge.git
cd claude-wechat-bridge
```

### 2. 配置环境变量

```bash
# 必需：Claude Code 可执行文件路径
export CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude
# 或 Claude Code Internal:
# export CLAUDE_CODE_EXECUTABLE=$HOME/.npm-global/bin/claude-internal

# 必需：Anthropic API（如果用自定义 endpoint）
export ANTHROPIC_BASE_URL=https://api.anthropic.com
export ANTHROPIC_AUTH_TOKEN=sk-ant-...

# 可选：模型（默认 claude-sonnet-4-6）
export WECHAT_BRIDGE_MODEL=claude-sonnet-4-6

# 可选：工作目录（默认当前目录）
export WECHAT_BRIDGE_CWD=$HOME/my-project

# 可选：session 超时（默认 30 分钟，单位毫秒）
export WECHAT_BRIDGE_SESSION_TTL=1800000

# 可选：上下文文件注入（逗号分隔的文件路径）
export WECHAT_BRIDGE_CONTEXT_FILES=SOUL.md,USER.md,MEMORY.md
```

### 3. 扫码登录

```bash
node daemon.mjs --setup
```

微信扫描弹出的 QR 码并确认登录。凭据保存在 `~/.wechat-bridge/credentials.json`。

### 4. 启动

```bash
node daemon.mjs
```

在微信 ClawBot 里发消息，即可收到 Claude 的回复。

## 斜杠命令

| 命令 | 说明 |
|------|------|
| `/new` | 新建会话，清除上下文 |
| `/model [名称]` | 查看/切换模型 |
| `/status` | 查看 bridge 状态 |
| `/help` | 显示帮助 |

## 后台运行 (macOS launchd)

创建 `~/Library/LaunchAgents/com.wechat-bridge.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.wechat-bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/claude-wechat-bridge/daemon.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/your/workspace</string>
    <key>StandardOutPath</key>
    <string>/tmp/wechat-bridge.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/wechat-bridge.log</string>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_CODE_EXECUTABLE</key>
        <string>/usr/local/bin/claude</string>
        <key>WECHAT_BRIDGE_MODEL</key>
        <string>claude-sonnet-4-6</string>
    </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.wechat-bridge.plist
```

## 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `CLAUDE_CODE_EXECUTABLE` | 是 | `claude` | Claude Code 可执行文件路径 |
| `ANTHROPIC_BASE_URL` | 否 | (SDK 默认) | API endpoint |
| `ANTHROPIC_AUTH_TOKEN` | 否 | (SDK 默认) | API 认证 token |
| `WECHAT_BRIDGE_MODEL` | 否 | `claude-sonnet-4-6` | 默认模型 |
| `WECHAT_BRIDGE_CWD` | 否 | `process.cwd()` | Claude 工作目录 |
| `WECHAT_BRIDGE_SESSION_TTL` | 否 | `1800000` (30min) | Session 保活超时 |
| `WECHAT_BRIDGE_CONTEXT_FILES` | 否 | (空) | 逗号分隔的上下文文件路径 |
| `WECHAT_BRIDGE_DATA_DIR` | 否 | `~/.wechat-bridge` | 数据目录 |

## 架构

```
daemon.mjs          主循环：poll → dispatch → send
├── ilink-client.mjs   iLink API 封装（QR登录/轮询/发送/typing）
└── llm.mjs            Agent SDK 封装（V2 session keepalive + V1 fallback）
```

## 工作原理

1. **长轮询** — `ilink/bot/getupdates` 35s 长轮询等待微信消息
2. **消息派发** — 斜杠命令直接处理，普通消息发给 Claude
3. **Session 保活** — 首条消息创建 V2 Session（spawn claude 进程），后续消息复用同一进程
4. **Typing 延迟** — Claude 处理超过 2s 才发送"正在输入"，避免快回复时残留
5. **长消息分割** — 超过 4000 字自动分割成多条发送
6. **错误恢复** — session 异常自动关闭并重建

## License

MIT
