# HarnessDock Android Release Signing

HarnessDock 的 PR / smoke Android 构建可以使用 Android 默认调试签名，但 `tauri-candidate` 的正式 APK/AAB 必须使用仓库维护者控制的 upload keystore。发布工作流会在上传前验证 APK 与 AAB 签名，并拒绝 Android Debug 证书。

## 1. 创建独立 upload keystore

在受控的维护者环境中创建一个专用于 HarnessDock Android 发布的 keystore。不要复用个人开发调试密钥，也不要把 keystore 提交到仓库。

```bash
keytool -genkeypair -v \
  -keystore harnessdock-upload.jks \
  -alias harnessdock-upload \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

妥善离线备份 keystore 与密码。若未来接入 Google Play App Signing，这个密钥作为 upload key 使用；Google Play 的 app signing key 由商店体系单独管理。

## 2. 生成 GitHub Secret 使用的 Base64

Linux / macOS：

```bash
base64 < harnessdock-upload.jks | tr -d '\n'
```

PowerShell：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("harnessdock-upload.jks"))
```

不要把 Base64 文本写入仓库、Issue、PR、Actions 日志或普通配置文件。

## 3. 配置 Repository Secrets

在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 配置：

- `ANDROID_KEY_BASE64`：完整 keystore Base64。
- `ANDROID_KEY_ALIAS`：例如 `harnessdock-upload`。
- `ANDROID_KEY_PASSWORD`：keystore / key 密码。

HarnessDock 当前 release signing 配置使用同一个密码作为 keystore password 与 key password。若以后需要拆成两个密码，应先扩展 `scripts/configure-android-signing.mjs` 的 Secret contract，再轮换配置。

## 4. Candidate 中的安全行为

`tauri-candidate` 会在 GitHub runner 上执行以下流程：

1. `cargo tauri android init --ci` 生成一次性 Android Gradle 工程。
2. `scripts/configure-android-signing.mjs` 校验三个 Secret，并把 keystore 只解码到 `RUNNER_TEMP`。
3. 临时 keystore 与 `keystore.properties` 使用限制性文件权限，不进入源码提交和 release artifact。
4. Release build 使用生成的 `signingConfigs.release`。
5. `scripts/check-android-package.mjs` 使用 `apksigner` 验证 APK，使用 `jarsigner` 验证 AAB，并拒绝 Android Debug signer。
6. 只有签名与包体检查全部通过后才上传 candidate artifact。

`jarsigner` 校验 intentionally 不要求 upload certificate 被系统公共 CA 信任，因为 Android upload keystore 通常是自签证书；门禁验证的是归档签名完整性与 signer 身份，而不是 Web PKI 信任链。

## 5. 故障定位

如果 candidate 在签名配置阶段失败，优先检查 Secret 是否存在、Base64 是否完整、alias 是否属于该 keystore、密码是否匹配。不要通过删除签名检查、改名为 `release.apk` 或允许 Debug certificate 来绕过门禁。

如果需要轮换 upload key，应先在目标分发平台完成对应的 key reset / upload-key rotation 流程，再更新 GitHub Secrets；已经发布的 release tag 和 release assets 不应被覆盖或重签。
