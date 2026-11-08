# 任务 3：曲线面板、信息与导出弹窗

本次基于 `9ec8b331`，按 `rapidraw-handoff/TASKS.md` 的任务 3 实施。桌面端默认左上显示曲线，标题行提供显隐、信息和导出入口。现有曲线图和信息、导出组件继续使用，修图算法、蒙版曲线、`ADJUSTMENT_SECTIONS` 与文件格式没有改动。

文件夹和联机拍摄标签仍保留（联机拍摄取决于原有平台支持），其余工具仍在原区域，面板仍可拖动。任务 4 的固定布局与工具移动、任务 5 的应用/取消、任务 6 的预设性能处理均未实施。阶段 1 仍未通过，任务 10 继续禁止。

## 行为与边界

- **曲线与回退：**旧工作区首次补上并激活 Curves；已经保存 Curves 的工作区保留用户排列。Metadata/Export 保留在左上布局数组，桌面全布局下从标签和侧栏内容中隐藏。曲线独立面板实际显示时，“调整”中不重复显示；切到其他左侧标签、收起左侧、窄到侧栏内容不可见或进入 compact 时，原“调整”中的曲线恢复。
- **调整操作：**新曲线面板与原 Controls 共享分区右键复制、粘贴、重置和显隐逻辑；仍按原规则深拷贝参数。点击、拖动或移动曲线面板不改写全局编辑模式；裁剪、蒙版和 AI 模式下操作左侧曲线调整整张图片。
- **统一入口：**桌面全布局的 `setPanel(Metadata/Export)` 与对应 `setActivePanel` 打开弹窗，已有快捷键及右键菜单沿用这些入口。打开弹窗不改变区域或全局模式；图库多选导出上下文保留。无选图时曲线标题的信息、导出按钮禁用，编辑器中的对应路由也不打开空弹窗。原图缺失的数据状态属于后续任务 12，本次没有新增该状态。
- **弹窗：**信息宽 480px、导出宽 560px，受可用窗口宽和 80vh 高度限制，内容可滚动。关闭按钮、Escape、空白处按下并松开可关闭；从内容内拖到外面松手不会关闭。初始焦点、Tab 循环、关闭后焦点恢复均已接入。
- **键盘隔离：**主快捷键守卫识别弹窗。Speed Edit 另有全局监听，本次也增加了守卫，并在打开弹窗时结束其已有的 drag/nudge/press/latch。导出下拉菜单仅在新弹窗内 portal 到 dialog；第一下 Escape 关闭菜单，第二下关闭弹窗，其他位置仍使用原 body portal。
- **导出状态：**弹窗打开也算 ExportPanel 激活，水印尺寸和文件估算会更新。关闭弹窗不调用取消导出，进度继续使用原 `useProcessStore`。未重写后端导出。
- **尺寸：**桌面默认左宽 250px、右宽 320px、左上高度 340px；已有保存尺寸保留。Rust 在缺少 workspace 时也会先补默认值，因此同步了其桌面左宽/左上高度。Android 保留原默认分支和旧布局。左侧已有上下分区时，上区可收缩、上下各至少 250px，空间不足时整个分区列可滚动；默认不额外创建任务 4 的下方工具区。

`isHistoryMode()` 本次仅用于集中判断桌面端；没有借此启动历史数据层、隐藏图库或改输入入口。

## 已执行的检查

| 检查                           | 结果与证据                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 全库 TypeScript                | 64 → 59 条既有诊断，无新增，退出码仍为 2                                                                  |
| 全库 `eslint src`              | 835 → 829 errors，45 → 45 warnings，无新增，退出码仍为 1                                                  |
| 前端生产构建                   | Vite 退出码 0                                                                                             |
| 翻译运行时检查                 | 17 个语言，1890 个复数解析及 31366 组占位符校验通过；新界面复用既有翻译键                                 |
| Rust 格式                      | `cargo fmt -p RapidRAW -- --check` 通过                                                                   |
| Chromium 组件联动              | 19/19 组：18 组组件/store、1 组源码审计；91 步，1030 条 trusted 事件，0 条 untrusted 事件，0 个浏览器错误 |
| Windows release / Clippy / GUI | release、rustfmt、Clippy 均为 0；真实应用 44/44 项通过，`coverageComplete=true`、待补测列表为空           |

全库 TS/ESLint 没有变成全绿。移除的诊断来自本次已修改分区操作和 store 区域类型，不是额外清理其他功能。前后原始输出、诊断差异与哈希见 [quality/comparison.json](evidence/quality/comparison.json)；gzip 保留原始字节，可读构建日志仅去除了 ANSI 和尾部空白。

