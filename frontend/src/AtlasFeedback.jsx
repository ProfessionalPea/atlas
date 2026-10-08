import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const AtlasFeedbackContext = createContext(null);

function compactCopy(message) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) return "Continue?";

  const cleaned = text
    .replace(/^Are you sure you want to\s+/i, "")
    .replace(/^Permanently\s+/i, "")
    .replace(/\s*This cannot be undone\.?$/i, "")
    .trim();

  if (cleaned.length <= 170) return cleaned;
  const firstSentence = cleaned.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim();
  if (firstSentence && firstSentence.length <= 170) return firstSentence;
  return `${cleaned.slice(0, 167).trimEnd()}…`;
}

function inferConfirmMeta(message, options = {}) {
  const text = String(message || "");
  const destructive = options.destructive ?? /delete|permanent|clear|abort/i.test(text);
  const title = options.title
    || (/delete|permanent/i.test(text)
      ? "Confirm deletion"
      : /abort/i.test(text)
        ? "Abort scan?"
        : /clear/i.test(text)
          ? "Clear view?"
          : /suspend/i.test(text)
            ? "Confirm change"
            : "Confirm action");
  const confirmLabel = options.confirmLabel
    || (/abort/i.test(text)
      ? "Abort"
      : /clear/i.test(text)
        ? "Clear"
        : /delete|permanent/i.test(text)
          ? "Delete"
          : /restore/i.test(text)
            ? "Restore"
            : /suspend/i.test(text)
              ? "Suspend"
              : "Continue");

  return { title, confirmLabel, destructive };
}

export function AtlasFeedbackProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const queueRef = useRef([]);
  const activeRef = useRef(null);

  const advance = useCallback(() => {
    if (activeRef.current || queueRef.current.length === 0) return;
    const next = queueRef.current.shift();
    activeRef.current = next;
    setDialog(next);
  }, []);

  const request = useCallback((entry) => new Promise(resolve => {
    queueRef.current.push({ ...entry, resolve });
    advance();
  }), [advance]);

  const confirm = useCallback((message, options = {}) => {
    const meta = inferConfirmMeta(message, options);
    return request({
      kind: "confirm",
      message: compactCopy(message),
      ...meta
    });
  }, [request]);

  const inform = useCallback((message, options = {}) => request({
    kind: "info",
    title: options.title || (/^Please\b/i.test(String(message || "")) ? "Action needed" : "Atlas"),
    message: compactCopy(message),
    confirmLabel: options.confirmLabel || "OK",
    destructive: false
  }), [request]);

  const settle = useCallback((value) => {
    const current = activeRef.current;
    activeRef.current = null;
    setDialog(null);
    current?.resolve(value);
    queueMicrotask(advance);
  }, [advance]);

  useEffect(() => {
    window.__atlasConfirm = confirm;
    window.__atlasAlert = (message, options) => { void inform(message, options); };
    return () => {
      if (window.__atlasConfirm === confirm) delete window.__atlasConfirm;
      delete window.__atlasAlert;
      activeRef.current?.resolve(false);
      queueRef.current.forEach(item => item.resolve(false));
      queueRef.current = [];
    };
  }, [confirm, inform]);

  useEffect(() => {
    if (!dialog) return undefined;
    const onKeyDown = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        settle(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dialog, settle]);

  return (
    <AtlasFeedbackContext.Provider value={{ confirm, inform }}>
      {children}
      {dialog && (
        <div
          className="atlas-feedback-layer fixed inset-0 z-[220] flex items-center justify-center p-4 bg-black/20"
          onMouseDown={event => {
            if (event.target === event.currentTarget) settle(false);
          }}
        >
          <section
            role={dialog.kind === "confirm" ? "alertdialog" : "dialog"}
            aria-modal="true"
            aria-labelledby="atlas-feedback-title"
            className="w-full max-w-[360px] rounded-2xl border border-border-subtle bg-surface-solid shadow-2xl px-4 py-4 text-text-main"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id="atlas-feedback-title" className="text-[15px] font-semibold tracking-[-0.01em]">
                  {dialog.title}
                </h2>
                <p className="mt-1.5 text-[11px] leading-5 text-text-muted break-words">
                  {dialog.message}
                </p>
              </div>
              <button
                type="button"
                onClick={() => settle(false)}
                className="w-8 h-8 -mt-1 -mr-1 rounded-full text-text-muted hover:text-text-main hover:bg-input-bg flex items-center justify-center flex-shrink-0"
                aria-label="Close"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              {dialog.kind === "confirm" && (
                <button
                  type="button"
                  onClick={() => settle(false)}
                  className="h-9 px-3.5 rounded-xl border border-border-subtle bg-surface-solid text-[11px] font-medium hover:bg-input-bg"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                autoFocus
                onClick={() => settle(true)}
                className={dialog.destructive
                  ? "h-9 px-3.5 rounded-xl border border-urgent-red/25 bg-urgent-red/10 text-urgent-red text-[11px] font-semibold hover:bg-urgent-red/15"
                  : "h-9 px-3.5 rounded-xl bg-electric-blue text-white text-[11px] font-semibold hover:brightness-105"}
              >
                {dialog.confirmLabel}
              </button>
            </div>
          </section>
        </div>
      )}
    </AtlasFeedbackContext.Provider>
  );
}

export function useAtlasFeedback() {
  const value = useContext(AtlasFeedbackContext);
  if (!value) throw new Error("useAtlasFeedback must be used inside AtlasFeedbackProvider");
  return value;
}
