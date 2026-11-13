import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

const AtlasFeedbackContext = createContext(null);
const POPOVER_WIDTH = 320;
const VIEWPORT_GAP = 12;
const MAX_TOASTS = 3;

let feedbackBridge = null;

function compactCopy(message) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) return "Continue?";

  const cleaned = text
    .replace(/^Are you sure you want to\s+/i, "")
    .replace(/^Permanently\s+/i, "")
    .replace(/\s*This cannot be undone\.?$/i, "")
    .trim();

  const firstSentence = cleaned.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim();
  if (firstSentence && firstSentence.length <= 135) return firstSentence;
  if (cleaned.length <= 135) return cleaned;
  return `${cleaned.slice(0, 132).trimEnd()}…`;
}

function inferConfirmMeta(message, options = {}) {
  const text = String(message || "").trim();
  const isRestore = /^restore\b/i.test(text);
  const isSuspend = !isRestore && (
    /^suspend\b/i.test(text) ||
    /^mark\b.*\bsuspended\b/i.test(text) ||
    /\bmark\b.*\bsuspend(?:ed)?\b/i.test(text)
  );

  const destructive = options.destructive ?? (/delete|permanent|clear|abort/i.test(text) || isSuspend);
  const title = options.title
    || (/delete|permanent/i.test(text)
      ? "Delete?"
      : /abort/i.test(text)
        ? "Abort scan?"
        : /clear/i.test(text)
          ? "Clear?"
          : isSuspend
            ? "Mark as suspended?"
            : isRestore
              ? "Restore?"
              : "Confirm action");
  const confirmLabel = options.confirmLabel
    || (/abort/i.test(text)
      ? "Abort"
      : /clear/i.test(text)
        ? "Clear"
        : /delete|permanent/i.test(text)
          ? "Delete"
          : isSuspend
            ? "Suspend"
            : isRestore
              ? "Restore"
              : "Continue");

  return { title, confirmLabel, destructive };
}

function getPopoverPosition(anchor) {
  if (typeof window === "undefined" || !anchor) {
    return {
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)"
    };
  }

  const viewportWidth = window.innerWidth || 1280;
  const viewportHeight = window.innerHeight || 720;
  const left = Math.max(
    VIEWPORT_GAP,
    Math.min(anchor.x - POPOVER_WIDTH + 34, viewportWidth - POPOVER_WIDTH - VIEWPORT_GAP)
  );
  const preferAbove = anchor.y > viewportHeight * 0.62;
  const top = preferAbove
    ? Math.max(VIEWPORT_GAP, anchor.y - 154)
    : Math.min(viewportHeight - 170, anchor.y + 12);

  return { left, top };
}

function getFocusableTrigger(target) {
  if (!(target instanceof Element)) return null;
  const candidate = target.closest('button, a[href], input, select, textarea, [role="button"], [tabindex]');
  return candidate instanceof HTMLElement ? candidate : null;
}

