# 任务 4：固定工具布局与模式保持

基底为 `33ba1eb7`，范围以 `rapidraw-handoff/TASKS.md` 的任务 4 为准。桌面全布局改为左上曲线、左下工具、右侧调整；FolderTree 和平台支持的 Tethering 入口继续保留。任务 5 的应用/取消按钮、蒙版/AI 会话快照、任务 6 的预设状态和性能处理均未实施。阶段 1 仍未通过，任务 10 继续禁止。

## 实现

共修改六个生产文件：

- `src/store/useUIStore.ts`：桌面全布局使用固定区域，恢复时忽略保存的标签排列和切换条位置，保留左右宽度和上下高度。左下依次为 Crop、Masks、Ai、Presets，默认 Presets；右上只有 Adjustments。集中处理模式、显式退出、无图保护、选择丢失，以及 compact/full 切换。
- `src/components/panel/PanelSwitcher.tsx`：桌面全布局隐藏至多一个可显示标签的切换条；停用标签拖动及拖动监听；没有图时原生禁用三个工具按钮。
- `src/components/panel/SidePanelArea.tsx`：关闭固定布局的区域投放和分割投放；沿用现有上下分区、可拖动分隔条，以及任务 3 的可收缩上区/至少 250px 下区和列滚动。
- `src/App.tsx`：拖动入口和结束入口也拒绝桌面全布局的标签移动，保留图库拖动。
- `src/components/panel/editor/ImageCanvas.tsx`：桌面全布局的中心标记、重光工具还必须处于全局 Adjustments 模式；compact 与 Android 沿用原条件。
- `src/components/panel/editor/overlays/SpeedEditOverlay.tsx`：桌面全布局按当前 Speed Edit 目标实际所属的 DOM 面板确定 A/D 循环范围，避免全局画布模式为裁剪/蒙版/AI 时串到该工具的滑块。无目标时仍使用原模式面板；compact 和 Android 保留旧范围。

没有改动 Rust、依赖、状态文件格式或调整算法。左侧默认宽 250px、右侧 320px、左上高 340px；已有尺寸保留。

| 桌面全布局入口                      | 结果                                                              |
| ----------------------------------- | ----------------------------------------------------------------- |
| 左下工具标签或对应 `setPanel`       | 左下激活该工具，全局画布进入 Crop/Masks/Ai                        |
| 选择预设                            | 左下 Presets，全局 Adjustments，修改保留                          |
| 点击右侧调整或左上曲线内容          | 保持全局工具模式，操作整张图的调整                                |
| 显式 `setPanel(Adjustments)`        | 左下回 Presets，退出工具；现有裁剪应用/取消及调整快捷键复用此入口 |
| 工具入口遇到无图                    | 不进入工具；已选图变为空时回 Presets/Adjustments                  |
| 左侧收起或宽度不足 200px 时进入工具 | 自动展开左侧并恢复可用宽度                                        |
| compact → full                      | 重建固定区域，保留当前有效工具模式，否则显示 Presets/Adjustments  |
| full → compact                      | 由原全局面板继续渲染，关闭仅供全布局的弹窗                        |

compact 的移动面板切换器、曲线在调整面板内的回退及 Android 原路径保留。信息和导出继续复用任务 3 弹窗。Masks 的波形按钮在右侧调整可见时保持禁用，提示为“在调整面板中切换分析”，波形仍在右侧。

## 已完成检查

| 检查                                    | 结果                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 改动前/后 TypeScript                    | 59 → 59 条既有诊断，无新增，退出码均为 2                                                          |
| 改动前/后 `eslint src`                  | 829 → 829 errors，45 → 45 warnings，无新增，退出码均为 1                                          |
| 生产前端构建、翻译运行时检查、Rust 格式 | 通过                                                                                              |
| Store 隔离行为检查                      | 225/225，通过真实 Zustand/UI/editor/settings store，原生主机接口为 mock                           |
| Chromium 组件/store 联动                | 19/19 组、91 步，其中 64 步包含可信输入；0 个浏览器/host 错误                                     |
| 默认 `eslint .`（干净源码快照）         | 跟踪/待提交检查文件 176→182，829 errors / 45 warnings 不变，无新增                                |
| Windows release / Rust 格式 / Clippy    | 均退出 0；416 个构建输入与交付源码匹配，构建前后未变，原输入恢复                                  |
| Windows 完整应用                        | 12 组、73/73 项通过；`passed`、`nativePlanComplete`、`coverageComplete` 均为 true，待补测列表为空 |

