# dsh-float

A Windows desktop assistant for DeepSeek Harness that lives in its own always-on-top window: ask from any application, send a region screenshot with one click, and read the streaming answer without switching back to DSH.

[中文说明](README.md)

## Features

- **Floating chat panel**: a borderless, always-on-top window with a drag handle and resizable edges; its position and size are remembered.
- **Screenshot questions**: click the camera button, drag a region, and the cropped image is attached to your question. The panel hides itself for the capture and comes back afterwards, and the capture overlay waits until the pixels are ready so it never flashes black.
- **Streaming answers** with stop, model selection, and a new-chat button. History keeps the last 8 rounds and the last 12 messages are shown.
- **Markdown and LaTeX**: headings, lists, tables, quotes, fenced code, inline code, and `$...$` / `$$...$$` formulas are rendered with the bundled KaTeX fonts.
- **Optional desktop-pet entry**: when dsh-pet is installed, double-clicking the pet opens or hides the panel. `Alt+Space` (or `Ctrl+Alt+Space` when taken) and the tray menu work without it.
- **No extra API key**: chat goes through the models and account already configured in DSH. A text-only model is automatically routed to an image-capable provider when the message carries a screenshot; if none is available the request fails with a clear error instead of silently dropping the image.

## Requirements

- Windows 10/11, x64 (arm64 is not tested).
- DeepSeek Harness Desktop 0.2.1-rc.2 or a compatible 0.2.x runtime.
- Internet access on first launch if Electron is not already present.

## Install

```bash
dsh plugin --profile desktop add dsh-float
```

Restart DeepSeek Harness after installation. The tray icon, `Alt+Space`, and the camera button are available once `[dsh-float] loaded` appears in the DSH log.

### Electron

The helper is a separate Electron process. It looks for an existing `electron.exe` in this order:

1. `DSH_FLOAT_ELECTRON_PATH`
2. `DSH_PET_ELECTRON_PATH`
3. the plugin's own `electron` dependency
4. `%USERPROFILE%\.dsh\electron\electron.exe` (used by dsh-pet)
5. `%USERPROFILE%\.dsh\dsh-float\electron\v43.3.0-win32-x64\electron.exe`

When none exists, the plugin downloads Electron 43.3.0 into the last path above on first launch (about 110 MB, one time). The download uses the npmmirror Electron mirror first and falls back to the official GitHub release. Set `DSH_FLOAT_ELECTRON_PATH` to skip the download and reuse an existing runtime.

## Usage

- Double-click the dsh-pet pet to toggle the panel, or press `Alt+Space` / use the tray menu.
- Drag the title bar to move the panel; drag the right edge, bottom edge, or corner to resize it (minimum 320×420).
- `Enter` sends, `Shift+Enter` inserts a newline, and the stop button appears while an answer streams.
- Camera button: drag a region and release to attach it; `Esc` cancels. The capture overlay closes after 60 seconds without a selection.
- The model name at the top opens the model list. "Follow dsh default" uses the current DSH session model.

## Data and privacy

Everything is stored under `%USERPROFILE%\.dsh\dsh-float\`:

| File | Contents |
| --- | --- |
| `config.json` | hotkey, system prompt, model preference, history length, autoVision |
| `history.json` | the last 40 conversation entries |
| `window.json` | last panel position and size |

Screenshots are written as `shot-*.png` under `%TEMP%\dsh-float\` and deleted by the host after a successful send. The screen-capture stream is opened only while the pointer is over the camera button or during a capture, and it is stopped after one frame. The helper only listens on `127.0.0.1` and authenticates the host with a per-process token; no content leaves the machine except through the DSH model you selected.

## Troubleshooting

- **Panel does not open**: check that dsh-pet is running when double-clicking the pet, and that both clicks land on the pet itself within the system double-click interval. `Alt+Space` and the tray menu work independently of dsh-pet.
- **Electron download fails**: set `DSH_FLOAT_ELECTRON_PATH` to an existing `electron.exe`, or install dsh-pet (which provides one). Progress and errors are logged in `%USERPROFILE%\.dsh\dsh-float\helper-debug.log`.
- **Hotkey unavailable**: another application owns it; the plugin falls back to `Ctrl+Alt+Space` and the tray menu shows the active shortcut.
- **Screenshot is black**: update the GPU driver. The helper uses a desktop stream first and falls back to `desktopCapturer`, then PowerShell capture.
- **Missing vision model**: install or enable modlens, or select a model whose `inputModalities` include `image`.

## Development

```bash
node --check lib/index.js
node --check runtime/electron-helper/main.js
env -u ELECTRON_RUN_AS_NODE "$USERPROFILE/.dsh/electron/electron.exe" \
  runtime/electron-helper/main.js --mock
node tools/mock-host.mjs
```

## License

MIT
