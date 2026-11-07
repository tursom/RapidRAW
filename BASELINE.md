# 任务 1：Windows 性能基线

**Windows 的 v2 基线已取得，任务 1 的跨平台验收仍未完成。** macOS、移动硬盘、安装器与官方版同时安装，以及人眼操作验收尚未执行。本报告不代表阶段 1 输入验收通过，任务 10 继续禁止开始。

旧版使用方向键检查滑块，会触发切图，相关切图数据全部作废。本文只引用重跑后的 `measurementVersion: 2` 最终记录；旧记录、身份检查及视口校准中的失败尝试仅留在 Windows 工作目录，不入库。

## 改动与身份隔离

任务从 `main` 建立 `task1/baseline` 分支，已配置 `upstream=https://github.com/CyberTimon/RapidRAW.git`。正式应用只调整本分支的身份和名称，没有修改编辑、解码、渲染、快捷键或布局功能：

- 桌面 `identifier` 为 `io.github.tursom.RapidRAW`，产品名、原生窗口标题和自绘标题统一为用户已确认的 **RapidRAW TBT**。
- 桌面 Immich 钥匙串服务名为 `io.github.tursom.RapidRAW.immich`；Android 保留 `io.github.CyberTimon.RapidRAW.immich`。没有迁移或用真实 Immich 凭据做集成测试。
- Android 配置覆盖保留原产品名、标识符和窗口配置；静态合并结果与原有效配置一致。没有构建或运行 Android。

[identity.json](baseline/evidence/windows/identity.json) 保存真实桌面 Session 1 的原生可见窗口和页面标题验证；当前 release 二进制包含新 Immich 服务名、不包含官方版服务名。这是编译产物字符串检查，不能替代真实钥匙串集成或安装器并存测试。

## 环境、素材和边界

测试时间为 **2026-11-07 10:48:03–10:50:23，UTC+08:00**。Windows release 构建在 10:36 完成，Rust 检查在测量及汇总完成之后启动，没有与性能采样同时编译。

| 项目           | 实际环境                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------ |
| 主机           | `pc.lan`，Windows 10 专业版 19045，x64；GUI 在已登录 Session 1                             |
| CPU / 内存     | Ryzen 7 5800X3D，8 核 16 线程；系统可见内存约 47.9 GiB；高性能电源方案                     |
| 实际图形适配器 | Radeon RX 9060 XT，Vulkan / DiscreteGpu；应用日志报告 AMD 驱动 26.5.2（LLPC）              |
| 工具链         | 仓库固定 Rust/Cargo 1.98.1；保持原 release 配置：LTO、单 codegen unit、strip               |
| WebView        | 采样 UA 报告 Edge/WebView 主版本 157；环境另记录已安装的完整版本                           |
| 显示条件       | 所有启动和独立滑块轮次均为实际可见的 1280×720 CSS 视口，DPR 1                              |
| 产物           | `RapidRAW.exe`；SHA-256 `26e37ffec105a56210bb6ac8940f742df01c7970224048685b2d811dfe707de6` |

[environment.json](baseline/evidence/windows/environment.json) 是测量后的 SSH Session 0 只读环境采集，不是 GUI 测量会话；实际 GUI 会话由 [run-result.json](baseline/evidence/windows/run-result.json)、身份记录共同确认。WMI 列出的全部显卡不等于实际选中的适配器；实际选择见 [gpu-adapter.json](baseline/evidence/windows/gpu-adapter.json) 的 17 条本轮应用日志，不根据 WMI 的 32 位 `AdapterRAM` 推断显存大小。

素材为 NASA 宇航员摄影的两张真实 Nikon NEF，原始 RAW 尺寸为 4288×2844 和 4992×3292。来源、许可说明和内容摘要见 [sources.json](baseline/sources.json)。生成 82 份 RAW 字节副本及 82 张全分辨率 JPEG 衍生图，共 **164 项、约 1.45 GB**，分布于 E 盘四个目录，包含日文、空格和方括号。前 16 项通过应用原生命令保存曝光 +0.25，其余项重置为未编辑；采样还核对应用实际的 `is_edited` 标记。

这是 **164 个路径、只有两张独立原图** 的受限工作负载。没有移动硬盘，没有多品牌、多分辨率、大量独立照片的代表性；不能据此推断广泛图库性能。没有关闭用户的常驻软件，也没有人眼验证远程桌面的显示和手感。

[完整性记录](baseline/evidence/windows/integrity.json) 核对 412 个应用源文件/构建输入，Windows 副本均与 [输入清单](baseline/evidence/windows/source-inputs.json) 一致；164 个原始素材的字节摘要全部与 [素材清单](baseline/evidence/windows/fixture-manifest.json) 一致。仅允许测试侧车及这个 fork 的配置发生变化。

## 采样口径

