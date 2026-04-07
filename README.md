# Booktoki Catcher

Booktoki Catcher 现在是一个面向 macOS 的桌面下载器，目标是让普通用户也能通过图形界面下载 BookToki / NewToki / ManaToki 作品，同时尽量保留原仓库的 Node.js 命令行能力与站点适配逻辑。

当前实现重点：

- 保留原始下载核心思路，不重写站点抓取链路
- 新增 Electron 桌面壳，支持双击启动 macOS `.app`
- renderer 侧固定启用安全边界
  - `contextIsolation: true`
  - `nodeIntegration: false`
  - 只通过 `preload + contextBridge` 暴露白名单 API
- CLI 继续保留 `-url / -start / -last` 参数
- GUI 默认把结果保存到“用户选择目录/作品名/…”
- CLI 默认继续保留旧版站点根目录输出结构

## 功能概览

桌面版界面包含：

- 作品链接输入框
- 开始章节输入框
- 结束章节输入框
- 保存目录选择
- 开始下载按钮
- 停止 / 取消按钮
- 日志输出区域
- 当前状态提示

支持站点：

- BookToki
- NewToki
- ManaToki

## 项目结构

```text
.
├─ assets/
│  └─ booktoki-catcher-mark.svg
├─ electron/
│  ├─ main.js
│  └─ preload.js
├─ scripts/
│  ├─ build-mac.sh
│  └─ dev.sh
├─ src/
│  ├─ core/
│  │  ├─ downloader.js
│  │  ├─ errors.js
│  │  ├─ output.js
│  │  └─ sites.js
│  └─ renderer/
│     ├─ index.html
│     ├─ renderer.js
│     └─ styles.css
├─ down.js
├─ tokiDownloader.js
├─ package.json
└─ package-lock.json
```

职责说明：

- `src/core/`: 可复用的下载核心，CLI 和 Electron 共用
- `electron/`: Electron 主进程与 preload 安全桥
- `src/renderer/`: 桌面应用界面
- `scripts/`: 一键开发启动与一键打包脚本
- `down.js`: 兼容原有 CLI 的薄入口
- `tokiDownloader.js`: 保留的 legacy userscript

## 下载结果结构

### GUI 默认输出

桌面版默认输出到用户选择目录下的作品名文件夹。

BookToki：

```text
选择的保存目录/
└─ 作品名/
   ├─ 0001 章节名.txt
   ├─ 0002 章节名.txt
   └─ ...
```

NewToki / ManaToki：

```text
选择的保存目录/
└─ 作品名/
   ├─ 0001 章节名/
   │  ├─ 0001 章节名 image0000.jpg
   │  └─ ...
   └─ ...
```

### CLI 兼容输出

CLI 默认继续使用旧结构：

```text
북토끼/作品名/0001 章节名.txt
뉴토끼/作品名/0001 章节名/0001 章节名 image0000.jpg
마나토끼/作品名/0001 章节名/0001 章节名 image0000.jpg
```

## 开发环境

建议环境：

- macOS
- Node.js 24+
- npm 11+

安装依赖：

```bash
npm install
```

## 本地运行

### 运行桌面版开发环境

```bash
npm run dev
```

或：

```bash
./scripts/dev.sh
```

### 运行 CLI

```bash
node down.js -url "https://booktoki469.com/novel/6981" -start 1 -last 10
```

参数说明：

- `-url`: 必填，作品目录页链接
- `-start`: 可选，开始章节编号
- `-last`: 可选，结束章节编号

## 打包 macOS App

执行：

```bash
npm run build:mac
```

或：

```bash
./scripts/build-mac.sh
```

默认产物位置：

```text
dist/mac-arm64/Booktoki Catcher.app
```

当前打包策略：

- 首版优先跑通，`asar: false`
- 如后续验证稳定，再评估切回 `asar + asarUnpack`

## 安全模型

Electron 安全边界已固定：

- `contextIsolation: true`
- `nodeIntegration: false`
- renderer 不直接访问 Node.js
- renderer 不直接使用裸 IPC
- 仅通过 `preload.cjs` 暴露白名单 API

## 已验证 / 未验证

已验证：

- CLI BookToki：`https://booktoki469.com/novel/6981` 已完成 `1-1` 下载并成功输出文本章节
- 桌面版开发环境可启动：`npm run dev` 已实际打开应用窗口
- macOS 打包成功：`dist/mac-arm64/Booktoki Catcher.app` 已实际生成并可启动
- 打包版 GUI BookToki：已完成 `1-1` 下载，状态栏显示“完成”，日志正常追加，成功输出 `.txt`
- 打包版 GUI 取消：已完成运行中取消，状态栏显示“已取消”，日志会记录“收到取消请求 / 已发送取消请求 / 任务已取消”
- CLI ManaToki：`https://manatoki468.net/comic/151107` 已完成 `1-1` 下载并成功输出 52 张图片

未验证或待补测：

- CLI NewToki：`https://newtoki469.com/webtoon/35285561` 在本轮测试中持续停留在站点可访问等待阶段，尚未完成真实下载
- 打包版 GUI 的 NewToki / ManaToki 真实下载尚未补测
- 默认应用图标仍为 Electron 默认图标

## 已知限制

- BookToki / NewToki / ManaToki 域名和页面结构经常变化，站点改版后可能需要更新正则和选择器
- Cloudflare / 验证页不保证永远自动通过；首版允许弹出受控辅助浏览器窗口
- `tokiDownloader.js` userscript 仍保留，但桌面版是主入口
- 当前 macOS 打包已验证可生成 `.app`，但默认仍使用 Electron 默认图标
- NewToki 当前真实烟测仍可能被站点验证页卡住

## 后续扩展方向

如果继续往“抓书姬”风格扩展，建议优先沿着下面几条走：

- 增加任务历史和最近下载记录
- 增加站点配置层，减少硬编码选择器散落
- 增加章节进度条、失败重试、断点续跑
- 增加多任务队列
- 增加作品信息卡片和封面预览
