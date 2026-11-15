# macOS 输入验证与离线修复

状态：2026-11-15 的本轮真实 Mac 测试已完成，包含 arm64 release 构建、签名和 AppKit／GUI 回归。**旧 HTML5 候选的关窗崩溃已修复；本轮仍有两项地址复制返回 busy，以及 Finder 整批驱动／导出覆盖缺口。** 阶段 1 尚未通过，正式任务 10 不开始。

## 旧版实测

来源客户端为提交 `ab016af8760ceb0477d530135e64f3913889457c` 的 GitHub Actions Apple Silicon 包；环境为 M5、macOS 26.6.2、Safari 26.6.2、Chrome 156.0.8078.80。主机地址是临时连接信息，不是应用配置，不在本说明保存。摘要和原始记录哈希见 [observations.json](observations.json)；大型 payload、完整 GUI 原始报告及进程快照仍私下保留，不随修复公开归档。

| 入口                        | 旧版实测                                                              | 不能扩大解释的部分                                                              |
| --------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Finder Native               | 七项完整路径通过：单图、多图、真实 RAW、目录、混合拖入、JPG/RAW 复制  | 不证明 RAW 解码或目录递归导入                                                   |
| Finder HTML5                | 两项复制路径通过；五项拖入有文件／目录元数据，路径全部为 null         | 收到 File 不等于取得本地 RAW 路径；没有接收端字节哈希比对                       |
| Chrome 复制                 | Native 9 项、HTML5 9 项及两份导出通过；16 张图片来源像素一致          | 两个独立成功批次；生成 HTTP 素材                                                |
| Safari 复制                 | 完整 18 项及两份导出通过，全部图片使用 TIFF 后备                      | PNG/WebP 像素与参考一致；JPEG 跨 Safari 读取一致，但不同于 Pillow JPEG 解码参考 |
| 网页拖入                    | Chrome 八项、Safari 六项都有接收事件                                  | Native 无路径；HTML5 无物理路径；Safari 的 WebP 变为 PNG                        |
| 文本／标记／空剪贴板／Cmd+V | 六项通过，两份导出                                                    | 空剪贴板是显式 AppKit 清空控制                                                  |
| 系统截图                    | 两个模式均为 1080×220，RGBA 相同，两份导出                            | 只截取已知测试窗口区域                                                          |
| 首次直接 PNG 读取           | 大图 12 次：anchor+0/100/500ms 共九次为空；+1500ms 两次成功、一次为空 | anchor 为首次观察到的 changeCount 变化，不是生产者完成信号                      |
| 后续直接 PNG 读取           | 36 次参考均完整稳定，6000×4000                                        | 第一次参考实际在复制调用后 3421.90–3577.05ms 开始；不能证明三秒总期限已验证     |

Finder 复制文件时，图片表示在连续读取中也会改变：JPEG 可由 800×600 变为 1024×1024，NEF 可由 160×120 变为 1024×1024；直接 `public.png` 均不可用。文件路径可用与图片表示可靠是两个独立结论。

## 修复版本轮实测

本轮环境为 Apple M5、macOS 27.2.1、Safari 27.2、Chrome 157.0.8103.51。它与下文旧版的系统和浏览器版本不同，结果分别保留。

本轮构建、冻结输入、结果范围和私下原始记录的哈希索引见 [runtime-validation.json](runtime-validation.json)。中断批次、功能失败和未覆盖范围均未计为通过。

