# 音悦台 Studio

本地优先的桌面音乐创作软件。Electron 提供桌面壳，Node 伴生服务负责模型部署、受管进程和 API 安全代理，IndexedDB 保存真实音频曲库。

## 两种模型来源

### 本地部署

模型中心提供六个独立、可选的本地模型包：

| 模型 | 本地运行方式 | 预计下载 |
|---|---|---:|
| MiniMax Music 3 · MLX 高速 | Apple MLX + MXFP8 权重 | 约 12.9GiB |
| MiniMax Music 3 · Comfy 兼容 | 共享 ComfyUI + INT8 权重 | 约 11.1GB |
| Stable Audio Open 1.0 | 共享 ComfyUI | 约 5.4GB |
| Stable Audio 3 | Stability AI 官方 MLX Medium | 约 6.7GB |
| ACE-Step 1.0 | 共享 ComfyUI + 3.5B checkpoint | 约 7.2GB |
| ACE-Step 1.5 | 共享 ComfyUI + Turbo 分离权重 | 约 13.7GB |

用户只会在点击“安装所选模型”后开始下载。MiniMax Music 3 在 Apple Silicon Mac 上推荐选择独立的 MLX 高速包：应用固定安装已合并 Music 3 支持的 `mlx-audio` 提交，并固定下载 `mlx-community/MiniMax-Music3-mxfp8` 的仓库修订；关键模型、调度器和分词器文件均按精确字节数校验。该转换包是社区提供的 Apple MLX 权重，不是 MiniMax 官方发布物，安装前会显示其许可链接。

原有 MiniMax 三文件仍作为“Comfy 兼容”选项保留。ComfyUI 模型共享一个隔离的 Python 3.13 运行时，避免重复安装依赖；模型文件支持 `.part` 断点续传。下载会优先使用系统 `curl` 以适配 HTTP/HTTPS/ALL_PROXY，然后回退 Hugging Face 官方分块客户端和内置 HTTP Range 下载器。MiniMax Comfy 包默认使用 Hugging Face，失败后自动切换 ModelScope 备用源，且三个权重均执行字节数与 SHA-256 完整性校验。连接连续 120 秒无数据时会自动重连，内置下载器最多重试 8 次，并从已保存的断点继续。Stable Audio 3 使用官方 MLX 安装和生成脚本，目前仅在 Apple Silicon Mac 开放安装按钮。

Apple Silicon 使用分阶段 MPS 模式：MiniMax 自回归文本编码器明确放到 Metal 运行，但不再对整个 ComfyUI 使用 `--gpu-only`，因此进入扩散阶段后可以正常卸载超大的文本编码器并回收统一内存。由于 PyTorch MPS 尚不支持 INT8 `_int_mm`，应用在每次启动时自动安装一个只对 Apple MPS 生效的兼容层：量化权重仍以 INT8 存储，当前线性层按需反量化后使用 MPS / Metal 计算，其他平台路径不受影响；同时启用 PyTorch CPU fallback 作为安全网。

MiniMax 默认安装包仍只有三个 INT8 必需文件，不增加额外部署项。若用户自行把官方 ComfyUI 仓库中的 `minimax_music3_dit_fp16.safetensors` 和/或 `minimax_music3_text_encoder_pruned_bf16.safetensors` 放入对应模型目录，应用会自动发现并优先选用这些原生 MPS 精度权重；缺少时自动回退到现有 INT8 文件。原生 FP16/BF16 会占用更多磁盘与统一内存，但可避开 INT8 在 MPS 上逐层反量化的主要开销。

生成中的本地任务可通过创作区“停止”按钮或 `Esc` 中断。ComfyUI 路径会同时调用 `/interrupt` 并从队列删除对应任务；MLX 路径会先向独立生成进程发送终止信号，超时后强制退出，并清理临时请求与音频文件。ComfyUI 节点失败时，创作区会显示具体节点和异常摘要，不再只显示笼统的“请检查模型和节点”。