新增夹具按仓库默认 ESLint 规则检查为 **0 error / 0 warning**，没有关闭规则或添加豁免。把基底与当前所有跟踪/待提交的 lint 输入分别放入干净源码快照，再执行 `eslint . --format json`，结果同样为 **835 → 829 errors、45 → 45 warnings，无新增**，完整原始输出见 quality 中的 `eslint-root-*.json.gz`。当前开发工作区直接运行该命令还会扫到先前 `spike/intake/src-tauri/target/` 中的 10 个旧生成资产解析错误，合计 839 errors；这些文件早于本任务、被 Git 忽略，干净检出不含它们。本次没有修改 ignore 规则或删除这批旧构建产物。

浏览器测试说明及复现命令见 [browser.md](browser.md)，完整原始结果见 [browser-manifest.json](evidence/browser/browser-manifest.json) 和 [chromium.json.gz](evidence/browser/chromium.json.gz)。1030 是事件数，包含 pointer/mouse/key/focus 等，并非 1030 次独立用户操作。测试导入生产组件、store 和 hooks，覆盖曲线模式保持与回退、共享分区操作、弹窗入口/关闭/焦点、Speed Edit 隔离、Dropdown 搜索与 Escape、双分区和小窗口。

**浏览器的 Tauri 主机接口使用 mock。** 水印尺寸、估算、导出 Promise 和进度证明前端行为，不证明后端编码、真实文件写入或水印像素；完整 App/ImageCanvas 及 Crop/Masks/AI 内容也没有在该夹具中挂载。Windows 真实应用结果另列，不把这些 mock 当作真机通过。

## Windows 实机记录

最终 Windows release 使用 [416 个应用/构建输入](evidence/windows/source-inputs.json)，构建前后哈希均已核对，与交付源码一致。release、Rust 格式、Clippy 退出码均为 0，见 [build.json](evidence/windows/build.json) 及 [原始构建输出的可读版本](evidence/windows/build-records/release.txt)。Clippy 按实际交付的 `tauri/custom-protocol` 特性运行，完整命令记录在 build.json；这里没有宣称已执行 Linux CI 的 `--all-features`。

在 WebView2 `Edg/157.0.4341.42`、DPR 1 的真实 Tauri 应用中，两次独立启动完成了 **44/44 项**。原始记录见 [windows-smoke.json](evidence/windows/windows-smoke.json)，包装程序的真实退出码见 [run-result.json](evidence/windows/run-result.json)。`passed=true`、`coverageComplete=true`、`pendingParentChecks=[]`；不以计划任务的退出状态代替这些判定。

| 分组                   | 用例数 | 实际覆盖                                                                                                                         |
| ---------------------- | -----: | -------------------------------------------------------------------------------------------------------------------------------- |
| 默认值、迁移与初始界面 |      4 | workspace 缺省时原生返回 250/320/340，实际侧栏 CSS 宽度一致；旧 350/350/450/450 保留并补齐曲线；文件夹及原平台支持的联机标签保留 |
| 标题、快捷键及关闭     |     12 | 信息与导出的标题按钮、真实默认快捷键、关闭按钮、Escape、空白处关闭、从内拖到外松手不关闭                                         |
| 画布右键导出           |      2 | 真实右键菜单打开弹窗及关闭                                                                                                       |
| 编辑模式               |      4 | 裁剪、蒙版、AI 下实际修改全局曲线仍保持相应画布模式，再切回调整                                                                  |
| 分区操作               |      5 | 复制、重置、粘贴、禁用、启用；调整值与 DOM 显隐状态一致                                                                          |
| 左侧回退               |      2 | 收起左侧后原右侧曲线可滚动访问；重开后不重复显示                                                                                 |
| 窗口与 compact         |      8 | 原生 HWND 改为 800×600、600×800，再恢复 1280×720；compact 保留调整内曲线和原信息/导出面板路径，回全布局再打开弹窗                |
| 水印与估算             |      3 | 真实尺寸/估算 IPC，开关更新；可见预览的 RAW 比例、水印 2:1 比例、大小、位置、透明度及 DOM 几何验证                               |
| 实际导出               |      4 | 真实提交 JPEG 导出，进行中关闭、进行中重开、完成后关闭；实际文件存在且格式/尺寸、参数、哈希核对通过                              |

