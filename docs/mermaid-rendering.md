# Mermaid 图表

完整的 `mermaid` 代码围栏可显示思维导图（`mindmap`）、流程图（`flowchart` / `graph`）和时序图（`sequenceDiagram`）。主会话与只读子智能体查看器共用显示方式；普通代码块仍保留代码复制。

图表随消息字号放大，在自己的区域内横向、纵向滚动。选择“查看源码”可展开原文，“复制”始终复制原代码。绘制期间手动选择的源码展开状态会保留。未闭合围栏、语法错误、超限或不支持的内容显示可读源码及提示；不保证支持上述三类的所有 Mermaid 扩展语法。

首次遇到支持且可见的图表时才加载本地 Mermaid 模块。普通消息和主会话尚未展开的工作过程不下载模块。模块固定为 Mermaid 12.1.0，经 esbuild 0.28.2 打包成单个约 5.01 MiB 文件；首次载入成本应计入图表体验，普通页面不会因此加载外部 CDN。构建命令为 `npm run vendor:mermaid`；版本、文件名与 SHA256 清单在服务启动时验证。

每条消息最多绘制四张图；源码最多 16,384 字符、128 行及分号语句、每行 512 字符、80 条边。最终 SVG 最多 524,288 字符、12,000 个元素，宽高各不超过 12,000，面积不超过 8,000,000。这些是保守的显示边界，超限内容仍可查看与复制。

会话文本不能改变初始化配置、主题 CSS 或安全等级，不支持 HTML、图标、资源 URL 及流程图的点击、样式指令。URL 字符串也保守地退回源码。图表采用固定字体和主题，SVG 仅允许文本、几何及本地片段引用；脚本、事件、外部资源、`foreignObject` 和动态 CSS 被拒绝。最终结果通过无交互的 SVG 图片显示，不绑定 Mermaid 回调。现有 CSP 的 script/eval/connect/style 规则保持；生成 CSS 通过非渲染的描述载体转为内联声明，Cytoscape 的固定容器样式来自现有本地 CSS。上游插入点变化会使有精确匹配守卫的 vendor 构建失败。

上述功能正式纳入 v1.0.4，此前已在 1.0.3 完成同版本试用。完整资源文件集为 `public/markdown.js`、`public/mermaid.js`、`public/style.css`、`public/i18n-messages.js`、`public/vendor/mermaid/mermaid.mjs`、`public/vendor/mermaid/LICENSE`、`public/vendor/mermaid/manifest.json` 与 `src/static-assets.mjs`。静态白名单在模块初始化时建立，完整文件集替换并核对后需要刷新专用 bridge child 与 Hub 进程；仅刷新浏览器不足以让旧进程识别新资源。本次已完成必要进程刷新，已有网页刷新后可使用。此轮试用站点保留既有远端 package 版本，正式安装包包含完整资源。回退应恢复完整文件集并重新载入相关进程；实际部署记录与未覆盖范围见 [验收记录](verification.md)。