所有本地模型均需遵守各自的模型许可，应用会在安装按钮旁显示对应许可链接和磁盘提示。模型详情页提供“卸载模型”：执行前必须确认，且安装、生成或引擎占用期间不可操作。Comfy 模型卸载时只删除所选权重和对应断点文件，保留共享 ComfyUI 运行时及其他模型；独立 MLX 模型会删除其专用模型目录与运行环境。失败安装留下的文件也可通过“清理残留”移除。

### 远端 API（BYOK）

远端区不包含平台账号或公共 Key，全部由用户自行配置：

- MiniMax 官方 Music Generation API；
- Stability AI Stable Audio API；
- Suno 第三方服务或任意自建兼容音乐 API。

Suno 被实现为“自定义兼容端点”，可配置服务地址、模型名、提交路径和任务查询路径，不宣称存在 Suno 官方公开 API。

API Key 不写入网页 `localStorage`，也不会由状态接口返回。桌面版使用 Electron `safeStorage` 加密后写入权限为 `0600` 的配置文件；如果系统加密存储不可用，Key 只保留在当前伴生进程内存中。

## 生成队列

点击“加入生成队列”后会立即回到可编辑状态，可继续准备和提交下一首。每个任务都保留提交时的模型、描述、歌词、参数和随机种子，不会被后续编辑覆盖。

队列默认串行处理，避免 48GB 统一内存上多个大模型生成互相抢占内存。MiniMax 单曲的自回归声学帧本身具有前后依赖，不能把同一首歌拆成多段并行后无损拼接；在同一台 Mac 上并发多首只会争抢 Metal 算力、内存带宽和统一内存，通常不会缩短单曲等待时间。真正适合并行的是多个独立 GPU 设备或多个远端服务实例。最多保留 20 个活动/等待任务；等待项可单独取消，当前 ComfyUI 或 MLX 任务可真正停止，完成、失败或取消的项可移除或一键清理。队列是当前应用会话内的任务表，退出应用前请等待或取消未完成任务。

等待任务会显示前方任务数与预计开始时间。应用优先采用曲库中同模型历史任务的耗时中位数；没有历史数据时才使用模型类型、时长、采样和 CFG 的保守粗估。有活动或等待任务时关闭窗口会触发退出保护。

## 智能模式

创作台可以单独填写歌名；歌名会随任务进入生成队列，并用于监听室、曲库与下载文件名。留空时按音乐描述自动命名。智能模式有独立的新指令输入框，提交时会同时读取当前歌名、模型、音乐描述、风格标签、歌词、时长、采样步数和遵循度：已有内容会要求所配置的大语言模型保留核心主题与 hook 后优化，空字段才生成。它只更新创作单，不会自动生成音频，用户确认或修改后再提交队列。

智能生成**没有内置文案或歌词模板**，必须先在“模型 → 智能创作”中配置模型 API；所有创意字段由该模型返回。应用只做字段完整性校验与已知结构标签别名归一（如「副歌」→ `[Chorus]`），不会硬编码补写描述或歌词。面向 MiniMax 时，描述必须按 Global Metadata / Vocal Details / Arrangement 三部分输出，歌词体量随时长增长。**ACE-Step 1.5 默认走原生整曲 playbook**：时长会直接写入一次推理，支持 20–600 秒；120–240 秒是优先区间，完整 caption、风格标签、整首歌词、BPM、调式、拍号和语言会共同进入模型以保持旋律、人声与编排上下文。兼容分段现在会为每个后续段多生成 8 秒上一段尾音承接区，合轨时再完整重叠消化，以避免尾音被当成新段开头重播；它仍适合内存不足或原生任务失败时手动启用，而原生整曲仍是连贯性最好的选择。

MiniMax Music 3 的默认创作参数为 30 秒 / 8 步，用于快速试听；确认方向后再逐步拉长。模型以每秒约 25 个声学帧进行自回归生成，长音频耗时会近似随时长增长；降低采样步数只能减少后续 Flow DiT 阶段，不能消除自回归阶段的成本。Comfy INT8 权重在 Apple MPS 上还会产生逐层反量化开销，因此仅建议作为兼容路径；Apple Silicon 优先使用 MLX MXFP8 路径，但 300 秒整曲依然属于重负载任务，不承诺实时生成。

