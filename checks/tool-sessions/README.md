# 任务 5：工具会话的应用和取消

对应 `rapidraw-handoff/TASKS.md` 任务 5、`PLAN.md` 6.9“应用和取消”。基底为 `fbb76a9f53a75d05d181bd66826b5a5a43464239`。最终 Windows、浏览器及实际截图的技术验证通过；截图由代理读取，不是产品负责人或人手体验验收。阶段 1 的人工缺项和任务 10 的禁令仍然有效。

## 最终行为

桌面进入裁剪、蒙版或 AI 后，画布下方显示生产 `Button` 的应用和取消按钮，沿用已有 17 种语言的文案。按钮行是画布的兄弟元素，占据独立高度，不覆盖图像和裁剪柄。它与原工具栏一样使用 `relative z-10`，避开画布的外扩 ring；Cancel 使用 `bg-surface text-text-primary`，复用主题语义色。共享 Button 没有修改。

| 会话 | 取消恢复的字段                                                              | 保留的内容                     |
| ---- | --------------------------------------------------------------------------- | ------------------------------ |
| 裁剪 | crop、rotation、orientationSteps、flipHorizontal、flipVertical、aspectRatio | 整图滑块、曲线、蒙版和 AI 内容 |
| 蒙版 | masks 深拷贝快照                                                            | 整图滑块、曲线、裁剪和 AI 内容 |
| AI   | aiPatches 深拷贝快照                                                        | 整图滑块、曲线、裁剪和普通蒙版 |

取消前的完整状态先进入历史，恢复快照后再形成独立历史步骤；撤销一次可找回取消内容，重做再次取消。迟到的 500ms 历史防抖不会覆盖这个步骤。无变化的取消不额外堆积历史。应用保留编辑并退出工具；切换工具或图片也保留已有编辑。

快照绑定当前图片和工具。路径变化立即失效旧快照，cached/cold 加载后的 `resetHistory` 按新图重新建立，避免切图后恢复上一张内容。AI 快照剥离瞬态 loading，运行中的真实 adjustments 和任务不受影响，避免取消或撤销复活没有请求负责的忙状态。

Enter 应用当前工具，聚焦应用/取消按钮时保留原生按钮激活；文本输入、输入法组合输入和 contenteditable 保留自身行为。Escape 先处理已有 straighten、自定义处理器、子蒙版和容器选择，最外层才取消工具。Android 保留原入口和生命周期分支。

生成标记、容器 loading 和真实 activeAiTasks 共用忙判定，按钮、Enter 和 actions 均不能在忙时退出。判定对全局任务采取保守阻塞。桌面 AI 请求在首次 await 前登记身份；取消后等原请求结算再释放忙状态，丢弃迟到结果。写回与 finally 同时核对请求所有权、图片路径、选择代次、historyRevision 和目标。DirectPatch 也登记本地任务，防止 Undo 恢复 loading 标志后误判空闲。对于没有所属请求的旧 loading，原取消生成入口仍可恢复；等待后再次核对图片、历史和请求/任务槽，避免清理新图或新任务。12 处 IPC 命令及参数 AST 保持不变。

桌面固定 `leftBottom` 按当前面板重建 presence 容器，避免快速应用/取消再重进时，外壳已是新工具、内部却永久停在 Presets。该区域不再等待旧面板淡出，新面板保留进入动画；同一面板重选保留实例。Android、非固定布局和其他区域沿用原逻辑。

## 验证及来源

| 检查                               | 最终结果                                                             |
| ---------------------------------- | -------------------------------------------------------------------- |
| Windows release / Rustfmt / Clippy | 退出码 0 / 0 / 0，最终构建 14 分 28 秒                               |
| Windows 原生交互                   | 12/12 组、108/108 项通过；真实 smokeExit=0                           |
| owned-client 实际截图              | 三图逐张读取通过；1280×720、96 DPI，按钮文字清楚，不遮画布/裁剪框    |
| Chromium                           | 71/71 组，727 步；467/467 可信步骤原始 trace 完整，0 untrusted input |
| 真实 SidePanelArea 快速重入        | 60 次；原有 70 组的 689 步、455 个可信步骤保留                       |
| CSS/像素组                         | 38 步、12 个可信步骤；12 张原图、24 个按钮区域独立像素核对           |
| Core / AI 隔离行为                 | 30 组 / 101 组、479 断言；范围见质量说明                             |
| TypeScript / 默认 ESLint           | 59→57 / 829 errors、45 warnings 不变；无新增诊断                     |

浏览器的 14 项补充合同保留 63 条原始来源记录，用于 busy、未 ready 和 prompt Enter 的确定性模拟；不计作原生模型生成覆盖。

原生各组结果如下。会话组覆盖取消保留整图滑块/曲线、独立 Undo、应用、Enter 和工具切换；切图组覆盖 A/B 各自快照、取消与回返；键盘组覆盖按钮焦点 Enter、逐层 Escape 和蒙版重命名输入；几何组覆盖真实裁剪图/柄、normal flow、窗口缩放及最终桌面截图。

| Native group |  裁剪 |  蒙版 |    AI |
| ------------ | ----: | ----: | ----: |
| session      | 15/15 | 15/15 | 15/15 |
| switch       |   7/7 |   7/7 |   7/7 |
| keyboard     |   7/7 | 11/11 |   9/9 |
| geometry     |   5/5 |   5/5 |   5/5 |

