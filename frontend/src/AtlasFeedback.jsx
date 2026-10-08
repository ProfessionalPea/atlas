import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

const AtlasFeedbackContext = createContext(null);
const POPOVER_WIDTH = 320;
const VIEWPORT_GAP = 12;

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

export function AtlasFeedbackProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const queueRef = useRef([]);
  const activeRef = useRef(null);
  const anchorRef = useRef(null);

  const advance = useCallback(() => {
    if (activeRef.current || queueRef.current.length === 0) return;
    const next = queueRef.current.shift();
    activeRef.current = next;
    setDialog(next);
  }, []);

  const request = useCallback((entry) => new Promise(resolve => {
    queueRef.current.push({ ...entry, anchor: entry.anchor || anchorRef.current, resolve });
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
    queueMicrotask(advance);
  }, [advance]);

  useEffect(() => {
    const capturePointer = event => {
      anchorRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointerdown", capturePointer, true);
    return () => window.removeEventListener("pointerdown", capturePointer, true);
  }, []);

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

  const popoverStyle = useMemo(() => getPopoverPosition(dialog?.anchor), [dialog]);

  return (
    <AtlasFeedbackContext.Provider value={{ confirm, inform }}>
      {children}
      {dialog && (
        <div className="atlas-feedback-layer fixed inset-0 z-[220] pointer-events-none">
          <section
            role={dialog.kind === "confirm" ? "alertdialog" : "dialog"}
            aria-modal="false"
            aria-labelledby="atlas-feedback-title"
            className="atlas-feedback-card fixed w-[320px] max-w-[calc(100vw-24px)] pointer-events-auto rounded-[14px] border shadow-xl px-3.5 py-3"
            style={popoverStyle}
          >
            <div className="flex items-start gap-2.5">
              <div className="min-w-0 flex-1">
                <h2 id="atlas-feedback-title" className="atlas-feedback-title text-[16px] leading-5 font-semibold tracking-[-0.01em]">
                  {dialog.title}
                </h2>
                <p className="atlas-feedback-message mt-1 text-[14px] leading-5 break-words">
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
                  onClick={() => settle(false)}
                  className="atlas-feedback-secondary h-9 px-3.5 rounded-lg border text-[13px] font-medium"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                autoFocus
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
    </AtlasFeedbackContext.Provider>
  );
}

export function useAtlasFeedback() {
  const value = useContext(AtlasFeedbackContext);
  if (!value) throw new Error("useAtlasFeedback must be used inside AtlasFeedbackProvider");
  return value;
}
