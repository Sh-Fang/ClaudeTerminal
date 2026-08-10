# Claude Terminal

适配 [Claude Code](https://claude.com/claude-code) 的多窗口管理终端。Electron + xterm.js + ConPTY,为同时开多个 cc 会话的重度用户设计。

> **非官方项目**:本项目与 Anthropic 无关联。"Claude" 与 "Claude Code" 是 Anthropic 的商标,本项目仅是配合 Claude Code CLI 使用的第三方终端工具。

## 功能

- **会话绑定 · 一键恢复** — 标签页绑定 Claude Code 会话,关闭重开自动 `--resume` 恢复现场
- **状态徽标** — busy / 待输入 / 完成 / 异常,一眼看出哪个会话该处理
- **分组 · 保存 · 工作区** — 标签按目录分组,分组可保存复用,多套工作区隔离
- **多窗口** — 标签拖出成独立窗口、拖回合并,同组内可拖动排序
- **会话历史** — 今天 / 昨天 / 更早的历史会话随时找回
- **悬浮窗** — 小窗悬浮桌面,全局会话状态一瞥
- **用量面板** — 账号级额度与上下文占用实时展示(token 只在内存里当请求头,不落命令行)
- **版本锁定** — 可锁定 cc 版本、禁用自动升级
- **PowerShell 7 + 真 ConPTY** — 不修改你的全局 shell / cc 配置
- 中英文界面,多主题

## 环境要求

- Windows 10 1809+(ConPTY)与 [PowerShell 7](https://github.com/PowerShell/PowerShell)(主要平台)
- 已安装 [Claude Code CLI](https://claude.com/claude-code)
- macOS 可构建使用,但产物未签名(首次打开需右键 → 打开)

## 开发与构建

```bash
npm install        # .npmrc 已配置 electron 镜像与 legacy-peer-deps
npm run dev        # 开发模式
npm run dist       # 打包:NSIS 安装包 + 便携 zip(Windows)
npm run dist:mac   # macOS 打包(仅能在 macOS 上执行)
```

## 许可证

[GPL-3.0](LICENSE) — 可自由使用与二次开发;分发修改版必须以同样的许可证开源。
