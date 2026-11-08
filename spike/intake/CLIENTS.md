# 输入补测客户端下载

GitHub Actions 的 **Build intake test clients** 工作流打包独立输入实验工具。它支持手动 Run workflow，main 上相关工具代码修改后也会自动构建；不会创建正式 Release。

在成功的运行页面底部下载对应 Artifact，有效期 30 天：

| 机器                        | Artifact             |
| --------------------------- | -------------------- |
| Windows x64                 | `intake-windows-x64` |
| Mac Apple Silicon（M 系列） | `intake-macos-arm64` |
| Mac Intel                   | `intake-macos-x64`   |

下载后再解压里面的 `rapidraw-intake-*.zip`。其中包含两个客户端、剪贴板 CLI、README.txt 和 BUILD.json；ZIP 旁有 SHA-256 校验文件。BUILD.json 记录来源提交、编译器版本、release 模式、原生拖放开关和各文件摘要。Mac ZIP 保留 app 的执行权限和符号链接。

## 打开和记录

Windows 双击 `intake-native.exe`，完成一轮后关闭，再双击 `intake-html5.exe`。需要 WebView2 Runtime，已有 Edge 的机器通常已经具备。另有 `clipboard.exe`、`clipboard-contention.exe` 和 `windows-clipboard-processes.ps1`，供剪贴板诊断使用。

Mac 双击 `RapidRAW Intake Native.app`，完成后关闭，再打开 `RapidRAW Intake HTML5.app`。这些实验 app 仅 ad-hoc 签名，没有开发者证书或 Apple 公证；首次打开可能需要在系统设置“隐私与安全性”中允许这个 app。不需要安装 Rust、Node 或 Xcode 来运行下载的客户端。`clipboard` 是可选的终端诊断程序。

两个客户端使用不同名称和独立的实验应用标识，不覆盖正式 RapidRAW TBT。先确认工具环境行：原生模式 `nativeDragDrop=true`，HTML5 模式为 `false`，构建应为 release。

Windows 的 HTML5 模式测本地路径时，勾选 AdditionalObjects 并等注册成功；Mac 保持不勾选，这个接口只适用于 WebView2。

每个操作先填写来源、浏览器版本、用例和素材信息，再实际拖入或复制。复制后点“读取系统剪贴板”；没有拖入事件时点“记录当前用例/观察”留下原样结果。每个模式分别导出 JSON，工具显示的 `report-saved.path` 是实际保存位置。

CI 包的报告目录使用各自的新标识：`io.github.tursom.rapidraw.intake-spike.native` 或 `.html5`。Mac 默认在 `~/Library/Application Support/<标识>/results/`，Windows 默认在 `%APPDATA%\<标识>\results\`。请以工具返回的实际路径为准。

## Windows 剪贴板观察

在解压目录另开 PowerShell，开始操作前运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows-clipboard-processes.ps1 -OutputPath .\clipboard-processes-本次新名字.ndjson -Seconds 3600
```

输出文件必须是新文件。做完在观察窗口按 **Q** 正常结束，以保存服务映射和 completed 记录。保留导出 JSON 和这个 NDJSON 文件。

## 补测范围

优先测系统截图；再测资源管理器/访达的单图、纯多图、真实相机 RAW、文件夹、混合拖入及复制。浏览器分别用 Windows Chrome/Edge、Mac Safari/Chrome，覆盖网页 JPEG/PNG/WebP、真实网站、复制图像及复制图片地址。Mac 小图和大图复制各重复三次，至少有一张 6000×4000 大图。

构建成功不代表这些输入已验收。Mac 第 5 项的“无前置探测直接读取与 changeCount 时序”仍需专用探针，GUI 按钮和附带的普通 CLI 不能替代。实际补测细节见源码中的 `SPIKE.md` 和 `spike/intake/evidence/macos/README.md`。
