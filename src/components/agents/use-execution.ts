"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/utils";
import type { ExecutionDetail } from "./types";

const ACTIVE = new Set(["queued", "running"]);

/**
 * Polls GET /api/executions/:id while the run is queued or running.
 * 2s interval for the first 30s, then 5s. Stops on a final status.
 */
export function useExecution(initial: ExecutionDetail | null) {
  const [execution, setExecution] = useState<ExecutionDetail | null>(initial);
  const [pollError, setPollError] = useState<string | null>(null);
  const startedAt = useRef<number | null>(null);

  const id = execution?.id;
  const status = execution?.status;

  useEffect(() => {
    if (!id || !status || !ACTIVE.has(status)) return;
    let cancelled = false;
    startedAt.current ??= Date.now();
    const elapsed = Date.now() - startedAt.current;
    const timer = setTimeout(
      async () => {
        try {
          const { execution: next } = await api<{ execution: ExecutionDetail }>(`/api/executions/${id}`);
          if (!cancelled) {
            setPollError(null);
            setExecution(next);
          }
        } catch (err) {
          if (!cancelled) {
            setPollError((err as Error).message);
            // Keep polling: trigger the effect again with a fresh object.
            setExecution((e) => (e ? { ...e } : e));
          }
        }
      },
      elapsed < 30_000 ? 2000 : 5000,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, status, execution]);

  function select(next: ExecutionDetail | null) {
    startedAt.current = null;
    setPollError(null);
    setExecution(next);
  }

  return { execution, select, pollError, isActive: Boolean(status && ACTIVE.has(status)) };
}
