import { CancelledError } from "./errors.js";
import { waitForAbortableDelay } from "./page-stability.js";

export const DEFAULT_SCHEDULER_PRESET = "balanced-test";

export const SCHEDULER_PRESETS = {
  "balanced-test": {
    chapterDelayMinMs: 2000,
    chapterDelayMaxMs: 3000,
    burstSize: 30,
    burstCooldownMinMs: 15000,
    burstCooldownMaxMs: 30000,
    maxImmediateRetryPerChapter: 0,
    retryCooldownMinMs: 15000,
    retryCooldownMaxMs: 30000,
    stopOnSuspectedBlock: true,
    consecutiveFailureThreshold: 3,
  },
  "fast-test": {
    chapterDelayMinMs: 2000,
    chapterDelayMaxMs: 3000,
    burstSize: 0,
    burstCooldownMinMs: 0,
    burstCooldownMaxMs: 0,
    maxImmediateRetryPerChapter: 0,
    retryCooldownMinMs: 15000,
    retryCooldownMaxMs: 30000,
    stopOnSuspectedBlock: true,
    consecutiveFailureThreshold: 2,
  },
  "aggressive-test": {
    chapterDelayMinMs: 1500,
    chapterDelayMaxMs: 2200,
    burstSize: 0,
    burstCooldownMinMs: 0,
    burstCooldownMaxMs: 0,
    maxImmediateRetryPerChapter: 0,
    retryCooldownMinMs: 15000,
    retryCooldownMaxMs: 30000,
    stopOnSuspectedBlock: true,
    consecutiveFailureThreshold: 2,
  },
  safe: {
    chapterDelayMinMs: 3000,
    chapterDelayMaxMs: 5000,
    burstSize: 20,
    burstCooldownMinMs: 30000,
    burstCooldownMaxMs: 45000,
    maxImmediateRetryPerChapter: 1,
    retryCooldownMinMs: 30000,
    retryCooldownMaxMs: 45000,
    stopOnSuspectedBlock: true,
    consecutiveFailureThreshold: 2,
  },
};

function randomBetween(min, max) {
  const lower = Math.max(0, Math.min(min, max));
  const upper = Math.max(lower, Math.max(min, max));
  if (lower === upper) {
    return lower;
  }

  return lower + Math.floor(Math.random() * (upper - lower + 1));
}

export function resolveSchedulerConfig(presetName = DEFAULT_SCHEDULER_PRESET) {
  const preset = SCHEDULER_PRESETS[presetName];
  if (!preset) {
    const available = Object.keys(SCHEDULER_PRESETS).join(", ");
    throw new Error(`未知 scheduler preset: ${presetName}。可用值: ${available}`);
  }

  return {
    presetName,
    config: { ...preset },
  };
}

async function waitWithLog(delayMs, message, signal, log) {
  if (delayMs <= 0) {
    return;
  }

  if (typeof log === "function") {
    log(message);
  }

  await waitForAbortableDelay(delayMs, signal);
}

export function createScheduler(config, { log, signal } = {}) {
  const state = {
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
  };
  const metrics = {
    totalDelayMs: 0,
    chapterDelayTotalMs: 0,
    burstCooldownTotalMs: 0,
    retryCooldownTotalMs: 0,
  };

  function resetFailureWindow() {
    state.consecutiveFailures = 0;
    state.consecutiveSuccesses = 0;
  }

  function shouldStopForConsecutiveFailures() {
    return (
      config.stopOnSuspectedBlock === true &&
      state.consecutiveFailures >= config.consecutiveFailureThreshold
    );
  }

  async function afterChapter({ outcome, hasMoreQueued }) {
    if (outcome === "success") {
      state.consecutiveFailures = 0;
      state.consecutiveSuccesses += 1;
    } else {
      state.consecutiveFailures += 1;
      state.consecutiveSuccesses = 0;
    }

    if (shouldStopForConsecutiveFailures()) {
      return {
        shouldStop: true,
        blockedReason: `连续 ${state.consecutiveFailures} 章异常，疑似验证页或封禁`,
      };
    }

    if (!hasMoreQueued) {
      return {
        shouldStop: false,
        waited: false,
      };
    }

    if (
      outcome === "success" &&
      config.burstSize > 0 &&
      state.consecutiveSuccesses > 0 &&
      state.consecutiveSuccesses % config.burstSize === 0
    ) {
      const delayMs = randomBetween(config.burstCooldownMinMs, config.burstCooldownMaxMs);
      metrics.totalDelayMs += delayMs;
      metrics.burstCooldownTotalMs += delayMs;
      await waitWithLog(
        delayMs,
        `已连续成功 ${state.consecutiveSuccesses} 章，执行批次冷却 ${delayMs}ms。`,
        signal,
        log,
      );

      return {
        shouldStop: false,
        waited: true,
        waitKind: "burstCooldown",
        waitMs: delayMs,
      };
    }

    const delayMs = randomBetween(config.chapterDelayMinMs, config.chapterDelayMaxMs);
    metrics.totalDelayMs += delayMs;
    metrics.chapterDelayTotalMs += delayMs;
    await waitWithLog(delayMs, `调度等待 ${delayMs}ms 后继续下一章。`, signal, log);

    return {
      shouldStop: false,
      waited: true,
      waitKind: "chapterDelay",
      waitMs: delayMs,
    };
  }

  function shouldRetryChapter(chapter) {
    return chapter.attempts <= config.maxImmediateRetryPerChapter;
  }

  async function waitBeforeRetry(chapter) {
    if (shouldRetryChapter(chapter) === false) {
      return false;
    }

    const delayMs = randomBetween(config.retryCooldownMinMs, config.retryCooldownMaxMs);
    metrics.totalDelayMs += delayMs;
    metrics.retryCooldownTotalMs += delayMs;
    await waitWithLog(
      delayMs,
      `章节将执行第 ${chapter.attempts + 1} 次尝试，重试冷却 ${delayMs}ms。`,
      signal,
      log,
    );
    return true;
  }

  return {
    config,
    state,
    afterChapter,
    shouldRetryChapter,
    waitBeforeRetry,
    resetFailureWindow,
    getState: () => ({ ...state }),
    getMetrics: () => ({ ...metrics }),
  };
}
