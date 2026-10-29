# PS5 插件更新中心（本地版）

基于 [nexgen999/PS5-Repository-List](https://github.com/nexgen999/PS5-Repository-List) 的本地化版本，提供全中文界面、每日同步、按需下载、金手指同步等功能。

## 功能

- 全中文分类与简介，支持自动翻译
- 每日 09:00 定时同步上游仓库，识别新增 / 更新插件
- 首次打开自动弹出「今日更新」
- 按需勾选下载，支持多文件、断点续传、旧版本清理
- 金手指（HEN Cheats Collection）同步与版本历史
- 响应式布局，适配手机 / 平板

## 安装（Windows）

1. 下载最新 Release 中的 `PS5-Plugin-Hub.zip`
2. 解压到任意目录
3. 右键 `install.ps1` → **使用 PowerShell 运行**
   - 若提示执行策略限制，先在 PowerShell 中运行：
     ```powershell
     Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
     ```
4. 安装脚本会自动检测 Node.js（必需）和 Git（推荐），缺失时打开官方下载页
5. 安装完成后桌面会生成「PS5 插件更新中心」快捷方式，双击即可启动

### 系统要求

- **Node.js** 18+（必需，用于运行本地服务）
- **Git**（推荐，同步更快；未安装时自动改用 GitHub 直连下载）
- Windows 10 / 11

## 从源码构建安装包

```powershell
cd dist
powershell -ExecutionPolicy Bypass -File build-installer.ps1
```

生成 `dist/PS5-Plugin-Hub.zip`，上传到 GitHub Release 即可分发。

## 目录结构

```
local/
├── scripts/     服务端 (server.js) 与同步脚本 (sync.js)
├── site/        前端页面与数据
├── i18n/        中文翻译
├── state/       运行时状态（同步结果、下载记录等）
├── config.json  配置文件
├── start.ps1    启动脚本
└── run-daily.ps1 每日定时任务
```

## 许可

本项目本地化部分遵循原仓库许可。
