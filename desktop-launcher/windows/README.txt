DSH Launcher 0.1.9 - Windows x64 一键构建包

这是构建包，不是已生成的安装程序。当前没有连接 Windows 构建机；Windows 上的真实构建与验证由下面的脚本执行。

1. 将整个 ZIP 解压到本地短路径，例如 C:\DSH-Build。不要直接在压缩包内运行，不要放在 OneDrive 或网络盘。
2. 使用 Windows 10/11 的 Intel/AMD 64 位电脑，建议 16 GB 内存和 30 GB 可用空间。
3. 如需代理，在 proxy.txt 中写一行，例如 http://127.0.0.1:7890。留空使用当前环境的网络设置；代理只作用于本次构建。
4. 双击 Build-Windows.cmd，保持终端打开。首次构建需要联网下载 Node、Git、pnpm、Electron 和项目依赖。
5. 成功后出现 BUILD-SUCCESS.txt。安装程序位于 desktop-launcher\.cache\dist\DSH-Launcher-0.1.9-Windows-x64-Setup.exe。

构建会校验下载文件、运行单元测试、验证内置服务启动/停止、打包，再验证安装包内的应用、端口占用切换和数据导入。任一步失败都不会生成成功记录。若原生依赖缺少预编译文件并要求 C++ 编译器，需要按错误信息安装对应构建工具。

失败时请保留 build-windows.log 和 desktop-launcher\.cache 中的日志。依赖下载可在网络恢复后重新运行；若明确提示 prepare-windows.lock 已存在，仅在确认所有构建进程退出后删除该锁文件再重试。

构建脚本不修改系统 PATH、不全局安装 Git/Node/pnpm，也不安装生成的应用。PowerShell 执行策略只对本次启动生效，不修改系统设置。

生成的安装包：
- 未签名，Windows 可能显示未知发布者或安全提示；企业策略可能阻止运行。
- 内置 Git、Node、pnpm、DSH 源码及 Windows 依赖，首次运行不需重新下载这些工具。
- 支持官方版本更新、代理、服务控制、端口自动切换和数据导入。
- 默认数据导入检测 %USERPROFILE%\.dsh。客户端数据位于 %APPDATA% 下，用“打开数据目录”查看准确位置。
- 卸载保留用户数据；更新切换和导入前会备份数据。

不要删除 .cache\dist\win-unpacked 中的部分文件后单独移动 EXE。分发给其他电脑时使用最终生成的 Setup.exe。

源码构建完成、安装包阶段失败时，可运行 Continue-Packaging.cmd：复用现有依赖和运行包，显式安装 Electron，重新运行测试、打包并检查成品。续跑会核对源码压缩包、清单、工具版本和启动器代码的构建记录；记录缺失或输入变化时请运行 Build-Windows.cmd，下载缓存仍会保留。旧运行包没有该记录时需要完整构建一次。
