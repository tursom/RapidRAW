# 阶段 1：拖放和剪贴板验证

**状态：Linux 完整构建及窗口验证、Windows 构建和 Chrome/Edge 主要用例已实测；macOS 及下文列出的 Windows 剩余用例待补，阶段 1 尚未达到退出条件。**

用户已选择 **macOS 留待人工补测**。人工验证步骤和待填表见 [macOS 补测交接](spike/intake/evidence/macos/README.md)；当前 macOS 结果仍为未测，不再等待远程主机信息。

范围对应 `rapidraw-handoff/PLAN.md` 第 7 节阶段 1、`TASKS.md` 任务 7。基于 `92a70324`，分支为 `spike/phase-1-image-intake`。只增加本报告和 `spike/intake/`，不合并到主线。正式编辑器、Android、图片导入及编辑记录均没有改动。

## 实验工具

`spike/intake/` 是独立的 Tauri 小应用，不编译 RapidRAW 的 RAW/GPU 管线。Tauri 固定 2.12.1，独立 `Cargo.lock` 以正式应用锁文件为种子生成，Tauri/Wry/tao 及相关运行库版本与基线一致；npm CLI 同样固定 2.12.1。图标复用仓库的 `src-tauri/icons/`，因此应保留完整仓库目录运行。真机复测时保留这些锁文件，避免版本漂移影响结论。

- `web/index.html`、`probe.js`、`style.css`：测试页面、事件记录和图片 File 解码。
- `src-tauri/tauri.conf.json`：原生拖放开启；`tauri.html5.conf.json`：关闭原生拖放的对照配置。
- `src-tauri/src/main.rs`：环境信息、后台剪贴板命令和 JSON 报告保存。
- `src-tauri/src/lib.rs`：系统剪贴板格式枚举、文件/图片/文本读取及分段计时。
- `src-tauri/src/additional_objects.rs`：Windows WebView2 的可选原生路径接收探针；勾选复选框后通过异步命令注册，COM 对象只在 UI 线程使用。
- `src-tauri/examples/clipboard.rs`：无需 WebView 的剪贴板命令行探针。
- 其余配置及锁文件仅用于独立构建；正式应用的配置、依赖和标识符未修改。

原生拖放记录 `enter / over / leave / drop`，包括 Tauri 提供的路径。HTML5 记录 `DataTransfer.types / items / files`、目录标记、非标准 `File.path` 是否存在，以及 URI/HTML/文本摘要。可用的图片 File 会解码并显示尺寸与耗时；仅有 URL 时不会下载。字符串摘要最多保留 4096 个字符。

系统剪贴板只在点击按钮时读取：记录所有原生格式名、文件列表、图片尺寸、读取耗时、PNG 编码字节数/耗时，以及文本摘要和调整参数标记是否匹配。文本摘要最多保留 512 个字符。后台读取不会阻塞页面，也不会修改系统剪贴板。读取过程中不要复制其他内容：各格式是顺序读取，并非原子快照。库返回的错误会原样记录；Linux X11 实测发现，不支持的文件/文本读取也可能返回成功的空列表/空字符串，须结合格式枚举及具体来源判断，不能仅凭 `ok: true` 判断该格式存在。

## 在 Windows/macOS 上运行