每个条件运行六个新启动进程，第一轮明确作为预热，统计其余五轮。OS 和缩略图缓存已热，应用正常预加载保持开启。启动时间包含 CDP 连接、20ms 轮询和脚本操作，是自动化上限，不是显示器扫描输出或冷启动测量。当前应用先到落地页，脚本再点 Continue Session 并打开第一张图；尚未实现未来的自动恢复编辑器流程。

启动驱动先确认新进程自己的原生主窗口可见。该主机的无边框窗口在显示后存在 31px 高度偏差，因此计时前写入的窗口状态高度校准为 689，最终 **实际 CSS 高度必须为 720**，不是把状态文件数值当作视口尺寸。每条启动记录保存 `initialWindowState` 和 `nativeVisibleUpperMs`；其他主机需要重新校准。

缩略图时间逐个检查视口内的容器，缺少 `img` 的占位也算未完成；连续两帧容器计数稳定、每个都有已加载图片才通过。本轮每次挂载 10 个容器，其中视口内 4 个，4 个全部加载；不把视口外的 overscan 容器当作已显示。

每个条件另有 **16 次真实 CDP 鼠标切图**：已编辑/未编辑 × RAW/JPEG × 首次选择/重复选择，八组各两次。目标从 manifest 按完整路径选择，记录实际选图历史并拒绝任何方向键或额外切图。首次是该进程第一次选中，**不是冷解码**；重复选择也**不证明后端缓存命中**。没有直接跟踪后端命中结果或源文件访问，二者明确为 `unknown`。

“到可用”为匹配目标路径的 `selectedImage.isReady` 首次成立，即 `readyAt - start`。滑块另开独立进程，在明确已编辑的 `photo-000.NEF` 上进行真实鼠标拖动，核对值变化、路径不变，不将这一轮混进切图时间。

预览可使用 SVG 解码后 rAF 或带路径的 GPU 事件后 rAF；**本轮 32 次全部采用 SVG 解码后 rAF**。会核对路径、当前画布来源、节点连接和自身/祖先可见性，排除透明淡入层。这仍是应用级代理，不证明显示器实际首帧或人眼无闪烁。

## Windows 实测数字

下表单位为 ms，数值为 **中位数 / P95**。P95 使用 nearest-rank；启动每条件 n=5，切图每组只有 n=2，因此切图 P95 就是组内最大值，不能当成稳定的尾延迟估计。

| 启动指标                                   | 默认布局，0 个保存预设 | 保存 20 个预设，预设面板展开 |
| ------------------------------------------ | ---------------------: | ---------------------------: |
| 原生主窗口可见上限                         |        1340.6 / 1379.5 |              1367.0 / 1372.5 |
| 落地页 Continue Session 可用上限           |        1355.2 / 1391.8 |              1374.2 / 1383.5 |
| 经 Continue Session 到视口缩略图齐全的上限 |        1729.9 / 1754.5 |              1757.2 / 1779.1 |
| 经脚本打开图片到编辑器 ready 的上限        |        2308.9 / 2330.9 |              2285.0 / 2318.2 |

| 条件    | 编辑状态 | 格式 | 选择 |   n | 预览代理，中位 / P95 | 到可用，中位 / P95 |
| ------- | -------- | ---- | ---- | --: | -------------------: | -----------------: |
| 默认    | 已编辑   | RAW  | 首次 |   2 |          37.1 / 42.5 |      483.4 / 564.8 |
| 默认    | 已编辑   | RAW  | 重复 |   2 |          56.4 / 71.9 |        43.1 / 57.0 |
| 默认    | 已编辑   | JPEG | 首次 |   2 |          29.3 / 30.5 |      114.8 / 149.4 |
| 默认    | 已编辑   | JPEG | 重复 |   2 |          69.5 / 96.0 |        52.0 / 76.1 |
| 默认    | 未编辑   | RAW  | 首次 |   2 |          36.9 / 37.2 |      462.7 / 515.3 |
| 默认    | 未编辑   | RAW  | 重复 |   2 |          67.7 / 90.7 |        50.7 / 72.6 |
| 默认    | 未编辑   | JPEG | 首次 |   2 |          32.9 / 39.3 |      153.1 / 180.1 |
| 默认    | 未编辑   | JPEG | 重复 |   2 |          47.2 / 53.6 |        27.7 / 28.8 |
| 20 预设 | 已编辑   | RAW  | 首次 |   2 |         89.6 / 141.8 |      388.1 / 685.8 |
| 20 预设 | 已编辑   | RAW  | 重复 |   2 |          58.0 / 75.8 |      259.8 / 464.8 |
| 20 预设 | 已编辑   | JPEG | 首次 |   2 |          44.8 / 46.6 |      161.6 / 220.0 |
| 20 预设 | 已编辑   | JPEG | 重复 |   2 |         78.3 / 113.6 |      117.6 / 146.2 |
| 20 预设 | 未编辑   | RAW  | 首次 |   2 |          47.2 / 48.7 |      529.7 / 620.4 |
| 20 预设 | 未编辑   | RAW  | 重复 |   2 |         91.0 / 124.2 |       79.4 / 108.2 |
| 20 预设 | 未编辑   | JPEG | 首次 |   2 |          76.8 / 95.6 |      134.2 / 165.8 |
| 20 预设 | 未编辑   | JPEG | 重复 |   2 |         94.4 / 142.3 |       85.0 / 132.5 |