- 原生构建、双 app 的 ad-hoc 签名和严格签名验证已完成。受控 Rust 单元测试为 49 passed／1 ignored；ignored 项作为监督测试的子进程 fixture 使用。此结果不包含真实剪贴板输入。
- 真实 AppKit 控制验证了文件优先、直接 PNG、旧标记和空内容超时。真实 NEF／文件夹列表同时带图片表示时，结果仍为文件列表，图片、文本与格式探测字段为空，worker 已回收；这不证明 RAW 解码或 Finder 拖动。
- 最终候选的 Finder Native 七项全部通过，HTML5 的 JPEG、双图、RAW、目录和混合拖入五项通过。HTML5 已验证可信事件、一次性配对、准确根路径，未观察到本地 File bytes／decode 事件。完整批次为 12 项通过、1 项复制前的驱动错误、1 项未执行；Native 最终导出已核对，HTML5 五项尚未完成最终导出核对。之后两个独立 HTML5 JPEG／RAW 复制子集各自通过，路径准确、图片／文本／格式探测字段为空，六个 worker 回收，两份导出核对完成；补测不能将已中断的完整批次改写为 14 项通过。
- Safari Native 的 PNG／WebP 两项已验证来源像素、CLI 与 GUI 结果一致，worker 均回收，实际使用 TIFF 解码后备。JPEG 样本的 CLI／GUI 彼此一致，但与 Pillow 参考不同；部分重复页面还触发源元素定位歧义，未获得完整批次通过。
- 最终候选的 Chrome 完整 18 项均已执行，无 driver／unsafe 错误：Native／HTML5 各八项图片全部通过，两项复制图片地址均返回 parent-deadline busy、没有 URL 文本，按功能失败保留。16 次图片 CLI 首次调用全部成功，其中六次 21.5 MB／6000×4000 大图各在 worker 内重读五轮后取得直接 PNG；CLI／GUI 编码摘要、尺寸及像素一致，实际像素也匹配来源参考。两份最终导出已核对，40 个 worker 均已回收。GUI 属于 CLI 读取后的 warm-provider 覆盖，不能代替 GUI 首读验证；这批结果不计为 18 项全部通过。
- Safari 网页 JPEG／PNG／WebP 拖入及显式 URL 读取完整三项通过，每项 15 个功能条件及最终导出均通过。三次可信拖入各关联一个 native 和一个 HTML drop，路径为空；实际 File 签名、SHA、800×600 解码及新 URL 响应摘要一致。36 条导出记录与 AX 记录核对完成，仅明确白名单中的毫秒耗时允许并逐项审计最多一 ULP 的序列化差异，其他字段严格相等，原始数值不归一化。旧 PNG smoke 的严格浮点导出误判仍保留为失败，没有回填通过。
- 本轮 Safari 三项均保留 JPEG／PNG／WebP 原格式，没有重现旧系统样本中的 WebP→PNG 转换。URL 读取证明本次显式新响应的字节，不证明 Safari 历史下载响应身份；转换表示、真实网站和认证场景的范围不能据此扩大。
- 旧候选正常关闭 HTML5 自有测试窗口时发生 `SIGSEGV`，堆栈包含 KVO 注销和 WebView 窗口移除。新候选移除 isa 改写后，完成一次精确处理系统恢复提示后的正常关闭，以及 fresh-process 条件下 HTML5 三次、Native 一次正常关闭，真实进程退出码均为 0，未使用 fallback signal。HTML5 的 raw／public class 和布局比较均保持不变，Destroyed 已退役实例记录。
- fresh-process 测试显式传入 `-ApplePersistenceIgnoreState YES`，系统 stderr 确认旧恢复状态不被修改，新状态写入临时目录。它隔离旧崩溃留下的恢复状态，不修改持久偏好或删除状态文件；不能替代普通窗口恢复启动验证。此前恢复提示、启动超时与取证脚本前缀错误分别保留，未计为正常关闭通过。

上述结果均绑定候选 7 的源码与构建记录，不能拼接成阶段验收。Finder 整批导出、两项地址复制、普通恢复启动及其他平台范围仍待收口。完整原始报告和 payload 私下保留。

