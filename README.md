# dsh-dynamic-bg

给 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 加一个**本地动态壁纸**的插件。

聊天界面与左侧会话栏的背景会变成你选的全屏视频，或者 **Wallpaper Engine 创意工坊里的场景壁纸**（直接解析 `scene.pkg`，用 WebGL 还原动效）；支持多壁纸切换、填充方式、亮度与白色遮罩调节。

## 功能

- 🎞 **本地视频当壁纸**：文件选择器直接挑本地视频（mp4 / webm / mov / mkv / m4v / ogg），不经过任何服务器
- 🎬 **Wallpaper Engine 场景壁纸**：自动扫描 Steam 创意工坊 `431960`，在本地解析 `scene.pkg`（纹理、遮罩、LZ4 解压全在宿主完成），再用 WebGL2 还原水流、发丝摆动等着色器动效
- 🖥 **聊天区 + 会话栏透出**：聊天主区与左侧栏的大背景都让给壁纸
- 🧊 **右栏代码区蒙层**：右侧代码 / diff / 预览区保留一层淡淡的白色蒙层，壁纸透出的同时保证代码可读
- 🎚 **亮度 / 白色遮罩**：视频亮度可调，白色遮罩强度可调（0 = 不遮）
- 📚 **多视频管理**：可添加多个视频，随时切换或删除
- 🧲 **可拖动按钮**：左下角 🎞 按钮可拖到任意位置，位置会记住
- 💾 **持久化**：视频与设置存在浏览器 IndexedDB，重启 DSH 后仍在
- 🚫 **不污染其它页面**：设置页、插件市场等整页视图会自动还原成 DSH 原生外观
- 🪶 **零第三方依赖**：不依赖 react 或任何 npm 包；宿主侧只读本地文件，不访问网络

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

1. 左下角有半透明的 **🎞** 按钮（可拖动，位置会记住）
2. 点开面板 → **「选择本地视频…」**
3. 选中视频后会自动应用
4. 用面板里的滑块调节：
   - **视频亮度**：视频本身的亮度
   - **白色遮罩**：叠加在视频上的白色蒙层，越大画面越白、文字越清楚
5. 面板底部状态行会显示：启用状态、视频是否挂载、分辨率、能否播放、壁纸模式判定

### 用 Wallpaper Engine 壁纸

1. 面板里点 **「Wallpaper Engine 壁纸…」**，插件会扫描本机所有 Steam 库（含多盘、`libraryfolders.vdf`）里的创意工坊目录
2. 列表里标 **「场景 · 可渲染」** 的可以点一下直接应用；其余类型会列出但不支持
3. **动效强度** 滑块用来放大/减弱着色器动效（100% 即场景原作强度；这类场景的动效通常很含蓄，觉得静止可以调到 200–300%）

应用后设置会记住，重启 DSH 仍在。渲染失败时会自动降级：先用场景底图（通常是 4K PNG），再退回壁纸自带的预览图。

## 配置项

| 键 | 说明 | 默认 |
|---|---|---|
| `enabled` | 是否启用壁纸 | `true` |
| `activeKey` | 当前选中的壁纸：视频是 `v:<时间戳>:<文件名>`，场景是 `we:<工坊目录>` | 空 |
| `fit` | 填充方式：`cover` / `contain` / `fill` | `cover` |
| `opacity` | 亮度 0.1–1 | `1` |
| `scrim` | 白色遮罩强度 0–0.9 | `0.35` |
| `effectStrength` | 场景动效强度 0–3 | `1` |

设置保存在浏览器 IndexedDB 的 `dsh-dynamic-bg` 数据库中。

## 工作原理

```
dsh-dynamic-bg/
├── package.json       # 插件元数据：dsh.bundle.patch + dsh.client
├── cordis.patch.yml   # bundle 挂载声明
├── lib/index.js       # 宿主半区：扫 Steam 库、解析 scene.pkg/.tex、提供只读 HTTP 接口
└── client.js          # 客户端半区：纯 DOM + IndexedDB + WebGL2
```

- 宿主半区只 `inject: ['webServer']`，在 `/api/dsh-dynamic-bg/*` 下挂四个只读路由（`scan` / `scene` / `asset` / `preview`）；拿不到 `webServer` 就只是不注册路由，不影响插件其余部分
- 所有读盘都限制在请求里的 `dir` 之内，贴图名必须命中 pkg 条目，路径穿越直接 400
- 客户端半区由 DSH 客户端加载器调用 `apply(ctx)`
- 视频层固定全屏、`z-index:-1`；同时把 `html / body / #root` 以及聊天区、侧栏容器改成透明，并覆盖背景类 CSS 变量
- 通过「输入框可见」判断当前是否聊天界面；离开时自动还原所有改动
- 右栏（代码 / diff / 预览）使用一层 45% 白色蒙层，兼顾壁纸与代码可读性

## Wallpaper Engine 场景支持

### 数据流

```
%Steam%\steamapps\workshop\content\431960\<id>\
├── project.json            # 标题 / 类型 / 预览图
├── scene.pkg               # PKGV 容器：scene.json + 贴图 + 着色器源码
└── preview.gif             # 降级时用

宿主解析 scene.pkg ─┬─ scene.json → object.image → model.json → material.json → 贴图名
                    │                              └→ effects[] → effect.json → shader 名 + 参数
                    └─ .tex 解码：内嵌 PNG 直传 / LZ4 解压 / R8·RG88·R16 展开为 RGBA

客户端 WebGL2 ── 全屏四边形 + 逐图层着色器（waterflow、foliagesway）→ 叠加 → 白色遮罩
```

### 实现范围

- 已移植：`waterflow`（水流扭曲）、`foliagesway`（发丝 / 树叶摆动）
- 未移植：`rain` 粒子、`waterripple`、`shake`、`iris_movement`（前三个在这些场景里覆盖面积很小；雨在多数场景默认关闭）
- 只支持「图片图层 + 上述效果」这一形态的 scene；音频可视化、Live2D、纯粒子场景会退化为静态底图
- 场景分辨率与原作一致（例：3840×2160），渲染缓冲按 ≤2560px 封顶以控制显存

### 已知限制

- Steam 库扫描只覆盖 Windows 盘符下的常见安装位置 + `libraryfolders.vdf`
- 需要 WebGL2；不可用时自动降级
- 移植的着色器逻辑参考了场景包内 WE 自带的效果实现（`shaders/effects/*.frag`），按其参数语义重写为 WebGL2 GLSL ES

## 兼容性

- DSH 桌面端 `2.0.x`（`dsh 0.2.1-rc.2`）测试通过
- 依赖 DSH 的客户端 bundle 机制（`dsh.client` + `exports["./client"]`）
- 场景壁纸额外依赖宿主的 `webServer` 服务与浏览器的 WebGL2；两者缺失时自动降级为静态图，视频壁纸不受影响
- 如果 DSH 升级后界面类名变化，插件内置的透明规则与变量覆盖通常仍能工作

## 卸载

1. 从 `dsh.profile.bundles` 移除 `"dsh-dynamic-bg"`
2. 删除 `node_modules/dsh-dynamic-bg` 目录
3. 重启 DSH

## License

MIT © [AyachiNeneCiallo](https://github.com/AyachiNeneCiallo)
