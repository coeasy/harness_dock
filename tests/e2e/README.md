# HarnessDock e2e smoke tests

Playwright 端到端冒烟测试，验证桌面客户端的核心启动路径。

## 背景

Harness 页面运行在系统 WebView（Windows: WebView2 / macOS: WKWebView / Linux:
WebKitGTK）中，不是普通 Chromium tab。Playwright 通过 WebView 的
**Chrome DevTools Protocol (CDP)** 端点访问它。HarnessDock 在
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`（或平台等效环境变量）携带
`--remote-debugging-port` 时开启 CDP。

## 已验证的症状（回归保护）

1. Shell bridge 注入成功（`window.__DSH_SHELL_BRIDGE__.apiVersion === 2`）
2. 顶栏满宽（`.bar` `left === 0` 且 `width === innerWidth`，无左右空白）
3. 设置面板不卡"连接中"，且页面无致命 console/exception 错误

这三项分别对应历史上的三个回归：
Chromium 113 WebView2 缺 `AbortSignal.any`/`Promise.withResolvers` 导致的
连接卡死、shell 误改 `web/` 而非 `src/web/` 导致的左右空白。

## 运行

必须已有构建产物。PowerShell 示例：

```powershell
$env:HARNESS_DOCK_E2E_BIN = "apps\tauri\src-tauri\target\debug\harnessdock-tauri.exe"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333 --remote-allow-origins=*"
pnpm --filter @dsh/e2e-tests e2e
```

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HARNESS_DOCK_E2E_BIN` | `target/debug/harnessdock-tauri.exe` | 待测客户端二进制；未显式设置时若默认路径不存在则跳过 |
| `HARNESS_DOCK_E2E_CDP_PORT` | `9333` | CDP 端口 |
| `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` | 自动填充 | 已设置时沿用，否则注入 `--remote-debugging-port` |

## CI 集成

建议在 `windows-packaged-startup.yml` 或独立 workflow 中：

1. `pnpm build:desktop` 产出调试/打包二进制
2. 设置上述两个环境变量
3. 先启动客户端 → 等待 CDP 端口 → 再运行本套件
4. `test.beforeAll` 会自动拉起客户端并等待 CDP；`afterAll` 关闭

注意：测试是串行的（`workers: 1`），且每次只允许一个客户端实例
（单实例锁）。若已有 HarnessDock 实例在运行，需要先关闭。