本轮自建 HTTP 服务、私有 Chrome、临时保活进程和本地 SSH 隧道均已按 PID、启动时间、可执行文件及参数核对后清理；没有遗留 intake app 或私有剪贴板 worker。用户的 Safari、Finder、其他 Chrome 实例及剪贴板未在清理中操作。测试源、客户端、失败记录和原始证据保留，素材页与 manifest 已恢复；清理审计哈希也记录在本轮索引中。

## 修复版的使用方式

继续保留 Native 和 HTML5 两个对照客户端，客户端下载和启动见 [CLIENTS.md](../../CLIENTS.md)。当前 Mac 候选用于排查与复测，尚不能作为已验收客户端分发。

### HTML5 与本地路径

HTML5 Mac 候选在应用自己的精确 Wry 类上安装透明方法包装，并用实例与 generation 记录只启用主 WebView 的观察；未追踪的实例直接调用原实现。候选保留对象 isa、Cocoa KVO 和系统类的方法表，保持 Wry 原始调用及返回值。它从该次 `NSDraggingInfo.draggingPasteboard()` 读取文件 URL，既不读全局剪贴板，也不按 `File.name` 拼接路径。已测单窗口启动与关闭，第二窗口、重载及重建隔离仍待验证。

首版验证严格采用单次采集：

1. 点击“准备一次 Mac 拖入”，等待 `macos-capture-armed`。
2. 只拖入一次；页面同步保存该次 File／items／strings 和 `htmlDropId`。
3. 只有一个原生 drop 和一个 HTML drop 在同一 capture 中完成时，才允许选择原生路径。歧义、过期、取消或旧 ID 均不得复用旧路径。
4. 原生路径可用时，不再为这些本地文件读取 File 字节、图片或 RAW 预览。
5. 下一轮重新准备。该约束是实验关联范围，不是连续生产拖放已经验收。

Mac 的 `File.path` 本身仍可能是 null；修复提供的是独立的原生路径结果，不能修改浏览器平台的 File 属性。`macos-native-drag` 的诊断记录也不能单独代替配对成功。

### 浏览器转换表示与来源 URL

收到的 File 按实际签名、长度和 SHA-256 记录，不能因为 URL 或文件名以 `.webp` 结尾就称为 WebP。已被浏览器转换成 PNG 的字节无法无损“还原原 WebP”。

已交付的网页 File 与可重新请求的 URL 分开处理：`blob:`、`data:`、相对图片来源或多个图片来源仍可检查收到的 File，不能因此猜测本地路径，也不会请求这些来源地址。没有网页来源证据的 Mac 未配对本地 File 继续只记录元数据。WebView 不提供 `SubtleCrypto` 时，已判定为网页图片的编码字节通过有大小上限的二进制 IPC 计算 SHA-256；本地 RAW／目录仍不读取，导出记录只包含摘要。

页面有唯一 HTTP(S) 来源候选时，可显式点击“读取原始图片 URL”。这会发出一次新的网络请求：只接受 HTTP(S)，不带浏览器 cookie／认证，限制请求时长、重定向、128 MiB 编码体积和 64M 像素，完整解码后保留响应原字节摘要，不重新编码。带认证的私有站点可能失败，不能绕过登录。

结果标记为 `explicit-url-request`；它证明这次来源 URL 响应的格式和字节，**不自动证明等于浏览器之前下载或拖放的原件**。只有可对照的摘要相等时，才记录响应与收到的 File 字节相同。新请求结果摘要中的 URL 隐去 query，实际请求仍使用原 query；HTML/URI 原始诊断字符串仍可能包含站点参数。默认拖入不会自动下载。

URL 按钮等同一轮 File 摘要结束后才启用。比较记录保存独立快照，不会随另一张图片的异步完成而改变；有未能读取的表示且没有匹配摘要时，结果保留 `null`，不把不完整样本定为不相同。

### 剪贴板

正常 GUI 读取由同一可执行文件的无窗口 worker 执行：文件列表成功且非空立即选择 `files`，不再探测可能是图标或缩略图的图片表示。图片依次尝试直接 PNG 和后备；格式列表不作完成信号，count 在读取期间变化时丢弃该轮，固定 count 下的 nil 仍会重试完整读取。

