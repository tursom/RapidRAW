# macOS 人工补测交接

**状态：用户已选择由人工补测，当前未执行 macOS 构建或测试。下表中的待测项不代表通过。** 完整设计、已有 Windows 结论和原始记录索引见仓库根目录 [SPIKE.md](../../../../SPIKE.md)。阶段 1 的跨平台验收状态保持待补测。

## 准备和启动

从 `main` 取得包含 `spike/intake/` 验证包的 RapidRAW 仓库并复制到 Mac，保留目录结构及 `src-tauri/icons/`。记录来源提交；保留两个锁文件。安装兼容锁文件的 Rust（已有验证环境为 1.99.1）、Node.js（建议 22 或更新版本）、Xcode Command Line Tools，以及 Safari、Chrome。需在已登录的图形桌面中测试。

记录 macOS、CPU 架构、Rust、Node、Safari 和 Chrome 版本。可在仓库根目录执行以下命令采集环境信息；浏览器版本从各自“关于”菜单读取：

```sh
sw_vers
uname -m
rustc --version
cargo --version
node --version
git rev-parse HEAD
xcode-select -p
```

从仓库根目录启动原生模式：

```sh
cd spike/intake
npm ci
npm run native
```

确认环境行出现 `os=macos`、`nativeDragDrop=true`，且剪贴板按钮已可用。完成该模式并导出 JSON 后，关闭窗口、结束运行，再启动 HTML5 对照模式：

```sh
npm run html5
```

此时应为 `nativeDragDrop=false`。macOS 不使用 Windows 的 AdditionalObjects 接收器，复选框保持不勾选；本次要测的是 WKWebView 的实际行为。

## 实际操作

每次操作前填写页面的来源、浏览器版本、用例和素材信息。使用本地图片和网页 JPEG/PNG，至少含小图及一张 6000×4000 或更大的图片；记录实际尺寸和来源 URL。

1. 从访达拖入单图、纯多图、文件夹、文件与文件夹混合选择，另测中日文及含空格的文件名。必须增加一个真实相机 RAW（记录相机型号、扩展名、字节数；不能用改名的占位文件）。记录完整路径、文件列表和目录标记；此工具不解码 RAW，RAW 验收看路径是否完整可用。
2. 分别从 Safari、Chrome 拖入网页 JPEG、PNG、WebP，至少增加一张真实网站的 WebP，记录页面和图片 URL、实际 MIME 和尺寸。核对收到的是原生路径、可解码 File、仅 URL/HTML，还是无事件。两个启动模式都要测；收到事件不等于取得图片字节或本地路径。
3. 分别在 Safari、Chrome 中使用“复制图像”，再点工具里的“读取系统剪贴板”。每个浏览器的小图和大图各重复 3 次，保存格式列表、尺寸、读取和 PNG 编码耗时。
4. 从访达复制文件、复制网页图像地址、复制系统截图，分别读取。再从文本编辑器复制普通文本及精确字符串 `RapidRAW:adjustments`，核对文件/图片/文本结果及标记匹配。空剪贴板用例也要记录。
5. 在输入框内按 Cmd+V，确认普通粘贴正常；在虚线区域粘贴，观察 HTML paste 记录。系统剪贴板结论以 Rust 按钮结果为准。
6. 遇到无事件，在用例中写明“未收到事件”，点击“记录当前用例/观察”。权限提示、读取错误、窗口无响应等现象原样记录，不填作空剪贴板或成功。
7. 每个启动模式分别导出 JSON。导出后的 `report-saved.path` 指向实际文件，默认在 `~/Library/Application Support/io.github.tursom.rapidraw.intake-spike/results/`。将原始报告放入本目录并回填下表。

读取剪贴板过程中保持内容不变。计时分别记录 `image.value.readMs`、`image.value.png.elapsedMs`、`image.value.png.value.bytes`、`totalMs`、`roundTripMs`；`image.elapsedMs` 包含 PNG 编码。注明 debug/release 以及是否为干净进程首次读取，避免把预热后的首次序列当作冷启动。

新增的图片模式可选择 `compare`、`prefer-png`、`reencode`。Mac 原始 PNG 使用 `get_buffer("public.png")`，当前仅经过源码核对，必须在 Mac 实测。比较时记录 `rawPng.value.readMs/decodeMs/bytes/sha256/rgba8Sha256` 和 `sameRgba8`；`compare.totalMs` 包含两条路径，不能当作 PNG 优先的实际耗时。优先用 release 重测性能，可在 `src-tauri/` 运行 `cargo run --locked --release --no-default-features --example clipboard -- prefer-png` 和 `-- reencode`；CLI 没有页面往返数据。若 PNG 缺失，补测系统 TIFF 后备来源；损坏 PNG 可能让库直接报错而不继续走 TIFF，须原样记录。