原始结果见 [windows-smoke.json](evidence/windows/windows-smoke.json)、[build.json](evidence/windows/build.json)、[417 项构建输入](evidence/windows/source-inputs.json)、[run-result.json](evidence/windows/run-result.json)。三张实际图片为[裁剪](evidence/windows/geometry-crop-1280x720.png)、[蒙版](evidence/windows/geometry-masks-1280x720.png)、[AI](evidence/windows/geometry-ai-1280x720.png)；[独立 agent review](evidence/windows/agent-visual-review.json) 绑定原始报告、script、EXE 和每张 PNG 的字节/SHA。三个 Cancel 区域都存在实际正文色像素，实测对比度约 14.14:1。

原生报告保持原始 `publicationEligible=false`，不倒填后续审查。单独的 [cleanup.json](evidence/windows/cleanup.json) 在代理图片复核及完整性门禁通过后记录交付资格、两个测试任务已删除和零自有进程；配置、原始 EXE、构建输入已恢复，两张 RAW 字节不变。下载前记录长度/SHA，按 14 项公开白名单下载；[raw-provenance.json](evidence/windows/raw-provenance.json) 关联 exact raw gzip、可读 JSON/日志和原样 PNG。私有备份未下载。

最终 EXE（64,005,120 bytes）保留在 `pc.lan`：

```text
E:\projects\tbt\rapidraw-baseline\app\src-tauri\target\release\RapidRAW-sessions.exe
SHA-256: 4e2ba2f54f56200c496c86d0cbf909afde169b524d9c40689e1d7cec40840022
```

构建 ZIP SHA 为 `a53156836646a332e33d4271067e402988b08ae136a3eb983fb0bd4331bd3d4f`，controller SHA 为 `f63dce3716862e824cb0a2713e31ab5083dcb9e0c3e2d05d0c711afbd3d29cf1`。417 项构建输入在构建中不变，八源冻结与浏览器的 430 项 runtime 输入均匹配最终文件。

- 浏览器完整结果与 mock/placeholder 边界见 [browser.md](browser.md)、[manifest](evidence/browser/browser-manifest.json) 和[原始 gzip](evidence/browser/chromium.json.gz)。旧组断言保留；新增真实 SidePanelArea 的快速退出/重入，以及使用生产 CSS、组件和实际布局 class 的像素回归。
- 隔离行为、质量基线和所有原始日志的字节/SHA 见 [quality/README.md](evidence/quality/README.md)、[comparison.json](evidence/quality/comparison.json)、[八源冻结清单](evidence/quality/source-freeze.json)。Core 最终 30 组；AI 101 组/479 断言，包含 18 组 Android 对照、请求 race 和旧源码负控。它们不是设备或真实模型测试。
- TypeScript **59→57**，仅减少两条原 AI spread 诊断；干净源码默认 ESLint 仍为 **829 errors / 45 warnings**，无新增。Vite 和 i18n runtime-check 退出 0，覆盖 17 locales。最终验证目录默认 ESLint 0 errors / 0 warnings。全库并非检查全绿。
- Root ESLint 使用 Git 输入及本任务新文件的干净副本；原工作区旧 `spike/intake/src-tauri/target` 中被 Git 忽略的生成文件有既存解析错误。没有修改 ignore、规则或依赖来规避检查。
- Windows 使用独立目录 `E:\projects\tbt\rapidraw-tool-sessions` 和两张隔离 NASA RAW 副本；来源与素材局限见 [baseline/README.md](../../baseline/README.md)。没有使用个人照片或下载模型。

## 验证方法的边界和教训

DOM 可见、命中和可信点击不能证明按钮已绘制。画布的大 ring 可以遮住静态兄弟按钮，但不拦截 hit-test；因此必须读实际 owned-client PNG。独立 CSS 对照使用真实 Button/ToolSessionActions 与生成的 Tailwind CSS，明确没有 WGPU/画布；最终原生截图另行验收。暗、浅、灰主题实测 Cancel computed color 均等于正文 token，对比度分别为 14.14:1、16.31:1、4.61:1。

原生 Enter 驱动包含 keyDown 的 CR text/unmodifiedText，才能触发聚焦按钮的默认 click；用例仍要求真实 trusted Cancel click 及正确恢复。最小 Chromium 正负对照保存在 quality，不能代替 Windows 结果。

只有跨存盘回读的 Brush `parameters.lines[*].points[*].x/y` 比较接受有限数值差 `≤1e-9` 像素，逐字段保留 expected/actual/delta；JSON 往返实测尾差约 `2.3e-13` 像素。结构、顺序、ID、其他字段和整图编辑严格比较；Cancel、Undo、新增笔画断言不使用这个例外。原始快照不归一化。

普通快速切换不是每次必现旧 presence 问题。独立受控 Framer hook 复现主动安排退出回调早于父 layout effect，证明一条停留旧内容的路径；它不声称测得了 Windows 内部回调顺序。真实 SidePanelArea 回归另行覆盖三个工具和 50/100/150/180/250ms 档快速重入。

失败运行、被拒绝的原生截图和私有 profile-backup 留在仓库外；仓库只收录最终通过结果、文字教训以及明确标注的预期负对照。私有备份没有下载或发布。原生报告不自批后续视觉审查，实际 PNG 的代理复核通过独立、绑定 report/script/EXE/PNG 哈希的 JSON 保存，不把它写成人工验收。

## 尚未覆盖

macOS/Android 硬件、多 DPI、人手拖动和视觉体验、真实模型生成/下载及算法图像质量未验证。浏览器 host mock、busy flag simulation、minimal CSS 和工具正文 placeholder 的范围在浏览器说明中逐项列明；它们不能代替完整原生画布或真实生成。本任务没有实施任务 6 的预设状态/性能或任务 10；阶段 1 的人工缺项仍待补齐，任务 10 继续禁止。
