"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * 智能轮询 hook：仅在 hasRunningTask=true 时启动轮询。
 * 支持指数退避：2s → 4s → 8s → 15s（上限）。
 * 无运行任务时完全停止，停止时自动触发一次 load 以同步最终状态。
 */
export function usePolling(
  load: () => Promise<void>,
  hasRunningTask: boolean,
  {
    minInterval = 2000,
    maxInterval = 15000,
    backoffFactor = 2,
  } = {}
) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentIntervalRef = useRef(minInterval);
  const loadRef = useRef(load);
  // render 期间不允许写 ref（React Compiler 规则），改为 effect 中同步最新 load
  useEffect(() => {
    loadRef.current = load;
  });

  const startPolling = useCallback(() => {
    if (intervalRef.current) return; // 已在轮询
    currentIntervalRef.current = minInterval;

    const tick = async () => {
      try {
        await loadRef.current();
      } catch {
        // 轮询请求失败不中断轮询（避免 unhandled rejection，也不让轮询死掉）
      }
      // 指数退避
      const next = Math.min(
        currentIntervalRef.current * backoffFactor,
        maxInterval
      );
      currentIntervalRef.current = next;
      // 重新调度（间隔可能变化）
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = setInterval(() => void tick(), currentIntervalRef.current);
      }
    };

    intervalRef.current = setInterval(() => void tick(), currentIntervalRef.current);
  }, [minInterval, maxInterval, backoffFactor]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      currentIntervalRef.current = minInterval;
    }
  }, [minInterval]);

  useEffect(() => {
    if (hasRunningTask) {
      startPolling();
    } else {
      stopPolling();
      // 停止时同步一次最终状态（失败静默，不产生 unhandled rejection）
      loadRef.current().catch(() => {});
    }
    return () => stopPolling();
  }, [hasRunningTask, startPolling, stopPolling]);
}
