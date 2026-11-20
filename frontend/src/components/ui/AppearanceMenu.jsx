import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Moon, Sun } from "lucide-react";

const THEME_OPTIONS = [
  {
    id: "dark",
    label: "Dark — Graphite",
    swatchBg: "#18191C",
    swatchBorder: "#3A3E47"
  },
  {
    id: "light-warm",
    label: "Light — Warm Paper",
    swatchBg: "#F4EFE6",
    swatchBorder: "#C7BCAB"
  },
  {
    id: "light-crisp",
    label: "Light — Crisp Neutral",
    swatchBg: "#F8F9FA",
    swatchBorder: "#CBD2DA"
  }
];

const ACCENT_OPTIONS = [
  {
    id: "cobalt",
    label: "Atlas Cobalt",
    swatchColor: "#1D4ED8"
  },
  {
    id: "mono",
    label: "Monochrome",
    swatchLight: "#18181B",
    swatchDark: "#F1F3F5"
  }
];

export default function AppearanceMenu({ theme, accent, onChangeTheme, onChangeAccent }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const isDark = theme === "dark";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Theme & appearance"
        aria-label="Theme & appearance"
        className="h-9 px-2.5 rounded-lg border border-border-subtle bg-surface-solid hover:bg-input-bg text-text-muted hover:text-text-main inline-flex items-center gap-1.5 transition-colors"
      >
        {isDark ? <Moon size={16} strokeWidth={1.75} /> : <Sun size={16} strokeWidth={1.75} />}
        <ChevronDown
          size={13}
          strokeWidth={1.75}
          className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label="Appearance settings"
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.13, ease: [0.16, 1, 0.3, 1] }}
            className="absolute right-0 top-11 w-64 rounded-xl bg-surface-solid border border-border-subtle shadow-lg p-2 z-[75]"
          >
            <div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Theme
            </div>
            <div className="space-y-0.5">
              {THEME_OPTIONS.map((opt) => {
                const active = theme === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    onClick={() => onChangeTheme(opt.id)}
                    className={`w-full flex items-center justify-between gap-2.5 px-2.5 py-2 rounded-lg text-[13px] transition-colors ${
                      active
                        ? "bg-primary-container text-on-primary-container font-medium"
                        : "text-text-main hover:bg-input-bg"
                    }`}
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <span
                        className="w-4 h-4 rounded-md shrink-0 border"
                        style={{ backgroundColor: opt.swatchBg, borderColor: opt.swatchBorder }}
                        aria-hidden="true"
                      />
                      <span className="truncate">{opt.label}</span>
                    </span>
                    {active && <Check size={14} strokeWidth={2} className="shrink-0" />}
                  </button>
                );
              })}
            </div>

            <div className="my-2 border-t border-border-subtle" />

            <div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Primary Accent
            </div>
            <div className="space-y-0.5">
              {ACCENT_OPTIONS.map((opt) => {
                const active = accent === opt.id;
                const swatch = opt.swatchColor || (isDark ? opt.swatchDark : opt.swatchLight);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    onClick={() => onChangeAccent(opt.id)}
                    className={`w-full flex items-center justify-between gap-2.5 px-2.5 py-2 rounded-lg text-[13px] transition-colors ${
                      active
                        ? "bg-primary-container text-on-primary-container font-medium"
                        : "text-text-main hover:bg-input-bg"
                    }`}
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <span
                        className="w-4 h-4 rounded-md shrink-0 border border-border-strong"
                        style={{ backgroundColor: swatch }}
                        aria-hidden="true"
                      />
                      <span className="truncate">{opt.label}</span>
                    </span>
                    {active && <Check size={14} strokeWidth={2} className="shrink-0" />}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
