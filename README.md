# dsh-dynamic-bg

给 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 加一个**本地视频动态壁纸**的插件。

聊天界面的背景会变成你选的全屏视频，支持多视频切换、填充方式、亮度与白色遮罩调节。

## 功能

- 🎞 **本地视频当壁纸**：文件选择器直接挑本地视频（mp4 / webm / mov / mkv / m4v / ogg），不经过任何服务器
- 🖥 **整屏透出**：聊天区、侧边栏、底栏、输入区的大背景都会被让给壁纸
- 🎚 **亮度 / 白色遮罩**：视频亮度可调，白色遮罩强度可调（0 = 不遮），用来平衡观感与文字可读性
- 📚 **多视频管理**：可添加多个视频，随时切换或删除
- 🧲 **可拖动按钮**：左下角 🎞 按钮可拖到任意位置，位置会记住
- 💾 **持久化**：视频与设置存在浏览器 IndexedDB，重启 DSH 后仍在
- 🚫 **不污染其它页面**：设置页、插件市场等页面保持 DSH 原本外观，只有聊天界面应用壁纸
- 🪶 **零第三方依赖**：客户端纯 DOM 实现，宿主侧为空实现，不依赖 react / 网络服务

## 安装

### 桌面客户端（desktop profile）

DSH 桌面端读取的是 `desktop` profile（`%USERPROFILE%\.dsh\profiles\desktop`），
不能用 `dsh plugin --profile web add`。两种安装方式：

**方式 A（推荐）**：把本仓库目录放到

```
%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-dynamic-bg\
```

然后在同目录的 `package.json` 的 `dsh.profile.bundles` 数组里加入：

```json
"dsh-dynamic-bg"
```

最后**完全退出 DSH（含托盘）再重新打开**。

**方式 B**：在桌面端会话里让 DSH 用内置 `plugin_manager` 安装本仓库。

### Web 版（dsh web）

```bash
dsh plugin --profile web add github:AyachiNeneCiallo/dsh-dynamic-bg
```

安装后重启 `dsh web`，浏览器 `Ctrl + F5`。

## 使用

1. 左下角有半透明的 **🎞** 按钮（可拖动）
2. 点开面板 → **「选择本地视频…」**
3. 选中视频后会自动应用
4. 用面板里的滑块调节：
   - **视频亮度**：视频本身的亮度
   - **白色遮罩**：叠加在视频上的白色蒙层，越大画面越白、文字越清楚
5. 面板底部状态行会显示：启用状态、视频是否挂载、分辨率、能否播放、已透明化容器数量

## 配置项

| 键 | 说明 | 默认 |
|---|---|---|
| `enabled` | 是否启用壁纸 | `true` |
| `activeKey` | 当前选中的视频 | 空 |
| `fit` | 填充方式：`cover` / `contain` / `fill` | `cover` |
| `opacity` | 视频亮度 0.1–1 | `1` |
| `scrim` | 白色遮罩强度 0–0.9 | `0.35` |

设置保存在浏览器 IndexedDB 的 `dsh-dynamic-bg` 数据库中。

## 工作原理

```
dsh-dynamic-bg/
├── package.json       # 插件元数据：dsh.bundle.patch + dsh.client
├── cordis.patch.yml   # bundle 挂载声明
├── lib/index.js       # 宿主半区：空实现，不接触任何 cordis 服务
└── client.js          # 客户端半区：纯 DOM + IndexedDB
```

- 宿主半区刻意留空：不注入 `webServer` 等服务，避免启动失败
- 客户端半区由 DSH 客户端加载器调用 `apply(ctx)`
- 视频层固定全屏、`z-index:-1`，同时把 DSH 的背景变量与分栏容器改成透明
- 通过检测聊天输入区是否可见，判断当前是否聊天界面；离开时自动还原所有被改过的背景

## 兼容性

- DSH 桌面端 `2.0.x`（`dsh 0.2.1-rc.2`）测试通过
- 依赖 DSH 的客户端 bundle 机制（`dsh.client` + `exports["./client"]`）
- 如果 DSH 升级后界面类名变化，插件内置的「大面积容器自动透明化」兜底通常仍能工作

## 卸载

1. 从 `dsh.profile.bundles` 移除 `"dsh-dynamic-bg"`
2. 删除 `node_modules/dsh-dynamic-bg` 目录
3. 重启 DSH

## License

MIT © [AyachiNeneCiallo](https://github.com/AyachiNeneCiallo)
