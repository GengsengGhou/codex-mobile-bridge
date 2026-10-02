# 跟随桌面排序

默认会话列表跟随 Codex 桌面的当前排序，网页拖动保存的顺序优先；“恢复桌面顺序”移除网页覆盖，不修改桌面偏好。

桥接读取桌面的项目归属、项目顺序、会话手动顺序以及必要的排序偏好。每次会话列表刷新重新读取这些数据；不会向手机转发完整桌面设置。

在已验证的 Codex 26.928.4866 中：

- 项目内会话使用当前 `projectSortMode`；无项目会话使用 `chatSortMode`。
- `manual` 只有配合 `manualSortVersion: 1` 才有效。旧的 `manual`、`priority`、`created_at` 会迁移为 `updated_at`；旧 `codex-sidebar-sort-mode-v1` 存在时也使用 `updated_at`。
- 最近排序保留桌面 `list_threads` 的原始最近顺序，不用 `updatedAt` 猜测另一种顺序。
- 有效手动排序先展示仍存在的已保存会话，再按桌面原顺序追加新会话。已删除的保存项不占位置。
- 项目文件夹独立使用 `unified-sidebar-project-order-v1` 的保存顺序，新项目追加在后；缺少这项时按旧 `project-order` 的规则把未记录项目放在前面。
- 置顶会话保持桌面返回的置顶序号。

完整列表计算 `projectOrder` 和 `projectThreadOrder`。单独读取会话只补充会话与项目信息，避免把单项读取中的未知位置覆盖回列表。网页继续把用户保存的拖动顺序应用在这些桌面位置之上。

这些规则来自安装版侧边栏的 `b_n`/`eA` 偏好迁移、`$Zn`/`rQn` 会话排序、`mOn`/`pOn` 旧项目排序及 `smn`/`umn` 统一项目排序。后续桌面升级可能需要重新验证内部设置格式。
