# Windows 实机记录

测试主机为 `pc.lan`，Windows 10 x64、桌面 Session 1。Chrome 156.0.8078.74、Edge/WebView2 156.0.4314.58，Tauri 2.12.1、Wry 0.57.0、clipboard-rs 0.3.5。详细方法、耗时和未测范围见仓库根目录 `SPIKE.md`。

| 文件                                                | 可以支持的结论                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `windows-final.json`                                | 最终 Chrome/Edge 的可信源端拖动及有效目标窗口：原生模式未收到事件，HTML5 模式取得 JPEG 字节并正确解码；Edge 真实右键复制小图/大图各 3 次 |
| `windows-automation.json`                           | Chrome 真实右键复制小图/大图各 3 次。这里的早期拖放和 Edge 菜单尝试不作为通过证据                                                        |
| `windows-additional-final.json`                     | 真实 Windows COM 接收器：磁盘文件输入路径回传；浏览器虚拟图片不能作为磁盘 File 发送；后续 IPC 和原生报告保存仍成功                       |
| `windows-shell-result.json`                         | Shell IDataObject 与真实 OLE DoDragDrop：文件、目录、混合、中日文文件名，两种模式共 8 个用例；HTML5 中目录标记及物理路径均匹配           |
| `windows-system-clipboard.json`                     | 由 Win32 API 生成的 CF_HDROP、标记、普通文本、空剪贴板，交给真实 Rust CLI 读取；不是资源管理器复制或系统截图                             |
| `windows-local.json`、`windows-explorer-final.json` | 资源管理器 UI 自动化失败的原始记录，不能作为产品兼容性结论                                                                               |
| `build-result.json`、`build-session.json`           | 两种模式和 CLI 编译退出码、实际交互会话信息                                                                                              |

`status: observed` 仅表示驱动保存了观察数据，不等于断言通过。判断浏览器拖放时必须结合 `sourceDragEvents.isTrusted`、目标窗口匹配和实际接收事件；判断原生路径必须看到 `additional-paths` 中 `phase=receive`、`ok=true` 和正确的 `paths`。Shell 用例还核对了 OLE 效果 `1`、目标窗口和返回的完整路径。

本地文件输入的 AdditionalObjects 测试使用 CDP 设置磁盘文件并构造 DataTransfer，明确不是物理拖放。随后独立的 Shell 用例通过真实 Windows OLE 和鼠标输入补齐本地拖放协议验证，其来源是最小 Tk 窗口而非资源管理器 UI。浏览器用例均通过实际跨窗口鼠标拖动，不使用合成 DOM 事件。

原始序列同时保留空格式、读取错误和驱动异常，没有将不支持的格式强行改成成功。`windows-final.json` 的 Explorer 行仍有失败结果；资源管理器的直接 UI 操作、系统截图、图片地址复制和 macOS 仍在待测范围。

这些是未优化 debug 探针的记录。大图为 6000×4000 高熵生成 JPEG；探针只回传数据摘要，未测正式导入写盘或完整像素的 IPC 传输，不能据此判断正式编辑器性能。

Windows 上保留了完整工作目录 `E:\projects\tbt\rapidraw-intake-spike`，包含 `build.ps1`、各个 `windows-*.py` 驱动、独立 venv、原始日志及所有失败尝试。这里选择与结论直接相关的 JSON 入库。驱动没有包含远程连接凭据。可手动运行 `artifacts\intake-native.exe` 或 `artifacts\intake-html5.exe`，按 `SPIKE.md` 复测并通过工具导出新记录。
