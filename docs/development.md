# 开发与构建

源码需要 Node.js 22.16+。在项目目录运行 npm ci 和 npm test。测试和维护脚本保留在源码仓库；发行包不包含纯开发验收工具。

首次 npm start 应从 Codex 桌面任务环境运行，以记录启动身份。默认只读；需要发送时明确设置 BRIDGE_ENABLE_SEND=1 和 BRIDGE_SEND_SCOPE=all-local，再启动。后续 npm run start:background 使用本机 .local/runtime.json。默认本地页面为 http://127.0.0.1:4317/。

Windows 上 npm run release:package 生成 EXE、Windows ZIP、Hub tar.gz 与 SHA256SUMS。构建依赖 .NET Framework 编译器、官方 Node.js 22 运行时和固定 WebView2 SDK。可用 --runtime-executable 与 --webview-package 复用已校验输入；运行时目录必须带 LICENSE。vendor:math 与 vendor:mermaid 重建固定本地渲染资源。

deploy/verify-windows-installer.mjs 检查实际隔离安装；deploy/verify-windows-upgrade.mjs 接受新旧真实安装器，检查升级保留与回退。其他 deploy/verify-* 为专项维护工具。不要将真实配对或账号状态用于测试，生成日志、截图和证据放在项目忽略的 work 或系统临时目录。