完整诊断、原始字节 gzip、六个生产文件的冻结 SHA-256 见 [quality/comparison.json](evidence/quality/comparison.json) 和 [source-freeze.json](evidence/quality/source-freeze.json)。隔离 store 用例包含旧基底的 compact/Android 对照、恶意/重复旧布局、模式和显式退出、选择丢失、无图快捷键、尺寸和侧栏恢复；新增 37 项可见性回归，覆盖 full→compact 后蒙版波形可用。它不代表完整原生应用。原临时 harness 与结果按原字节归档，harness 使用记录中的本机路径。

浏览器复现与覆盖说明见 [browser.md](browser.md)，[manifest](evidence/browser/browser-manifest.json) 和 [完整原始 gzip](evidence/browser/chromium.json.gz) 保留输入哈希、每步结果和清理记录。默认 ESLint 下新增夹具为 0 error / 0 warning，无规则关闭。测试导入真实布局/调整/曲线组件、快捷键和 Speed Edit，Crop/Masks/AI 内容为显式占位及局部 Slider 哨兵；Tauri host 使用 mock，不证明真实工具内容、画布绘制、编码或设备表现。Masks 的波形和 ImageCanvas 条件使用实际源码 AST 提取的 selector 进行聚焦验证，不是已渲染画布的证据。

默认 root 检查用相同依赖、分别包含基底与全部待提交代码的干净源码快照运行。开发工作区的旧 `spike/intake/src-tauri/target/` 还包含 10 个被 Git 忽略的生成资产解析错误，因此直接运行 root lint 为 839 errors；本次没有改 ignore 或删除旧生成文件。TypeScript/ESLint 的既有诊断没有修到全绿。

## Windows 完整应用

最终记录见 [windows-smoke.json](evidence/windows/windows-smoke.json)、[真实包装程序退出码](evidence/windows/run-result.json) 和 [build.json](evidence/windows/build.json)。WebView2 为 `Edg/157.0.4341.42`，DPR 1；最终 EXE 对应 [416 个输入](evidence/windows/source-inputs.json)。release、Rust 格式和交付特性 `tauri/custom-protocol` 的 Clippy 均退出 0；没有宣称已运行 Linux CI 的 `--all-features` 或全平台构建矩阵。

| 分组                 | 项数 | 实际覆盖                                                                                                           |
| -------------------- | ---: | ------------------------------------------------------------------------------------------------------------------ |
| 旧工作区恢复         |    2 | 忽略故意打乱的标签位置和激活项，保留 350/350/340/450 尺寸；实际曲线/文件夹入口，工具默认预设、右侧通栏且没有工具条 |
| 模式保持             |   12 | 四个工具页分别进入，操作实际右侧曝光及左侧曲线；工具模式保持，整图参数确实变化                                     |
| 裁剪                 |    9 | 实际拖动裁剪柄，Enter 保留修改、Escape 恢复进入前几何；左下回预设，三种工具切预设退出                              |
| 快捷键与弹窗         |    9 | 调整/裁剪/蒙版/AI/预设快捷键；信息/导出继续打开弹窗并关闭                                                          |
| 蒙版笔刷             |    4 | 实际创建 Brush、在真实画布拖动绘制，蒙版数据改变，切到预设后保留                                                   |
| 250px 面板           |    4 | 实际调整左宽至 250px，蒙版/AI 控件矩形、截图、Clone 工具入口可用                                                   |
| 小窗口、滚动与分隔条 |    6 | 原生窗口分别为 1280×720、800×600；真实 wheel 导致滚动，真实指针拖动改变上下分区高度                                |
| 左侧收起             |    8 | 收起后用四种工具快捷键重新展开正确侧栏并显示对应工具                                                               |
| 中心标记             |    3 | 普通调整下实际控件激活、Konva 绘制可见；裁剪和蒙版下操作同一控件不显示标记且模式保持                               |
| 重光叠加层           |    4 | 实际 Add Light 增加灯光数据和绘制；裁剪/蒙版下不出现灯光叠加层，回调整后可重新激活                                 |
| compact              |    9 | 原生改为 600×800 后七种面板入口；真实蒙版波形按钮启用、开关均改变挂载的波形                                        |
| 无图                 |    3 | 第二次独立启动进入实际无选图图库侧栏，工具按钮与信息/导出禁用，三个工具快捷键不能进入工具                          |

实际原生计划用例全部通过后，控制器才请求截图复核。父代理通过图片读取工具检查了 [蒙版](evidence/windows/narrow-250-masks.png) 和 [AI](evidence/windows/narrow-250-ai.png) 两张最终截图，并提交 [结构化复核](evidence/windows/visual-review.json)。程序校验 EXE、脚本、两张 PNG 的哈希和长度以及逐图观察，才关闭 `narrow-visual` 待办；此复核不能覆盖失败用例，进程清理和恢复检查也仍会影响最终通过。**这是代理的截图检查，不是人类操作或主观手感验收。**截图覆盖代表性控件及滚动入口，没有遍历所有展开组合或 AI 提供方。

