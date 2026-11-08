# 任务 3 浏览器验证夹具

此夹具在 Linux headless Chromium 中运行真实 React/Vite 和生产组件，验证任务 3 的前端行为。最终结果与输入哈希见 [browser-manifest.json](evidence/browser/browser-manifest.json)，逐步输入、全部 store 输出、IPC、错误及清理记录见 [chromium.json.gz](evidence/browser/chromium.json.gz)。失败尝试只保存在 `/tmp/curves-browser-*`。

生产代码、依赖清单、历史证据和提交均不属于本夹具的修改范围。`windows-smoke.py`、`evidence/windows/`、`quality/` 和总体 `README.md` 由父会话负责，本说明只描述浏览器结果。

## 运行

从 `RapidRAW/` 运行：

```sh
node checks/curves-panel/run.mjs
node checks/curves-panel/run.mjs --output /tmp/curves-browser-final.json.gz
```

默认沿用 `checks/slider` 的环境：

- Playwright：`/root/.npm/_npx/dd48173ecf795e2b/node_modules/playwright/index.mjs`
- Chromium：`/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`
- Vite：`127.0.0.1:9143`

可通过 `PLAYWRIGHT_MODULE`、`CHROMIUM_PATH`、`CURVES_PORT` 覆盖。`CURVES_CASE=SpeedEditOverlay` 或 `CURVES_CASE=Dropdown` 可只跑对应组；这种结果不能替代完整运行。`--output` 支持 JSON 和 `.gz`，任何失败都会强制输出到临时目录，即使指定了仓库内路径也不会写入失败证据。

## 使用的真实实现

夹具直接导入生产 `useUIStore`、`useEditorStore`、`useProcessStore`、`useSettingsStore`、`CurvesPanel`、`ControlsPanel`、`SidePanelArea`、`PanelSwitcher` / `MobilePanelSwitcher`、`AppPanelModal`、`MetadataPanel`、`ExportPanel`、`SpeedEditOverlay`、`useKeyboardShortcuts` 和 `useAppContextMenus`。曲线通过真实 `AdjustmentSection` / `Curves` 编辑，导出面板内的 `Dropdown` 和滑块也来自生产实现。

样式导入完整 `src/styles.css`，使用生产 dark theme tokens；挂载生产 `ContextMenuProvider` 和真实 `DndContext`，传感器与 `App.tsx` 一样使用 `PointerSensor` 的 5px 激活距离。夹具不复制曲线算法、workspace 迁移、模式路由、弹窗或导出设置算法。compact → full 直接走生产 `store.setUI({ isFullLayout: true })`。

仅 Tauri host IPC、外部应用回调使用明确 mock。`host.ts` 对未知 IPC 抛错，记录每次调用与参数：尺寸返回 3000×2000，水印返回 400×100，估算返回 123456 字节，保存对话框返回专用假路径。图像设置为已就绪但尺寸未知，以触发真实 `ExportPanel` 的尺寸回退请求。`export_images` 返回待完成 Promise，进度通过显式 `mockHostProgress` 写入真实共享 process store。**这些结果不能代表 Rust 后端实际编码、写文件、水印合成、真实导出任务或取消导出成功。**

## 覆盖

最终完整运行包含 19 组：18 组浏览器内组件 / store 用例，以及 1 组明确标记的源码入口审计；逐步数量以 manifest 为准。

| 验证范围                   | 实际断言                                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认值与旧 workspace       | desktop 250 / 320 / 340；旧布局补一个 Curves、保留自定义尺寸及 FolderTree/Tethering；重复、未知标签与无效激活值清理；Android 沿用旧前端 350 / 350 / 450                                               |
| 独立曲线去重与回退         | 默认左侧真实曲线、Controls 无重复；真实 FolderTree/Curves 标签切换；左隐藏、宽度不足 200、全屏、compact；library 已挂载侧栏也正确去重                                                                 |
| 模式保持                   | Crop / Masks / AI 下真实鼠标新增和拖动曲线点；每次移动与全部中间 store 输出保持模式；`setPanel(Curves)` / `setActivePanel` 入口同样保持                                                               |
| context 与蒙版隔离         | 真实右键菜单 Copy / Reset / Paste、visibility；曲线确实改变、重置、恢复，哨兵蒙版完整数据在全部输出中不变                                                                                             |
| 信息 / 导出入口            | 真实标题按钮、真实快捷键 hook 的 I/E、真实编辑器右键菜单 Export Image；编辑 activePanel 保持                                                                                                          |
| 弹窗交互                   | Close / Escape / backdrop；内部按下拖出后松手不关闭；Close 初始焦点、Shift+Tab / Tab 循环、关闭返回按钮焦点；Enter 与编辑快捷键隔离                                                                   |
| SpeedEdit 隔离             | 挂载真实全局 overlay；Close 聚焦时 W/箭头不激活或改值；实际验证 latched、held nudge、active drag 先能改真实滑块值，开弹窗后退出，保持按键 / 鼠标移动不能继续改值                                      |
| Dropdown                   | 真实导出目标 Dropdown：键入 Original 搜索，Tab 到选项，Enter 选中；先 Escape 关 Dropdown，再 Escape 关 modal；800×600 / 1280×720 中检查菜单坐标及首末选项的 `elementFromPoint` 命中，证明未被弹窗裁剪 |
| ExportPanel 激活           | activePanels 中没有 Export、只通过 panelModal 激活，仍发起图像 / 水印尺寸与含水印参数的估算调用，显示 mock 估算字节；实际导出滑块拖出不关闭                                                           |
| 共享进度                   | 点击真实 ExportPanel 导出按钮确实请求 mock `export_images`；关闭重开后真实 process store 与界面保留 1/3，未请求 cancel_export                                                                         |
| 最小窗口及双分区           | 800×600 / 1280×720、250px 左宽、保存过大的 topHeight；真实双分区外层至少 250px、内容存在且可滚动到；真实竖分隔条拖动更新尺寸；Info 480 / Export 560 宽、80vh 上限和滚动容器                           |
| 平台与空状态               | Android 全布局仍用侧栏 Info/Export，Controls 保留曲线；Android / desktop compact 的 7 个真实移动入口；无图按钮禁用且 store 不打开 modal                                                               |
| compact → full             | 从 Metadata / Export 激活态直接调用真实 store.setUI，区域回退 Curves，selector 与实际 DOM 同步，Controls 不重复                                                                                       |
| 源码审计（不作为原生实测） | App 写 isFullLayout / panelModal；Rust 新安装默认 desktop 左 250、上 340、右 320，Android 左 320、上 450 保持                                                                                         |

