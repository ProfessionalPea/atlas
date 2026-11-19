import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import AtlasIcon from "./components/ui/AtlasIcon.jsx";

export default function AtlasSelect({
  value,
  onChange,
  options = [],
  groups = null,
  icon = null,
  placeholder = "Select...",
  ariaLabel = "Choose option",
  searchable = undefined, // auto if items > 8
  searchPlaceholder = "Search options...",
  className = "",
  buttonClassName = "",
  menuClassName = "",
  align = "left"
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [resolvedAlign, setResolvedAlign] = useState(align);
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const searchInputRef = useRef(null);
  const triggerRef = useRef(null);

  // Normalize all options into a flat array for quick lookup
  const flatOptions = useMemo(() => {
    if (groups && Array.isArray(groups)) {
      const flat = [];
      for (const g of groups) {
        if (Array.isArray(g.items)) {
          for (const item of g.items) {
            flat.push({ ...item, group: g.group });
          }
        }
      }
      return flat;
    }
    return options;
  }, [options, groups]);

  // Selected item
  const selected = useMemo(() => {
    return flatOptions.find((opt) => String(opt.value) === String(value)) || null;
  }, [flatOptions, value]);

  // Should we show search?
  const shouldSearch = useMemo(() => {
    if (typeof searchable === "boolean") return searchable;
    return flatOptions.length > 8;
  }, [searchable, flatOptions.length]);

  // Filtered list with flat keyboard index
  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = !q
      ? flatOptions
      : flatOptions.filter(
          (opt) =>
            String(opt.label || "").toLowerCase().includes(q) ||
            String(opt.subtext || "").toLowerCase().includes(q) ||
            String(opt.group || "").toLowerCase().includes(q)
        );
    return list.map((opt, idx) => ({ ...opt, _flatIdx: idx }));
  }, [flatOptions, query]);

  // Grouped structure for rendering
  const renderedGroups = useMemo(() => {
    const map = new Map();
    for (const opt of filteredOptions) {
      const gName = opt.group || "";
      if (!map.has(gName)) map.set(gName, []);
      map.get(gName).push(opt);
    }
    return Array.from(map.entries()).map(([group, items]) => ({ group, items }));
  }, [filteredOptions]);

  // Focus search input and compute viewport-safe alignment when opening
  useEffect(() => {
    if (open) {
      const activeIdx = filteredOptions.findIndex((opt) => String(opt.value) === String(value));
      setHighlightedIndex(activeIdx >= 0 ? activeIdx : filteredOptions.length > 0 ? 0 : -1);

      if (typeof window !== "undefined" && rootRef.current) {
        const rect = rootRef.current.getBoundingClientRect();
        const estimatedWidth = 280;
        if (align === "right") {
          setResolvedAlign(rect.right - estimatedWidth < 12 ? "left" : "right");
        } else {
          setResolvedAlign(rect.left + estimatedWidth > window.innerWidth - 12 ? "right" : "left");
        }
      } else {
        setResolvedAlign(align);
      }

      if (shouldSearch) {
        setTimeout(() => {
          searchInputRef.current?.focus();
        }, 40);
      }
    } else {
      setQuery("");
      setHighlightedIndex(-1);
    }
  }, [open, shouldSearch, align]);

  // Keep highlighted option within bounds as query changes
  useEffect(() => {
    if (!open) return;
    setHighlightedIndex((prev) => {
      if (filteredOptions.length === 0) return -1;
      if (prev >= 0 && prev < filteredOptions.length) return prev;
      return 0;
    });
  }, [filteredOptions.length, open]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (!open || highlightedIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-atlas-option-idx="${highlightedIndex}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex, open]);

  const handleMenuKeyDown = (event) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }

    if (filteredOptions.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % filteredOptions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((prev) => (prev <= 0 ? filteredOptions.length - 1 : prev - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setHighlightedIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHighlightedIndex(filteredOptions.length - 1);
    } else if (event.key === "Enter") {
      const idx = highlightedIndex >= 0 && highlightedIndex < filteredOptions.length ? highlightedIndex : 0;
      const chosen = filteredOptions[idx];
      if (chosen) {
        event.preventDefault();
        onChange?.(chosen.value);
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    }
  };

  // Dismiss listeners
  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
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
    <div ref={rootRef} className={`relative inline-block text-left ${className}`}>
      {/* Trigger Button */}
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleMenuKeyDown}
        className={`h-9 px-3 rounded-lg bg-surface-solid border border-border-subtle hover:border-border-strong text-text-main text-xs font-medium transition-colors flex items-center justify-between gap-2 cursor-pointer select-none ${buttonClassName} ${
          open ? "border-accent ring-1 ring-accent/20" : ""
        }`}
      >
        <div className="flex items-center gap-1.5 truncate">
          {icon && (
            <AtlasIcon name={icon} size={15} className="text-text-muted shrink-0" />
          )}
          {selected?.icon && (
            <AtlasIcon name={selected.icon} size={15} className="text-accent shrink-0" />
          )}
          <span className="truncate">{selected ? selected.label : placeholder}</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 ml-1">
          {selected?.badge && (
            <span className="px-1.5 py-0.5 rounded-md text-xs font-mono bg-input-bg text-text-muted tabular-nums">
              {selected.badge}
            </span>
          )}
          <AtlasIcon
            name="expand_more"
            size={15}
            className={`text-text-muted transition-transform duration-150 ${
              open ? "rotate-180" : ""
            }`}
          />
        </div>
      </button>

      {/* Dropdown Menu */}
      <AnimatePresence>
        {open && (
          <motion.div
            ref={listRef}
            role="listbox"
            aria-label={ariaLabel}
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.13, ease: [0.16, 1, 0.3, 1] }}
            className={`absolute ${
              resolvedAlign === "right" ? "right-0" : "left-0"
            } top-full mt-1.5 z-[100] min-w-[220px] max-w-[min(340px,calc(100vw-24px))] max-h-80 overflow-y-auto bg-surface-solid border border-border-subtle rounded-xl shadow-lg p-1.5 flex flex-col gap-1 ${menuClassName}`}
            onClick={(e) => e.stopPropagation()}
          >
          {/* Quick Search */}
          {shouldSearch && (
            <div className="p-1 pb-1.5 border-b border-border-subtle sticky top-0 bg-surface-solid z-10">
              <div className="relative">
                <AtlasIcon
                  name="search"
                  size={14}
                  className="text-text-muted absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleMenuKeyDown}
                  placeholder={searchPlaceholder}
                  className="w-full h-8 pl-8 pr-7 rounded-lg bg-input-bg border border-border-subtle text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:border-accent"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      searchInputRef.current?.focus();
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main p-0.5"
                    aria-label="Clear search"
                  >
                    <AtlasIcon name="close" size={13} />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Option list / Groups */}
          {filteredOptions.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-text-muted">
              No matching options
            </div>
          ) : (
            renderedGroups.map(({ group, items }) => (
              <div key={group || "default"} className="flex flex-col gap-0.5">
                {group && (
                  <div className="px-2.5 py-1 text-[11px] font-medium text-text-muted uppercase tracking-wider bg-surface-glass rounded-md mt-1 select-none flex items-center justify-between">
                    <span>{group}</span>
                    <span className="text-xs font-mono opacity-80">({items.length})</span>
                  </div>
                )}
                {items.map((opt) => {
                  const active = String(opt.value) === String(value);
                  const isHighlighted = opt._flatIdx === highlightedIndex;
                  return (
                    <button
                      key={String(opt.value)}
                      type="button"
                      role="option"
                      data-atlas-option-idx={opt._flatIdx}
                      aria-selected={active}
                      onMouseEnter={() => setHighlightedIndex(opt._flatIdx)}
                      onClick={() => {
                        onChange?.(opt.value);
                        setOpen(false);
                        triggerRef.current?.focus({ preventScroll: true });
                      }}
                      className={`w-full rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors flex items-center justify-between gap-2 cursor-pointer ${
                        active
                          ? "bg-primary-container text-on-primary-container"
                          : isHighlighted
                            ? "bg-input-bg text-text-main"
                            : "text-text-main hover:bg-input-bg"
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        {opt.icon && (
                          <AtlasIcon name={opt.icon} size={15} className="text-text-muted shrink-0" />
                        )}
                        <span className="truncate">{opt.label}</span>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0 ml-1">
                        {opt.badge && (
                          <span
                            className={`px-1.5 py-0.5 rounded-md text-xs font-mono tabular-nums ${
                              active
                                ? "bg-surface-solid/60 text-on-primary-container"
                                : "bg-input-bg text-text-muted"
                            }`}
                          >
                            {opt.badge}
                          </span>
                        )}
                        {active && (
                          <AtlasIcon name="check" size={14} className="text-on-primary-container shrink-0" />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
