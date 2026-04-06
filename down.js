import { downloadSeries } from "./src/core/downloader.js";
import { ValidationError } from "./src/core/errors.js";

function showHelp() {
  console.log('使用法: node down.js -url "URL" [-start STARTINDEX] [-last LASTINDEX]');
}

function consoleGrey(message) {
  console.log(`\x1b[100m${message}\x1b[0m`);
}

function parseCliArguments(argv) {
  const parsed = {
    url: "",
    startIndex: undefined,
    lastIndex: undefined,
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

    if (!args.url) {
      throw new ValidationError("url을 입력하세요");
    }

    const summary = await downloadSeries({
      url: args.url,
      startIndex: args.startIndex,
      lastIndex: args.lastIndex,
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
      `완료: ${summary.completedChapters}/${summary.totalChapters} chapters, output=${summary.outputDirectory}`,
    );

    if (summary.failedChapters > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    consoleGrey(error.message ?? "다운로드 중 오류가 발생했습니다.");
    process.exitCode = 1;
  }
}

main();
