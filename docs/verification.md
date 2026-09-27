# 验收记录

截至 2026-09-28，最近一次集成测试为 368 通过、0 失败。已验证鉴权、设备与会话隔离、请求去重、模型设置、公式渲染、历史分页、轮询和隔离 Windows 安装器。断线恢复不会自动重放聊天、审批、新建会话或附件提交。

实体手机触摸与移动网络、第二台实际电脑、已登录公网浏览器完整流程，以及可交互 Windows 桌面的完整安装体验尚未验收。Windows 界面检查包含真实 WinForms 渲染和隔离安装验证，不能替代上述体验验收。

详细本机日志、截图、临时路径、会话标识和部署记录保存在忽略版本控制的 work/ 与 docs/verification/ 中。模型设置说明见 [model-settings.md](model-settings.md)，运行条件见 [remote-readiness.md](remote-readiness.md)，部署与设备配对见 [vps-device-hub.md](vps-device-hub.md)。
