# 独立修复：主窗口尺寸持久化

这是用户确认后单独处理的窗口修复，独立于任务 2 和任务 10。任务 1 的性能数字及阶段 1 的输入验收结论不因本任务改变。

主窗口原来保存 `outer_size()`，却通过接受内容区尺寸的 `set_size(PhysicalSize)` 恢复。预览窗口的对应代码保存 `inner_size()`。修复将主窗口的保存与恢复统一为物理像素内容区尺寸；位置仍使用外框坐标。没有改变状态 JSON 格式，也不猜测并缩减已有尺寸；如果窗口此前已变大，用户仍可手动缩回需要的大小。

实机也确认了第二个因素：仅改为 `inner_size()` 保存后，宽度稳定，高度仍每次增加 31px。Tao 0.37.1 的 Windows 无边框阴影尺寸计算使用当时的外框/内容区差值，显示时还会重算非客户区。最终补丁在 Windows 首次显示后复核内容区尺寸，必要时按启动目标校正，再恢复最大化/全屏。目标来自 setup 的一次性内存快照，不重新读取可能已被后台保存器更新的文件。前端就绪和四秒兜底共用主线程上的显示逻辑；快照只消费一次，迟到回调不会重置用户随后改变的大小。

正式代码修改限于桌面主窗口的尺寸恢复和保存路径。Android 不执行该桌面代码块，预览窗口代码不变。

## 验证方法

`verify-windows.py` 复用基线 CDP 连接驱动，只控制新启动的这个 fork。测试开始前拒绝已有的 RapidRAW TBT 窗口；测试结束恢复本 fork 的窗口状态和设置原字节。脚本不选择或编辑图片，应用本身仍执行正常启动流程；不触碰官方版配置。

运行前构建 release 程序，保留修复前后的独立可执行文件和 SHA-256。在已登录的 Windows Interactive 会话运行，要求 Python、`pywin32` 和 `websocket-client`：

```powershell
python checks\window-size\verify-windows.py `
  --driver baseline\scripts\windows-cdp.py `
  --original E:\path\original\RapidRAW.exe `
  --fixed E:\path\fixed\RapidRAW.exe `
  --workspace E:\projects\tbt\rapidraw-window-size
```

两个可执行文件均须可在各自目录正常加载运行时资源。不要用 SSH 的 Session 0 直接运行 GUI。脚本不覆盖现有 `evidence/verification.json`；失败尝试留在 Windows 工作目录，只有完整成功的最终证据可以入库。

每个用例三次真实启动，后两次必须读到前次关闭后的状态，不在中途重置：

1. 原程序控制：重现窗口增长。
2. 修复程序，无边框窗口。
3. 修复程序，有系统边框窗口。
4. 修复程序，无效旧尺寸被拒绝，使用默认尺寸后连续启动。
5. 修复程序，首次由原生窗口操作改变尺寸后重启，并重复调用前端就绪。
6. 修复程序，首次最大化、重启恢复最大化、还原后再次启动。
7. 修复程序，首次全屏、重启恢复全屏、退出全屏后再次启动。
8. 修复程序，在真实前端 IPC 入口暂存 `frontend_ready` 请求，窗口须靠四秒兜底显示；显示后先改变窗口尺寸，再放行原请求，确认不被重置，随后再启动两次。

记录原生外框、客户区、CSS 视口、DPR、窗口标志、读取和保存的状态；每次操作后等待两秒让现有 500ms 保存循环落盘。除预期的旧程序控制外，必须确认保存值等于正常客户区尺寸、重启无增长、手动尺寸保持及最大化状态正确。窗口操作由自动化发出，不能代替人眼视觉确认。

第八组必须在窗口尚不可见时建立拦截，至少一个就绪请求仍在等待、尚未放行，且窗口可见时间不早于 3.9 秒；不满足就判控制失败。原请求只在原生缩放后放行，随后重新量尺寸。没有给正式应用添加测试接口或改变其计时器。

旧程序控制显式使用 689px 历史种子；修复程序使用 720px。普通无边框组还验证当前基线驱动的默认种子。原 v3 性能输入和数据固定于 `9588e26c`；当前驱动用 720px 默认值，旧程序复现通过 `RAPIDRAW_BASELINE_SEED_HEIGHT=689` 保留原口径。没有重跑或改写性能数字。

## 平台范围

