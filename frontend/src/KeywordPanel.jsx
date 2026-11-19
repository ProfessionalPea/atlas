import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { createPortal } from "react-dom";
import AtlasFeedback from "./AtlasFeedback.jsx";
import AtlasIcon from "./components/ui/AtlasIcon.jsx";
import { Badge } from "./components/ui/UiPrimitives.jsx";
import { API_BASE } from "./apiConfig.js";

const AUTH_TOKEN_KEY = "atlas_auth_token";

async function fetchJson(url, options = {}) {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      "ngrok-skip-browser-warning": "69420",
      ...(token ? { "x-atlas-token": token } : {})
    }
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("Invalid server response.");
  }
  if (!response.ok) throw new Error(data?.error || `Error ${response.status}`);
  return data;
}

function DistinctivenessBadge({ value }) {
  const meta = {
    very_high: { label: "Very high", tone: "accent" },
    high: { label: "High", tone: "success" },
    medium: { label: "Medium", tone: "warning" },
    low: { label: "Low", tone: "neutral" }
  }[value] || { label: "Low", tone: "neutral" };

  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function KeywordPanel({ packageName, title, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("phrases");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setData(null);
    setTab("phrases");

    fetchJson(`${API_BASE}/api/game-keywords?packageName=${encodeURIComponent(packageName)}`)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Unable to load keywords.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [packageName]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const rows = tab === "phrases" ? data?.phrases || [] : data?.words || [];

  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-center justify-center p-3 sm:p-5 antialiased">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
        onClick={onClose}
      />

      <motion.section
        initial={{ opacity: 0, scale: 0.98, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 8 }}
        transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full max-w-5xl h-[88vh] max-h-[860px] bg-surface-solid border border-border-subtle rounded-xl shadow-xl overflow-hidden flex flex-col"
      >
        <header className="px-5 py-4 border-b border-border-subtle flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <AtlasIcon name="key" size={18} className="text-text-muted" />
              <h2 className="text-base font-semibold text-text-main">Keyword intelligence</h2>
            </div>
            <p className="text-[13px] text-text-main mt-1 truncate">
              {title || data?.title || packageName}
            </p>
            <p className="text-xs text-text-muted font-mono mt-0.5 truncate">{packageName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-input-bg flex items-center justify-center text-text-muted hover:text-text-main transition-colors shrink-0"
            aria-label="Close keyword intelligence"
          >
            <AtlasIcon name="close" size={18} />
          </button>
        </header>

        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center text-text-muted">
            <AtlasIcon name="progress_activity" size={24} className="text-accent animate-spin" />
            <p className="text-[13px] mt-3">Analyzing competitor descriptions...</p>
          </div>
        ) : error ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
            <AtlasIcon name="error" size={28} className="text-sem-danger" />
            <p className="text-sm font-medium text-text-main mt-3">Keyword analysis unavailable</p>
            <p className="text-[13px] text-text-muted mt-1">{error}</p>
          </div>
        ) : (
          <>
            <div className="px-5 py-3.5 border-b border-border-subtle flex flex-col lg:flex-row lg:items-center gap-3 lg:justify-between shrink-0 bg-surface-solid">
              <div className="grid grid-cols-3 divide-x divide-border-subtle rounded-lg border border-border-subtle bg-input-bg/50 flex-1 w-full">
                <div className="px-3.5 py-2">
                  <div className="text-xs text-text-muted">Short description</div>
                  <div className="text-base font-semibold text-text-main mt-0.5 tabular-nums">
                    {data?.stats?.shortWordCount || 0}{" "}
                    <span className="text-xs font-normal text-text-muted">words</span>
                  </div>
                </div>
                <div className="px-3.5 py-2">
                  <div className="text-xs text-text-muted">Long description</div>
                  <div className="text-base font-semibold text-text-main mt-0.5 tabular-nums">
                    {data?.stats?.longWordCount || 0}{" "}
                    <span className="text-xs font-normal text-text-muted">words</span>
                  </div>
                </div>
                <div className="px-3.5 py-2">
                  <div className="text-xs text-text-muted">Atlas corpus</div>
                  <div className="text-base font-semibold text-text-main mt-0.5 tabular-nums">
                    {data?.stats?.corpusGames || 0}{" "}
                    <span className="text-xs font-normal text-text-muted">games</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 self-start lg:self-center shrink-0">
                {rows.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const topTerms = rows.slice(0, 10).map((r) => r.term).join(", ");
                      AtlasFeedback.copy(topTerms, "Top 10 keywords");
                    }}
                    className="h-9 px-3 rounded-lg bg-surface-solid hover:bg-input-bg border border-border-subtle text-xs font-medium text-text-main inline-flex items-center gap-1.5 transition-colors"
                    title="Copy top 10 ranked keywords"
                  >
                    <AtlasIcon name="content_copy" size={14} className="text-text-muted" />
                    Copy top 10
                  </button>
                )}
                <div className="bg-input-bg border border-border-subtle rounded-lg p-1 inline-flex gap-1">
                  {[
                    ["phrases", "Top phrases"],
                    ["words", "Single words"]
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setTab(id)}
                      className={`h-7 px-3 rounded-md text-xs font-medium transition-colors ${
                        tab === id
                          ? "bg-surface-solid text-text-main shadow-sm"
                          : "text-text-muted hover:text-text-main"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4">
              <div className="rounded-lg border border-border-subtle bg-input-bg/50 px-3.5 py-2.5 text-xs text-text-muted leading-5 mb-4">
                <strong className="font-medium text-text-main">Distinctiveness</strong> compares
                this game's wording against descriptions currently stored in Atlas. Rare terms
                score higher than phrases shared across many titles.
              </div>

              {rows.length ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {rows.map((row, index) => (
                    <article
                      key={`${row.type}-${row.term}`}
                      className="rounded-xl border border-border-subtle bg-surface-solid p-4 min-w-0"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs text-text-muted font-mono shrink-0">
                              #{index + 1}
                            </span>
                            <h3 className="text-sm font-medium text-text-main truncate">
                              {row.term}
                            </h3>
                            <button
                              type="button"
                              onClick={() => AtlasFeedback.copy(row.term, "Keyword")}
                              title={`Copy "${row.term}"`}
                              aria-label={`Copy keyword ${row.term}`}
                              className="p-1 rounded-md hover:bg-input-bg text-text-muted hover:text-text-main transition-colors shrink-0"
                            >
                              <AtlasIcon name="content_copy" size={13} />
                            </button>
                          </div>
                          <div className="text-xs text-text-muted mt-1">
                            Used by {row.documentShare}% of Atlas games
                          </div>
                        </div>
                        <DistinctivenessBadge value={row.distinctiveness} />
                      </div>

                      <div className="grid grid-cols-3 divide-x divide-border-subtle rounded-lg border border-border-subtle bg-input-bg/40 mt-3">
                        <div className="px-3 py-2">
                          <div className="text-xs text-text-muted">Total</div>
                          <div className="text-sm font-semibold text-text-main mt-0.5 tabular-nums">
                            {row.count}
                          </div>
                        </div>
                        <div className="px-3 py-2">
                          <div className="text-xs text-text-muted">Short desc.</div>
                          <div className="text-sm font-semibold text-text-main mt-0.5 tabular-nums">
                            {row.shortCount}
                          </div>
                        </div>
                        <div className="px-3 py-2">
                          <div className="text-xs text-text-muted">Long desc.</div>
                          <div className="text-sm font-semibold text-text-main mt-0.5 tabular-nums">
                            {row.longCount}
                          </div>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="py-16 text-center text-[13px] text-text-muted">
                  Not enough description text to rank keywords.
                </div>
              )}

              {(data?.shortDescription || data?.longDescription) && (
                <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {data.shortDescription && (
                    <details className="rounded-xl border border-border-subtle bg-surface-glass p-4">
                      <summary className="text-[13px] font-medium text-text-main cursor-pointer">
                        Short description source
                      </summary>
                      <p className="text-xs text-text-muted leading-5 mt-3">
                        {data.shortDescription}
                      </p>
                    </details>
                  )}
                  {data.longDescription && (
                    <details className="rounded-xl border border-border-subtle bg-surface-glass p-4">
                      <summary className="text-[13px] font-medium text-text-main cursor-pointer">
                        Long description source
                      </summary>
                      <p className="text-xs text-text-muted leading-5 mt-3 whitespace-pre-wrap">
                        {data.longDescription}
                      </p>
                    </details>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </motion.section>
    </div>,
    document.body
  );
}

export default KeywordPanel;