先安装 [Tauri 桌面构建前置依赖](https://v2.tauri.app/start/prerequisites/)、Rust、Node.js。Windows 需要 WebView2 和 MSVC 构建工具，macOS 需要 Xcode Command Line Tools。独立工具不要求先构建 RapidRAW。

在仓库根目录执行：

```sh
cd spike/intake
npm ci
npm run native
```

关闭窗口并结束前一次进程后，在同一目录运行对照模式：

```sh
npm run html5
```

启动后确认环境行中的 `nativeDragDrop`：前者为 `true`，后者为 `false`。记录系统版本、WebView2/macOS 版本、来源浏览器版本、用例和素材尺寸。**每个模式分别启动、分别导出记录。** macOS 上接收端始终是 WKWebView，Safari/Chrome 指拖入或复制图片的来源浏览器；Windows 上接收端是 WebView2。

仅测试剪贴板可在 `spike/intake/src-tauri/` 执行：

```sh
cargo run --locked --no-default-features --example clipboard
```

点击“导出 JSON”后，Tauri 会将报告写入这个独立工具的应用数据目录 `results/`，界面记录 `report-saved.path` 的完整路径。默认位置为：

- Windows：`%APPDATA%/io.github.tursom.rapidraw.intake-spike/results/`
- macOS：`~/Library/Application Support/io.github.tursom.rapidraw.intake-spike/results/`

报告包含环境、时间、每条记录的人工来源标签、实际数据或错误，以及耗时。普通浏览器打开测试页只能检查 HTML5 部分，导出采用浏览器下载；这不构成 Tauri 实测。

## 真机操作和记录方法

1. 先用默认原生模式，从资源管理器/访达拖单图、多图、文件夹、混合选择、中文/日文文件名、RAW 和 JPEG。核对 `native-drop.paths` 是否完整。此探针只观察，不实现格式过滤或文件夹拒绝。
2. 从每个来源浏览器拖网页 JPEG、PNG，以及一个大尺寸图片，记录收到的是路径、图片 File、URL/HTML，还是完全没有事件。记录可访问的测试页面 URL 和图片来源；不要用“存在 drop 事件”代替“图片数据可用”。
3. 在 HTML5 模式重复上述本地及浏览器操作。分别检查绝对路径是否可用、图片 File 能否解码。本地 File 只有文件名或字节不代表已有正式 RAW 打开的本地路径方案。
4. 逐一测试资源管理器/访达“复制”、浏览器“复制图像”、浏览器“复制图像地址”、系统截图、纯文本、空剪贴板，以及文本 `RapidRAW:adjustments`。每次复制后点击“读取系统剪贴板”，核对原生格式、文件列表、图片和文本四项结果。
5. 浏览器复制图片至少用一张小图和一张大图（例如 6000×4000 或更大，记录实际尺寸），各重复 3 次。记录 `image.value.readMs`、`image.value.png.elapsedMs`、`image.value.png.value.bytes`、`totalMs` 和 `roundTripMs`；`image.elapsedMs` 包含 PNG 编码，不应当作单纯读取耗时。单独记录首次与后续读取。
6. 在来源/用例输入框内粘贴普通文本，确认页面未拦截。聚焦虚线测试区域后粘贴会额外记录 HTML paste，但系统剪贴板结论以 Rust 按钮的结果为准。
7. 每个平台每种模式导出 JSON，把下表“未测”替换为事件类型、数据可用性、耗时及报告文件名。未收到事件时，在“用例/素材”补写“未收到事件”并点击“记录当前用例/观察”，保留人工观察。报告还会保存导出时的当前来源标签；无事件不能凭空生成成功记录。

## 目标平台实测矩阵

Windows 已在 `pc.lan` 的实际桌面会话测试，来源页面由该机本地 HTTP 服务提供，图片是生成素材；没有将 Linux、合成 DOM 事件或无效鼠标落点填作目标平台成功。macOS 已按用户选择转交人工补测，原始记录及版本待补。现有原始记录及版本见后文。

| 系统    | 来源                                               | 原生模式拖入                    | HTML5 模式拖入                                            | 复制图片/文件后系统读取                                 | 大图耗时/报告      |
| ------- | -------------------------------------------------- | ------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- | ------------------ |
| Windows | Edge：网页 JPEG、小图/大图（PNG 来源待补）         | 真实源端拖动，目标未收到事件    | 图片 File 字节可用、可解码；无物理路径                    | “复制图像”成功，小图/大图各 3 次                        | 已记录，debug 构建 |
| Windows | Chrome：网页 JPEG、小图/大图（PNG 来源待补）       | 真实源端拖动，目标未收到事件    | 图片 File 字节可用、可解码；无物理路径                    | “复制图片”成功，小图/大图各 3 次                        | 已记录，debug 构建 |
| Windows | 资源管理器：单图/多图/文件夹/混合                  | 自动化落点/焦点无效，待有效复验 | 自动化落点/焦点无效，待有效复验                           | CF_HDROP 原生格式生成/读取已验证；不是资源管理器 Ctrl+C | 不适用             |
| Windows | Windows Shell 原生 OLE 来源：文件/目录/混合/中日文 | 真实 native-drop 路径全部匹配   | 真实 HTML drop、目录标记及 AdditionalObjects 路径全部匹配 | 不涉及剪贴板                                            | 原始记录已保存     |
| macOS   | Safari：网页 JPEG/PNG、小图/大图                   | 未测                            | 未测                                                      | 未测                                                    | 未测               |
| macOS   | Chrome：网页 JPEG/PNG、小图/大图                   | 未测                            | 未测                                                      | 未测                                                    | 未测               |
| macOS   | 访达：单图/多图/文件夹/混合                        | 未测                            | 未测                                                      | 未测                                                    | 未测               |

| 系统剪贴板其他来源                                 | Windows                                     | macOS |
| -------------------------------------------------- | ------------------------------------------- | ----- |
| 系统截图                                           | 未测                                        | 未测  |
| 浏览器“复制图像地址”（Edge/Chrome；Safari/Chrome） | 未测                                        | 未测  |
| 普通文本、空剪贴板、调整参数标记                   | Win32 生成内容，实际 Rust 读取已测          | 未测  |
| 大图首次及后续读取各 3 次                          | Chrome/Edge 各 3 次已测；不是干净进程冷启动 | 未测  |

## 源码/文档结论与方案选择

**已选定实验剪贴板依赖：`clipboard-rs = "=0.3.5"`。** 它直接提供 `available_formats()`、`get_files()`、`get_image()`、`get_text()` 和 PNG 转换，可在一个依赖里完成本阶段要求的原生格式诊断和计时。上下文在同一个后台任务内创建和使用；界面在任务完成前禁用读取按钮，避免重复操作竞争 Windows 剪贴板。无需 watcher。

已核对 `arboard 3.7.0`（以及 3.6.1）也提供 `Clipboard::get().file_list()`。arboard 仍是正式实现的候选；本实验选择 clipboard-rs 的理由是格式枚举和诊断便利。两者都需要真机验证来源兼容性，不能仅凭 API 存在判定浏览器复制图片成功。

**Windows 选定 HTML5 图片字节加 AdditionalObjects 本地路径；macOS 方案待实测，正式接入时补齐资源管理器 UI 及完整输入验收。** Windows 实测原生模式收不到 Chrome/Edge 的网页 JPEG 拖入；HTML5 模式两者均成功。Windows Shell 提供的原生文件/目录/混合拖放在 HTML5 模式也已取回正确的物理路径，保住本地输入能力。Tauri 官方文档明确 Windows 上 HTML5 拖放需要 `dragDropEnabled: false`。本次只验证方案，不修改正式应用的拖放配置。

Windows 的 `chrome.webview.postMessageWithAdditionalObjects` 能将 File 送到原生端的 `ICoreWebView2File::Path`；Tauri/Wry 的普通字符串 IPC 不会把 AdditionalObjects 自动转为路径。需要通过 `with_webview` 注册 Windows COM 接收器，并在 WebView2 UI/STA 线程读取属性。macOS 没有这个接口，需要另外验证 WKWebView 的行为。

工具中的 AdditionalObjects 复选框现已连接 Windows 原生接收器。只有 `additional-paths` 的 `phase=receive, ok=true` 及实际 `paths` 才证明路径可用；发送成功或注册成功均不足以证明接收。实测：通过 CDP 文件输入提供的两个磁盘 File 可回传完整路径，含中日文文件名；Chrome/Edge 拖来的网页图片调用该 API 报“不是磁盘文件”，但它们的 HTML5 图片字节可解码。文件输入路径验证不替代资源管理器的实际拖放验证。

接收器新增的直接依赖 `windows=0.62.2`、`webview2-com=0.39.1` 都与现有 Wry 栈的锁定版本一致，且仅在这个独立实验的 Windows desktop 特性启用。注册入口必须是异步命令；同步安装曾导致 WebView 无响应。发送消息使用 JSON 字符串：对象消息会使现有 Wry 字符串 IPC handler 提前失败，接收不到附加路径；改成字符串后已验证路径回传和后续正常 IPC。

本探针嵌入静态页面，接收器只接受 `http://tauri.localhost` origin。正式程序的 Vite 开发入口需要同步匹配受信 origin，不能直接沿用这个固定值到开发服务器，也不能放开任意来源。

尚不能断言“浏览器拖入代价过大”，也未决定第一版只支持粘贴。若后续实测得到这个结论，按 PLAN.md 第 11 节向产品负责人报告后决定。本地拖入优先的产品规则保持有效。

证据链接（源码/文档检查，不是本工具的真机结果）：

- [Tauri dragDropEnabled 配置](https://v2.tauri.app/reference/config/#windowconfig)
- [clipboard-rs 0.3.5 公共 API](https://docs.rs/clipboard-rs/0.3.5/clipboard_rs/trait.Clipboard.html)、[RustImage](https://docs.rs/clipboard-rs/0.3.5/clipboard_rs/common/trait.RustImage.html)
- [arboard 3.7.0 Get::file_list](https://docs.rs/arboard/3.7.0/arboard/struct.Get.html#method.file_list)
- [WebView2 JavaScript 接口](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/javascript/webview)、[ICoreWebView2File](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2file)、[线程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/threading-model)
- [Tauri with_webview](https://docs.rs/tauri/2.12.1/tauri/webview/struct.WebviewWindow.html#method.with_webview)、[Wry 0.57.0 Windows IPC 源码](https://docs.rs/crate/wry/0.57.0/source/src/webview2/mod.rs)

## 本机实际检查

环境：Linux x86_64；Rust 1.99.1、Node 26.12.1。首次检查时没有 DISPLAY/Wayland 会话及 GTK3/WebKitGTK 开发库；2026-11-06 补装 GTK 3.24.52、WebKitGTK 2.54.2、Xvfb、xclip 和 xdotool 后，已完成下述独立窗口构建及 X11 虚拟显示会话实测。最终实验锁文件为 Tauri 2.12.1、tauri-runtime-wry 2.12.1、Wry 0.57.0、tao 0.37.1、clipboard-rs 0.3.5；CLI 固定 2.12.1。正式应用锁文件保持原样。初次 `tauri info` 检查使用了自动解析的较新补丁版本，提交前已固定并核对上述基线版本。

| 命令/用例                                                                            | 实际结果                                                                                                                                              |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd spike/intake && npm install --ignore-scripts`，随后 `npm ci --ignore-scripts`    | 成功，生成并验证独立 npm 锁文件；没有新增正式应用依赖                                                                                                 |
| `cd spike/intake && npm run check`                                                   | 成功，验证页面 JavaScript 语法                                                                                                                        |
| `cd spike/intake/src-tauri && cargo check --locked --no-default-features --lib`      | 成功；仅验证剪贴板测量核心，不包含 Tauri 窗口及命令接线                                                                                               |
| 同目录 `cargo clippy --locked --no-default-features --lib --examples -- -D warnings` | 成功                                                                                                                                                  |
| 同目录 `cargo run --locked --no-default-features --example clipboard`                | 正常返回 `contextError: $DISPLAY variable not set and no value was provided explicitly`，无 panic。只验证无图形环境的错误报告路径，不是读取剪贴板成功 |
| 同目录 `cargo fmt -- --check`                                                        | 成功                                                                                                                                                  |
| 同目录 `cargo check --locked`                                                        | 首次因缺少 `gdk-3.0` 失败；2026-11-06 补库后完整 desktop 检查通过，见下文                                                                             |
| `cd spike/intake && npm exec tauri -- info`                                          | 首次识别独立应用配置和依赖，报告缺少 WebKitGTK 和 rustup；补库后的可选重查因 crates.io 连接重置而超时，未作为构建结论依据                             |
| 两种合并后配置的 JSON Schema 检查，共享图标存在检查                                  | 通过。使用官方 Tauri 2 schema 和 Ajv，关闭 schema 中非标准数字格式注解的校验；结构、属性和类型校验开启                                                |
| Linux headless Chromium 158.0.8127.18，Playwright 合成 DataTransfer                  | PNG File 元数据及 32×32 图片解码、URI/HTML 摘要、输入框粘贴未被拦截、JSON 下载、清空记录通过                                                          |
| 同一浏览器，模拟 `window.__TAURI__` 桥接                                             | 原生事件转录、剪贴板命令及往返耗时记录、报告保存调用、AdditionalObjects 缺失报错、剪贴板错误后按钮恢复通过。是 mock，不是原生集成测试                 |
| 仓库根目录 `npm ci --ignore-scripts`、`npm run build`                                | 成功；生产前端构建通过，有既有大包体积提示                                                                                                            |
| `cd src-tauri && cargo fmt -p RapidRAW -- --check`                                   | 成功                                                                                                                                                  |
| 仓库根目录 `npm run typecheck`                                                       | 失败：64 处既有 TS 错误，例如 CopyPasteSettingsModal、CullingModal、MasksPanel；未修改这些源文件                                                      |
| 仓库根目录 `npm run lint`                                                            | 失败：835 个错误、45 个警告，位于既有源文件；未修复范围外问题                                                                                         |
| 仓库根目录 `npm run i18n:check`                                                      | 失败：既有语言文件格式/顺序差异，uk 缺少两个 hideCollapsedPanels 键；dry-run 未改写文件                                                               |
| 仓库根目录 `npm run format:check`                                                    | 失败：既有 436 个文件不符合格式；仅格式化本次新增文件                                                                                                 |

浏览器冒烟使用本机已安装的 Playwright 和 Chromium，通过临时 Node HTTP 服务加载实验页面。拖放由合成 `DataTransfer`/`DragEvent` 触发；模拟 Tauri API 返回固定响应并核对事件、错误分支及导出的 JSON。临时脚本为 `/tmp/tbt-intake-smoke.cjs`。这些检查只证明页面记录逻辑可执行，不证明跨应用拖放、系统剪贴板、WebView2/WKWebView 或目标平台下载行为。

### Linux 完整构建及实际窗口复验（2026-11-06）

安装执行 `pacman -S --needed --noconfirm gtk3 webkit2gtk-4.1 xorg-server-xvfb xclip`，另装 `xdotool`。首次下载因镜像旧版本 404，整笔事务未安装；随后从 `archive.archlinux.org/packages/<首字母>/<包名>/` 补齐缺失精确版本包及 `.sig` 到 pacman 缓存，再重跑成功。没有执行系统更新、修改镜像配置或关闭签名校验。安装日志为 `/tmp/tbt-spike-pacman.log`、`/tmp/tbt-spike-archive.log` 和 `/tmp/tbt-spike-xdotool-install.log`。

| 命令（独立应用目录内）                                                                 | 实际结果                                                            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `src-tauri/`: `cargo check --locked`                                                   | 通过；默认特性包含 `desktop`，检查真实 Tauri 窗口、命令和剪贴板核心 |
| `src-tauri/`: `cargo build --locked`                                                   | 通过；完整 debug 可执行文件成功链接，随后实际启动                   |
| `src-tauri/`: `cargo clippy --locked --all-targets -- -D warnings`                     | 通过；包含 desktop、库和 example                                    |
| `npm exec tauri -- build --debug --no-bundle --config src-tauri/tauri.html5.conf.json` | 通过；HTML5 对照配置实际构建及启动，`nativeDragDrop=false`          |
| `npm run check`、`src-tauri/`: `cargo fmt -- --check`                                  | 通过                                                                |

没有发现需要修复的实验代码编译问题。Tauri CLI 自动添加的两个空 `features` 数组已恢复，应用代码、依赖和锁文件均未改动。对照运行后重新执行默认配置的 check/build/Clippy，全部通过；最终构建产物恢复为原生模式。这里验证的是 debug 应用，没有执行 release 优化构建或安装包打包。

使用 `xvfb-run ... dbus-run-session -- .../target/debug/rapidraw-intake-spike` 启动真实 GTK 窗口。初次 Xvfb 在本机 NVIDIA EGL 路径崩溃，继而导致 GTK 初始化失败；本次测试进程采用以下软件渲染设置后成功，未修改全局驱动配置：

```sh
LIBGL_ALWAYS_SOFTWARE=1 \
__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json \
xvfb-run -a -s '-screen 0 1280x1024x24 -extension GLX' \
dbus-run-session -- ./src-tauri/target/debug/rapidraw-intake-spike
```

自动化通过 WebKitGTK 已有的 `WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:19231` 连接本机调试窗口，点击实际页面按钮并检查 DOM/原生导出文件；没有 mock `window.__TAURI__` 或增加应用测试钩子。测试时 `XDG_DATA_HOME=/tmp/tbt-spike-linux-data`，报告由实际 `save_report` 命令写到该目录下的应用 `results/`。软件渲染和缺少 AT-SPI 服务有警告，未阻止窗口和 IPC 运行。截图及完整日志保存在 `/tmp`；结束后关闭本次窗口、来源程序、调试端口和 Xvfb/dbus 会话。

| 用例及来源                                           | 实际结果                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 两种实际 Tauri 窗口初始化                            | `environment` 原生 IPC 返回 `os=linux`，原生/HTML5 模式的 `nativeDragDrop` 分别为 `true/false`；事件监听和剪贴板按钮正常启用                                             |
| xclip：中日文普通文本、`RapidRAW:adjustments`        | 实际 X11 选择区读取成功，文本摘要及标记匹配；不是 JS mock                                                                                                                |
| xclip：含空格、中文文件名的 `text/uri-list`          | `files.value` 保留百分号编码的 `file:///...` URI；此 Linux 库结果尚不是已解码的本地路径                                                                                  |
| xclip：32×32、6000×4000 生成 PNG，各连续读取 3 次    | 原生图片读取、尺寸、PNG 编码及往返计时成功；详见下表                                                                                                                     |
| xclip：无剪贴板 owner                                | 格式枚举返回 X11 Atom 错误，图片返回 `No image data found`；文件返回成功空列表、文本返回成功空字符串，页面按钮恢复可用                                                   |
| xdotool：实际 Ctrl+V                                 | 普通输入框收到文本；聚焦测试区域后记录真实 `html-paste`，文本内容匹配                                                                                                    |
| 临时 GTK 来源窗口：实际 Xdnd，原生模式               | 收到 `native-enter/over/drop/leave`；混合 PNG、中文空格文件名、目录、占位 `.RAW` 文件的四条绝对路径完整。没有执行 RAW 解码或文件过滤                                     |
| 同一 GTK 来源：实际 Xdnd，HTML5 模式                 | 收到 `html-enter/drop`，但 `files=[]`、URI 字符串为空，仅 HTML 锚点包含第一条 file URI；没有可解码图片数据或目录标记。仅代表此 GTK URI 来源，不推断文件管理器/浏览器表现 |
| 两种实际 WebView：合成 DOM `DataTransfer` / PNG File | 32×32 图片 File 元数据及解码成功，`File.path=null`；原生模式另验证 URI/HTML 摘要。这一行是合成事件，不是跨应用文件字节传输成功                                           |
| 两种模式“导出 JSON”                                  | 实际 Rust `save_report` 写文件成功，回读确认模式、事件及剪贴板数据，原始报告见下文                                                                                       |

6000×4000 素材是生成的灰度梯度转 RGB PNG，输入 81,157 字节；32×32 素材为生成的纯色 PNG。以下是最终测试序列的三次读取，进程和库已经经过前面的排查读测，**第 1 次不是进程冷启动**。这是 Linux X11、软件渲染、debug 构建、xclip 来源的结果，不能当作 Windows/macOS 浏览器复制图片的性能：

| PNG 尺寸 / 次数 | 图片读取 `readMs` | PNG 编码 ms | 编码字节数 | 原生 `totalMs` | 页面往返 ms |
| --------------- | ----------------- | ----------- | ---------- | -------------- | ----------- |
| 32×32 / 1       | 50.37             | 0.19        | 221        | 201.66         | 203         |
| 32×32 / 2       | 50.45             | 0.26        | 221        | 202.01         | 203         |
| 32×32 / 3       | 51.57             | 0.19        | 221        | 153.27         | 154         |
| 6000×4000 / 1   | 574.98            | 2779.72     | 473244     | 3510.01        | 3512        |
| 6000×4000 / 2   | 586.03            | 2752.90     | 473244     | 3492.54        | 3493        |
| 6000×4000 / 3   | 594.30            | 2774.40     | 473244     | 3523.97        | 3525        |

读取耗时包含系统图片读取和解码，PNG 编码另外计时；总耗时还含格式枚举、文件、文本的顺序探测。报告原样保留不支持格式返回的空值和具体错误，不能把图片格式之外的 `text.ok=true` 解释为剪贴板同时存在文本。

可复核产物：

- [原生模式原始 JSON](spike/intake/evidence/linux-x11/native.json)：原生 IPC、X11 剪贴板、实际键盘粘贴、实际 Xdnd 路径，以及明确标注的合成 HTML5 事件。
- [HTML5 模式原始 JSON](spike/intake/evidence/linux-x11/html5.json)：真实 GTK URI 拖入未获得 File 的结果、人工观察、合成 File 解码、原生剪贴板 IPC。
- `/tmp/tbt-spike-linux-{check,build,clippy}.log` 和 `/tmp/tbt-spike-linux-final-{check,build,clippy}.log`；`/tmp/tbt-spike-linux-html5-build.log`；`/tmp/tbt-spike-linux-{js-check,fmt,versions}.log`。
- `/tmp/tbt-spike-linux-smoke.log`、`/tmp/tbt-spike-html5-smoke.log`，以及 `/tmp/tbt-spike-linux-artifacts/` 内的截图、素材和计时汇总。初期断言按实际库的空值语义修正，失败记录保留在 `*-attempt*.log`，最终两套脚本退出码均为 0。
- 临时驱动 `/tmp/tbt-spike-inspector.py`、`/tmp/tbt-spike-linux-smoke.py`、`/tmp/tbt-spike-html5-smoke.py`；实际拖放来源 `/tmp/tbt-spike-xdnd-source.c`。原生窗口日志 `/tmp/tbt-spike-linux-native-window.log`，HTML5 窗口日志 `/tmp/tbt-spike-linux-html5-window.log`，最初 Xvfb 崩溃栈 `/tmp/tbt-spike-xvfb-diagnostic.log`。

## Windows 实机复验（2026-11-06）

主机 `pc.lan`，Windows 10 x64、内核版本 `10.0.19045`。现有 Rust/Cargo 1.99.1、Visual Studio 2022 C++ 工具、Node 22.23.2；来源 Chrome `156.0.8078.74`、Edge `156.0.4314.58`，接收端 WebView2 `156.0.4314.58`。源码按用户指定用 rclone 放到 `E:\projects\tbt\rapidraw-intake-spike`，复用现有 Rust，没有运行此前准备的 Rust 安装脚本。

编译和 UI 驱动通过临时计划任务在已登录的 **Session 1** 执行，`UserInteractive=true`，没有将 SSH Session 0 的剪贴板当作桌面剪贴板。浏览器使用这个目录下的独立 profile，没有接入用户已打开的浏览器标签页。CDP 仅设置实验标签、读取日志、提供明确标注的文件输入及调试信息；浏览器拖放使用实际 Win32 鼠标事件，复制图片通过真实浏览器右键菜单选择。

Windows Cargo 公网下载持续超时，改由 Linux `cargo fetch --locked --target x86_64-pc-windows-msvc` 准备锁定依赖，通过内网传到项目专用 `cargo-home/`，使用 `--offline` 构建。Python 自动化依赖同样通过独立 `venv/` 离线安装。没有修改全局 PATH 或 Cargo 配置。以下命令均以独立工具的 `src-tauri/` 为工作目录：

| 实际命令                                                                   | 结果                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------- |
| `cargo build --locked --offline`                                           | 原生模式编译及运行成功                                    |
| 设置 `TAURI_CONFIG` 为 `tauri.html5.conf.json` 内容，再执行同一 build 命令 | HTML5 对照编译及运行成功，页面确认 `nativeDragDrop=false` |
| `cargo build --locked --offline --no-default-features --example clipboard` | 剪贴板 CLI 编译及桌面会话运行成功                         |
| `cargo clippy --locked --offline --all-targets -- -D warnings`             | 通过，包含 Windows COM 接收代码                           |

可直接运行的两个 debug 可执行文件保留在 `E:\projects\tbt\rapidraw-intake-spike\artifacts\intake-native.exe` 和 `intake-html5.exe`，命令行探针为同目录 `clipboard.exe`。源码、构建日志、临时 UI 驱动和所有尝试的原始 JSON 均保留在该项目目录，源码和图片来源目录没有混放。

测试结束后已移除两个临时计划任务并关闭本次应用及专用浏览器进程，回读确认剩余数量均为 0；恢复并核对生成的大小图素材仍在。用户原有浏览器进程、Rust、全局配置和项目目录保留。

### 浏览器拖放与路径接收

- 来源是 `http://127.0.0.1:8765/source.html`，图片为生成 JPEG：小图 1024×768、14,735 字节；大图 6000×4000、23,288,788 字节。大图使用固定随机种子的高熵 RGB 像素。此次不泛化为所有远程网站、CDN、受保护图片或 PNG 来源均已通过。
- 最终浏览器拖放记录同时核对来源 `dragstart.isTrusted=true`、目标落点所属窗口以及 `dragend.dropEffect`。原生模式两浏览器均无目标拖放事件，源端结束为 `none`；HTML5 模式均为 `copy`，收到 `image/jpeg` File、URI/HTML/文本，图片能解码到原始尺寸。大图解码约 40 ms。`File.path=null`，不能从文件名推断源路径。
- 勾选 AdditionalObjects 后，原生注册确认成功。通过 CDP 文件输入提供两个磁盘 File 后，真实 COM 接收器回传完整绝对路径，包含中日文；这一步没有伪装为资源管理器的物理拖动。
- 同一接收器面对 Chrome/Edge 实际拖入的网页图片，JS API 报 `additional File object is not a file on the disk`，图片的 File 字节仍可解码。正式实现应分别处理磁盘路径和网页字节，不应对网页 File 强求物理路径。
- 路径回传后再次调用 `environment` 并导出报告成功，现有 Tauri IPC 保持可用。首次同步安装导致无响应、对象消息发送后无路径回调的失败尝试保留在 Windows 项目的原始记录里；最终代码分别用异步安装和 JSON 字符串发送解决，并重跑验证。

本地路径另用真实 Windows Shell 数据对象完成了端到端验证。最小来源窗口调用 Shell `GetUIObjectOf` 取得磁盘对象的 `IDataObject`，通过原生 OLE `DoDragDrop`、实际鼠标移动及释放拖入 Tauri；没有合成 DOM 拖放事件。它与资源管理器 UI 的自动化分开记录：

| 来源选择        | 原生模式                           | HTML5 模式                             |
| --------------- | ---------------------------------- | -------------------------------------- |
| 单个 JPEG       | native-enter/drop 返回正确路径     | 图片字节可解码，原生接收器回传正确路径 |
| 目录            | native-enter/drop 返回正确目录路径 | `isDirectory=true`，原生回传目录路径   |
| JPEG 与目录混合 | 两条路径完整、顺序匹配             | 两个条目可区分目录，两个物理路径完整   |
| 中日文文件名    | 原生路径完整                       | File 名称、图片解码及原生路径完整      |

八个 OLE 用例均返回复制效果 `1`，拖入前核对目标窗口匹配。由此确认 Windows 本地拖放和网页拖放可共用 HTML5 模式，文件和目录均可保留路径。正式入口的格式过滤、只拖目录时提示、混合时忽略目录等行为仍属于后续输入任务。

### 系统剪贴板与大图耗时

Chrome 的“复制图片(Y)”和 Edge 的“复制图像(Y)”均通过真实右键菜单调用，小图、大图各复制并读取 3 次。Edge 最终驱动另记录了系统剪贴板序列号变化。原生格式包括 PNG、CF_DIBV5、HTML、URL 和 Chromium 自有格式；Rust 读取到正确尺寸，并完成 PNG 编码。

以下是 **未优化 debug 实验应用** 的毫秒数；每个尺寸第 1 次为这段序列的首次读测，非干净进程冷启动。这个最小工具没有继承正式应用的 dev 优化配置，不能用编码耗时断言最终产品性能。大图编码输出为 96,011,388 字节，体现该高熵 RGBA 素材和当前编码方式的开销。

| 来源 / 尺寸        | 三次图片读取 ms             | 三次 PNG 编码 ms               | 三次页面往返 ms             |
| ------------------ | --------------------------- | ------------------------------ | --------------------------- |
| Chrome / 1024×768  | 19.83 / 19.57 / 20.08       | 124.85 / 125.73 / 125.91       | 148.3 / 147.8 / 148.5       |
| Chrome / 6000×4000 | 1664.86 / 1666.83 / 1673.37 | 16203.62 / 16285.26 / 16223.38 | 18109.6 / 18153.2 / 18137.3 |
| Edge / 1024×768    | 19.29 / 19.30 / 19.45       | 126.68 / 126.86 / 126.21       | 150.3 / 149.8 / 148.7       |
| Edge / 6000×4000   | 1657.05 / 1637.17 / 1637.19 | 16307.11 / 16268.48 / 16299.81 | 18060.0 / 18022.3 / 18050.2 |

Chrome 大图首次读取时，格式枚举成功但返回空列表，随后图片读取成功；必须结合实际读出的内容判断，不能仅因一次枚举为空就认定没有图片。

另用 Win32 API 生成 CF_HDROP 文件列表（含中日文路径）、调整参数标记、普通中日文文本、空剪贴板，由真实 Rust CLI 读取。文件列表与输入完全一致，文本及标记匹配，空剪贴板的格式列表为空，文件/图片/文本读取错误按原样记录。它验证系统格式与库的行为，不代表已通过资源管理器 Ctrl+C 或系统截图来源测试。

### 原始证据与验收边界

- [浏览器最终拖放与 Edge 剪贴板](spike/intake/evidence/windows/windows-final.json)：以可信源端事件及有效目标窗口为准；文件中失败的 Explorer 自动化行不算通过。
- [Chrome 剪贴板序列](spike/intake/evidence/windows/windows-automation.json)：只引用其中真实右键复制成功的 Chrome 数据；这次早期尝试的拖放缺少有效源端事件，不能用于兼容性结论。
- [AdditionalObjects 最终接收](spike/intake/evidence/windows/windows-additional-final.json)：含本地文件输入的真实路径回传、网页 File 的明确错误、后续 IPC/导出成功。
- [Win32 系统剪贴板格式](spike/intake/evidence/windows/windows-system-clipboard.json)：明确标记生成来源。
- [Windows Shell 原生拖放](spike/intake/evidence/windows/windows-shell-result.json)：八个真实 OLE 用例，包括 HTML5 的目录标记、混合列表及回传物理路径。
- 早期 Explorer UI 自动化落点未匹配目标窗口，UIA 元素还曾失效；这些是测试驱动失败，不是产品不支持本地拖入的证据。实际资源管理器拖动仍需有效复验。

## 剩余验收及未处理问题

- macOS 已交由人工补测，当前没有实测结果：Safari/Chrome、访达、实际构建和剪贴板性能均待补，操作及回填要求见 [补测交接](spike/intake/evidence/macos/README.md)。Windows 尚有资源管理器实际操作、PNG/远程网站来源、“复制图片地址”及系统截图用例待补；已完成的 Windows 浏览器和生成系统格式结果见上文。
- Windows 已选定并验证 HTML5 加原生路径桥接；macOS 的输入方案仍待实测。不能据此宣布跨平台阶段完成或第一版仅支持网页粘贴。
- 独立窗口未挂载编辑器的 @dnd-kit 面板/快捷条，正式输入接入时仍须实测拖放冲突。本次不修改正式功能。
- 正式应用的完整 Rust 构建/Clippy 本次未重跑；补库后通过的是独立实验应用，未据此声称正式应用或 CI 全通过。已有 TypeScript、ESLint、i18n 和格式问题记录如上，留给相应任务处理。
- 完成目标平台矩阵、填入原始 JSON 和耗时并确定方案后，才能把阶段 1 标为完成。