export function AtlasFeedbackProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const [toasts, setToasts] = useState([]);
  const queueRef = useRef([]);
  const activeRef = useRef(null);
  const anchorRef = useRef(null);
  const triggerRef = useRef(null);
  const cardRef = useRef(null);
  const toastTimersRef = useRef(new Map());
  const toastSeqRef = useRef(0);

  const dismissToast = useCallback((id) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((message, options = {}) => {
    const text = String(message || "").trim();
    if (!text) return null;
    const tone = ["success", "info", "amber", "danger"].includes(options.tone) ? options.tone : "info";
    const duration = typeof options.duration === "number" ? options.duration : 3200;
    const id = ++toastSeqRef.current;

    setToasts((prev) => {
      const next = [...prev, { id, message: text, tone }];
      if (next.length <= MAX_TOASTS) return next;
      const dropped = next.slice(0, next.length - MAX_TOASTS);
      dropped.forEach((d) => {
        const t = toastTimersRef.current.get(d.id);
        if (t) {
          clearTimeout(t);
          toastTimersRef.current.delete(d.id);
        }
      });
      return next.slice(-MAX_TOASTS);
    });

    if (duration > 0) {
      const timer = setTimeout(() => {
        dismissToast(id);
      }, duration);
      toastTimersRef.current.set(id, timer);
    }

    return id;
  }, [dismissToast]);

  const copy = useCallback(async (value, label = "Copied to clipboard") => {
    const text = String(value ?? "").trim();
    if (!text) return false;
    let copied = false;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }

    if (!copied && typeof document !== "undefined") {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        ta.style.pointerEvents = "none";
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        copied = false;
      }
    }

    if (copied) {
      const preview = text.length > 44 ? `${text.slice(0, 41)}...` : text;
      toast(`${label}: ${preview}`, { tone: "success", duration: 2200 });
    } else {
      toast("Unable to copy to clipboard.", { tone: "danger", duration: 2600 });
    }
    return copied;
  }, [toast]);

  const advance = useCallback(() => {
    if (activeRef.current || queueRef.current.length === 0) return;
    const next = queueRef.current.shift();
    activeRef.current = next;
    setDialog(next);
  }, []);

  const request = useCallback((entry) => new Promise(resolve => {
    queueRef.current.push({
      ...entry,
      anchor: entry.anchor || anchorRef.current,
      returnFocus: entry.returnFocus || triggerRef.current || document.activeElement,
      resolve
    });
    advance();
  }), [advance]);

  const confirm = useCallback((message, options = {}) => {
    const meta = inferConfirmMeta(message, options);
    return request({
      kind: "confirm",
      message: compactCopy(message),
      anchor: options.anchor || null,
      ...meta
    });
  }, [request]);

  const inform = useCallback((message, options = {}) => request({
    kind: "info",
    title: options.title || (/^Please\b/i.test(String(message || "")) ? "Action needed" : "Atlas"),
    message: compactCopy(message),
    confirmLabel: options.confirmLabel || "OK",
    destructive: false,
    anchor: options.anchor || null
  }), [request]);

  const settle = useCallback((value) => {
    const current = activeRef.current;
    activeRef.current = null;
    setDialog(null);
    current?.resolve(value);

    queueMicrotask(() => {
      if (queueRef.current.length === 0 && current?.returnFocus instanceof HTMLElement && current.returnFocus.isConnected) {
        try { current.returnFocus.focus({ preventScroll: true }); } catch {}
      }
      advance();
    });
  }, [advance]);

  useEffect(() => {
    const capturePointer = event => {
      anchorRef.current = { x: event.clientX, y: event.clientY };
      const trigger = getFocusableTrigger(event.target);
      if (trigger) triggerRef.current = trigger;
    };
    window.addEventListener("pointerdown", capturePointer, true);
    return () => window.removeEventListener("pointerdown", capturePointer, true);
  }, []);

  useEffect(() => {
    const api = { confirm, inform, toast, dismissToast, copy };
    feedbackBridge = api;
    window.__atlasConfirm = confirm;
    window.__atlasAlert = (message, options) => { void inform(message, options); };
    window.__atlasToast = toast;
    window.__atlasCopy = copy;
    return () => {
      if (feedbackBridge === api) feedbackBridge = null;
      if (window.__atlasConfirm === confirm) delete window.__atlasConfirm;
      delete window.__atlasAlert;
      if (window.__atlasToast === toast) delete window.__atlasToast;
      if (window.__atlasCopy === copy) delete window.__atlasCopy;
      activeRef.current?.resolve(false);
      queueRef.current.forEach(item => item.resolve(false));
      queueRef.current = [];
      toastTimersRef.current.forEach(timer => clearTimeout(timer));
      toastTimersRef.current.clear();
    };
  }, [confirm, inform, toast, dismissToast, copy]);

  useEffect(() => {
    if (!dialog) return undefined;

    const onKeyDown = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        settle(false);
      }
    };

    const onPointerDown = event => {
      if (cardRef.current?.contains(event.target)) return;
      settle(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [dialog, settle]);

  const popoverStyle = useMemo(() => getPopoverPosition(dialog?.anchor), [dialog]);

  const contextValue = useMemo(
    () => ({ confirm, inform, toast, dismissToast, copy }),
    [confirm, inform, toast, dismissToast, copy]
  );

  const toastToneMeta = {
    success: { icon: "check_circle", iconClass: "text-emerald-500" },
    info: { icon: "info", iconClass: "text-electric-blue" },
    amber: { icon: "warning", iconClass: "text-amber-500" },
    danger: { icon: "error", iconClass: "text-urgent-red" }
  };

  return (
    <AtlasFeedbackContext.Provider value={contextValue}>
      {children}
      {dialog && (
        <div className="atlas-feedback-layer fixed inset-0 z-[220] pointer-events-none">
          <section
            ref={cardRef}
            role={dialog.kind === "confirm" ? "alertdialog" : "dialog"}
            aria-modal="false"
            aria-labelledby="atlas-feedback-title"
            aria-describedby="atlas-feedback-message"
            className="atlas-feedback-card fixed w-[320px] max-w-[calc(100vw-24px)] pointer-events-auto rounded-[14px] border shadow-xl px-3.5 py-3"
            style={popoverStyle}
          >
            <div className="flex items-start gap-2.5">
              <div className="min-w-0 flex-1">
                <h2 id="atlas-feedback-title" className="atlas-feedback-title text-[16px] leading-5 font-semibold tracking-[-0.01em]">
                  {dialog.title}
                </h2>
                <p id="atlas-feedback-message" className="atlas-feedback-message mt-1 text-[14px] leading-5 break-words">
                  {dialog.message}
                </p>
              </div>
              <button
                type="button"
                onClick={() => settle(false)}
                className="atlas-feedback-close w-7 h-7 -mt-0.5 -mr-0.5 rounded-lg flex items-center justify-center flex-shrink-0"
                aria-label="Close"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="mt-3 flex justify-end gap-2">
              {dialog.kind === "confirm" && (
                <button
                  type="button"
                  autoFocus
                  onClick={() => settle(false)}
                  className="atlas-feedback-secondary h-9 px-3.5 rounded-lg border text-[13px] font-medium"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                autoFocus={dialog.kind !== "confirm"}
                onClick={() => settle(true)}
                className={dialog.destructive
                  ? "atlas-feedback-danger h-9 px-3.5 rounded-lg border text-[13px] font-semibold"
                  : "atlas-feedback-primary h-9 px-3.5 rounded-lg border text-[13px] font-semibold"}
              >
                {dialog.confirmLabel}
              </button>
            </div>
          </section>
        </div>
      )}
      {toasts.length > 0 && (
        <div
          aria-live="polite"
          aria-atomic="false"
          className="fixed bottom-5 right-5 z-[10001] pointer-events-none flex flex-col items-end gap-2 max-w-[calc(100vw-24px)]"
        >
          {toasts.map((item) => {
            const meta = toastToneMeta[item.tone] || toastToneMeta.info;
            return (
              <div
                key={item.id}
                role="status"
                data-tone={item.tone}
                className="atlas-toast-card pointer-events-auto flex items-center gap-2.5 max-w-[380px] rounded-xl border px-3.5 py-2.5 shadow-lg text-[13px] font-medium"
              >
                <span className={`material-symbols-outlined text-[18px] shrink-0 ${meta.iconClass}`}>
                  {meta.icon}
                </span>
                <span className="leading-snug break-words flex-1">{item.message}</span>
                <button
                  type="button"
                  onClick={() => dismissToast(item.id)}
                  className="atlas-feedback-close w-6 h-6 -mr-1 rounded-md flex items-center justify-center shrink-0"
                  aria-label="Dismiss notification"
                >
                  <span className="material-symbols-outlined text-[15px]">close</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </AtlasFeedbackContext.Provider>
  );
}

export const AtlasFeedback = {
  confirm(message, options) {
    if (feedbackBridge?.confirm) return feedbackBridge.confirm(message, options);
    if (typeof window !== "undefined" && typeof window.__atlasConfirm === "function") {
      return window.__atlasConfirm(message, options);
    }
    return Promise.resolve(false);
  },
  inform(message, options) {
    if (feedbackBridge?.inform) return feedbackBridge.inform(message, options);
    if (typeof window !== "undefined" && typeof window.__atlasAlert === "function") {
      window.__atlasAlert(message, options);
    }
    return Promise.resolve();
  },
  toast(message, options) {
    if (feedbackBridge?.toast) return feedbackBridge.toast(message, options);
    if (typeof window !== "undefined" && typeof window.__atlasToast === "function") {
      return window.__atlasToast(message, options);
    }
    return null;
  },
  dismissToast(id) {
    if (feedbackBridge?.dismissToast) feedbackBridge.dismissToast(id);
  },
  copy(value, label) {
    if (feedbackBridge?.copy) return feedbackBridge.copy(value, label);
    if (typeof window !== "undefined" && typeof window.__atlasCopy === "function") {
      return window.__atlasCopy(value, label);
    }
    return Promise.resolve(false);
  }
};

export function useAtlasFeedback() {
  const value = useContext(AtlasFeedbackContext);
  if (!value) throw new Error("useAtlasFeedback must be used inside AtlasFeedbackProvider");
  return value;
}

export default AtlasFeedback;
