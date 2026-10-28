# Add 18840024879/dsh-float

## What it is

A Windows desktop floating assistant for DeepSeek Harness. It runs in its own borderless, always-on-top Electron window, independent of the DSH window, and uses the models and account already configured in DSH.

## What the entry claims, and where it lives in the code

- **Always-on-top floating panel** — `runtime/electron-helper/window.js`, `runtime/ui/index.html`.
- **Streaming answers, stop, model switching, history** — `lib/index.js` (bridge and `chat.send`), `runtime/ui/app.js`.
- **Region-screenshot questions** — `runtime/electron-helper/capture.js`, `runtime/ui/overlay.js`; the cropped PNG is written to `%TEMP%\dsh-float\` and passed to the host through the existing attachment path.
- **Windows only** — the helper relies on Windows desktop capture, PowerShell fallback, and the .NET `csc.exe` used to build the small pet-click watchdog; `package.json` declares `"os": ["win32"]`.
- **Optional dsh-pet entry** — when dsh-pet is installed, a double-click on the pet toggles the panel (`runtime/electron-helper/pet-watch.js`). Without it, `Alt+Space` and the tray menu still open the panel.

## Differentiation

The closest existing entries are `cyh3436332528/dsh-float-chat` (a floating window that pops out DSH's side conversation) and `Azetus/dsh-quorfloat` (a hotkey session/approval window). Neither captures a screen region. The screenshot entries (`Max-Null/dsh-capture`, `linandadada-pixel/dsh-screenshot`, and similar) attach a crop to the DSH composer inside the DSH UI; dsh-float instead owns a standalone assistant panel and sends the crop as the question itself. No listed entry combines the standalone floating panel with screenshot Q&A.

## Checklist

- [x] Public repository with real, working code.
- [x] `package.json` declares `dsh.bundle` with `./cordis.patch.yml`; the patch file is at the repository root.
- [x] `dsh-plugin` topic added to the repository.
- [x] Repository created at least one day before this PR is opened.
- [x] README documents installation (`dsh plugin --profile desktop add dsh-float`), Windows support, permissions, data locations, and the one-time Electron download.
- [x] Only `data/plugins/18840024879__dsh-float.yml` is added; generated READMEs are untouched.