截图来自前台自有 HWND 的实际 Windows 客户区：物理 1280×720、DPI 96，截取范围、前台归属及屏幕边界有记录；拍摄前的 0.4 秒与两帧等待仅用于动画稳定，不是性能指标。WebView 的 `Page.captureScreenshot` 会漏掉此主机的原生 GPU 图像层，本次最终两张均使用 `PIL.ImageGrab` 客户区捕获，实际照片和笔刷叠加可见。

测试只用独立 NASA RAW 副本。为访问现有 Spatial/Relight UI，临时配置 `aiProvider="cpu"`，这不是更改渲染器；在该副本按现有 `ImageMetadata` 格式预先保存 `relightEnabled=true`、`relightNormalMap=null`。实际流程观察到 52 字符的映射引用，其类型、长度及 SHA 有记录；没有验证该引用的内容、法线图或照明算法质量。各阶段严格检查没有导出提交、AI 生成或模型下载命令。未调用隐藏回调、注入 store/React 参数或替换原生 IPC 返回值。

无选图原生检查使用当前版本实际可到达的图库侧栏；`App` 本来只在有选图时挂载 `EditorView`。同会话选图丢失后的状态恢复另由真实 store 与浏览器用例覆盖，不把它称为已测原生空编辑器。

[控制器](windows-smoke.py) 复用未修改的 baseline CDP driver/observer 和原默认快捷键文件。准备好的本机专用目录为 `E:\projects\tbt\rapidraw-tool-layout`，需包含校验过的 `fixture/photo-000.NEF`、[fixture.json](evidence/windows/fixture.json)、driver/observer、`keyboardUtils.ts` 以及 `logs/`、`evidence/`。在交互式桌面运行：

```powershell
& 'E:\projects\tbt\rapidraw-intake-spike\venv\Scripts\python.exe' `
  'E:\projects\tbt\rapidraw-tool-layout\windows-smoke.py'
```

脚本拒绝覆盖已有证据、复核、私有备份及有额外文件的素材目录。Windows 原始用户配置先保存到仅当前用户可读的本机 `profile-backup`，它从未下载或入库。运行成功的必要条件包括：明确验证自有进程树已停止，再逐字节恢复两份原配置，RAW SHA 不变。正常的截图复核需在请求生成后 300 秒内提供匹配的 `parent-visual-review.json`；超时保持待办，不会写成通过。其他主机应先适配固定路径、窗口及环境，不能指向个人图库。

可运行产物：

```text
E:\projects\tbt\rapidraw-baseline\app\src-tauri\target\release\RapidRAW-tools.exe
SHA-256 2ffc180b1f25099bf4d147b92c7cd689e3f55bdda7d1eb87c9841a5b4622abb1
```

[cleanup.json](evidence/windows/cleanup.json) 确认原缓存源码/基线 EXE 恢复、两份用户配置恢复、RAW 未变、自有进程剩余 0，两个专用计划任务均删除。[raw-provenance.json](evidence/windows/raw-provenance.json) 对应 Windows 下载前记录的 13 个文件哈希和长度：8 份 JSON、3 份日志、2 张 PNG。gzip 保留原始 BOM/换行，PNG 原样保存，可读 JSON 只改排版；原始上传的代理复核 JSON 也单独按控制器实际读取的哈希保留，和程序重排的副本语义一致。私有备份不在任何发布归档中。

## 方法限制与发现

- 图像画布故意省略部分色调 props；原生观察器分别读取当前 Basic/Effects 所属参数，而不是把字段不存在误判为默认值。裁剪与 Konva 在 `overlayRoot` portal 下，使用实际 React 归属定位；不能只查图片节点的物理子树。
- 本机重新进入裁剪时，实际几何会重新投影：此素材一次宽度从进入前的 3984 变为 3983px，Escape 正确恢复进入前的 3984px。用例保留两个值，并精确比较进入前快照，没有放宽成像素容差。此坐标换算路径本次未改，未用基底 EXE 重跑同一序列，不把它断言为本次引入或已独立复现的上游缺陷。
- 程序化图库导航、固定测试配置和副本元数据属于显式 setup；测量输入使用对应角色的可信 CDP 输入。DOM/React props 只读，原始响应从 fetch clone 读取，原 Promise/Response 和只读 Tauri 入口保持原样。
- macOS/Android 真机、不同 DPI、多语言展开组合、AI 生成、导出编码和人工手感未测。任务 3 的导出实现未改；预设的已知状态/预览性能问题留给任务 6，缺失原图状态留给任务 12。

运行失败和被替代的构建只留在临时目录或 Windows 工作目录。这里只保存最终成功运行，既有 baseline、slider、window-size、curves-panel 的源码/证据均保持冻结。
