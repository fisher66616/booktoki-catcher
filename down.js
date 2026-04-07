import { downloadSeries } from "./src/core/downloader.js";
import { ValidationError } from "./src/core/errors.js";
import { DEFAULT_SCHEDULER_PRESET, SCHEDULER_PRESETS } from "./src/core/scheduler.js";

function showHelp() {
  console.log(`使用法:
  初次抓取:
    node down.js -url "URL" [-start STARTINDEX] [-last LASTINDEX] [--scheduler-preset PRESET]

  继续主线抓取:
    node down.js --resume-tail "/path/to/_session/manifest.json" [--scheduler-preset PRESET]

  补抓缺失章节:
    node down.js --resume-missing "/path/to/_session/manifest.json" [--scheduler-preset PRESET]

  可用策略预设:
    ${Object.keys(SCHEDULER_PRESETS).join(", ")}

  默认策略:
    ${DEFAULT_SCHEDULER_PRESET}`);
}

function consoleGrey(message) {
  console.log(`\x1b[100m${message}\x1b[0m`);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "未统计";
  }

  if (ms < 1000) {
    return `${ms}ms`;
  }

  if (ms < 60000) {
    return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}秒`;
  }

  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}分${seconds}秒`;
}

function parseCliArguments(argv) {
  const parsed = {
    url: "",
    startIndex: undefined,
    lastIndex: undefined,
    schedulerPreset: undefined,
    resumeTailManifestPath: undefined,
    resumeManifestPath: undefined,
  };

  if (argv.length === 2) {
    showHelp();
    process.exit(0);
  }

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "-url" && index + 1 < argv.length) {
      parsed.url = argv[index + 1];
      index += 1;
      continue;
    }

    if (current === "-start" && index + 1 < argv.length) {
      parsed.startIndex = argv[index + 1];
      index += 1;
      continue;
    }

    if (current === "-last" && index + 1 < argv.length) {
      parsed.lastIndex = argv[index + 1];
      index += 1;
      continue;
    }

    if (current === "--scheduler-preset" && index + 1 < argv.length) {
      parsed.schedulerPreset = argv[index + 1];
      index += 1;
      continue;
    }

    if (current === "--resume-missing" && index + 1 < argv.length) {
      parsed.resumeManifestPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (current === "--resume-tail" && index + 1 < argv.length) {
      parsed.resumeTailManifestPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (current === "-h" || current === "-help" || current === "--help") {
      showHelp();
      process.exit(0);
    }
  }

  return parsed;
}

async function main() {
  try {
    const args = parseCliArguments(process.argv);

    if (args.resumeTailManifestPath && args.resumeManifestPath) {
      throw new ValidationError("不能同时使用 --resume-tail 和 --resume-missing");
    }

    if (!args.url && !args.resumeManifestPath && !args.resumeTailManifestPath) {
      throw new ValidationError("url을 입력하세요");
    }

    const summary = await downloadSeries({
      url: args.url,
      startIndex: args.startIndex,
      lastIndex: args.lastIndex,
      resumeTailManifestPath: args.resumeTailManifestPath,
      resumeManifestPath: args.resumeManifestPath,
      schedulerPreset: args.schedulerPreset,
      outputRoot: process.cwd(),
      outputMode: "legacy-site-root",
      onLog: (entry) => {
        console.log(entry.message);
      },
      onStatus: (event) => {
        console.log(`[${event.status}] ${event.message}`);
      },
    });

    console.log(
      `任务结束: ${summary.completedChapters}/${summary.totalChapters} chapters, status=${summary.finalStatus}, output=${summary.outputDirectory}`,
    );
    if (summary.failureStage) {
      console.log(`failureStage: ${summary.failureStage}`);
    }
    if (summary.failureReason) {
      console.log(`failureReason: ${summary.failureReason}`);
    }
    if (summary.resumeDisposition && summary.resumeDisposition !== "started") {
      console.log(`resumeDisposition: ${summary.resumeDisposition}`);
    }
    if (summary.manifestPath) {
      console.log(`manifest: ${summary.manifestPath}`);
    }
    if (summary.reportPath) {
      console.log(`report: ${summary.reportPath}`);
    }
    console.log(
      `latestSuccess=${summary.latestSuccessOrder ?? "无"}, nextForward=${summary.nextForwardOrder ?? "无"}, missing=${summary.missingCount}`,
    );
    console.log(
      `总耗时=${formatDuration(summary.totalDurationMs)}, 平均每章=${formatDuration(summary.averageChapterDurationMs)}, 有效速度=${summary.effectiveChaptersPerMinute ?? "未统计"} 章/分钟`,
    );
    console.log(
      `startup验证=${formatDuration(summary.startupVerificationDurationMs)}, scheduler等待=${formatDuration(summary.schedulerDelayTotalMs)}, 页面稳定等待=${formatDuration(summary.pageStabilityDelayTotalMs)}`,
    );

    if (summary.finalStatus !== "completed" && summary.resumeDisposition === "started") {
      process.exitCode = 1;
    }
  } catch (error) {
    consoleGrey(error.message ?? "다운로드 중 오류가 발생했습니다.");
    process.exitCode = 1;
  }
}

main();
