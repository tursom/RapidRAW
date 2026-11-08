# 质量和隔离行为验证

最终生产输入见 [source-freeze.json](source-freeze.json)，完整命令、诊断比较及每份归档的原始长度/SHA-256、gzip SHA-256 见 [comparison.json](comparison.json)。gzip 保存原始字节；可读命令日志仅去掉 ANSI 和行尾空白。TypeScript、ESLint 使用基底 `fbb76a9f53a75d05d181bd66826b5a5a43464239` 的独立快照比较，不能把非零退出码说成全库通过。

目录中的阶段审查记录分别绑定当时的候选源码哈希，保留修复来源和对照范围；最终交付以顶部八源冻结清单、完整 417 项构建输入和最终 EXE 绑定为准。

| 检查                     |     基底 |             本次 |
| ------------------------ | -------: | ---------------: |
| TypeScript 诊断          |       59 |       57，未新增 |
| ESLint 错误 / 警告       | 829 / 45 | 829 / 45，未新增 |
| 干净根目录 ESLint 文件数 |      182 |              190 |
| Vite、i18n runtime-check |        — |     退出码均为 0 |

根目录比较使用 Git 输入及本任务新文件的干净副本；没有改变仓库 ignore 或规则。原工作区旧 `spike/intake/src-tauri/target` 的被 Git 忽略生成文件另有既存解析错误，不包含在这个干净副本中。

最终验证目录还单独使用仓库默认 ESLint 和 `--max-warnings 0` 检查了全部 7 个适用文件，结果为 0 错误、0 警告。命令、文件哈希和原始输出也保存在 comparison 与 gzip 归档中。

`core/` 保存真实 Zustand stores、actions 和 lodash debounce 的 Node 隔离验证：最终扩展套件为 30 组，包含原 27 组及三组瞬态 loading 快照回归。没有替换依赖或 native host stub，测试本身未调用原生命令。`core/README.md.gz` 记录实际 esbuild 和运行命令，绝对路径需要在复现环境中显式重建或调整。取消后还实际等待 550ms，确认迟到 debounce 不覆盖历史。

`ai/` 保存 React 中真实 `useAiMasking` 多实例及 stores 的 101 组、479 断言测试；token 和 native IPC 明确使用 deferred mocks。包括 18 组 Android 当前/基底对照，以及 12 处命令及参数 AST 比较。它验证请求归属、取消、历史重建、缓存回返、DirectPatch 的 Undo 边界和旧 loading 的取消恢复，不代表真实模型或设备运行。可将该目录的 gzip 解压到 `/tmp/tbt-task5-ai-guard`，按 `ai/run.mjs.gz` 的环境路径启动；需要本仓库依赖及已安装的 Playwright Chromium。`useAiMasking.before.ts` 为基底负对照；`useAiMasking.pre-review.ts` 是缺少桌面 manual-patch 登记的专门负对照输入；`useAiMasking.pre-orphan.ts` 是尚未恢复旧 loading 取消入口的负对照。它们均不是最终实现。

上述套件中的负对照是预期会被断言拒绝的测试输入。最终成功记录同时包含这些预期结果；没有归档失败的 Windows 或浏览器运行尝试。

`cdp-enter/` 保存最小 Linux Chromium 页面上的 38 组输入协议观测、完整命令和可信事件，包含原生按钮及真实生产 `Button`。同一按钮只发送 Enter keyDown/keyUp 时没有原生 click；keyDown 带 CR 文本后会产生 click，显式 `preventDefault` 对照仍阻止激活。这用于确定测试驱动的 Enter 协议，不代替 Windows 验收。脚本内记录的临时目录、浏览器及依赖路径需按复现环境调整。

`windows-retry4-validation.json.gz` 和对应 patch 保存最终控制器的局部验证与增量：Enter 字符协议、真实标题挂载后滚动可见，以及跨存盘回读时的笔刷坐标比较。坐标例外仅限 Brush `parameters.lines[*].points[*].x/y` 的有限数值，绝对差不超过 `1e-9` 像素；结构及其他字段保持严格比较，取消和撤销断言不使用此例外。中间版的静态合同用于说明修复来源，不代表这些中间版已通过 Windows 完整运行。

`panel-lifecycle/` 保存固定工具区的渲染边界审查：9 项受控 Framer hook 控制、160 项平台/布局/区域 key 控制及 16 项真实 React/Framer 生命周期控制。受控复现主动安排退出回调早于父 layout effect，证明旧 presence 容器能够停留在旧内容；它不声称普通快速切换必现，也不声称测得了 Windows 上的内部回调顺序。实际修复仅为桌面固定布局 `leftBottom` 按当前面板重建容器，旧内容立即卸载、新内容挂载；同一面板重选保留实例。

`actions-paint/` 保存成功的独立 CSS 对照和源码审查。使用真实 Button、ToolSessionActions 和生成的 Tailwind CSS，在没有 WGPU/画布的最小布局中，旧静态按钮行被 viewport 的外扩 ring 覆盖；仅加 `relative z-10` 或仅移除 ring 都恢复绘制，位置尺寸不变，恢复旧样式后整图像素再次一致。DOM 命中和可信点击在按钮被覆盖时仍可成功，因此不能代替实际绘制检查。临时目录原清单保留以说明来源，其中失败原生截图的审计数据及审计脚本按归档选择说明排除；原生失败运行和被拒绝截图没有入库。最终原生图另见 Windows 证据。

`cancel-contrast/` 保存生产 Button、实际生成 CSS 和三主题的正负对照。Cancel 使用 `bg-surface text-text-primary`，暗、浅、灰主题 computed color 均覆盖原主按钮文字色，对比度分别为 14.14:1、16.31:1、4.61:1；旧调用分别为 1.23:1、1.13:1、2.62:1。六张图属于独立 CSS 控制，不替代重建后的原生截图。共享 Button 和 Apply 样式未改。

完整界面验证及其 mock 边界见上级浏览器说明和任务报告。隔离控制、浏览器组件测试及 Windows 原生交互不能互相代替。