主进程持有单读取许可、焦点保护和整体期限，原生调用卡住时终止并回收 worker，不用丢弃线程来冒充取消。500ms 焦点保护、保护结束后的三秒预算和 200ms 重读间隔仍为暂定参数，不能称作 Mac 已验证阈值。持续 nil 或旧文本／标记来源无法确认时保留 unresolved/busy，不把它当作“已确认空”，更不套用调整参数。独立工具本身不实施调整参数粘贴或正式导入。

## 本机离线回归

从仓库根目录运行：

```sh
npm --prefix spike/intake ci
npm --prefix spike/intake run check
npm --prefix spike/intake test
cargo test --locked --no-default-features --features original-images --manifest-path spike/intake/src-tauri/Cargo.toml
cargo clippy --locked --no-default-features --features original-images --manifest-path spike/intake/src-tauri/Cargo.toml --all-targets -- -D warnings
```

可另外提供本机 Chromium 路径运行真实生产 HTML/JS、模拟 Tauri host 的浏览器回归：

```sh
INTAKE_CHROMIUM=/path/to/chrome npm --prefix spike/intake run test:browser
```

该浏览器回归明确使用 host mock，不是 Mac/WKWebView。它覆盖路径优先不读 RAW 字节、过期／歧义／合成事件不配路径、来源 HTML 解析不自动请求、无可请求 URL 的网页图片、异步摘要完整性、无 Web Crypto 后备、显式 URL 读取和 busy 后按钮恢复。Rust 回归包含真实子进程阻塞的终止与回收、父进程退出后的 worker 自限时，以及 loopback HTTP 原字节、协议和大小限制。

离线阶段的实际命令、退出码、范围和输入 SHA 记录在 [offline-validation.json](offline-validation.json)，保留其原始源码快照含义。Linux 上使用匹配的官方 Rust compiler／Apple target 标准库完成了 `aarch64-apple-darwin` 的库及 desktop 类型检查；该交叉检查没有链接、打包或运行 Mac app，也不启用 `original-images` 网络 feature。HTTP 模块由 Linux 回归检查。后续 Mac 原生构建与运行结果见上方复测进度，不能与离线检查或旧版客户端实测相互替代。

## 最终候选待验矩阵

- HTML5 实例桥接的第二窗口、重建／重载隔离和普通窗口恢复启动；已测构建、签名与单窗口关闭的范围见上方进度。
- Finder 完整 14 项单批收口及 HTML5 五项拖入的最终导出复核；已测五类拖入、真实 RAW、Unicode／空格、路径优先和独立复制子集的范围见上方结果。
- Chrome 新源码网页拖入、更多 Safari 转换表示与真实网站；取消、连续拖入、第二次拖入、内部拖动及页面重载不误配旧路径。
- 源站变化、认证失败及不支持格式的真实场景；已测生成 HTTP 素材的显式新 URL 响应，不能扩展为历史浏览器响应身份验证。
- 最终 Rust worker 的 GUI cold-provider 首读、系统截图、旧标记后立即复制新图和更多延迟样本；保留保护、每轮 count、hard deadline 与 kill/reap 时间记录。本轮 Chrome 图片首个 CLI 调用和随后 GUI warm-provider 通过，不代表这些余项已通过。
- 延迟提供者阻塞在首读与后续读时都必须可回收；重复超时和同时请求不积累进程、线程或永久 busy。
- Apple Silicon／Intel 及移动 `.app` 后的 self-worker 路径、无第二窗口／抢焦点行为；Windows 客户端回归。

已完成的局部控制见上方进度；其余矩阵以及最终候选的完整回归仍未通过。Mac 输入方案、正式 Rust 集成时限和完整编辑器 Retina/DPR2 基线仍未整体定案，任务 10 继续等待。
