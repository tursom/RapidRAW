# macOS 人工补测交接

**状态：用户已选择由人工补测，当前未执行 macOS 构建或测试。下表中的待测项不代表通过。** 完整设计、已有 Windows 结论和原始记录索引见仓库根目录 [SPIKE.md](../../../../SPIKE.md)。阶段 1 的跨平台验收状态保持待补测。

## 准备和启动

将 `spike/phase-1-image-intake` 分支对应的 RapidRAW 仓库复制到 Mac，保留目录结构及 `src-tauri/icons/`。记录来源提交；保留两个锁文件。安装兼容锁文件的 Rust（已有验证环境为 1.99.1）、Node.js（建议 22 或更新版本）、Xcode Command Line Tools，以及 Safari、Chrome。需在已登录的图形桌面中测试。

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

1. 从访达拖入单图、多图、文件夹、文件与文件夹混合选择，另测中日文及含空格的文件名。记录完整路径、文件列表和目录标记。RAW 素材可用于路径观察，此工具不解码 RAW。
2. 分别从 Safari、Chrome 拖入网页 JPEG 和 PNG。核对收到的是原生路径、可解码 File、仅 URL/HTML，还是无事件。两个启动模式都要测；收到事件不等于取得图片字节或本地路径。
3. 分别在 Safari、Chrome 中使用“复制图像”，再点工具里的“读取系统剪贴板”。每个浏览器的小图和大图各重复 3 次，保存格式列表、尺寸、读取和 PNG 编码耗时。
4. 从访达复制文件、复制网页图像地址、复制系统截图，分别读取。再从文本编辑器复制普通文本及精确字符串 `RapidRAW:adjustments`，核对文件/图片/文本结果及标记匹配。空剪贴板用例也要记录。
5. 在输入框内按 Cmd+V，确认普通粘贴正常；在虚线区域粘贴，观察 HTML paste 记录。系统剪贴板结论以 Rust 按钮结果为准。
6. 遇到无事件，在用例中写明“未收到事件”，点击“记录当前用例/观察”。权限提示、读取错误、窗口无响应等现象原样记录，不填作空剪贴板或成功。
7. 每个启动模式分别导出 JSON。导出后的 `report-saved.path` 指向实际文件，默认在 `~/Library/Application Support/io.github.tursom.rapidraw.intake-spike/results/`。将原始报告放入本目录并回填下表。

读取剪贴板过程中保持内容不变。计时分别记录 `image.value.readMs`、`image.value.png.elapsedMs`、`image.value.png.value.bytes`、`totalMs`、`roundTripMs`；`image.elapsedMs` 包含 PNG 编码。注明 debug/release 以及是否为干净进程首次读取，避免把预热后的首次序列当作冷启动。

## 待填记录

测试人、日期、来源提交：待填。

macOS / 架构 / Rust / Node / Safari / Chrome 版本：待填。

| 来源/用例                         | 原生模式结果 | HTML5 模式结果 | JSON 文件及备注 |
| --------------------------------- | ------------ | -------------- | --------------- |
| 访达单图、多图                    | 未测         | 未测           | 待填            |
| 访达目录、混合选择                | 未测         | 未测           | 待填            |
| 中日文、空格文件名                | 未测         | 未测           | 待填            |
| Safari 网页 JPEG/PNG、小图/大图   | 未测         | 未测           | 待填            |
| Chrome 网页 JPEG/PNG、小图/大图   | 未测         | 未测           | 待填            |
| Safari 复制图像，小图/大图各 3 次 | 未测         | 未测           | 待填            |
| Chrome 复制图像，小图/大图各 3 次 | 未测         | 未测           | 待填            |
| 访达复制文件                      | 未测         | 未测           | 待填            |
| 复制图像地址、系统截图            | 未测         | 未测           | 待填            |
| 普通文本、调整参数标记、空剪贴板  | 未测         | 未测           | 待填            |
| 输入框与测试区域 Cmd+V            | 未测         | 未测           | 待填            |
| 原生 JSON 导出及回读              | 未测         | 未测           | 待填            |

| 来源 / 图片尺寸 | 次数 | 图片读取 ms | PNG 编码 ms / 字节数 | 原生总耗时 ms | 页面往返 ms | JSON 文件 |
| --------------- | ---- | ----------- | -------------------- | ------------- | ----------- | --------- |
| 待填            | 待填 | 待填        | 待填                 | 待填          | 待填        | 待填      |

可另在独立应用的 `src-tauri/` 运行 `cargo check --locked`、`cargo build --locked`、`cargo clippy --locked --all-targets -- -D warnings` 和 `cargo fmt -- --check`，将实际命令、退出码及错误日志写入记录。未运行的检查保留未测。

## 回填和方案结论

提供原始 JSON、环境及构建信息、逐项结果和三次读测数据，再更新根目录 SPIKE.md 的 macOS 矩阵。Windows 的 HTML5 加原生路径桥接不能直接作为 macOS 已验证方案。

本地拖入优先：HTML5 能取得网页字节，但本地路径丢失时，记录路径缺口，继续评估 macOS 原生处理。若结论是浏览器拖入代价过大，按 PLAN.md 第 11 节交由产品负责人决定；不要自行改成第一版只支持粘贴。目标平台记录与方案补齐后，再确认阶段 1 是否达到退出条件。
