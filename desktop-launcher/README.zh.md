# Personal DSH Launcher

[English](README.md) | 中文

## 概述

在 Electron 窗口中运行 DeepSeek Harness，使用独立数据目录、分范围代理、服务控制，以及来自官方 GitHub 仓库的分阶段更新。此独立项目不加入 DSH 的 pnpm workspace。构建目标包括 macOS Apple Silicon 和 Windows x64，不替代官方 Desktop 应用。Windows 安装包必须在 Windows 上完成构建并通过冒烟检查，才能视为可交付。

## 目录

- [构建与运行](#build-and-run)
- [Windows Git 工作区构建](#windows-checkout)
- [使用启动器](#use-the-launcher)
- [更新与恢复](#updates-and-recovery)
- [开发与检查](#development-and-checks)
- [限制](#limitations)

## 构建与运行 {#build-and-run}

开发者需要 Git、Node.js、npm 以及 DSH 所需的原生构建工具。在 `desktop-launcher/` 中执行：

```sh
npm ci
npm run prepare:payload
npm start
```

运行包准备会下载并校验 Node.js、desktop/dugite-native 的便携 Git 和 pnpm。它导出当前已提交的 Git 代码，排除此启动器，按锁文件安装 DSH 依赖、构建产品并检查 CLI 入口。准备前必须提交已跟踪文件的修改。未跟踪文件、凭据和本地 `.env` 文件不会复制。构建日志和下载缓存在 `.cache/` 下；准备中断后保留诊断文件，也可能留下锁文件，只有确认准备进程已退出后才能删除锁。

准备运行包后构建本地安装包：

```sh
npm run package:mac
```

DMG 输出在 `.cache/dist/` 下。本地构建没有 Developer ID 签名或 Apple 公证，macOS 可能要求明确的安全授权。缺少运行包时，打包会停止。安装包包含 Git、Node、pnpm、DSH 源码及构建依赖，因此首次准备无需安装开发工具或下载 npm 包。模型请求及可选插件下载仍需要网络。

### 从 Windows Git 工作区构建 {#windows-checkout}

可以在 Windows 克隆自己的 fork，再让本地编程 AI 构建启动器。这条路径需要 Git、受支持的 Node.js 与 npm，以及 Windows x64 构建环境；构建包脚本随后会准备自己固定版本的工具。使用较短的本地检出路径，拉取更新前保留已有修改。为源码工作流安装 Git 和 Node 不会改变安装包自带运行工具的要求。

Git 仓库不是解压后的构建包。不要直接运行 `windows/Build-Windows.cmd`。在干净的已提交工作区中进入 `desktop-launcher/`，执行：

```sh
npm ci
npm run export:windows
```

导出器使用 Node 归档库，不依赖 macOS 工具路径或创建符号链接的权限。输出 `WINDOWS_BUILD_DIRECTORY` 指向独立构建目录，在该目录运行 `Build-Windows.cmd`。需要 ZIP 时执行 `npm run export:windows:zip`。快照记录源码提交、版本和 SHA-256；内部链接转为普通副本，越界和循环链接会被拒绝。导出仅包含已提交的源码，排除启动器；不要将凭据或用户数据提交到源码仓库。原生 Windows 验证由 CI 和构建包脚本执行。

在 Windows 工作区中，可以将下面的任务说明交给 AI：

> 阅读仓库 AGENTS.md 和 desktop-launcher/README.zh.md。构建 desktop-launcher 目录下的独立启动器，不是官方 apps/desktop 客户端。 更新前检查 git status 和 fork 远程地址，保留本地修改。 在 desktop-launcher 中运行 npm ci 和 npm run export:windows，生成构建包。 使用选定的已提交源码版本，保留快照哈希及内部链接校验。 不要将凭据或本地用户数据打入快照。 在生成的构建包中运行 Build-Windows.cmd；必要时将我的实际 HTTP 代理 填入 proxy.txt，不修改全局 npm/Git 配置，不关闭 TLS 校验。 保留锁定的依赖版本。若修改启动器版本，只更新 package.json 的 version 以及 package-lock.json 顶层和 packages[""] 中的 version。 不得在依赖记录中全局替换版本字符串。 使用现有构建脚本显式安装 Electron；pnpm 命令必须在声明使用 pnpm 的解压后 DSH 源码目录中执行。 运行包完成后若打包失败，在同一构建包运行 Continue-Packaging.cmd， 复用已下载内容和编译完成的运行包。 不得跳过失败测试；检查 not ok 段落和首个构建错误。 只有单元测试、服务启动重启、打包、端口占用和导入检查全部通过后， 才交付 Setup.exe 路径、SHA-256、源码提交号及 BUILD-SUCCESS.txt。 单独说明尚未验证的安装程序交互。未经我要求，不安装或发布产物。

产物是生成的构建包中 `desktop-launcher/.cache/dist/` 下的未签名 `DSH-Launcher-<version>-Windows-x64-Setup.exe`。构建包根目录的 `BUILD-SUCCESS.txt` 是脚本完成记录；仅在第 7 步前出现可执行文件并不代表完成。重试时沿用同一构建目录，以保留 `proxy.txt`、下载缓存和已完成的运行包。Git 更新只改变源码，不会重建已有安装包或刷新旧的导出构建包。

### Windows 构建包

运行包构建完成并进入打包阶段后，可用 `Continue-Packaging.cmd` 复用现有依赖和运行包，显式安装 Electron，重新执行单元测试、服务和成品检查，而不重新构建 DSH。续跑要求已完成的构建记录与源码压缩包、清单、工具版本和启动器构建及运行代码匹配。记录缺失或输入变化时，须运行 Build-Windows.cmd，下载缓存仍会保留。没有该记录的旧运行包需要完整构建一次。完整构建同样会在测试前显式安装 Electron。

Windows 构建包包含经过校验的当前已提交 DSH 源码快照、本启动器和 `Build-Windows.cmd`。在 Intel/AMD Windows 10/11 电脑上解压到本地短路径后，双击该命令文件。pnpm 版本检查和构建命令均在声明使用 pnpm 的解压后 DSH 源码目录中运行。依赖安装显式使用 npm 官方源，不修改全局 npm 配置。脚本下载固定版本的 Node、Git 和声明的 pnpm，安装依赖、构建 DSH、运行生命周期测试及服务冒烟测试、生成未签名 NSIS 安装包，再验证打包应用的端口占用切换及测试数据导入。所有检查通过后才写入 `BUILD-SUCCESS.txt`；安装包位于 `desktop-launcher/.cache/dist/`。脚本不会安装该产物，也不修改全局 PATH。首次构建需要联网；若原生依赖没有预编译文件，可能需要 C++ 构建工具。命令文件旁可选的 `proxy.txt` 只为本次构建设定 HTTP/HTTPS 代理；空文件或仅含空白的文件不会改变环境中的代理设置。失败时保留 `build-windows.log` 和 `.cache/` 下各步骤日志。只有确认全部构建进程退出后，才能删除残留的 `prepare-windows.lock`。

Windows 包目录链接保存为相对位置元数据，首次解包到最终目录后再创建 junction，避免安装后的运行时引用构建电脑路径。Windows 服务关闭使用 `taskkill /T /F` 并等待所持有的子进程退出。Windows 用户数据位于 `%APPDATA%` 下，默认数据检测使用 `%USERPROFILE%/.dsh`。NSIS 按用户安装，卸载时保留用户数据。macOS 测试不能证明 Windows 构建或原生安装界面已经通过验证。

## 使用启动器 {#use-the-launcher}

紧凑管理窗口在顶部保留服务状态和可用操作，下方通过连接设置、官方更新、数据管理和运行日志四个标签切换。标签支持方向键切换，并保留未保存的设置。修改后会显示提示，可撤销修改；保存或撤销前不能测试 GitHub 连接，确保测试使用已保存的配置。

管理窗口在另一个隔离的 Electron 窗口中打开 DSH 工作区。关闭工作区会回到管理窗口，不停止服务。退出启动器时，如果有服务或构建运行，会先请求确认，再停止其拥有的进程树，不终止其他 DSH 应用。

数据目录使用 Electron 的 userData，通常为 `~/Library/Application Support/personal-dsh-launcher`。点击“打开数据目录”确认实际位置。`dsh-home/` 保存独立会话、设置及凭据，`workspace/` 是初始工作目录，`versions/` 保存托管的应用副本，`runtime.json` 选择当前版本与已准备版本。日志约每 2 MB 轮转一次，并遮盖 URL 查询参数及常见凭据赋值；第三方插件的任意输出仍可能包含敏感信息。

“导入默认数据”自动检测 `~/.dsh`，“重新检测”可刷新结果；“选择目录导入”可选择包含 `sessions/`、`storages/` 或 `profiles/` 的其他 DSH 数据目录。请先停止使用来源目录的所有外部 DSH 进程，并只导入可信数据，因为导入包含配置及凭据。确认后，启动器停止自己的服务，将来源复制到暂存目录，把原数据保留在 `backups/import-…/dsh-home`，再整体替换客户端数据；不合并数据库，也不修改来源。导入后服务保持停止，需手动点击“启动服务”。启动器代理设置和外部项目文件不在导入范围。生成的共享依赖目录 `profiles/node_modules/` 会在检查链接前跳过，包括指向旧安装位置的失效链接。Profile 配置、插件清单及各 profile 自己的依赖仍按正常规则复制；导入操作不会重新安装额外插件。目录重叠以及其他位置的链接或特殊文件会被拒绝，错误提示显示对应的相对路径。替换失败或中断时，会在启动前恢复原数据；恢复失败则阻止启动。复制失败的暂存文件保留供排查。导入不会转换不兼容的会话格式；若启动报告版本错误，请保留备份。

模型 API Key 请在工作区的模型设置中配置，或导入可信的现有 DSH 数据。服务不继承终端中的 API Key。

代理设置接受不含账号密码的 HTTP 或 HTTPS 地址。开关分别控制更新与依赖安装、DSH 服务请求及工作区浏览器流量。本地回环流量绕过代理。服务设置在重启后生效，修改首选端口前必须停止服务。首选端口被占用时，由系统为本次服务分配空闲端口，管理窗口显示实际端口，工作区自动连接新地址。首选设置不变，下次启动仍优先尝试它。连接测试使用已保存的更新代理访问 GitHub，不测试模型提供方。不修改系统代理、Shell 配置或全局 Git 配置。

## 更新与恢复 {#updates-and-recovery}

检查更新会选择官方仓库最近发布的 `dsh-v…` 版本，包括预发布版。下载并构建使用独立源码目录及内置工具，旧服务可继续运行。不支持的 Node 要求或不同的 pnpm 版本会阻止准备，需要先更新启动器或工具链。只有依赖安装、构建、前端产物及 CLI 检查全部成功后，新版才可供切换。

切换需要确认，会先停止服务，将独立 DSH 数据目录复制到 `backups/`，再记录新版为当前版本并启动。持久化恢复标记可在切换中断后阻止无人确认的自动启动。启动成功后清除标记；启动失败时保留新版、旧程序及数据备份。“重试当前版本”会再次启动同一版本。每份备份的 `recovery.json` 记录对应的新旧版本。新版可能已经迁移数据，因此启动器不自动降级会话或还原备份。手动恢复要求停止服务，并同时还原旧程序选择及其对应的数据备份。

下载或构建失败时保留暂存目录供诊断。旧版本和备份不自动删除。只有停止服务并确认所需版本及备份后，才能手动清理无用副本。Git 更新不修改开发者的源码仓库或自定义启动器文件。

## 开发与检查 {#development-and-checks}

```sh
npm run check
npm run test:ui
npm run test:import
npm run test:runtime
npm run test:desktop
npm run test:occupied
npm run test:update
```

独立 lint 和单元检查统一使用 `npm run check`。desktop-launcher 工作流在 Windows 和 macOS 上运行检查、导入冒烟及构建包导出；手动选择 Windows 安装包选项可运行完整构建。工具版本和校验值集中在 `toolchain.json`，pnpm 版本跟随源码清单。`node scripts/size-report.mjs` 统计现有运行包体积，不删除依赖。

导入冒烟测试通过管理按钮和 IPC 使用测试目录及自动确认的测试对话框，检查导入文件及原数据备份，并捕获管理窗口。原生目录选择器本身需手动验证。测试以 TAP 格式在各用例结束时输出失败详情。进程测试从标准输出读取完整的带标记 PID 消息，不将错误输出中的诊断信息作为 PID。服务测试先等待进程退出，再删除临时运行目录。Node 测试覆盖导入替换、复制拒绝、提交失败、中断恢复、设置校验、发布版本输入、进程取消、后代进程清理和中断后的更新恢复。Electron 冒烟测试使用独立测试数据目录打开真实管理窗口，检查渲染文本，并输出 `.cache/test-results/management.png`。它不调用模型，也不代表完整 DSH 兼容性验证。运行包冒烟测试在 PATH 中排除开发工具后，执行两次真实服务启动、HTTP 页面访问及停止。桌面冒烟测试在 Electron 中打开真实 DSH 页面并输出 `.cache/test-results/workspace.png`。更新冒烟测试会联网拉取固定官方发布版并构建、备份测试标记、切换启动；它使用专用测试目录，需要更多时间和磁盘空间。运行包准备和打包是独立检查，管理窗口冒烟测试不代表离线安装或真实版本升级已验证。

## 限制 {#limitations}

管理界面为中文。不提供 Intel Mac 打包、代理认证、启动器自身自动更新、磁盘容量预估和自动备份保留策略。工作区渲染器拒绝权限请求，因此麦克风输入及其他需要浏览器授权的功能不可用。首个运行包包含开发依赖以支持现有 DSH 源码启动器，安装包较大。未来源码构建可能需要额外原生编译器或新的内置工具版本。构建运行包可能执行受信任上游的生命周期脚本。发布版本查询依赖 GitHub 连接与限流状态。启动和重启最多等待两分钟，直到 CLI 输出已认证的就绪地址；第三方改变该输出时需要适配启动器。
