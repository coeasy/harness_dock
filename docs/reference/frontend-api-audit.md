# dsh-web-frontend API 审计清单

> 维护频率：随上游 runtime 升级（`origin.json` 变化）时更新 | 上次更新：2026-09-05

## 背景

`dsh-web-frontend` 以打包产物（`resources/dsh-runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist/`）
分发给客户端，源码不在本仓库。为了可审计性，本清单记录前端 bundle 依赖的
关键浏览器 Web API 与宿主侧假设，供以下用途：

1. **WebView2/WebKit 版本兼容性基线**——哪些 API 缺失会导致哪些症状（见 2026-09-05 的
   Chromium 113 事件：缺 `AbortSignal.any`/`Promise.withResolvers` 导致连接卡死+桥崩）
2. **`POLYFILL_SCRIPT`（harness_shell.rs）的覆盖矩阵**——注入的 polyfill 必须覆盖这里登记的缺口
3. **升级 diff 看板**——上游升级后，对照清单检查新 bundle 是否引入新的 API 依赖

## Host 侧注入（按注入顺序）

| 层 | 内容 | 目的 |
|---|---|---|
| POLYFILL | `Promise.withResolvers`、`AbortSignal.any` | 补 WebView2 113 缺失 |
| BRIDGE | `window.__DSH_SHELL_BRIDGE__`（apiVersion 2） | 窗口控制 + host 命令信封 |
| SHELL_WEB | `plugin-harness-shell/src/web/shell.js` | Shadow DOM 顶栏 UI |

## 前端 bundle 依赖的关键 Web API（实测基线与缺失记录）

### 由 POLYFILL_SCRIPT 覆盖

| API | 检测结果（WebView2 113.0.1774.50） | 缺失症状 |
|---|---|---|
| `Promise.withResolvers` | 缺失 | Tauri `window.__TAURI__` 桥崩溃 → shell bridge 部分安装 |
| `AbortSignal.any` | 缺失 | dsh `RemoteStream.read` 抛 TypeError → 连接反复 retry → 卡"连接中" |

### 已探测到（Chromium 113 中 present）

- `AbortController` / `AbortSignal.abort` / `signal.reason`
- `structuredClone`（compat `client.js` 的深克隆优先路径）
- `crypto.randomUUID`（shell bridge `requestId`）
- DOM/shadow DOM、`EventTarget`、`FormData`、`fetch`、`WebSocket`
- 其余 40+ 现代 API（`cdp_envcheck.py` 实测 45 项中 37+ present；缺失的非致命项暂不在此登记）

### 宿主假设（前端 bundle 依赖宿主提供）

| 假设 | 提供方 | 验证方式 |
|---|---|---|
| `window.__DSH_SHELL_BRIDGE__` 存在且 `apiVersion===2` | BRIDGE_SCRIPT | `check:shell-package` 锁定版本一致性 |
| `window.__ModuleLoader__`（cordis loader）存在 | dsh-web-frontend 自举 | e2e smoke 断言 |
| loopback origin `http://127.0.0.1:<port>` | validated_runtime_url | Rust side precheck |
| ready.json 的 generation/nonce/imageIdentity | embedded-client 插件 | validated_ready |

## 升级检查清单

升级 runtime（`origin.json` 变更）后必须执行：

```bash
# 1. 重新探测 bundle 的 API 使用面（工具：apps/tauri/src-tauri/resources 下 grep 关键字）
# 2. 对照本表，新 API 缺失则扩展 POLYFILL_SCRIPT + `cdp_envcheck` 检查项
# 3. 跑 e2e smoke（连接状态 + 满宽 + 无致命错误）
# 4. 更新本文件的"上次更新"与版本段
```

参考工具（开发调试用，位于 P:/tmp-rust-toolchain/，不入库）：
`cdp_capture.py`（console/exception 抓取）、`cdp_envcheck.py`（45 API 探测）、
`cdp_verify.py`（错误+文案+几何综合验证）。