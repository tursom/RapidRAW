# 阶段 1：拖放和剪贴板验证

**状态：验证工具及 Linux 检查已完成，Windows/macOS 实测待补；阶段 1 尚未达到退出条件。**

范围对应 `rapidraw-handoff/PLAN.md` 第 7 节阶段 1、`TASKS.md` 任务 7。基于 `92a70324`，分支为 `spike/phase-1-image-intake`。只增加本报告和 `spike/intake/`，不合并到主线。正式编辑器、Android、图片导入及编辑记录均没有改动。

## 实验工具

`spike/intake/` 是独立的 Tauri 小应用，不编译 RapidRAW 的 RAW/GPU 管线。Tauri 固定 2.12.1，独立 `Cargo.lock` 以正式应用锁文件为种子生成，Tauri/Wry/tao 及相关运行库版本与基线一致；npm CLI 同样固定 2.12.1。图标复用仓库的 `src-tauri/icons/`，因此应保留完整仓库目录运行。真机复测时保留这些锁文件，避免版本漂移影响结论。

- `web/index.html`、`probe.js`、`style.css`：测试页面、事件记录和图片 File 解码。
- `src-tauri/tauri.conf.json`：原生拖放开启；`tauri.html5.conf.json`：关闭原生拖放的对照配置。
- `src-tauri/src/main.rs`：环境信息、后台剪贴板命令和 JSON 报告保存。
- `src-tauri/src/lib.rs`：系统剪贴板格式枚举、文件/图片/文本读取及分段计时。
- `src-tauri/examples/clipboard.rs`：无需 WebView 的剪贴板命令行探针。
- 其余配置及锁文件仅用于独立构建；正式应用的配置、依赖和标识符未修改。

原生拖放记录 `enter / over / leave / drop`，包括 Tauri 提供的路径。HTML5 记录 `DataTransfer.types / items / files`、目录标记、非标准 `File.path` 是否存在，以及 URI/HTML/文本摘要。可用的图片 File 会解码并显示尺寸与耗时；仅有 URL 时不会下载。字符串摘要最多保留 4096 个字符。

系统剪贴板只在点击按钮时读取：记录所有原生格式名、文件列表、图片尺寸、读取耗时、PNG 编码字节数/耗时，以及文本摘要和调整参数标记是否匹配。文本摘要最多保留 512 个字符。后台读取不会阻塞页面，也不会修改系统剪贴板。读取过程中不要复制其他内容：各格式是顺序读取，并非原子快照。格式不支持或读取失败会记录具体错误，不视为空剪贴板。

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

以下全部为**未测**：当前只有无图形会话的 Linux 开发机，无法运行目标平台的来源浏览器及 WebView。没有 Windows/macOS 构建或运行成功的声明。

| 系统    | 来源                              | 原生模式拖入 | HTML5 模式拖入 | 复制图片/文件后系统读取 | 大图耗时/报告 |
| ------- | --------------------------------- | ------------ | -------------- | ----------------------- | ------------- |
| Windows | Edge：网页 JPEG/PNG、小图/大图    | 未测         | 未测           | 未测                    | 未测          |
| Windows | Chrome：网页 JPEG/PNG、小图/大图  | 未测         | 未测           | 未测                    | 未测          |
| Windows | 资源管理器：单图/多图/文件夹/混合 | 未测         | 未测           | 未测                    | 未测          |
| macOS   | Safari：网页 JPEG/PNG、小图/大图  | 未测         | 未测           | 未测                    | 未测          |
| macOS   | Chrome：网页 JPEG/PNG、小图/大图  | 未测         | 未测           | 未测                    | 未测          |
| macOS   | 访达：单图/多图/文件夹/混合       | 未测         | 未测           | 未测                    | 未测          |

| 系统剪贴板其他来源                                 | Windows | macOS |
| -------------------------------------------------- | ------- | ----- |
| 系统截图                                           | 未测    | 未测  |
| 浏览器“复制图像地址”（Edge/Chrome；Safari/Chrome） | 未测    | 未测  |
| 普通文本、空剪贴板、调整参数标记                   | 未测    | 未测  |
| 大图首次及后续读取各 3 次                          | 未测    | 未测  |

## 源码/文档结论与方案选择

**已选定实验剪贴板依赖：`clipboard-rs = "=0.3.5"`。** 它直接提供 `available_formats()`、`get_files()`、`get_image()`、`get_text()` 和 PNG 转换，可在一个依赖里完成本阶段要求的原生格式诊断和计时。上下文在同一个后台任务内创建和使用；界面在任务完成前禁用读取按钮，避免重复操作竞争 Windows 剪贴板。无需 watcher。

已核对 `arboard 3.7.0`（以及 3.6.1）也提供 `Clipboard::get().file_list()`。arboard 仍是正式实现的候选；本实验选择 clipboard-rs 的理由是格式枚举和诊断便利。两者都需要真机验证来源兼容性，不能仅凭 API 存在判定浏览器复制图片成功。

