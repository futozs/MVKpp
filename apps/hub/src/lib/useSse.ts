"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Server-Sent Events feliratkozás: minden `data:` üzenet → onMessage. Az
 * EventSource magától újracsatlakozik; `done` eseménynél lezárjuk.
 */
export function useSse<T>(url: string | null, onMessage: (data: T) => void, onDone?: (data: unknown) => void): { connected: boolean; error: string | null } {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handler = useRef(onMessage);
  const doneHandler = useRef(onDone);
  handler.current = onMessage;
  doneHandler.current = onDone;

  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url);
    es.onopen = () => {
      setConnected(true);
      setError(null);
    };
    es.onmessage = (e) => {
      try {
        handler.current(JSON.parse(e.data) as T);
      } catch {
        /* hibás sor — kihagyjuk */
      }
    };
    es.addEventListener("done", (e) => {
      doneHandler.current?.(JSON.parse((e as MessageEvent).data));
      es.close();
      setConnected(false);
    });
    es.addEventListener("notice", (e) => setError(JSON.parse((e as MessageEvent).data).msg));
    es.addEventListener("error", (e) => {
      const data = (e as MessageEvent).data;
      if (data) setError(JSON.parse(data).error);
      setConnected(false);
    });
    return () => {
      es.close();
      setConnected(false);
    };
  }, [url]);

  return { connected, error };
}
