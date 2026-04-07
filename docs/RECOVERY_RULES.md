# 当前恢复规则与使用约定

这份文档只描述当前分支里已经落地的行为，不描述未来计划。

## 当前推荐 preset

- 当前主试验 / 推荐 preset 是 `balanced-test`
- `fast-test` 和 `aggressive-test` 仍然保留为可选 preset
- 当前不建议把 `fast-test` / `aggressive-test` 作为主线真实站点测试方案

当前默认 scheduler preset 由 `src/core/scheduler.js` 中的 `DEFAULT_SCHEDULER_PRESET` 决定，当前值是 `balanced-test`。

## startup gate 与 runtime blocked

当前代码已经把“启动阶段验证等待”和“运行期疑似验证/封禁”拆开处理。

### 启动阶段

- 新任务会先进入目录页 startup gate
- `resume-tail` 和 `resume-missing` 也都会先经过 startup gate
- 如果页面处在 `just a moment`、`checking`、`verifying` 这类验证页，程序不会立刻判为 blocked
- 这时状态会保持在 `running`，phase 会显示为 `startup-verification`
- 日志会提示：正在等待站点可访问，可在辅助浏览器中完成验证
- 只有 startup gate 超时，才会记为 `failed + startup-verification-timeout`

### 运行阶段

- 只有在第一次真正进入正常目录页或章节页之后，才启用 runtime blocked detection
- startup gate 成功后会重置连续失败计数，避免把启动阶段噪声带入运行期判定
- 运行期再次命中疑似验证页、异常页，或连续失败达到阈值时，任务会被标记为 `blocked`
- 这类情况会停止后续抓取，不会继续高速访问后续章节

## manifest / report 当前结构

每个任务目录下都会生成固定的会话目录：

```text
作品目录/
└─ _session/
   ├─ manifest.json
   └─ report.json
```

### manifest 顶层关键字段

- `latestSuccessOrder`
  - 当前所有成功章节里最靠后的 `order`
- `latestSuccessChapterKey`
  - 该章节对应的稳定章节 key
- `nextForwardOrder`
  - 下次继续主线时默认从哪里开始
- `nextForwardChapterKey`
  - `nextForwardOrder` 对应的章节 key
- `missingChapterKeys`
  - 所有非 `success` 章节的 key 列表
- `lastStopReason`
  - 最近一次任务结束原因
- `lastRunMode`
  - 最近一次运行模式，当前可为 `initial`、`resume-tail`、`resume-missing`

当前实现里，`missingChapterKeys` 由 `src/core/session-manifest.js` 的 `refreshManifestProgress(manifest)` 统一计算，不在 downloader 其他路径里手动维护。

### report 当前会写出的关键恢复字段

- `latestSuccessOrder`
- `latestSuccessChapterKey`
- `nextForwardOrder`
- `nextForwardChapterKey`
- `missingChapterKeys`
- `missingCount`
- `failedCount`
- `blockedCount`
- `lastRunMode`
- `resumeDisposition`

report 还会保留当前运行的测速字段，例如：

- `totalDurationMs`
- `averageChapterDurationMs`
- `effectiveChaptersPerMinute`
- `schedulerDelayTotalMs`
- `pageStabilityDelayTotalMs`
- `startupVerificationDurationMs`

## 两种恢复模式的区别

### `resume-tail`

- 用途：继续主线，只从 `nextForward` 往后推进
- 入口：CLI 的 `--resume-tail`，或 GUI 的“继续爬取”
- 行为：
  - 只从 `nextForwardOrder / nextForwardChapterKey` 对应章节开始
  - 不重新处理已经 `success` 的章节
  - 不优先回头处理中间 `failed / blocked / cancelled` 的章节
  - 不再从头逐章确认

明确规则：

- 继续爬取将从 `nextForward` 开始，不会从头确认
- 中间漏章会先留在 `missingChapterKeys` 里，等补漏模式单独处理

特殊情况：

- 如果 `nextForwardOrder = null` 且 `missingCount > 0`
  - 说明主线已到末尾，但仍有漏章
  - 这时会返回 no-op，提示“主线已完成，可改用补漏章节”
- 如果 `nextForwardOrder = null` 且 `missingCount = 0`
  - 说明任务已经完整完成
  - 这时会返回 no-op，提示“已无可继续章节”

### `resume-missing`

- 用途：补漏，不负责推进主线
- 入口：CLI 的 `--resume-missing`，或 GUI 的“补漏章节”
- 行为：
  - 只处理非 `success` 章节
  - 不处理任何 `success` 章节
  - 按章节 `order` 升序补洞

明确规则：

- 补漏章节只处理非 `success` 章节

## GUI 当前恢复入口

当前 GUI 的恢复流程已经拆开：

1. 先选择 `_session/manifest.json`
2. 界面会读取并显示：
   - 小说名
   - `latestSuccess`
   - `nextForward`
   - `missingCount`
   - `runKind`
3. 然后再点击：
   - “继续爬取” -> 触发 `resume-tail`
   - “补漏章节” -> 触发 `resume-missing`

GUI 概览区当前会直接显示这条说明：

- `继续爬取将从 nextForward 开始，不会从头确认`

如果当前主线已经到末尾，但仍有漏章，GUI 会显示：

- `主线已到末尾，请使用补漏章节`

## 当前推荐使用方式

- 当前推荐 preset：`balanced-test`
- 当前推荐启动方式：优先使用打包版 macOS `.app`
- 当前推荐恢复方式：
  - 主线继续 -> `resume-tail`
  - 补漏 -> `resume-missing`

## 已知限制

以下问题当前真实存在：

- 开发版 GUI 仍存在不稳定现象
  - 已出现过 `npm run dev` 偶发异常退出
  - 也出现过开发态窗口白屏
  - 因此当前更推荐使用打包版 `.app`
- 真实站点仍可能在 startup gate 阶段遇到验证页，需要等待或人工完成验证
- 网络波动、站点变更或验证页仍可能导致任务中断
- 当前恢复规则已经按前向继续和补漏拆开，但这些恢复入口的所有黑盒链路仍未完全回归验证
- `fast-test` / `aggressive-test` 虽然可选，但当前不作为主线推荐
