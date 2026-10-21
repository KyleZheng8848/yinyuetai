# GitHub 发版与安装包验收

以公开维护目录的已审阅提交发版；原开发目录、模型运行库、作品和旧安装包不直接复制进来。

1. 同步 `package.json` / `package-lock.json` / `CHANGELOG.md` / `index.html` 的版本，执行 `npm run check:version` 和 `npm test`。
2. 推送后，在 **Actions → Publish macOS apps → Run workflow** 手动启动。两种 macOS runner 分别安装依赖，使用 `--publish never` 打包。
3. `scripts/verify-macos-release.py` 解包检查实际 DMG/ZIP 的版本、主程序架构、临时签名、SofunAI 标识、GitHub 链接、MIT 和第三方许可，并排除运行数据、模型与生成音频。没有模型权重的干净安装也应可使用 Demo。
4. 两种架构通过后统一创建 `v<version>` tag 与 Release；含四个安装包及 `SHA256SUMS.txt`。已有 tag 时停止，不覆盖已有资产。
5. 发布任务从匿名公开 URL 重新下载四个安装包并核对 SHA256。再核对 README 的 Releases、latest、具体版本链接与安装包名；若主分支有后续文档提交，Release 仍对应原始构建提交。

文件名：`Yinyuetai-Studio-<version>-mac-{arm64,x64}.{dmg,zip}`。Apple Silicon 使用 arm64；Intel 使用 x64。应用采用 ad hoc 临时签名，没有 Apple 公证。DMG 中将应用拖入 Applications；首次打开若被拦截，确认来源后使用系统「隐私与安全性 → 仍要打开」。

当前 GitHub workflow 仅发布 macOS 两种架构。Windows/Linux 的 electron-builder 目标配置仍可供开发者构建，不表示已有受验证的公开发行包。源码 CI 与 UI 检查不会自动下载音乐模型、调用付费 API 或替换用户已安装应用。

`release:manifest` / `release:publish` 及 OSS 下载清单属于可选的自托管分发流程，需要维护者自行配置 `.env.local`。GitHub 发布不执行这些上传命令，也不默认更新第三方下载站或本机应用。