## 待填记录

新增阶段 1 第 5 项仍须在 Mac 单独补测：复制大图后跳过格式、文件和文本探测，直接 `get_buffer("public.png")`，分别记录从复制触发与首次 `NSPasteboard.changeCount` 变化开始的等待间隔、错误、内容何时稳定，以及完整解码结果。当前窗口按钮的格式/文件前置探测会掩盖等待，不能代替这一项；Windows 的 `clipboard_contention` 探针使用 Win32，不能用于 Mac。3 秒总时限、焦点后 500ms 保护均为暂定，200ms 只是完整重读前的间隔，不是完成信号；它们不代表已在 Mac 验证。真实截图和 Safari TIFF 来源仍需优先补测。

Windows 已发现系统剪贴板服务和其他常驻程序在序列号稳定时仍打开剪贴板。Mac 补测须保存复制来源、测试应用及已启用剪贴板工具的**进程名、PID、启动时间**，同时记录每个操作的 UTC 时间和用例名。测试前后分别执行 `date -u` 和 `ps -axo pid=,ppid=,lstart=,comm=` 保存快照（不采集含参数的命令行）；在来源应用退出前立即补存快照，避免事后 PID 复用导致误认。此命令记录运行程序，不证明它们访问了 NSPasteboard；若用平台诊断观察到具体访问，再关联当时进程身份。Windows 的打开窗口 API 没有在 Mac 实现对应观测，不能将进程列表或 `changeCount` 当作访问者身份；无法归属的占用和来源明确记为未知，不猜测浏览器或常驻工具。

测试人、日期、来源提交：待填。

macOS / 架构 / Rust / Node / Safari / Chrome 版本：待填。

| 来源/用例                                    | 原生模式结果 | HTML5 模式结果 | JSON 文件及备注    |
| -------------------------------------------- | ------------ | -------------- | ------------------ |
| 访达单图、多图                               | 未测         | 未测           | 待填               |
| 访达真实 RAW                                 | 未测         | 未测           | 待填               |
| 访达目录、混合选择                           | 未测         | 未测           | 待填               |
| 中日文、空格文件名                           | 未测         | 未测           | 待填               |
| Safari 网页 JPEG/PNG、小图/大图              | 未测         | 未测           | 待填               |
| Chrome 网页 JPEG/PNG、小图/大图              | 未测         | 未测           | 待填               |
| Safari/Chrome 真实网站 WebP                  | 未测         | 未测           | 待填               |
| Safari 复制图像，小图/大图各 3 次            | 未测         | 未测           | 待填               |
| Chrome 复制图像，小图/大图各 3 次            | 未测         | 未测           | 待填               |
| 访达复制文件                                 | 未测         | 未测           | 待填               |
| 复制图像地址、系统截图                       | 未测         | 未测           | 待填               |
| 普通文本、调整参数标记、空剪贴板             | 未测         | 未测           | 待填               |
| 输入框与测试区域 Cmd+V                       | 未测         | 未测           | 待填               |
| 原生 JSON 导出及回读                         | 未测         | 未测           | 待填               |
| 第 5 项：大图直接读取与 changeCount 稳定时序 | 未测         | 未测           | 待填，须无前置探测 |

| 来源 / 图片尺寸 | 次数 | 图片读取 ms | PNG 编码 ms / 字节数 | 原生总耗时 ms | 页面往返 ms | JSON 文件 |
| --------------- | ---- | ----------- | -------------------- | ------------- | ----------- | --------- |
| 待填            | 待填 | 待填        | 待填                 | 待填          | 待填        | 待填      |

可另在独立应用的 `src-tauri/` 运行 `cargo check --locked`、`cargo build --locked`、`cargo clippy --locked --all-targets -- -D warnings` 和 `cargo fmt -- --check`，将实际命令、退出码及错误日志写入记录。未运行的检查保留未测。

## 回填和方案结论

提供原始 JSON、环境及构建信息、逐项结果和三次读测数据，再更新根目录 SPIKE.md 的 macOS 矩阵。Windows 的 HTML5 加原生路径桥接不能直接作为 macOS 已验证方案。

本地拖入优先：HTML5 能取得网页字节，但本地路径丢失时，记录路径缺口，继续评估 macOS 原生处理。若结论是浏览器拖入代价过大，按 PLAN.md 第 11 节交由产品负责人决定；不要自行改成第一版只支持粘贴。目标平台记录与方案补齐后，再确认阶段 1 是否达到退出条件。
