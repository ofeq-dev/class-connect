import { useCallback, useEffect, useRef, useState } from "react";

interface ToastState {
  message: string;
  undo?: () => void;
}

/** One short message at a time with an optional Undo, gone after a few seconds. */
export function useToast(ms = 6000) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback(
    (message: string, undo?: () => void) => {
      clearTimeout(timer.current);
      setToast({ message, undo });
      timer.current = setTimeout(() => setToast(null), ms);
    },
    [ms],
  );
  const view = toast && (
    <div className="toast" role="status">
      <span>{toast.message}</span>
      {toast.undo && (
        <button
          type="button"
          className="link"
          onClick={() => {
            toast.undo?.();
            setToast(null);
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
  return { show, view };
}
