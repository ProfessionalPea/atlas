import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const NGROK_URL = 'https://skeptic-resample-caution.ngrok-free.dev';
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000'
  : (import.meta.env?.VITE_API_BASE_URL || NGROK_URL);
const AUTH_TOKEN_KEY = 'atlas_auth_token';

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

function findCardForAsset(root, asset) {
  if (!root || !asset) return null;
  const articles = [...root.querySelectorAll('article')];
  const expectedUrls = [asset.youtubeUrl, !asset.mediaUrlExpired ? asset.mediaUrl : null]
    .filter(Boolean)
    .map(normalizeHref);

  for (const card of articles) {
    const hrefs = [...card.querySelectorAll('a[href]')].map(link => normalizeHref(link.href));
    if (expectedUrls.some(url => hrefs.includes(url))) return card;
  }

  if (asset.youtubeId) {
    const card = articles.find(article => article.textContent?.includes(asset.youtubeId));
    if (card) return card;
  }

  if (asset.assetKey) {
    const card = articles.find(article => article.textContent?.includes(asset.assetKey));
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

    let cancelled = false;
    const timer = window.setTimeout(() => {
      fetchJson(`${API_BASE}/api/video-assets/package-options?q=${encodeURIComponent(activePackageQuery)}`)
        .then(data => {
          if (!cancelled) setSuggestions(Array.isArray(data) ? data : []);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 180);

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
    try {
      await fetchJson(`${API_BASE}/api/video-assets/${encodeURIComponent(asset.id)}/metadata`, {
        method: 'PATCH',
        body: JSON.stringify({
          customTitle: title,
          packageNames: packageTokens,
          tags: tagTokens
        })
      });
      await onSaved();
    } catch (err) {
      setError(err.message || 'Unable to save video metadata.');
    } finally {
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
  const refreshTimerRef = useRef(null);

  const refreshAssets = useCallback(async () => {
    try {
      const data = await fetchJson(`${API_BASE}/api/video-assets`);
      setAssets(Array.isArray(data) ? data : []);
    } catch {
      // The normal Video Library handles its own load errors. This enhancer is
      // deliberately silent so it never makes the core library unusable.
    }
  }, []);

  const editingAsset = useMemo(
    () => assets.find(asset => Number(asset.id) === Number(editingId)) || null,
    [assets, editingId]
  );

  useEffect(() => {
    void refreshAssets();
    return () => {
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
    };
  }, [refreshAssets]);

  useEffect(() => {
    let disposed = false;
    let scheduled = false;

    const decorate = () => {
      scheduled = false;
      if (disposed) return;
      const root = findVideoRoot();
      if (!root) return;

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
        unassignedButton.className = `h-9 px-3.5 rounded-[11px] text-[11px] font-medium whitespace-nowrap transition-all ${
          unassignedOnly
            ? 'bg-surface-solid text-text-main shadow-sm'
            : 'text-text-muted hover:text-text-main'
        }`;
      }

      for (const asset of assets) {
        const card = findCardForAsset(root, asset);
        if (!card) continue;
        card.dataset.atlasAssetId = String(asset.id);
        card.style.display = unassignedOnly && asset.reviewState !== 'unassigned' ? 'none' : '';

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

        const title = card.querySelector('h2');
        const titleRow = title?.parentElement;
        if (titleRow && asset.hasManualMetadata && !titleRow.querySelector('[data-atlas-manual-badge="1"]')) {
          const badge = document.createElement('span');
          badge.dataset.atlasManualBadge = '1';
          badge.className = 'px-2 py-0.5 rounded-full border border-electric-blue/20 bg-electric-blue/10 text-electric-blue text-[8px] font-medium';
          badge.textContent = 'Manual';
          titleRow.appendChild(badge);
        }

        if (asset.tags?.length && title) {
          const info = titleRow?.parentElement;
          if (info && !info.querySelector('[data-atlas-video-tags="1"]')) {
            const tags = document.createElement('div');
            tags.dataset.atlasVideoTags = '1';
            tags.className = 'mt-2 flex flex-wrap gap-1.5';
            tags.innerHTML = asset.tags.slice(0, 5).map(tag =>
              `<span class="px-2 py-0.5 rounded-full bg-input-bg border border-border-subtle text-[8px] text-text-muted">#${String(tag).replace(/[<>&"']/g, '')}</span>`
            ).join('');
            info.appendChild(tags);
          }
        }
      }

      for (const card of root.querySelectorAll('article[data-atlas-asset-id]')) {
        const id = Number(card.dataset.atlasAssetId);
        const asset = assets.find(item => Number(item.id) === id);
        if (!asset) card.style.display = '';
      }
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(decorate);
    };

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);

    const videoClickHandler = event => {
      const button = event.target.closest?.('[data-atlas-video-library="1"]');
      if (!button) return;
      window.setTimeout(() => { void refreshAssets(); }, 80);
    };
    document.addEventListener('click', videoClickHandler, true);

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('click', videoClickHandler, true);
      document.querySelectorAll('[data-atlas-video-edit="1"], [data-atlas-manual-badge="1"], [data-atlas-video-tags="1"], [data-atlas-unassigned-filter="1"]').forEach(node => node.remove());
      document.querySelectorAll('article[data-atlas-asset-id]').forEach(card => {
        card.style.display = '';
        delete card.dataset.atlasAssetId;
      });
    };
  }, [assets, refreshAssets, unassignedOnly]);

  const handleSaved = useCallback(async () => {
    setEditingId(null);
    await refreshAssets();
    // Refresh the canonical React Video Library so custom titles/package links
    // become part of its own search state immediately rather than waiting for a
    // page reload or future scan.
    window.setTimeout(() => {
      findVideoRoot()?.querySelector('button[title="Refresh library"]')?.click();
      void refreshAssets();
    }, 30);
  }, [refreshAssets]);

  if (!editingAsset) return null;

  return (
    <VideoMetadataPanel
      asset={editingAsset}
      onClose={() => setEditingId(null)}
      onSaved={handleSaved}
    />
  );
}
