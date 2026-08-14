"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 自动消失的错误提示 hook：setError 后 5s 自动清除
 */
export function useAutoError(timeoutMs = 5000) {
  const [error, setErrorInner] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setError = useCallback((msg: string | null) => {
    setErrorInner(msg);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (msg) {
      timerRef.current = setTimeout(() => setErrorInner(null), timeoutMs);
    }
  }, [timeoutMs]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return [error, setError] as const;
}