**拖放保留 Tauri 原生本地拖放作为首选，正式输入方案待真机数据决定。** Tauri 官方配置文档明确：Windows 上 HTML5 拖放需要 `dragDropEnabled: false`，原生 handler 替换了 WebView2 的拖放处理器。因此提供两个启动配置做对照。普通 DOM File 不保证有本地绝对路径。

Windows 的 `chrome.webview.postMessageWithAdditionalObjects` 能将 File 送到原生端的 `ICoreWebView2File::Path`；Tauri/Wry 的普通字符串 IPC 不会把 AdditionalObjects 自动转为路径。需要通过 `with_webview` 注册 Windows COM 接收器，并在 WebView2 UI/STA 线程读取属性。macOS 没有这个接口，需要另外验证 WKWebView 的行为。

工具中的 AdditionalObjects 复选框**只探测 JS API 是否存在以及能否发送**。本次未实现原生接收器；`additional-objects-sent` 中明确记录 `nativeReceiverInstalled: false`，不得据此声称本地路径可用。只有当真机结果表明必须用 HTML5 模式且本地路径丢失时，才有证据继续补这个 Windows 接收实验。网页图片或内存 File 也不能预设一定有磁盘路径。

尚不能断言“浏览器拖入代价过大”，也未决定第一版只支持粘贴。若后续实测得到这个结论，按 PLAN.md 第 11 节向产品负责人报告后决定。本地拖入优先的产品规则保持有效。

证据链接（源码/文档检查，不是本工具的真机结果）：

- [Tauri dragDropEnabled 配置](https://v2.tauri.app/reference/config/#windowconfig)
- [clipboard-rs 0.3.5 公共 API](https://docs.rs/clipboard-rs/0.3.5/clipboard_rs/trait.Clipboard.html)、[RustImage](https://docs.rs/clipboard-rs/0.3.5/clipboard_rs/common/trait.RustImage.html)
- [arboard 3.7.0 Get::file_list](https://docs.rs/arboard/3.7.0/arboard/struct.Get.html#method.file_list)
- [WebView2 JavaScript 接口](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/javascript/webview)、[ICoreWebView2File](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2file)、[线程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/threading-model)
- [Tauri with_webview](https://docs.rs/tauri/2.12.1/tauri/webview/struct.WebviewWindow.html#method.with_webview)、[Wry 0.57.0 Windows IPC 源码](https://docs.rs/crate/wry/0.57.0/source/src/webview2/mod.rs)

## 本机实际检查

环境：Linux x86_64；Rust 1.99.1、Node 26.12.1；无 DISPLAY/Wayland 会话，无 GTK3/WebKitGTK 开发库。最终实验锁文件为 Tauri 2.12.1、tauri-runtime-wry 2.12.1、Wry 0.57.0、tao 0.37.1、clipboard-rs 0.3.5；CLI 固定 2.12.1。正式应用锁文件保持原样。初次 `tauri info` 检查使用了自动解析的较新补丁版本，提交前已固定并核对上述基线版本。

| 命令/用例                                                                            | 实际结果                                                                                                                                              |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd spike/intake && npm install --ignore-scripts`，随后 `npm ci --ignore-scripts`    | 成功，生成并验证独立 npm 锁文件；没有新增正式应用依赖                                                                                                 |
| `cd spike/intake && npm run check`                                                   | 成功，验证页面 JavaScript 语法                                                                                                                        |
| `cd spike/intake/src-tauri && cargo check --locked --no-default-features --lib`      | 成功；仅验证剪贴板测量核心，不包含 Tauri 窗口及命令接线                                                                                               |
| 同目录 `cargo clippy --locked --no-default-features --lib --examples -- -D warnings` | 成功                                                                                                                                                  |
| 同目录 `cargo run --locked --no-default-features --example clipboard`                | 正常返回 `contextError: $DISPLAY variable not set and no value was provided explicitly`，无 panic。只验证无图形环境的错误报告路径，不是读取剪贴板成功 |
| 同目录 `cargo fmt -- --check`                                                        | 成功                                                                                                                                                  |
| 同目录 `cargo check --locked`                                                        | 失败：系统缺少 `gdk-3.0`；完整窗口应用没有通过编译验证                                                                                                |
| `cd spike/intake && npm exec tauri -- info`                                          | 识别独立应用配置和依赖；报告缺少 WebKitGTK 和 rustup                                                                                                  |
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

## 剩余验收及未处理问题

- Windows 和 macOS 的实际构建、四个指定来源浏览器、资源管理器/访达及系统截图尚未测试。没有可报告的大图实测数字。
- 尚未根据实测选择最终浏览器拖入路径；AdditionalObjects 原生接收器也未实现。
- 独立窗口未挂载编辑器的 @dnd-kit 面板/快捷条，正式输入接入时仍须实测拖放冲突。本次不修改正式功能。
- 正式应用的完整 Rust 构建/Clippy 同样受桌面系统库限制，没有声称 CI 全通过。已有 TypeScript、ESLint、i18n 和格式问题记录如上，留给相应任务处理。
- 完成目标平台矩阵、填入原始 JSON 和耗时并确定方案后，才能把阶段 1 标为完成。
