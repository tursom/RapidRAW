# Windows release：原始 PNG 与重编码对照

本轮只补剪贴板方案和 release 性能证据，**不代表阶段 1 验收通过**。资源管理器 UI、真实 RAW、纯多图拖入、系统截图、复制图片地址、真实网站拖放和全部 macOS 验证仍待补。

## 环境和构建

2026-11-06，`pc.lan`，Windows 10 x64 10.0.19045，桌面 Session 1；AMD Ryzen 7 5800X3D，8 核 16 线程，高性能电源方案。Rust/Cargo 1.99.1，Tauri 2.12.1、clipboard-rs 0.3.5、image 0.25.10。Chrome 本轮已更新到 **157.0.8103.38**，Edge/WebView2 仍为 156.0.4314.58；因此不能把旧 Chrome debug 与本轮 release 当作完全相同浏览器环境的严格对照。

在 `E:\projects\tbt\rapidraw-intake-spike\spike\intake\src-tauri`，项目专用 `CARGO_HOME=E:\projects\tbt\rapidraw-intake-spike\cargo-home`，实际执行：

```powershell
cargo build --locked --offline --release --no-default-features --example clipboard
cargo test --locked --offline --no-default-features --lib
$env:TAURI_CONFIG = Get-Content tauri.html5.conf.json -Raw
cargo build --locked --offline --release
Remove-Item Env:\TAURI_CONFIG
```

构建及 3 个单元测试成功。产物复制为 `artifacts\clipboard-release.exe` 和 `artifacts\intake-html5-release.exe`，原来的 debug `intake-native.exe`、`intake-html5.exe`、`clipboard.exe` 保留。每条实际读取结果都报告 `profile=release`、`optLevel=3`、`debugAssertions=false`。CLI 与窗口分别完成构建后才开始对应的性能测试；没有同时编译和测量浏览器性能。

[environment.json](environment.json) 保存 CPU、系统、Rust、源文件和产物 SHA-256；[build-records/](build-records/) 保存构建、测试日志与退出码，日志从 PowerShell UTF-16 转为 UTF-8 文本。基于 `a50e3dc6` 加本次 PNG 探针改动，源文件摘要用于核对实际构建输入。`index.html` 构建输入与提交文件的哈希不同；此前记录称差异来自构建后格式化，但没有保存该构建输入的文件快照，现有入库证据不足以独立复核“仅空白”的说法。其余已核对的源码和产物摘要保留。

## 素材、操作和计时边界

[驱动](../../../scripts/windows-clipboard-release.py) 只操作独立浏览器 profile，通过真实右键菜单选择 Chrome“复制图片”、Edge“复制图像”。图片由 `http://127.0.0.1:8767/clipboard-release.html` 提供，**不是远程真实网站覆盖**。前 3 个素材每个浏览器、每种独立模式各读 3 次，第二轮交换模式顺序，每次读测前重新复制；另各做一次 `compare`。两个额外格式每浏览器各测三种模式一次，共 **54 个浏览器样本**。

- `small.jpg`：旧生成素材，1024×768、14,735 字节。
- `large.jpg`：旧固定种子高熵生成 JPEG，6000×4000、23,288,788 字节，用于与旧记录对应。
- `photo-control.jpg`：仓库 `public/splash-light.jpg` 的 2048×2048 照片经 Pillow LANCZOS 裁切放大到 6000×4000，JPEG quality92；是自然纹理对照，**不是原生 24MP 相机照片**。原图及生成结果摘要见 JSON。
- `transparent.png`：1024×768、含透明度的生成 PNG。
- `photo-control.webp`：仓库照片转换的 2048×2048 WebP，quality85。

每次 CLI 为新进程；这不等于浏览器/系统冷启动。每张素材在计时前计算来源浏览器 canvas 和源文件 Pillow 的 RGBA8 摘要，会预热来源解码。驱动要求实际复制改变序列号、结果尺寸匹配素材，且像素摘要匹配这两个来源基准之一；部分素材的 canvas 与文件解码值并不完全相同，不能将 canvas 当作唯一基准。`processWallMs` 额外含进程启动/退出，不能当页面往返。首个模式仍可能承担浏览器首次供数成本：高熵图 PNG 直读三次，Chrome 为 **126.29 / 21.73 / 21.41 ms**，Edge 为 **129.58 / 32.00 / 21.53 ms**。

`get_buffer("PNG")` 不依赖格式枚举，原始 PNG 要求签名正确并能完整解码。`rawPng.value.readMs` 仅计系统供数、分配和复制；`decodeMs`、规范化 RGBA8 摘要及字节摘要分别计时。`prefer-png.totalMs` 包含这些完整诊断和其他格式探测；`reencode.totalMs` 也含诊断摘要和文件/文本探测。`compare` 顺序运行两条路径，总时间不能当作任一条路径的延迟。

## release CLI 结果

下面为各 3 次的中位数，单位 ms；完整单次记录在 [results.json](results.json)。