可选接口：

- Ollama 本地 API：配置本机 Ollama 地址和已安装的模型名；
- OpenAI-compatible API：由用户配置兼容服务地址、模型名和可选 API Key，可连接云端或本地兼容服务。

智能引擎的 API Key 与音乐服务 Key 采用相同的本机加密与脱敏策略。

创作单会自动保存到本机并在下次启动时恢复，保存范围包括模型、歌名、智能指令、描述、标签、歌词、生成参数和目标专辑。创作台标题栏会显示保存状态；“新建”会在确认后清空内容，同时保留当前模型和收录专辑。智能字段提供“一键全部解锁”，避免跨会话锁定造成智能模式似乎没有生效。

## 功能

- macOS / Windows / Linux Electron 桌面应用；
- 左上角始终显示由当前运行包读取的真实版本号，窗口标题同步显示版本；
- 六个本地音乐模型包的选择、安装、状态、启动、停止、更新和日志；
- MiniMax Music 3 的 Apple MLX MXFP8 高速路径与原有 Comfy INT8 兼容路径；
- 本地模型按包卸载、残留清理和运行中删除保护；
- MiniMax、Stability 和 Suno/自定义远端适配器；
- 外部 ComfyUI 高级兼容入口；
- 后台生成队列，可连续提交、取消等待项、停止当前项并自动处理下一首；
- 一句话智能补全描述与歌词（必须配置 Ollama 或 OpenAI-compatible BYOK，无离线模板补全）；
- 模型驱动的动态参数与可视化信号链；
- 歌单式本地曲库，支持搜索、播放全部、模型/风格/日期/时长信息与自动生成封面；
- 可展开的沉浸式播放页，支持唱片动效、同步滚动歌词、歌词定位、上一首/下一首、双进度条与音频下载；
- IndexedDB 本地曲库，重启后仍可播放已保存音频；
- 创作单自动保存与恢复、明确的新建边界和排队退出保护；
- 基于历史速度的队列预计开始时间，以及模型失败后的断点续装和诊断复制；
- 同源限制、CSP、URL 校验、无 shell 拼接进程启动和沙箱化渲染器；
- 无需后端的即时 Demo 合成器。

## 开发运行