默认条件的 16/16 次预览代理小于 100ms；20 预设条件为 12/16。这不是正式功能总验收，也不能从每格两次推断性能差异的稳定幅度。启动直接恢复编辑器和不访问源文件的目标尚未建立。

| 滚动指标                   |        默认 |     20 预设 |
| -------------------------- | ----------: | ----------: |
| 采样帧数                   |         180 |         180 |
| 平均 rAF FPS               |       60.09 |       58.33 |
| 帧间隔中位 / P95，ms       | 16.4 / 19.5 | 16.6 / 23.1 |
| 最长帧间隔，ms             |        30.4 |        38.9 |
| 可见容器缺少已加载图的帧数 |           0 |           0 |
| 最大滚动位置，px           |        7200 |        7200 |

滚动是固定轨迹往返，不覆盖全部路径，也没有证明合成器无白块。上游 `bench/replay.js` 另外运行十轮、预热两轮；其编辑阶段 FPS 中位数为默认 **59.95**、20 预设 **58.93**。上游重复打开同一图的近零耗时不作为切图基线。

两轮独立鼠标检查均从曝光 `0.25` 改到 `-1.77`，选图路径不变，可信鼠标事件、编辑目标和独立进程断言全部通过。这是功能性输入检查，不是切图到滑块响应时间样本。

## 检查结果与证据

- Windows `npm run tauri -- build --no-bundle`、真实标题检查、两组测量和汇总均退出 0。
- Windows `cargo fmt -- --check` 退出 0；`cargo test --release --lib --locked --features tauri/custom-protocol` 退出 0，但实际 **0 个测试**，不能当作单元测试覆盖。
- Windows 交付特性的 `cargo clippy --release --all-targets --locked --features tauri/custom-protocol -- -D warnings` 退出 0。
- Windows `--all-features` Clippy 退出 101，报 18 个未解析 `gphoto2` 的错误。它启用了现有 `tethering` 代码，但对应依赖在 Windows 不可用；相关功能未改，本任务未修联机拍摄的跨平台配置。
- Linux 前端构建完成；TypeScript 和 i18n 全量检查仍分别退出 2、1，与修改前的诊断完全一致。源码 ESLint 排除双方的 Rust `target` 生成资产后，前后均为 835 错误、45 警告，没有新增源码错误。未过滤的当前工作目录另有 10 个旧生成资产解析错误，不能把全库检查写成全绿。
- 新 observer 的 ESLint/Node 语法、全部基线 Python 语法、修改文件格式检查通过。最终真实记录可被汇总；8 类针对版本、键盘污染、窗口可见性、缩略图、ready、路径和滑块的坏数据副本均被拒绝，且不覆盖旧 summary。这些负例仅在临时目录中执行，不是实机测量数据。

[默认原始记录](baseline/evidence/windows/measurements.json)、[20 预设原始记录](baseline/evidence/windows/presets20.json)、[分组汇总](baseline/evidence/windows/summary.json)、[测量脚本输入摘要](baseline/evidence/windows/measurement-inputs.json)、[构建输入与产物](baseline/evidence/windows/build.json) 和 [复现说明](baseline/README.md) 一并保存。JSON 统一为 UTF-8/LF 并按仓库格式排版，字段和值保留；汇总按 JSON 值逐项复算一致，不声称排版后的文件与 Windows 原文件逐字节相同。

Windows 检查退出码见 [quality.json](baseline/evidence/windows/quality.json) 和 [默认交付特性 Clippy](baseline/evidence/windows/clippy-default.json)，完整构建/检查日志见 [build-records/](baseline/evidence/windows/build-records/)；日志统一编码、换行并去除行末空白，保留诊断内容。[前端对照结果](baseline/evidence/windows/build-records/frontend-comparison.json) 单列历史错误，未将非阻塞检查改写成通过。

[清理记录](baseline/evidence/windows/cleanup.json) 确认测试计划任务和基线应用进程剩余均为 0；五个旧/失败归档目录保留在 Windows 的 `attempts/`，没有提交到仓库。

## 待补验收

任务 1 仍缺 macOS 构建/运行及同素材实测、移动硬盘、更多独立原图、官方版安装器并存和真实钥匙串集成验证、人眼对预览/滑块/滚动的确认，以及实际缓存命中和源文件访问证据。后续性能比较须保留本轮素材局限、显示条件、分组和计时口径，不将重复选择改标为缓存命中。

阶段 1 的 macOS 全矩阵和 Windows 资源管理器、系统截图等人工输入补测仍须独立完成；本次从图库加载真实 RAW 不能充当 RAW 拖入的通过证据。系统截图补测仍应优先，开始前运行已验收的观察脚本，结束时按 Q 保存完整记录。