| 来源 / 素材            | 原始 PNG 读取 | 原始 PNG 解码验证 | 旧 get_image（含解码） | 旧 to_png 编码 | PNG 优先诊断总计 | 旧路径诊断总计 |
| ---------------------- | ------------: | ----------------: | ---------------------: | -------------: | ---------------: | -------------: |
| Chrome / 小 JPEG       |          0.05 |              0.85 |                   0.83 |           1.30 |             3.87 |           5.41 |
| Chrome / 高熵大 JPEG   |         21.73 |            176.54 |                 204.11 |         336.99 |           621.28 |         918.35 |
| Chrome / 放大照片 JPEG |          9.76 |            204.78 |                 215.97 |         235.13 |           577.61 |         771.84 |
| Edge / 小 JPEG         |          0.06 |              0.76 |                   0.87 |           1.25 |             3.73 |           5.15 |
| Edge / 高熵大 JPEG     |         32.00 |            181.44 |                 194.35 |         350.82 |           622.41 |         939.04 |
| Edge / 放大照片 JPEG   |         10.86 |            201.37 |                 215.52 |         239.16 |           612.61 |         789.05 |

两个浏览器的输出大小一致：

| 剪贴板图片来源 | 原始 PNG 字节 | 旧重编码 PNG 字节 |
| -------------- | ------------: | ----------------: |
| 小 JPEG        |        26,327 |            25,859 |
| 高熵大 JPEG    |    72,171,482 |        96,011,388 |
| 放大照片 JPEG  |    32,632,178 |        39,329,898 |
| 透明 PNG       |        18,558 |            17,018 |
| 照片 WebP      |     8,697,412 |        10,705,720 |

高熵图直取可省 23,839,906 字节（约 24.8%），但浏览器提供的 PNG 仍约为源 JPEG 的 3.1 倍。自然纹理素材膨胀更多：放大照片 JPEG 从 **4,973,219** 到 **32,632,178** 字节（**6.56 倍**）；照片 WebP 从 **1,228,342** 到 **8,697,412** 字节（**7.08 倍**）。两张大 JPEG 直读相比重编码省约 17–25%。**不能声称直读总会更小**：小 JPEG 和透明 PNG 的原始 PNG 都略大于重编码结果。此方案的直接收益是保存浏览器提供的 PNG、避免再次编码和按稳定字节去重；不会保留源 JPEG/WebP 压缩字节，也没有解决正式 `imported/` 的累计占用问题。该代价应向产品负责人说明，用户已在计划中要求设置提示。

54 个样本均核对执行模式和图片来源。实际包含 Rust 原始 PNG 读取及其 SHA-256 与独立 Win32 缓冲区比对的是 **32 个**（22 个 `prefer-png`、10 个 `compare`）；其余 **22 个 `reencode`** 不取原始 PNG，只核对旧路径的尺寸、像素和输出摘要。32 个原始 PNG 字节摘要均一致；`compare` 两条路径均成功且 `sameRgba8=true`。54 个样本的规范化 RGBA8 摘要和尺寸均与 Pillow 和来源基准一致。独立读取在计时之后进行，同一剪贴板 3 次参考缓冲区的完整字节相等，Rust 结束与参考读取之间序列号不变。摘要不代表 ICC、元数据或 16 位精度完全保真。

本轮 `prefer-png` 也先调用 `available_formats()` 和 `get_files()`，所以并非“复制后立即只取 PNG”。所有 6000×4000 样本（CLI 28/28、窗口 12/12）枚举为空且耗时约 155ms，其他尺寸 0/32 为空。库吞掉了打开失败；前置探测可能掩盖占用，不能用本轮成功结果判断立即读取可靠。第 5 项另用无前置探测的独立进程和显式打开对照补测。

## 实际 release Tauri 窗口

[窗口驱动](../../../scripts/windows-clipboard-release-ui.py) 启动 `intake-html5-release.exe`，实际页面按钮调用 Rust 后台命令，记录 `roundTripMs` 并完成原生报告保存；没有 mock Tauri IPC。Chrome 真实复制同一批前 3 个素材，每种模式各 3 次，共 **18 个样本**：9 个 PNG 优先样本核对 Rust 原始 PNG 字节，另外 9 个只测重编码路径；18 个均核对尺寸和来源像素。见 [ui-results.json](ui-results.json)。

| 素材          | PNG 优先页面往返 ms（3 次） | 旧重编码页面往返 ms（3 次） |
| ------------- | --------------------------- | --------------------------- |
| 小 JPEG       | 6.3 / 5.3 / 6.7             | 6.5 / 7.1 / 6.6             |
| 高熵大 JPEG   | 759.3 / 590.1 / 644.8       | 920.4 / 923.4 / 916.5       |
| 放大照片 JPEG | 641.1 / 572.3 / 591.2       | 783.5 / 785.4 / 780.2       |

这些数值包含完整 PNG 解码验证和摘要，返回的只有诊断信息。尚未测正式导入写盘、缓存清理、完整像素 IPC 或编辑器解码/渲染。旧 debug 的约 18 秒仅保留为历史实验数据，不能当作产品粘贴耗时或 release 结论。

## 后备路径与异常输入

