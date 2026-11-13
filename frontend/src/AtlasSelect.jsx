import { useEffect, useMemo, useRef, useState } from "react";

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
        className={`h-9 px-3 rounded-xl bg-input-bg border border-border-subtle hover:border-electric-blue/40 text-text-main text-xs font-semibold shadow-xs transition flex items-center justify-between gap-2 cursor-pointer select-none ${buttonClassName} ${
          open ? "border-electric-blue ring-1 ring-electric-blue/20" : ""
        }`}
      >
        <div className="flex items-center gap-1.5 truncate">
          {icon && (
            <span className="material-symbols-outlined text-[15px] text-text-muted shrink-0">
              {icon}
            </span>
          )}
          {selected?.icon && (
            <span className="material-symbols-outlined text-[15px] text-electric-blue shrink-0">
              {selected.icon}
            </span>
          )}
          <span className="truncate">{selected ? selected.label : placeholder}</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 ml-1">
          {selected?.badge && (
            <span className="px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-surface-glass text-text-muted">
              {selected.badge}
            </span>
          )}
          <span
            className={`material-symbols-outlined text-[15px] text-text-muted transition-transform duration-150 ${
              open ? "rotate-180" : ""
            }`}
          >
            expand_more
          </span>
        </div>
      </button>

      {/* Dropdown Menu */}
      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={ariaLabel}
          className={`absolute ${
            resolvedAlign === "right" ? "right-0" : "left-0"
          } top-full mt-1.5 z-[100] min-w-[220px] max-w-[min(340px,calc(100vw-24px))] max-h-80 overflow-y-auto bg-surface-solid border border-border-subtle rounded-2xl shadow-2xl p-1.5 flex flex-col gap-1 backdrop-blur-md animate-in fade-in zoom-in-95 duration-100 ${menuClassName}`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Quick Search */}
          {shouldSearch && (
            <div className="p-1 pb-1.5 border-b border-border-subtle sticky top-0 bg-surface-solid z-10">
              <div className="relative">
                <span className="material-symbols-outlined text-[15px] text-text-muted absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                  search
                </span>
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleMenuKeyDown}
                  placeholder={searchPlaceholder}
                  className="w-full h-8 pl-8 pr-7 rounded-xl bg-input-bg border border-border-subtle text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:border-electric-blue"
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
                    <span className="material-symbols-outlined text-[14px]">close</span>
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
                  <div className="px-2.5 py-1 text-[10px] font-bold text-text-muted uppercase tracking-wider bg-surface-glass/40 rounded-lg mt-1 select-none flex items-center justify-between">
                    <span>{group}</span>
                    <span className="text-[9px] font-mono opacity-70">({items.length})</span>
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
                      className={`w-full rounded-xl px-2.5 py-1.5 text-left text-xs font-medium transition flex items-center justify-between gap-2 cursor-pointer ${
                        active
                          ? "bg-electric-blue/15 text-electric-blue font-semibold"
                          : isHighlighted
                            ? "bg-surface-glass text-text-main ring-1 ring-electric-blue/30"
                            : "text-text-main hover:bg-surface-glass"
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        {opt.icon && (
                          <span className="material-symbols-outlined text-[15px] text-text-muted shrink-0">
                            {opt.icon}
                          </span>
                        )}
                        <span className="truncate">{opt.label}</span>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0 ml-1">
                        {opt.badge && (
                          <span
                            className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono ${
                              active
                                ? "bg-electric-blue/20 text-electric-blue"
                                : "bg-input-bg text-text-muted"
                            }`}
                          >
                            {opt.badge}
                          </span>
                        )}
                        {active && (
                          <span className="material-symbols-outlined text-[15px] text-electric-blue">
                            check
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
