import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { createPortal } from "react-dom";
import AtlasFeedback from "./AtlasFeedback.jsx";
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
    very_high: ["Very high", "text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-500/10 border-violet-300 dark:border-violet-500/20"],
    high: ["High", "text-electric-blue bg-electric-blue/10 border-electric-blue/20"],
    medium: ["Medium", "text-amber-800 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/20"],
    low: ["Low", "text-text-muted bg-input-bg border-border-subtle"]
  }[value] || ["Low", "text-text-muted bg-input-bg border-border-subtle"];

  return <span className={`px-2 py-0.5 rounded-full border text-[9px] font-medium ${meta[1]}`}>{meta[0]}</span>;
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
      .then(result => { if (!cancelled) setData(result); })
      .catch(err => { if (!cancelled) setError(err.message || "Unable to load keywords."); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [packageName]);

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const rows = tab === "phrases" ? (data?.phrases || []) : (data?.words || []);

  return createPortal(
    <div className="atlas-google-shell fixed inset-0 z-[130] flex items-center justify-center p-3 sm:p-5 font-body-md antialiased [text-rendering:optimizeLegibility]">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
        onClick={onClose}
      />

      <motion.section
        initial={{ opacity: 0, scale: 0.98, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 10 }}
        transition={{ duration: 0.18 }}
        className="relative w-full max-w-5xl h-[88vh] max-h-[900px] bg-surface-solid border border-border-subtle rounded-[26px] shadow-2xl overflow-hidden flex flex-col"
      >
        <header className="px-5 md:px-6 py-4 border-b border-border-subtle flex items-start justify-between gap-4 flex-shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-electric-blue text-[21px]">key</span>
              <h2 className="text-base md:text-lg font-medium text-text-main">Keyword intelligence</h2>
            </div>
            <p className="text-[10px] md:text-xs text-text-muted mt-1 truncate">{title || data?.title || packageName}</p>
            <p className="text-[9px] text-text-muted font-mono mt-0.5 truncate">{packageName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-full hover:bg-input-bg flex items-center justify-center text-text-muted hover:text-text-main transition-colors flex-shrink-0"
            aria-label="Close keyword intelligence"
          >
            <span className="material-symbols-outlined text-[21px]">close</span>
          </button>
        </header>

        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center text-text-muted">
            <span className="material-symbols-outlined text-electric-blue text-[32px] animate-spin">progress_activity</span>
            <p className="text-xs mt-3">Analyzing competitor descriptions…</p>
          </div>
        ) : error ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
            <span className="material-symbols-outlined text-urgent-red text-[36px]">error</span>
            <p className="text-sm font-medium mt-3">Keyword analysis unavailable</p>
            <p className="text-xs text-text-muted mt-1">{error}</p>
          </div>
        ) : (
          <>
            <div className="px-5 md:px-6 py-4 border-b border-border-subtle flex flex-col lg:flex-row lg:items-center gap-3 lg:justify-between flex-shrink-0 bg-surface-solid">
              <div className="grid grid-cols-3 gap-2 md:gap-3 flex-1 w-full">
                <div className="bg-input-bg rounded-xl px-3 py-2.5">
                  <div className="text-[9px] text-text-muted">Short description</div>
                  <div className="text-base md:text-lg font-semibold mt-0.5 tabular-nums">{data?.stats?.shortWordCount || 0}</div>
                  <div className="text-[9px] text-text-muted">words</div>
                </div>
                <div className="bg-input-bg rounded-xl px-3 py-2.5">
                  <div className="text-[9px] text-text-muted">Long description</div>
                  <div className="text-base md:text-lg font-semibold mt-0.5 tabular-nums">{data?.stats?.longWordCount || 0}</div>
                  <div className="text-[9px] text-text-muted">words</div>
                </div>
                <div className="bg-input-bg rounded-xl px-3 py-2.5">
                  <div className="text-[9px] text-text-muted">Atlas corpus</div>
                  <div className="text-base md:text-lg font-semibold mt-0.5 tabular-nums">{data?.stats?.corpusGames || 0}</div>
                  <div className="text-[9px] text-text-muted">games</div>
                </div>
              </div>

              <div className="flex items-center gap-2 self-start lg:self-center flex-shrink-0">
                {rows.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const topTerms = rows.slice(0, 10).map((r) => r.term).join(", ");
                      AtlasFeedback.copy(topTerms, "Top 10 keywords");
                    }}
                    className="h-9 px-3 rounded-full bg-input-bg hover:bg-surface-glass border border-border-subtle text-[10px] font-semibold text-text-main inline-flex items-center gap-1.5 transition"
                    title="Copy top 10 ranked keywords"
                  >
                    <span className="material-symbols-outlined text-[14px] text-electric-blue">content_copy</span>
                    Copy Top 10
                  </button>
                )}
                <div className="bg-input-bg rounded-full p-1 inline-flex gap-1">
                  {[["phrases", "Top phrases"], ["words", "Single words"]].map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setTab(id)}
                      className={`h-9 px-4 rounded-full text-[10px] font-medium transition-colors ${tab === id ? "bg-surface-solid text-text-main shadow-sm" : "text-text-muted hover:text-text-main"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar px-5 md:px-6 py-5">
              <div className="rounded-2xl border border-border-subtle bg-input-bg/60 px-4 py-3 text-[10px] md:text-[11px] text-text-muted leading-5 mb-4">
                <b className="text-text-main">Distinctiveness</b> compares this game's wording against descriptions currently stored in Atlas. Rare wording scores higher than generic phrases shared by many games.
              </div>

              {rows.length ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {rows.map((row, index) => (
                    <article key={`${row.type}-${row.term}`} className="rounded-2xl border border-border-subtle bg-surface-glass p-4 min-w-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[10px] text-text-muted font-mono flex-shrink-0">#{index + 1}</span>
                            <h3 className="text-sm font-medium truncate">{row.term}</h3>
                            <button
                              type="button"
                              onClick={() => AtlasFeedback.copy(row.term, "Keyword")}
                              title={`Copy "${row.term}"`}
                              aria-label={`Copy keyword ${row.term}`}
                              className="p-1 rounded-md hover:bg-input-bg text-text-muted hover:text-electric-blue transition shrink-0"
                            >
                              <span className="material-symbols-outlined text-[13px]">content_copy</span>
                            </button>
                          </div>
                          <div className="text-[9px] text-text-muted mt-1">Used by {row.documentShare}% of Atlas games</div>
                        </div>
                        <DistinctivenessBadge value={row.distinctiveness} />
                      </div>

                      <div className="grid grid-cols-3 gap-2 mt-3">
                        <div className="bg-input-bg rounded-xl p-2.5">
                          <div className="text-[8px] text-text-muted">Total uses</div>
                          <div className="text-sm font-semibold mt-0.5 tabular-nums">{row.count}</div>
                        </div>
                        <div className="bg-input-bg rounded-xl p-2.5">
                          <div className="text-[8px] text-text-muted">Short desc.</div>
                          <div className="text-sm font-semibold mt-0.5 tabular-nums">{row.shortCount}</div>
                        </div>
                        <div className="bg-input-bg rounded-xl p-2.5">
                          <div className="text-[8px] text-text-muted">Long desc.</div>
                          <div className="text-sm font-semibold mt-0.5 tabular-nums">{row.longCount}</div>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="py-16 text-center text-xs text-text-muted">Not enough description text to rank keywords.</div>
              )}

              {(data?.shortDescription || data?.longDescription) && (
                <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {data.shortDescription && (
                    <details className="rounded-2xl border border-border-subtle bg-surface-glass p-4">
                      <summary className="text-xs font-medium cursor-pointer">Short description source</summary>
                      <p className="text-[11px] text-text-muted leading-5 mt-3">{data.shortDescription}</p>
                    </details>
                  )}
                  {data.longDescription && (
                    <details className="rounded-2xl border border-border-subtle bg-surface-glass p-4">
                      <summary className="text-xs font-medium cursor-pointer">Long description source</summary>
                      <p className="text-[11px] text-text-muted leading-5 mt-3 whitespace-pre-wrap">{data.longDescription}</p>
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
