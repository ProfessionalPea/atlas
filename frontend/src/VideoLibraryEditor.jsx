import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const NGROK_URL = 'https://skeptic-resample-caution.ngrok-free.dev';
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000'
  : (import.meta.env?.VITE_API_BASE_URL || NGROK_URL);
const AUTH_TOKEN_KEY = 'atlas_auth_token';

// Client-side cache for package autocomplete suggestions
const packageSuggestionCache = new Map();

async function fetchJson(url, options = {}) {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
      'ngrok-skip-browser-warning': '69420',
      ...(token ? { 'x-atlas-token': token } : {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; }
  catch { throw new Error('Invalid server response.'); }
  if (!response.ok) throw new Error(data?.error || `Error ${response.status}`);
  return data;
}

function normalizeHref(value) {
  if (!value) return '';
  try { return new URL(value, window.location.origin).href; }
  catch { return String(value || ''); }
}

function splitList(value) {
  return [...new Set(
    String(value || '')
      .split(/[\n,]+/)
      .map(item => item.trim())
      .filter(Boolean)
  )];
}

function findVideoRoot() {
  const heading = [...document.querySelectorAll('h1')]
    .find(node => node.textContent?.trim() === 'Video Library');
  return heading?.closest('.atlas-google-shell') || null;
}

// Single O(N) pass to index all cards inside the Video Library root
function buildCardLookupMap(root) {
  const byId = new Map();
  const byHref = new Map();
  const articles = [...root.querySelectorAll('article')];

  for (const card of articles) {
    if (card.dataset.atlasAssetId) {
      byId.set(Number(card.dataset.atlasAssetId), card);
    }
    for (const link of card.querySelectorAll('a[href]')) {
      const normalized = normalizeHref(link.href);
      if (normalized && !byHref.has(normalized)) {
        byHref.set(normalized, card);
      }
    }
  }

  return { articles, byId, byHref };
}

function resolveCardForAsset(lookup, asset) {
  if (!lookup || !asset) return null;
  const numericId = Number(asset.id);
  if (lookup.byId.has(numericId)) return lookup.byId.get(numericId);

  const expectedUrls = [asset.youtubeUrl, !asset.mediaUrlExpired ? asset.mediaUrl : null]
    .filter(Boolean)
    .map(normalizeHref);

  for (const url of expectedUrls) {
    if (lookup.byHref.has(url)) return lookup.byHref.get(url);
  }

  if (asset.youtubeId) {
    const card = lookup.articles.find(article => article.textContent?.includes(asset.youtubeId));
    if (card) return card;
  }

  if (asset.assetKey) {
    const card = lookup.articles.find(article => article.textContent?.includes(asset.assetKey));
    if (card) return card;
  }

  return null;
}

function VideoMetadataPanel({ asset, onClose, onSaved }) {
  const [title, setTitle] = useState(asset?.customTitle || '');
  const [packages, setPackages] = useState((asset?.manualPackageNames || []).join(', '));
  const [tags, setTags] = useState((asset?.tags || []).join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const panelRef = useRef(null);

  const automaticGame = asset?.automaticGames?.[0] || null;
  const packageTokens = useMemo(() => splitList(packages), [packages]);
  const tagTokens = useMemo(() => splitList(tags), [tags]);
  const activePackageQuery = useMemo(() => {
    const parts = String(packages || '').split(/[\n,]+/);
    return String(parts[parts.length - 1] || '').trim();
  }, [packages]);

  useEffect(() => {
    setTitle(asset?.customTitle || '');
    setPackages((asset?.manualPackageNames || []).join(', '));
    setTags((asset?.tags || []).join(', '));
    setError('');
  }, [asset]);

  useEffect(() => {
    const handleKey = event => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, saving]);

  useEffect(() => {
    if (activePackageQuery.length < 2) {
      setSuggestions([]);
      return undefined;
    }

    const cacheKey = activePackageQuery.toLowerCase();
    if (packageSuggestionCache.has(cacheKey)) {
      setSuggestions(packageSuggestionCache.get(cacheKey));
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      fetchJson(`${API_BASE}/api/video-assets/package-options?q=${encodeURIComponent(activePackageQuery)}`)
        .then(data => {
          const list = Array.isArray(data) ? data : [];
          packageSuggestionCache.set(cacheKey, list);
          if (!cancelled) setSuggestions(list);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activePackageQuery]);

  const addSuggestion = suggestion => {
    const current = splitList(packages);
    const next = [...new Set([...current, suggestion.packageName])];
    setPackages(next.join(', '));
    setSuggestions([]);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    const normalizedTitle = title.trim() || null;
    const normalizedPackages = packageTokens.map(pkg => pkg.toLowerCase());
    const normalizedTags = tagTokens;

    try {
      const response = await fetchJson(`${API_BASE}/api/video-assets/${encodeURIComponent(asset.id)}/metadata`, {
        method: 'PATCH',
        body: JSON.stringify({
          customTitle: normalizedTitle,
          packageNames: normalizedPackages,
          tags: normalizedTags
        })
      });

      const savedMeta = response?.metadata || {
        customTitle: normalizedTitle,
        packageNames: normalizedPackages,
        tags: normalizedTags,
        updatedAt: new Date().toISOString()
      };

      onSaved(asset.id, savedMeta);
    } catch (err) {
      setError(err.message || 'Unable to save video metadata.');
      setSaving(false);
    }
  };

  return createPortal(
    <section
      ref={panelRef}
      data-atlas-video-editor-panel="1"
      role="dialog"
      aria-modal="false"
      aria-labelledby="video-metadata-editor-title"
      className="atlas-google-shell fixed z-[190] top-[82px] right-4 md:right-6 w-[calc(100vw-32px)] max-w-[430px] rounded-[22px] border border-border-subtle bg-surface-solid text-text-main shadow-2xl font-body-md antialiased overflow-hidden"
    >
      <header className="px-4.5 py-4 border-b border-border-subtle flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-electric-blue text-[19px]">edit_note</span>
            <h2 id="video-metadata-editor-title" className="text-[16px] font-semibold tracking-[-0.01em]">Edit video details</h2>
          </div>
          <p className="text-[12px] leading-5 text-text-muted mt-1">Organizational metadata only. Automatic ad/video attribution is never changed.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="w-8 h-8 rounded-full border border-border-subtle bg-input-bg text-text-muted hover:text-text-main flex items-center justify-center disabled:opacity-50"
          aria-label="Close video editor"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      </header>

      <div className="p-4 space-y-4 max-h-[calc(100vh-170px)] overflow-y-auto overscroll-contain custom-scrollbar">
        <div className="rounded-2xl border border-border-subtle bg-input-bg/60 px-3.5 py-3">
          <div className="text-[11px] text-text-muted">Automatic attribution</div>
          <div className="mt-1 text-[13px] font-medium break-words">
            {automaticGame?.title || (asset.associationState === 'ambiguous' ? 'Unresolved — multiple package signals' : 'Unassigned')}
          </div>
          {automaticGame?.packageName && (
            <div className="mt-0.5 text-[11px] font-mono text-text-muted break-all">{automaticGame.packageName}</div>
          )}
        </div>

        <label className="block">
          <span className="text-[12px] font-medium">Custom name</span>
          <span className="block text-[11px] text-text-muted mt-0.5">Shown in the Video Library instead of the automatic/generic title.</span>
          <input
            value={title}
            onChange={event => setTitle(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !saving) {
                event.preventDefault();
                void save();
              }
            }}
            maxLength={120}
            placeholder="e.g. Fake messenger choice ad"
            className="mt-2 w-full h-10 rounded-xl border border-border-subtle bg-input-bg px-3 text-[13px] text-text-main outline-none focus:border-electric-blue/45"
          />
        </label>

        <div>
          <label className="block">
            <span className="text-[12px] font-medium">Library package links</span>
            <span className="block text-[11px] text-text-muted mt-0.5">Comma-separated package names. These help search/browse and do not add ads to a game.</span>
            <textarea
              value={packages}
              onChange={event => setPackages(event.target.value)}
              rows={2}
              placeholder="com.example.game, com.other.game"
              className="mt-2 w-full min-h-[70px] resize-y rounded-xl border border-border-subtle bg-input-bg px-3 py-2.5 text-[12px] font-mono text-text-main outline-none focus:border-electric-blue/45"
            />
          </label>

          {packageTokens.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {packageTokens.map(packageName => (
                <span key={packageName} className="px-2 py-1 rounded-full border border-electric-blue/15 bg-electric-blue/8 text-[10px] font-mono text-text-main">
                  {packageName}
                </span>
              ))}
            </div>
          )}

          {suggestions.length > 0 && (
            <div className="mt-2 rounded-xl border border-border-subtle bg-surface-solid shadow-lg overflow-hidden">
              {suggestions.slice(0, 6).map(option => (
                <button
                  key={option.packageName}
                  type="button"
                  onClick={() => addSuggestion(option)}
                  className="w-full px-3 py-2.5 text-left hover:bg-input-bg border-b border-border-subtle last:border-b-0"
                >
                  <div className="text-[12px] font-medium truncate">{option.title || option.packageName}</div>
                  <div className="text-[10px] font-mono text-text-muted truncate mt-0.5">{option.packageName}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <label className="block">
          <span className="text-[12px] font-medium">Tags</span>
          <span className="block text-[11px] text-text-muted mt-0.5">Use searchable creative labels such as UGC, gameplay, runner, fake UI or ASMR.</span>
          <input
            value={tags}
            onChange={event => setTags(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !saving) {
                event.preventDefault();
                void save();
              }
            }}
            placeholder="UGC, gameplay, fake UI"
            className="mt-2 w-full h-10 rounded-xl border border-border-subtle bg-input-bg px-3 text-[13px] text-text-main outline-none focus:border-electric-blue/45"
          />
          {tagTokens.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tagTokens.slice(0, 12).map(tag => (
                <span key={tag.toLowerCase()} className="px-2 py-1 rounded-full bg-input-bg border border-border-subtle text-[10px] text-text-muted">#{tag}</span>
              ))}
            </div>
          )}
        </label>

        {error && (
          <div role="alert" className="rounded-xl border border-urgent-red/20 bg-urgent-red/10 px-3 py-2.5 text-[12px] text-urgent-red">
            {error}
          </div>
        )}

        <div className="pt-1 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-9 px-3.5 rounded-xl border border-border-subtle bg-surface-solid text-[12px] font-medium hover:bg-input-bg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { void save(); }}
            disabled={saving}
            className="h-9 min-w-[84px] px-3.5 rounded-xl bg-electric-blue text-white text-[12px] font-semibold hover:brightness-95 disabled:opacity-60 flex items-center justify-center gap-1.5"
          >
            {saving && <span className="material-symbols-outlined text-[15px] animate-spin">progress_activity</span>}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </section>,
    document.body
  );
}

export default function VideoLibraryEditor() {
  const [assets, setAssets] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const isDecoratingRef = useRef(false);

  const refreshAssets = useCallback(async () => {
    try {
      const data = await fetchJson(`${API_BASE}/api/video-assets`);
      setAssets(Array.isArray(data) ? data : []);
    } catch {
      // Silent fallback
    }
  }, []);

  const editingAsset = useMemo(
    () => assets.find(asset => Number(asset.id) === Number(editingId)) || null,
    [assets, editingId]
  );

  useEffect(() => {
    void refreshAssets();
  }, [refreshAssets]);

  useEffect(() => {
    let disposed = false;
    let scheduled = false;

    const decorate = () => {
      scheduled = false;
      if (disposed || isDecoratingRef.current) return;
      const root = findVideoRoot();
      if (!root) return;

      isDecoratingRef.current = true;
      try {
        const directButton = [...root.querySelectorAll('button')]
          .find(button => button.textContent?.trim() === 'Direct video');
        const filterGroup = directButton?.parentElement;
        if (filterGroup && !filterGroup.querySelector('[data-atlas-unassigned-filter="1"]')) {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.atlasUnassignedFilter = '1';
          button.textContent = 'Unassigned';
          button.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            setUnassignedOnly(value => !value);
          };
          filterGroup.appendChild(button);
        }

        const unassignedButton = root.querySelector('[data-atlas-unassigned-filter="1"]');
        if (unassignedButton) {
          const desiredClass = `h-9 px-3.5 rounded-[11px] text-[11px] font-medium whitespace-nowrap transition-all ${
            unassignedOnly
              ? 'bg-surface-solid text-text-main shadow-sm'
              : 'text-text-muted hover:text-text-main'
          }`;
          if (unassignedButton.className !== desiredClass) {
            unassignedButton.className = desiredClass;
          }
        }

        const lookup = buildCardLookupMap(root);

        for (const asset of assets) {
          const card = resolveCardForAsset(lookup, asset);
          if (!card) continue;

          const assetIdStr = String(asset.id);
          if (card.dataset.atlasAssetId !== assetIdStr) {
            card.dataset.atlasAssetId = assetIdStr;
          }

          const desiredDisplay = unassignedOnly && asset.reviewState !== 'unassigned' ? 'none' : '';
          if (card.style.display !== desiredDisplay) {
            card.style.display = desiredDisplay;
          }

          const deleteButton = card.querySelector('button[title="Delete video asset"]');
          if (deleteButton && !card.querySelector('[data-atlas-video-edit="1"]')) {
            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.dataset.atlasVideoEdit = '1';
            editButton.title = 'Edit video details';
            editButton.setAttribute('aria-label', 'Edit video details');
            editButton.className = 'w-8 h-8 rounded-full bg-input-bg border border-border-subtle flex items-center justify-center text-text-muted hover:text-electric-blue hover:border-electric-blue/25 transition-colors';
            editButton.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px">edit</span>';
            editButton.onclick = event => {
              event.preventDefault();
              event.stopPropagation();
              setEditingId(Number(asset.id));
            };
            deleteButton.insertAdjacentElement('beforebegin', editButton);
          }

          const titleEl = card.querySelector('h2');
          if (titleEl) {
            const autoTitle = asset.automaticGames?.[0]?.title || asset.manualPackageNames?.[0] || null;
            const desiredTitle = asset.customTitle || autoTitle;
            if (desiredTitle && titleEl.textContent !== desiredTitle) {
              titleEl.textContent = desiredTitle;
            }
          }

          const titleRow = titleEl?.parentElement;
          if (titleRow) {
            const existingBadge = titleRow.querySelector('[data-atlas-manual-badge="1"]');
            if (asset.hasManualMetadata && !existingBadge) {
              const badge = document.createElement('span');
              badge.dataset.atlasManualBadge = '1';
              badge.className = 'px-2 py-0.5 rounded-full border border-electric-blue/20 bg-electric-blue/10 text-electric-blue text-[8px] font-medium';
              badge.textContent = 'Manual';
              titleRow.appendChild(badge);
            } else if (!asset.hasManualMetadata && existingBadge) {
              existingBadge.remove();
            }
          }

          const info = titleRow?.parentElement;
          if (info) {
            let tagsContainer = info.querySelector('[data-atlas-video-tags="1"]');
            if (asset.tags?.length) {
              const desiredHtml = asset.tags.slice(0, 5).map(tag =>
                `<span class="px-2 py-0.5 rounded-full bg-input-bg border border-border-subtle text-[8px] text-text-muted">#${String(tag).replace(/[<>&"']/g, '')}</span>`
              ).join('');
              if (!tagsContainer) {
                tagsContainer = document.createElement('div');
                tagsContainer.dataset.atlasVideoTags = '1';
                tagsContainer.className = 'mt-2 flex flex-wrap gap-1.5';
                tagsContainer.innerHTML = desiredHtml;
                info.appendChild(tagsContainer);
              } else if (tagsContainer.innerHTML !== desiredHtml) {
                tagsContainer.innerHTML = desiredHtml;
              }
            } else if (tagsContainer) {
              tagsContainer.remove();
            }
          }
        }
      } finally {
        isDecoratingRef.current = false;
      }
    };

    const schedule = () => {
      if (scheduled || isDecoratingRef.current) return;
      scheduled = true;
      window.requestAnimationFrame(decorate);
    };

    schedule();

    const observer = new MutationObserver((mutations) => {
      if (isDecoratingRef.current) return;
      // Ignore mutations caused by our own editor panel or badges
      const relevant = mutations.some(mutation => {
        const target = mutation.target;
        if (!(target instanceof Element)) return false;
        if (target.closest('[data-atlas-video-editor-panel="1"]')) return false;
        return true;
      });
      if (relevant) schedule();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const videoClickHandler = event => {
      const button = event.target.closest?.('[data-atlas-video-library="1"]');
      if (!button) return;
      window.setTimeout(() => { void refreshAssets(); }, 50);
    };
    document.addEventListener('click', videoClickHandler, true);

    return () => {
      disposed = true;
      observer.disconnect();
      document.removeEventListener('click', videoClickHandler, true);
    };
  }, [assets, refreshAssets, unassignedOnly]);

  const handleSaved = useCallback((assetId, savedMeta) => {
    const customTitle = savedMeta?.customTitle || null;
    const packageNames = Array.isArray(savedMeta?.packageNames) ? savedMeta.packageNames : [];
    const tags = Array.isArray(savedMeta?.tags) ? savedMeta.tags : [];
    const hasManualMetadata = Boolean(customTitle || packageNames.length || tags.length);

    // 1. Close modal and update local state immediately (0ms perceived latency)
    setEditingId(null);
    setAssets(prev => prev.map(item => {
      if (Number(item.id) !== Number(assetId)) return item;
      const linkedPackageCount = Number(item.linkedPackageCount) || 0;
      return {
        ...item,
        customTitle,
        manualPackageNames: packageNames,
        tags,
        hasManualMetadata,
        manualMetadataUpdatedAt: savedMeta?.updatedAt || new Date().toISOString(),
        reviewState: linkedPackageCount === 1
          ? 'resolved'
          : hasManualMetadata
            ? 'manually_organized'
            : 'unassigned'
      };
    }));

    // 2. Sync the underlying Video Library search state in the background
    window.setTimeout(() => {
      findVideoRoot()?.querySelector('button[title="Refresh library"]')?.click();
    }, 20);
  }, []);

  if (!editingAsset) return null;

  return (
    <VideoMetadataPanel
      asset={editingAsset}
      onClose={() => setEditingId(null)}
      onSaved={handleSaved}
    />
  );
}