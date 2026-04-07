# Booktoki Catcher

Booktoki Catcher 是一个面向 macOS 的 BookToki / NewToki / ManaToki 下载器。当前分支已经把下载核心、桌面 GUI、任务清单、任务报告和恢复模式落到了同一套代码里。

当前更完整的恢复规则说明见：

- `docs/RECOVERY_RULES.md`

## 当前推荐用法

- 当前推荐 preset：`balanced-test`
- 当前推荐使用方式：优先使用打包版 macOS `.app`
- `fast-test` / `aggressive-test` 目前保留为可选 preset，但不作为主线推荐

当前打包产物默认位置：

```text
dist/mac-arm64/Booktoki Catcher.app
```

## scheduler preset

当前可用 preset：

- `balanced-test`
- `fast-test`
- `aggressive-test`
- `safe`

当前默认 preset 由 `src/core/scheduler.js` 中的 `DEFAULT_SCHEDULER_PRESET` 决定，当前值是：

```text
balanced-test
```

含义约定：

- `balanced-test`：当前主试验 / 推荐 preset
- `fast-test`：保留为可选试验 preset
- `aggressive-test`：保留为可选试验 preset
- `safe`：保留为更保守的备用 preset

## 启动与运行中的验证规则

当前代码已经把 startup gate 和 runtime blocked 拆开：

- 启动阶段命中验证页时，不会立刻判为 blocked
- 程序会进入 startup verification wait，允许等待或在辅助浏览器里完成人工验证
- 只有 startup gate 超时，才会记为 `failed + startup-verification-timeout`
- 只有在第一次真正进入正常目录页或章节页之后，才会启用 runtime blocked detection
- 运行阶段再次命中疑似验证页、异常页或连续失败阈值，才会被标记为 `blocked`

## CLI 用法

### 新任务

```bash
node down.js -url "https://booktoki469.com/novel/6981" -start 1 -last 10
```

### 继续主线

```bash
node down.js --resume-tail "/path/to/_session/manifest.json"
```

规则：

- 继续爬取将从 `nextForward` 开始，不会从头确认
- 不会优先回头处理旧的 missing
- 如果主线已到末尾，会返回 no-op 提示

### 补漏章节

```bash
node down.js --resume-missing "/path/to/_session/manifest.json"
```

规则：

- 补漏章节只处理非 `success` 章节
- 不处理已经 `success` 的章节

### 选择 preset

三种模式都可以叠加：

```bash
node down.js --resume-tail "/path/to/_session/manifest.json" --scheduler-preset balanced-test
```

## GUI 恢复入口

当前 GUI 已经把恢复入口拆开：

1. 先选择 `_session/manifest.json`
2. GUI 会读取并显示：
   - 小说名
   - `latestSuccess`
   - `nextForward`
   - `missingCount`
   - `runKind`
3. 然后再点：
   - `继续爬取` -> `resume-tail`
   - `补漏章节` -> `resume-missing`

GUI 概览区会直接提示：

- `继续爬取将从 nextForward 开始，不会从头确认`
- 当主线已到末尾但仍有漏章时，会提示 `主线已到末尾，请使用补漏章节`

## manifest / report 路径

每个任务目录下都会生成固定的会话目录：

```text
作品目录/
└─ _session/
   ├─ manifest.json
   └─ report.json
```

当前 manifest / report 会记录恢复相关信息，例如：

- `latestSuccessOrder`
- `latestSuccessChapterKey`
- `nextForwardOrder`
- `nextForwardChapterKey`
- `missingChapterKeys`
- `lastStopReason`
- `lastRunMode`

report 还会记录当前测速字段，例如：

- `totalDurationMs`
- `averageChapterDurationMs`
- `effectiveChaptersPerMinute`
- `schedulerDelayTotalMs`
- `pageStabilityDelayTotalMs`
- `startupVerificationDurationMs`

## 本地运行与打包

安装依赖：

```bash
npm install
```

开发版 GUI：

```bash
npm run dev
```

CLI：

```bash
npm run cli -- -url "https://booktoki469.com/novel/6981" -start 1 -last 3
```

打包 macOS `.app`：

```bash
npm run build:mac
```

## 已知问题 / 已知限制

- 当前推荐优先使用打包版 `.app`
- 开发版 GUI 仍有已知不稳定现象
  - 曾出现 `npm run dev` 偶发异常退出
  - 曾出现开发态窗口白屏
- 真实站点仍可能在 startup gate 阶段遇到验证页或网络波动，从而中断任务
- 恢复规则已经按 `resume-tail` 和 `resume-missing` 分开，但相关黑盒链路仍未完全回归验证
- `fast-test` / `aggressive-test` 当前不建议作为主线真实站点测试方案