另有 7 个 Win32 生成用例，见 `results.json` 的 `generated=true`：

| 用例                                     | 观察结果                                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 无 PNG，只有 DIBV5 BI_RGB                | PNG 直读失败，旧路径成功返回 2×1 图并编码 PNG                                                                                            |
| DIBV5 BI_BITFIELDS，掩码位于 V5 头内     | Pillow 可解码、Rust 报 `failed to fill whole buffer`；素材缺少库按微软文档预期的额外 12 字节，布局需核实，不能据此认定真实截图或库不兼容 |
| 截断 PNG                                 | 完整解码失败，旧路径也失败，没有成功图片                                                                                                 |
| PNG 格式名下放 JPEG 字节                 | 原始 PNG 签名检查拒绝；旧 get_image 自动识别有效 JPEG，成功解码重编码。没有把 JPEG 原样当 PNG 保存                                       |
| 损坏 PNG + 已单独证明可读的 DIBV5 BI_RGB | 原始 PNG 拒绝；库优先处理存在的 PNG 并报错，没有继续尝试 DIB。仍是待处理边界                                                             |
| 调整参数标记、空剪贴板                   | 无成功图片；标记文本匹配，读取错误原样记录                                                                                               |

DIB 布局问题须在正式后备方案前继续确认。当前 image 0.25.10 的 BMP `new_without_file_header` 注释援引微软文档，对 V5 `BI_BITFIELDS` 在头部后再跳过 12 字节；132 字节生成样本只有 V5 头与 8 字节像素，可能不符合该布局。此前将这一结果定为“兼容性缺口”证据不足，现予撤回；原始 JSON 的旧解释保留为历史记录，不代表当前结论。优先用真实系统截图验证后备路径，本轮不改依赖；生成位图不等于真实截图。

`passed=true` 仅表示上述驱动断言和明确预期的异常行为得到验证，**不代表所有来源均兼容，也不代表阶段 1 通过**。

## 复现与失败记录

先完成构建并复制上述两个产物，在已登录 Windows 图形桌面（不能用 SSH Session 0）执行：

```powershell
cd E:\projects\tbt\rapidraw-intake-spike
.\venv\Scripts\python.exe -u .\spike\intake\scripts\windows-clipboard-release.py
.\venv\Scripts\python.exe -u .\spike\intake\scripts\windows-clipboard-release-ui.py
```

venv 依赖 Pillow 13.0.0、pywinauto 0.6.9、pywin32 312、websocket-client 1.9.2。驱动需要保留原来的 `fixtures/small.jpg`、`large.jpg` 和仓库照片；结果写入该 Windows 工作目录的 `evidence/clipboard-release/`。每个驱动结束后关闭自己的浏览器/窗口和 HTTP 服务，不关闭用户浏览器。

最终 CLI 数据来自增加模式、来源素材和完成状态断言后的完整序列（22:07:06–22:09:09）；54 个浏览器样本和 7 个生成用例在同轮完成。`--generated-only` 必须检查浏览器完成标志和完整的 54 个唯一用例，不能将中途失败的浏览器序列改成通过。窗口最终序列另存 `ui-results.json`。按任务 7 决定，以下失败或被替代的原始 JSON 已从当前版本删除，可从 Git 提交 `3b5df34f` 的本目录追溯；保留失败教训，没有将驱动失败当成兼容性失败：

- `attempt1.json`：29 个已完成样本后 Edge 菜单定位失败。
- `attempt2.json`：独立参考读取 `OpenClipboard` 短暂被占用，未完成；随后参考读取增加了有界重试。
- `attempt3.json`：54 个浏览器样本完成，随后原先假定所有 DIBV5 都成功的断言失败；后续区分 BI_RGB 与 BI_BITFIELDS。
- `generated-attempt2.json`：保存 DIB 诊断，以及原先假定错标 JPEG 必须完全拒绝的断言失败；最终明确为原始 PNG 拒绝、旧解码路径接受有效 JPEG。
- `ui-attempt1.json`：CDP 过早连接空白初始化页，尚无按钮；修正就绪判断后重跑 18 组成功。
- `before-source-validation.json`、`ui-before-source-validation.json`：第一轮 release 记录尚未在驱动内加入严格的模式与素材绑定断言；仅在 Git 历史中作对照，不与最终序列混合统计。
- `source-attempt1.json`：仅用 canvas 像素摘要作来源基准，首张小图不匹配而停止；最终同时记录源文件 Pillow 解码基准，结果须匹配至少一个基准，并检查尺寸、复制序列和实际执行模式。

这些旧尝试中的数据不与最终序列混合求中位数。保留的最终 JSON 未因本次清理改变字段或值。

测试结束后的 [cleanup.json](cleanup.json) 确认本轮计划任务与专用进程剩余均为 0，旧 debug 与新 release 产物均保留。

后续 [第 5 项占用实测](../contention/README.md) 已跳过前置探测，明确复现早读的占用失败，并区分复制尚未发布时旧标记仍可读的阶段。这里保留的 release 耗时数据不能当作“复制后立即读取总能成功”的证据。
