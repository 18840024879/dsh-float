# dsh-float

豆包风格的 DeepSeek Harness 桌面助手：常驻置顶的独立对话面板，面板可自由缩放，框选屏幕区域直接提问。使用 dsh 里已经配置好的模型与账号，不需要另外填 API Key。

仅支持 Windows 10/11 x64。English: [README.en.md](README.en.md)

## 功能

- **双击桌宠打开**：安装了 dsh-pet 时，双击桌宠本体打开/隐藏面板（两次点击需在系统双击间隔内、位置基本不变），单击或拖动桌宠不会误触；不装桌宠也能用 `Alt+Space` 或托盘菜单。
- 面板可拖动标题栏移动，拖右边缘、底边或右下角缩放；位置与大小自动记忆。
- 流式回答、停止生成、模型选择、新对话、历史保留最近 8 轮。
- 回答里的 LaTeX 公式（`$...$`、`$$...$$`、`\(...\)`、`\[...\]`）用本地 KaTeX 渲染，内置 KaTeX 字体，效果与豆包悬浮窗一致；Markdown 的标题、有序/无序列表、表格、分隔线、引用、代码块、粗体与行内代码也会正常显示，不再出现 `##`、`- `、`---` 之类的原始符号。
- 截图提问：框选屏幕区域，图片作为附件发送；发送过的截图会以缩略图留在对话历史里，重新打开面板也能看到。遮罩窗口常驻预热，悬停相机按钮时就开始取屏幕流，因此点下去很快出现选区；遮罩等截图画面绘好后才淡入，不会先黑一下再显示。
- 文本模型遇到图片时，会自动寻找可用的 modlens 视觉路由；找不到会明确报错，不会静默丢图。
- 默认快捷键 `Alt+Space`；被占用时自动降级为 `Ctrl+Alt+Space`，托盘菜单也可打开/截图/退出。
- 关闭 dsh 后 Helper 自动退出，不留后台进程。

## 安装

### 从命令行安装（普通用户）

```bash
dsh plugin --profile desktop add dsh-float
```

