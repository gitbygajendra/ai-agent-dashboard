"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/utils";

type FetchState<T> = { key: string | null; data: T | undefined; error: string | null };

/**
 * Minimal client data loader: refetches when `url` or `refreshKey` change, keeps
 * the previous data while a new request is in flight, and aborts stale requests.
 */
export function useFetch<T>(url: string | null, refreshKey: string | number = 0) {
  const [nonce, setNonce] = useState(0);
  const key = url ? `${url}|${refreshKey}|${nonce}` : null;
  const [state, setState] = useState<FetchState<T>>({ key: null, data: undefined, error: null });

  useEffect(() => {
    if (!url || !key) return;
    const ctrl = new AbortController();
    api<T>(url, { signal: ctrl.signal }).then(
      (data) => setState({ key, data, error: null }),
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        setState((s) => ({ key, data: s.data, error: err instanceof Error ? err.message : "Request failed." }));
      },
    );
    return () => ctrl.abort();
  }, [url, key]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const mutate = useCallback((fn: (d: T | undefined) => T | undefined) => setState((s) => ({ ...s, data: fn(s.data) })), []);

  return {
    data: state.data,
    error: state.key === key ? state.error : null,
    loading: key !== null && state.key !== key,
    reload,
    mutate,
  };
}

export function useDebounced<T>(value: T, ms = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const noopSubscribe = () => () => {};

/** False during SSR and hydration, true afterwards (for timezone-dependent output). */
export function useHydrated() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