Windows release 和真机回归结果如下。macOS、Linux、多显示器或不同 DPI 的运行验收不能从本次 Windows 结果推断；没有把未运行的平台写成通过。阶段 1 的人工输入补测仍需单独完成，任务 10 继续禁止。

## Windows 最终实测

在 `pc.lan` 的 Windows 10、已登录 Session 1、DPR 1 上，最终验证运行于 **2026-11-07 21:35:09–21:36:55，UTC+08:00**。八组各三次，共 24 次启动（旧版对照 3 次、修复版 21 次）全部符合各自预期。

| 用例                 | 三轮内容区表现                                          | 结果                     |
| -------------------- | ------------------------------------------------------- | ------------------------ |
| 旧版对照             | 1280×720 → 1296×759 → 1312×798                          | 重现每轮 +16×39px        |
| 修复版，无边框       | 1280×720 → 1280×720 → 1280×720                          | 通过，驱动默认种子也正确 |
| 修复版，有系统边框   | 1280×720 → 1280×720 → 1280×720                          | 通过                     |
| 无效旧状态           | 1×1 被拒绝，三轮均为默认 1280×720                       | 通过                     |
| 用户缩放及重复 ready | 首轮改为 1144×752；重复 ready 和后两轮均保持            | 通过                     |
| 最大化及还原         | 重启为 2560×1440 最大化；还原及第三轮均为 1280×720      | 通过                     |
| 全屏及退出           | 重启为 2560×1440 全屏；退出及第三轮均为 1280×720        | 通过                     |
| 四秒兜底及迟到 ready | 首显为 1280×720，改为 1144×752 后放行 ready，后两轮保持 | 通过                     |

兜底组首次显示上限为进程启动后 **5124.4ms**，包括初始化和轮询，不把它解释为定时器本身的时长。显示时确有一个 ready 请求被扣住（pending=1、released=0）；缩放后释放同一个请求（pending=0、released=1），客户区仍为 1144×752。原请求、原 Promise 和其他 IPC 均正常转发。

实际执行的检查：

- Windows `npm run tauri -- build --no-bundle` 退出 0，使用原锁文件、Rust 1.98 工具链及原 release 配置（LTO、单 codegen unit、strip）。没有更换依赖。
- Windows `cargo fmt -- --check` 退出 0。
- Windows `cargo clippy --release --all-targets --locked --features tauri/custom-protocol -- -D warnings` 退出 0。未运行 `--all-features`。
- 最终 GUI 验证退出 0；原状态和设置字节恢复检查通过，基线旧 exe/源码恢复，测试任务及应用剩余均为 0。
- 本地 Python 语法、Rust 格式、改动 Markdown/JSON 格式及 `git diff --check` 通过。使用实际 Tauri 2.12.1 core/protocol/ipc 脚本的 Node 控制，确认暂存、其他 IPC 透传、放行原 Promise、只读接口保持，以及不可写 fetch 拒绝安装。只读代码复审通过。

构建以 `9588e26c` 为源代码基底，修改后的 `lib.rs` SHA-256 为 `c8798a1f52847c9734a4b6780eb49c686cfa9cc21ba4d484fd010fd48f59fb85`。最终 exe SHA-256 为 `2692a2ebfff4f23d2afd446db89b68651f8708d419823f364d1531efe39ae9e6`。测试程序留在 Windows 的 `E:\projects\tbt\rapidraw-baseline\app\src-tauri\target\release\RapidRAW-window-size.exe`，原基线 exe 未替换。

[构建记录](evidence/windows/build.json)、[运行退出码](evidence/windows/run-result.json)、[完整验证](evidence/windows/verification.json)、[清理记录](evidence/windows/cleanup.json)及[构建/检查日志](evidence/windows/build-records/)随提交保存。记录中的源代码、测试脚本、驱动和 exe 摘要均核对一致。

[原始字节来源](evidence/windows/raw-provenance.json)保存 Windows 下载前的 SHA-256 和长度；[raw/](evidence/windows/raw/) 的四个 gzip 解压后匹配这些字节，并与格式化 JSON 逐值一致。日志仅统一编码和换行。早期脚本 API/拦截时机错误和仅修改保存口径的失败尝试保留在 Windows `attempts/`，没有入库或混入最终结果；仓库只保存最终成功证据。

自动化证明的是稳定后的尺寸与状态，不代替人眼确认首次显示有无短暂跳动。本任务未做性能优化，也没有重新测量或改写 v3 性能基线。