装完重启 DeepSeek Harness。Helper 是独立的 Electron 进程：会依次查找 `DSH_FLOAT_ELECTRON_PATH`、`DSH_PET_ELECTRON_PATH`、插件自带依赖、`~\.dsh\electron\electron.exe`，都没有时首次启动会下载 Electron 43.3.0 到 `~\.dsh\dsh-float\electron\`（约 110 MB，仅一次；优先 npmmirror，失败回退 GitHub）。想复用现成的运行时，设置 `DSH_FLOAT_ELECTRON_PATH` 即可跳过下载。

### 本地开发安装

插件目录：`%USERPROFILE%\.dsh\plugins\dsh-float`，profile：`%USERPROFILE%\.dsh\profiles\desktop`。

1. **登记依赖**：在 profile 的 `package.json` 中加

   ```json
   "dsh-float": "link:C:/path/to/dsh-float"
   ```

   并在 `dsh.profile.bundles` 数组末尾加 `"dsh-float"`。

2. **安装链接**（使用 dsh 自带运行时）：

   ```bash
   NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
   PNPM="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
   cd "$HOME/.dsh/profiles/desktop"
   "$NODE" "$PNPM" install --offline --no-frozen-lockfile
   ```

   若提示缺包，去掉 `--offline` 再执行一次。确认 `node_modules/dsh-float` 指向插件目录。

3. **重启 DeepSeek Harness**。启动成功时 dsh 日志会出现 `[dsh-float] loaded` 和 `helper ready on 127.0.0.1:…`。

### 卸载

从 profile `package.json` 删除依赖与 `dsh.profile.bundles` 里的 `dsh-float`，重新执行 pnpm install，或直接删除 `node_modules/dsh-float` 链接，然后重启 dsh。

## 使用

- 双击 dsh-pet 桌宠打开面板；再次双击、按 `Esc` 或点右上角「—」隐藏。拖动桌宠时不会打开。
- 拖动面板标题栏移动位置；拖右边缘 / 底边 / 右下角调整大小（最小 320×420，超出屏幕会自动限制）。
- `Enter` 发送，`Shift+Enter` 换行；回答中可点停止按钮。
- 左下角相机按钮进入框选：拖拽选区，松开完成，`Esc` 取消。
- 面板顶部的模型名可打开模型列表；「跟随 dsh 默认」表示使用 dsh 当前会话模型。
- 托盘图标：显示/隐藏、截图提问、退出；`Alt+Space` 同样可切换面板。

## 数据与配置

都在 `~\.dsh\dsh-float\`：

| 文件 | 内容 |
| --- | --- |
| `config.json` | 快捷键、system prompt、模型偏好、历史轮数、autoVision |
| `history.json` | 最近 40 条对话（面板显示最近 12 条） |
| `window.json` | 面板上次的位置与大小 |

截图先保存在系统临时目录 `%TEMP%\dsh-float\shot-*.png`，发送后由宿主删除。

`config.json` 示例：

```json
{
  "hotkey": "Alt+Space",
  "systemPrompt": "你是一个常驻桌面的 AI 助手……",
  "model": null,
  "maxHistoryRounds": 8,
  "autoVision": true,
  "opacity": 1
}
```

`model: null` 跟随 dsh 默认；也可以写成 `{"provider": "...", "model": "..."}`。删除该文件即恢复默认配置。

## 视觉（看图）

图片会经过两层检查：

1. 当前模型 `inputModalities` 含 `image` → 直接发送。
2. 否则在已安装的 provider 中找含 `image` 能力、且模型名匹配的视觉路由（优先 modlens），自动切换并提示。
3. 都没有 → 报 `VISION_UNAVAILABLE`，提示安装/启用 modlens 或手动选择视觉模型。

> 文本模型不会对图片报错，而是把图片静默替换成占位文本，所以不能靠「发送成功」判断视觉能力。

## 排障

- **面板打不开 / 双击桌宠没反应**：确认 dsh-pet 正在运行，且双击的是宠物本体（不是气泡里的按钮）；两次点击要在系统双击间隔内、位置基本不变（拖拽桌宠不算双击）。确认 dsh 日志里有 `[dsh-float] loaded`。点击监听器首次运行时会用系统自带 .NET Framework 的 `csc.exe` 编译到 `~\.dsh\dsh-float\bin\`，失败会写入 `helper-debug.log`，此时仍可用 `Alt+Space` 或托盘打开。
- **找不到 Electron / 下载失败**：Helper 会在首次启动时自动下载；若下载失败（网络或代理），设置 `DSH_FLOAT_ELECTRON_PATH` 指向现成的 `electron.exe`，或安装 dsh-pet 复用它的 `~\.dsh\electron`。下载与查找过程写入 `helper-debug.log`。
- **快捷键无效**：被其他软件占用会降级并提示；以托盘菜单为准，提示文字会显示实际快捷键。
- **回答报「上一条回答还没结束」**：先停止上一条；Helper 重启期间请求会超时，稍候重试。
- **Helper 崩溃**：宿主会自动重启，750ms 起指数退避，最多 12 次；约每 3 分钟稳定运行后重置计数。
- **截图是黑屏/失败**：先升级显卡驱动；Helper 优先用屏幕流取帧，不可用时自动回退到 `desktopCapturer`，再失败则用 PowerShell 截屏。
- **截图遮罩没出现**：Helper 会等画面绘好再显示遮罩，并在显示失败时重试；60 秒未选择区域会自动取消并恢复面板。诊断日志在 `~\.dsh\dsh-float\helper-debug.log`（超过 256 KB 自动清空），其中 `capture start` / `stream frame` / `overlay revealed` / `capture finish` 记录了各阶段耗时。
- **想彻底重置**：退出 dsh，删除 `~\.dsh\dsh-float\`，重启。

## 开发与自测

```bash
# 语法检查
node --check runtime/electron-helper/main.js
node --check runtime/electron-helper/pet-watch.js
node --check runtime/electron-helper/window.js
node --check lib/index.js

# 离线预览（不碰 dsh，使用内置假模型）
env -u ELECTRON_RUN_AS_NODE "$HOME/.dsh/electron/electron.exe" \
  runtime/electron-helper/main.js --mock

# 宿主 ↔ Helper 桥接自测：鉴权、epoch、流式、中止、退出
node tools/mock-host.mjs
```

渲染进程开启 `contextIsolation`、关闭 `nodeIntegration`；脚本侧使用严格 CSP（`script-src 'self'`，无 `'unsafe-inline'` / `'unsafe-eval'`），因为 KaTeX HTML 输出依赖行内样式，`style-src` 允许内联但仍禁止外部样式。模型输出逐节点构建 DOM，只有 KaTeX 生成的转义标记经 `innerHTML` 插入（`trust: false`）；宿主只接受白名单临时目录里的 PNG/JPEG/WebP 截图。

截图用的屏幕流只在鼠标悬停相机按钮或开始截图时打开，取到一帧后立即关闭；选区图像只写入 `%TEMP%\dsh-float`，由宿主发送后删除。遮罩页使用独立 CSP（`img-src data: blob:`），除本地 `overlay.js` 外不加载任何脚本。
