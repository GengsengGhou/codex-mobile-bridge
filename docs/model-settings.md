# 手机模型与推理强度

输入框旁的紧凑设置入口用于下一轮；新建会话也有模型和推理强度选择。初始值“沿用桌面”不传 `model` / `thinking`，继续采用桌面现有设置。选择使用既有用户、设备隔离存储包装，按会话保存到会话存储；新建会话使用独立设置键。它表示下一次提交的选择，不表示运行中的模型已经改变。

## 桌面接口

已读取安装版本 `OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0` 的只读 `tools/list`。`codex_app.send_message_to_thread` 与 `create_thread` 均支持可选 `model` / `thinking`。模型属性描述动态列出本机可用模型及支持的强度，`thinking` 的枚举提供校验边界。`src/model-settings.mjs` 读取该实际目录；如果目录格式不再可识别，仅关闭自定义选项，桌面默认发送仍可用，不猜测模型列表。

安装源 `webview/assets/app-initial-ff48311587c5.js` 动态为工具 schema 添加模型与强度目录。原生 `main-DAwJoFgo.js` 的 `FCe` 读取启动请求 `model` / `effort` 并可继承桌面设置；`thread-follower-steer-turn` 的处理参数没有模型或强度。因此运行中补充从前端明确省略覆盖参数，并显示本轮沿用运行模型、所选设置用于下一轮。服务端遇到运行中显式覆盖返回 `MODEL_CHANGE_ACTIVE`，在持久化发送标记前拒绝，不会忽略选择或自动重发。

权限覆盖需要使用另一条原生启动路径，见 [会话上下文与权限](thread-context-permissions.md)。与显式模型一起发送时，当前桌面的 `FCe` 将模型与推理强度放入 `collaborationMode.settings`，经所属实例的请求转换进入执行引擎的 `turn/start`。这种模式下 `turn.params.model` / `effort` 为 `null` 是桌面存储形态，不能据此判断模型或强度丢失；验证需要同时查看实际执行轮次的模式设置。仅覆盖权限时沿用原有 collaboration mode、模型与指令；显式模型未选择强度时使用该模型默认强度，不继承另一个模型可能不支持的旧强度。

`GET /api/status` 添加 `modelOptions.send` 与 `modelOptions.create`，仍使用已有本机/公网 relay 路由。消息和创建请求支持两个可选覆盖字段；服务端校验模型与强度组合，失效选择返回 `MODEL_UNAVAILABLE`。发送与创建的持久化请求指纹均包括显式选择，重用请求 ID 改变选择返回冲突。审批与发送权限沿用原有检查。

## 2026-09-27 验收与部署

- 完整测试 `node --test --test-concurrency=4 test/*.test.mjs`：332 通过、0 失败。覆盖动态目录、默认省略覆盖、组合拒绝、请求去重、会话隔离、运行中补充和损坏存储恢复。
- 授权独立验收会话实际提交 `gpt-6-luna` / `high`。原生快照的最新设置和新回合 `params.model` / `params.effort` 均确认该值；回合完成。未向业务会话发送验收消息。
- 生产本机服务 `4317` 上隔离 Chrome 的 390×844 与桌面视口验收通过：模型目录、Luna 无 ultra、重载保持设置、恢复桌面默认、新建会话选择；没有页面错误或横向溢出。模型入口移动端触摸高度44px，空闲输入区域86px。运行中长模型名称与 Stop/补充并存的截图使用明确标注的只读视觉 fixture，未额外创建运行回合。
- 桥接子进程经稳定持久化记录与无未完成变更检查后重新加载；保留监督进程和连接器，不重启 Codex、不改变配对。生产目录返回7个模型，连接器保持 online / inFlight 0。
- 公网 `public/index.html` / `app.js` / `style.css` 已部署，远端 SHA256 与本地一致。部署保留了回滚备份；没有重启 hub 服务。现有 relay API 路径未改变。
- 发布归档与 `dist/SHA256SUMS` 已重建。本轮未重新检查已登录公网浏览器页面，也未验证实体手机触摸。

本机验收记录位于忽略版本控制的 `work/codex-probe/model-settings-{live,ui,deployment}-evidence.json`、`models-full-test.log` 与 `models-*.png`。复现脚本为 `accept-model-settings.mjs --production`（仅GET）和 `accept-model-deployment.mjs`；`accept-live-model-send.mjs` 会发送真实验收消息，只能针对已授权独立测试会话使用。