要求 Node.js 22.14+。本地模型部署还需要 Git 与 [uv](https://docs.astral.sh/uv/)。

Apple MPS 的 INT8 兼容文件位于 `server/runtime-assets/yinyuetai_mps_int8.py`，启动共享 ComfyUI 时会自动同步到其 `custom_nodes` 目录；无需用户手动复制或修改已经下载的模型。

```bash
cd yinyuetai
npm install
npm start
```

浏览器开发版：

```bash
npm run web
# http://127.0.0.1:8799
```

桌面版默认使用固定本地端口 `18799`，保证 IndexedDB 曲库跨重启使用同一来源；可通过 `YYT_DESKTOP_PORT` 覆盖。

如 Hugging Face 下载需要令牌，可在启动应用前设置 `HF_TOKEN`。令牌只会发送给 `huggingface.co`，不会跟随到其他主机。

macOS 桌面版会自动读取“系统设置 → 网络”中的 HTTP/HTTPS/SOCKS 代理，并把可用代理传给 Git、uv 与 Hugging Face 下载器；因此从 Finder 启动时不需要另外导出代理环境变量。未完成的 Hugging Face 分块下载会保留在模型目录，重新点击安装即可续传。

MiniMax Music 3 MLX 权重优先由内置 Python/httpx 下载器从 ModelScope 同名镜像下载，最多三路并行，并对九个必需文件执行大小与 SHA-256 校验；连接中断后会保留 `.part` 文件继续传输。ModelScope 不可用时自动回退到禁用 Xet 的 Hugging Face 标准 HTTP 下载。

## 打包与测试

```bash
npm test
npm run pack
npm run dist
```

当前没有代码签名配置。正式对外分发前需要配置 Apple Developer ID / Windows 签名和公证。

测试覆盖 Demo 音频、四套 ComfyUI 工作流、10 个模型入口、6 个本地模型包、ComfyUI/MLX 两类任务中断、BYOK 凭据不泄露、Ollama / OpenAI-compatible 智能协议、HTTPS/回环地址限制、伴生服务和静态文件隔离。

### 可选发布配置

项目不预设发布账号、存储桶或下载地址。桌面应用与本地创作不需要发布配置；`pack` 和 `dist` 仅生成本地产物，不会自动上传。

需要发布时，将 `.env.example` 复制为 `.env.local`，填写自己的 `YINYUETAI_OSS_TARGET`、`YINYUETAI_OSS_ENDPOINT`、`YINYUETAI_DOWNLOAD_BASE_URL`、`OSS_ACCESS_KEY_ID` 和 `OSS_ACCESS_KEY_SECRET`。通用 OSS 客户端保留；端点应使用你自己可访问的服务地址。下载页地址和入口页链接可通过 `YINYUETAI_DOWNLOAD_PAGE`、`YINYUETAI_HUB_URL` 选填，入口页未配置时不显示返回链接。

`npm run release:manifest` 读取这些配置生成清单；`npm run release:publish` 才会上传。发布配置缺失时命令会明确报错。`.env.local` 只供发布脚本读取，不会打入桌面安装包；不要提交其中的凭据。`release/index.html` 中的相对链接用于同目录部署，发布脚本会按新配置重新生成页面与下载地址。当前公开源码的安装包输出到 `release/`；仓库不包含历史安装包。

## 目录

```text
yinyuetai/
├── desktop/                    # Electron 主进程与最小 preload
├── server/
│   ├── launcher.js             # 本地 HTTP 服务、路由和安全代理
│   ├── runtime-manager.js      # 多模型包与本地运行时生命周期
│   ├── remote-provider-manager.js # 远端配置、密钥与 API 适配器
│   └── smart-composer-manager.js  # 智能创作、Ollama 与兼容 LLM 适配器
├── js/
│   ├── models.js               # 本地/远端模型注册表和工作流
│   ├── providers.js            # 浏览器端 Provider
│   ├── library-store.js        # 持久音频曲库
│   ├── audio-engine.js         # 即时 Demo 合成器
│   └── app.js                  # 界面与播放逻辑
├── tools/                      # 离线与服务测试
├── UX_TODOLIST.md              # 按优先级维护的用户体验改进清单
├── index.html
└── css/style.css
```

## 伴生服务端点

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/status` | 硬件、本地模型和脱敏远端状态 |
| `POST` | `/api/local/models/:id/install` | 异步安装指定本地模型 |
| `POST` | `/api/local/models/:id/uninstall` | 安全卸载指定模型包或清理安装残留 |
| `POST` | `/api/local/start` | 启动共享 ComfyUI 本地引擎 |
| `POST` | `/api/local/stop` | 停止共享本地引擎 |
| `POST` | `/api/local/update` | 更新本地运行时 |
| `POST` | `/api/local/models/:id/generate` | 运行 MiniMax Music 3 或 Stable Audio 3 的原生 MLX 生成 |
| `POST` | `/api/local/models/:id/cancel` | 停止当前原生 MLX 生成进程 |
| `PUT` | `/api/remote/providers/:id/config` | 保存远端服务与 Key |
| `POST` | `/api/remote/providers/:id/test` | 测试远端连接 |
| `POST` | `/api/remote/providers/:id/generate` | 代理远端音乐生成并返回音频 |
| `PUT` | `/api/smart/config` | 保存脱敏的智能创作引擎配置 |
| `POST` | `/api/smart/test` | 测试 Ollama 或 OpenAI-compatible 连接 |
| `POST` | `/api/smart/complete` | 将一段想法补全为结构化创作单 |
| 任意 | `/local/*` | 代理到共享本地 ComfyUI |
| 任意 | `/comfy/*` | 代理到用户已有的外部 ComfyUI |

旧的 `/api/music3/*` 与 `/music3/*` 路径保留为兼容别名。