任务 3 不移动 Crop/Masks/AI/Presets。双分区使用自定义布局，低分区内容是明确的工具占位；未挂载完整 `App`、`ImageCanvas`、真实 Crop/Masks/AI/Presets/Folder/Tether 内容。这里能证明模式 store 和曲线数据隔离，不能证明裁剪画布预览、蒙版绘制、AI 生成或这些工具在 250px 内的完整可用性。真实窗口响应式判定、Rust 新安装及 Windows WebView2 由完整应用检查补足。Android 是浏览器中配置平台分支，未测 Android 硬件。

## 输入、负对照与来源

鼠标 / 键盘由 Playwright CDP 产生，事件记录 `isTrusted`。观察器在 host bootstrap 的 `window` capture 提前注册，因此 SpeedEdit 在全局 capture 阻止传播的按键也能记录。每步保留 before / after，按顺序保存完整 input、UI/editor/process store 输出与 IPC；程序化 fixture setup、真实 store API 调用、静态审计和 mock 进度单独标记，不冒充 trusted 用户输入。

Vite 虚拟模块读取 `git show 9ec8b331:src/store/useUIStore.ts` 原文，仅放在内存中，未写入生产目录。相同关键断言会拒绝这个基线的默认激活、默认宽度和曲线交互覆盖编辑模式的行为；基线导出路由也观测到 activePanel 被设为 Export。另外输入重复 / 未知标签和篡改模式观测作自检。基线模块仍使用当前依赖和 Panel 枚举，这属于聚焦负对照，不能称为完整旧版本应用对比。

runner 在前后计算全部 `src/`、`src-tauri/src/app_settings.rs`、package/lock 文件与浏览器夹具运行文件的 SHA-256；任何漂移使整次运行失败。说明文档、证据输出、父会话保留文件不计入运行输入，文档另由 manifest 记录。清理取消夹具防抖、释放 mock 导出 Promise、释放按键 / 鼠标、关闭浏览器和 Vite，确认 Vite PID 已消失、端口已释放。

## 夹具检查与实测限制

夹具 TypeScript 文件使用仓库默认 ESLint 规则检查，结果为 0 error / 0 warning。配置、设置、图像和 store API 使用真实生产类型，host payload 按 Tauri 的 `InvokeArgs` 类型缩窄，固定英文测试文案集中在 `FIXTURE_LABELS`，没有规则禁用或配置豁免。

```sh
./node_modules/.bin/eslint checks/curves-panel/{fixture.tsx,host.ts,bootstrap.ts,virtual.d.ts} --max-warnings 0
./node_modules/.bin/tsc -p checks/curves-panel/tsconfig.browser.json
```

runner / Vite JS 的作用域 ESLint 检查及浏览器自有文件的 Prettier 检查通过。`tsconfig.browser.json` 类型检查覆盖夹具及真实导入图：夹具没有诊断，导入的生产文件仍有 16 条既有诊断，不能称为整个 TypeScript 检查通过；失败输出留在 `/tmp/curves-browser-typescript.txt`。父会话的全库质量检查另行交付。

补测时修正过的夹具问题包括初次 Vite 依赖预构建超时、缺少 LUT 列表 host 返回、误把分区内容高度当作包含工具条的外层 250px、默认 Dnd 传感器吞标签点击，以及将文件格式普通按钮误当作 Dropdown。最终用生产传感器配置、真实外层最小高度和真实目标 Dropdown 重跑，未通过放宽业务断言解决问题。失败原始记录均在临时目录，仓库证据只保存最终通过结果。
