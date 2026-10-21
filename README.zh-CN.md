<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/sofunai-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/brand/sofunai-logo-light.svg">
  <img alt="SofunAI Studio" src="assets/brand/sofunai-logo-light.svg" width="240">
</picture>

**由 [SofunAI 工作室](assets/brand/README.md)出品并维护。**

**[GitHub 仓库](https://github.com/KyleZheng8848/yinyuetai)** · **[Releases](https://github.com/KyleZheng8848/yinyuetai/releases)** · **[下载最新版](https://github.com/KyleZheng8848/yinyuetai/releases/latest)** · [反馈问题](https://github.com/KyleZheng8848/yinyuetai/issues)

[English](README.md) | **简体中文**

# 音悦台 Studio · Yinyuetai

**把音乐创作、生成、整理和播放放进同一个本地优先的工作台。** 可以选择安装本地音乐模型，也可以连接自己的 API；下载模型前，先用离线 Demo 跑通「队列 → 曲库 → 播放器」。

![真实创作台：已完成的离线 Demo 试听](assets/screenshots/studio.jpg)

[![浏览器演示剪辑：创作、生成、播放、曲库与关于页](assets/demo/preview.gif)](docs/MEDIA.md)

**[观看演示（MP4）](https://github.com/KyleZheng8848/yinyuetai/releases/download/v1.15.11/yinyuetai-browser-walkthrough-1.15.11.mp4)** · **[界面截图与演示介绍](docs/MEDIA.md)** · [完整使用说明](docs/USAGE.zh-CN.md)

预览来自 Computer Use 在空白隔离会话中的真实浏览器操作，为带双语字幕、无旁白的采样画面剪辑。音频由内置**程序化 Demo 合成器**产生，不是音乐模型的生成样例，也不会演唱界面中的歌词。当前不包含原生桌面窗口录像。

## 为什么值得试试

- **创作集中在一处：** 歌名、风格、歌词、随机种子和模型参数随任务保存，提交后可继续准备下一首。
- **选择自己的引擎：** 提供 MiniMax Music 3、Stable Audio、ACE-Step 接入路径，以及自带 Key 的远端接口；点击安装后才下载本地模型。
- **作品能整理、能带走：** 本机曲库、专辑、搜索、播放、音频导出，以及每首作品的生成参数。
- **可选智能创作：** 连接 Ollama 或 OpenAI 兼容大模型辅助填写创作单，与音频生成分开配置。
- **零 Key 起步：** 内置离线 Demo 不需要模型权重、账号凭据或付费调用。

应用界面目前以**简体中文**为主。中英文 README 对应同一应用，暂未实现完整英文界面。

## 下载应用

[Releases](https://github.com/KyleZheng8848/yinyuetai/releases) · **[v1.15.11](https://github.com/KyleZheng8848/yinyuetai/releases/tag/v1.15.11)** · **[下载最新版](https://github.com/KyleZheng8848/yinyuetai/releases/latest)**

- [Apple Silicon (M 系列) — DMG](https://github.com/KyleZheng8848/yinyuetai/releases/download/v1.15.11/Yinyuetai-Studio-1.15.11-mac-arm64.dmg)
- [Intel — DMG](https://github.com/KyleZheng8848/yinyuetai/releases/download/v1.15.11/Yinyuetai-Studio-1.15.11-mac-x64.dmg)

Release 同时提供 ZIP 和 `SHA256SUMS.txt`，双架构安装包已解包验收并匿名下载核对校验和。采用临时签名，未 Apple 公证；将应用拖入 Applications。首次打开如被拦截，核对来源后在系统「隐私与安全性」使用「仍要打开」。Windows/Linux 仅有构建目标配置，尚无经过验证的安装包。

## 不下载模型，先完成一次试听

需要 **Node.js 22.14+** 和 npm；`npm ci` 会下载 Electron。

```bash
git clone https://github.com/KyleZheng8848/yinyuetai.git
cd yinyuetai
npm ci
npm start
```

1. 在**创作台 → 生成模型**选择**即时 Demo 合成器**。
2. 填写歌名和风格标签，先将时长设为 12 秒等较短值。
3. 点击**加入生成队列**，完成后点**播放**，再到**曲库**查看保存的作品。

Demo 用来体验完整流程，不会演唱歌词，也不代表可选音乐模型的音质。网页模式执行 `npm run web`，打开 `http://127.0.0.1:8799/`。曲库存于当前浏览器/配置/来源对应的 IndexedDB；换端口、换配置或清除网站数据会改变曲库访问范围，清理前请导出重要音频。

## 本地模型与自带 API

在**模型中心**选择本地模型、远端 API 或智能创作大模型。本地安装需要 Git、[uv](https://docs.astral.sh/uv/)、数 GB 下载量，以及所选模型需要的磁盘与内存；MLX 路径仅支持 Apple Silicon，Intel 应用包不代表可以运行 MLX。安装界面会显示模型许可和资源提示，仓库与安装包不附带模型权重。

远端音乐生成及智能创作会把输入发给你配置的服务，可能产生供应商费用。Suno 兼容项是可配置接口，不宣称存在官方公开 Suno API。具体路径见[完整使用说明](docs/USAGE.zh-CN.md)和[第三方声明](THIRD_PARTY_NOTICES.md)。源码测试及 Demo 不代表所有引擎、硬件上的真实模型推理均已验证。

## 数据与隐私

桌面版的运行配置与可选模型位于 Electron 用户数据的 runtime 目录；网页/服务模式默认使用 `.runtime/`。音频曲库存于当前应用或浏览器配置的 IndexedDB。API Key 由伴生服务保存在本机，在调用所配置服务时使用。运行目录、浏览器配置和音频导出应视为私人数据，不属于公开源码快照。本地优先描述的是本机工作流；配置远端生成、下载及大模型调用时仍会联网。

## 开发与贡献

```bash
npm ci --ignore-scripts
npm test
npm run check:version
```

测试使用模拟服务和临时运行目录，不安装模型、不调用付费接口。跳过脚本安装后，如需启动桌面应用，先正常执行一次 `npm ci`。

欢迎从可复现的 [Bug 反馈](https://github.com/KyleZheng8848/yinyuetai/issues)、翻译、已验证的硬件/模型使用记录或小范围修复开始，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。如果它帮到了你的创作，欢迎点 Star，让更多人发现它。

打包与双架构验收见 [RELEASING.md](docs/RELEASING.md)。`npm run dist` 使用 `--publish never`，产物位于 `release/`；可选自托管分发需要自己的配置，不属于普通安装步骤。

## 许可证与致谢

应用源码采用 [MIT](LICENSE)，© 2026 SofunAI 工作室及音悦台贡献者。**lamejs / LAME 保留 LGPL-3.0**，完整许可与替换/重建说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。可选模型的代码、权重、API 与生成内容遵循各自条款，本仓库的 MIT 不对它们重新授权。

[Codex](https://developers.openai.com/codex/) 协助完成开源整理、文档与验证；在此致谢工具，不虚构 GitHub 贡献者身份。

## 更多 SofunAI 开源作品

- [Musepaper](https://github.com/KyleZheng8848/musepaper) — AI 壁纸与作品管理
- [FreeAll](https://github.com/KyleZheng8848/freeall) — 本机 API 账号池与网关
- [CPET](https://github.com/KyleZheng8848/cpet) — 编程 Agent 桌宠与工作台