导出关闭前 `status=exporting` 且尚未收到完成事件；重开立即仍为 `exporting`，随后收到真实进度与完成事件。隔离输出 `fixture/output/photo-000_curves-smoke.jpg` 为 **4256×2832、3,649,431 bytes**，SHA-256 为 `926052e46bd935f87936eb6d15cce9dc5122a5539750ddb8bc5a02374359dd99`。预览沿用原来的 LOGO 占位框，本次验证其实际 props 与可见几何；没有比较输出 JPEG 中的水印像素，未把前端 mock 当作该项证明。

原始记录也保留了一次既有后备路径错误：`compact-legacy-export` 请求 RAW 的 `get_image_dimensions` 时，后端不能识别 `.NEF`，随后面板按原逻辑回退为 3:2。这条路径在基底已有，本次没有修改；新全布局弹窗使用已加载图片的真实尺寸，水印预览的 17 项几何断言及真实 JPEG 导出均通过。44/44 表示所列用例通过，不表示所有 native IPC 都没有错误。

控制器为 [windows-smoke.py](windows-smoke.py)，复用未修改的 [baseline CDP driver](../../baseline/scripts/windows-cdp.py) 和 [observer](../../baseline/scripts/observe.js)，并读取冻结的默认快捷键定义。它只操作专用 NASA RAW 副本；程序化图库导航及滚动到已有曲线/下方控件都有区分，不称为可信拖放或滚轮测试。测量用例必须收到对应目标/按键的 trusted 输入，且原生窗口尺寸没有用设备指标模拟。IPC 观察仅读取真实 fetch 响应的 clone，保留原 Promise/Response，不修改 Tauri 的只读 `invoke`。

在本次准备好的测试主机上重现，需提供独立的 `E:\projects\tbt\rapidraw-curves`、受校验的 `fixture/photo-000.NEF`、[fixture.json](evidence/windows/fixture.json)（包括 `sourceRel`）、driver/observer/keyboardUtils.ts、编译后的 exe，以及 `logs/`、`evidence/` 目录，在交互式桌面运行 Python。脚本拒绝覆盖已有结果、水印素材、导出目录和额外 fixture 文件；重复运行前将上一轮专用结果及其 sidecar/output 移到工作目录归档，不能指向个人图库。具体目录为脚本中的显式常量，其他主机应先适配这些路径。

```powershell
& 'E:\projects\tbt\rapidraw-intake-spike\venv\Scripts\python.exe' `
  'E:\projects\tbt\rapidraw-curves\windows-smoke.py'
```

可运行产物：

```text
E:\projects\tbt\rapidraw-baseline\app\src-tauri\target\release\RapidRAW-curves.exe
SHA-256 477a9583f16b43182c2627a3a35d045b79e805e0e6313d7ef9f1e712cdc7307c
```

配置恢复、RAW SHA、自有进程退出都是 `passed` 和退出码 0 的必要条件。[cleanup.json](evidence/windows/cleanup.json) 确认：两份用户配置恢复、RAW 原字节未变、构建缓存原输入及原基线 exe 恢复，两个专用计划任务已删除，自有应用进程剩余 0。[raw-provenance.json](evidence/windows/raw-provenance.json) 保存 Windows 下载前取得的哈希与长度；六份 JSON 和三份构建日志的 gzip 保留 BOM/换行等原始字节，水印 PNG 原样保留，可读 JSON 只改排版而解析内容一致。

失败尝试揭示了测试驱动的三处问题，最终均修正后完整重跑：素材清单 `source/sourceRel` 字段不一致；React bailout/alternate 链读取到旧显隐 props，改用真实 DOM 标签与图标相互验证；下方控件应先定位再滚动、最后检查可见性和命中，不能先只查可见元素。回退到原“调整”的曲线仍按原分区顺序位于“基础”下方，用例明确滚动访问，不声称会自动滚到曲线。应用源码没有因这些驱动修正再次改变，最终 416 个输入仍与同一个构建吻合。

## 尚未验证

macOS 与 Android 真机、不同 DPI 和人工视觉体验尚未验证。compact 与 Android 在 Chromium 中的配置/组件对照不等于设备验收。原图缺失状态的按钮禁用需随任务 12 接入。没有开展性能基线对比，任务 6、13 仍需按既定规则在同一会话中运行旧、新版本。

失败尝试只留在临时目录或 Windows 工作目录；本目录只收最终成功结果，不收失败归档。既有 `baseline/`、`checks/slider/` 和 `checks/window-size/` 证据保持冻结。
