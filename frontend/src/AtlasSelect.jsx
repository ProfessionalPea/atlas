import { useEffect, useMemo, useRef, useState } from "react";

export default function AtlasSelect({ value, onChange, options = [], ariaLabel = "Choose option" }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = useMemo(() => options.find(option => option.value === value) || options[0], [options, value]);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        className="h-11 min-w-[172px] rounded-[14px] border border-border-subtle bg-input-bg px-3.5 text-[11px] font-medium text-text-main shadow-sm transition-colors hover:bg-surface-solid flex items-center justify-between gap-3"
      >
        <span className="truncate">{selected?.label || "Select"}</span>
        <span className={`material-symbols-outlined text-[17px] text-text-muted transition-transform ${open ? "rotate-180" : ""}`}>expand_more</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className="absolute right-0 top-[calc(100%+7px)] z-[80] w-[210px] overflow-hidden rounded-[14px] border border-border-subtle bg-surface-solid p-1.5 shadow-xl"
        >
          {options.map(option => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange?.(option.value);
                  setOpen(false);
                }}
                className={`w-full rounded-[10px] px-3 py-2.5 text-left text-[11px] transition-colors flex items-center justify-between gap-3 ${active ? "bg-input-bg text-text-main" : "text-text-muted hover:bg-input-bg/70 hover:text-text-main"}`}
              >
                <span>{option.label}</span>
                {active && <span className="material-symbols-outlined text-[16px] text-electric-blue">check</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
