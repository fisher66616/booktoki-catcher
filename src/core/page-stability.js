import { CancelledError } from "./errors.js";

export const PAGE_STABILITY_DEFAULTS = {
  siteReadyPollMs: 500,
  listPageSettleMs: 800,
  chapterNavigationSettleMs: 1500,
  comicImageSettleMs: 1000,
  siteReadyTimeoutMs: 120000,
};

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function resolvePageStabilityConfig(overrides = {}) {
  return {
    ...PAGE_STABILITY_DEFAULTS,
    ...overrides,
  };
}

export async function waitForAbortableDelay(ms, signal) {
  if (signal?.aborted) {
    throw new CancelledError();
  }

  await Promise.race([
    delay(ms),
    new Promise((_, reject) => {
      if (!signal) {
        return;
      }

      signal.addEventListener(
        "abort",
        () => {
          reject(new CancelledError());
        },
        { once: true },
      );
    }),
  ]);
}

async function waitForNamedDelay(ms, label, signal, log) {
  if (ms <= 0) {
    return;
  }

  if (typeof log === "function") {
    log(`页面稳定等待 ${ms}ms（${label}）`);
  }

  await waitForAbortableDelay(ms, signal);
}

export function createPageStability(config, { log, signal } = {}) {
  const metrics = {
    totalDelayMs: 0,
    siteReadyPollDelayTotalMs: 0,
    listPageSettleDelayTotalMs: 0,
    chapterNavigationSettleDelayTotalMs: 0,
    comicImageSettleDelayTotalMs: 0,
  };

  async function waitWithMetric(ms, label, metricKey, shouldLog = true) {
    if (ms <= 0) {
      return;
    }

    metrics.totalDelayMs += ms;
    metrics[metricKey] += ms;

    if (shouldLog) {
      await waitForNamedDelay(ms, label, signal, log);
      return;
    }

    await waitForAbortableDelay(ms, signal);
  }

  return {
    config,
    waitForSiteReadyPoll: () =>
      waitWithMetric(config.siteReadyPollMs, "站点可访问轮询", "siteReadyPollDelayTotalMs", false),
    waitForListPageSettle: () =>
      waitWithMetric(config.listPageSettleMs, "目录页 settle", "listPageSettleDelayTotalMs"),
    waitForChapterNavigationSettle: () =>
      waitWithMetric(
        config.chapterNavigationSettleMs,
        "章节页 settle",
        "chapterNavigationSettleDelayTotalMs",
      ),
    waitForComicImageSettle: () =>
      waitWithMetric(config.comicImageSettleMs, "漫画图片 settle", "comicImageSettleDelayTotalMs"),
    getMetrics: () => ({ ...metrics }),
  };
}
