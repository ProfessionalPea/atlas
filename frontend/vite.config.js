import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function replaceRequired(source, search, replacement, label) {
  const next = source.replace(search, replacement)
  if (next === source) throw new Error(`Atlas polish transform could not apply: ${label}`)
  return next
}

function atlasBrowserDialogBridge() {
  return {
    name: 'atlas-browser-dialog-bridge',
    enforce: 'pre',
    transform(code, id) {
      const normalizedId = id.replace(/\\/g, '/')
      if (!normalizedId.endsWith('/src/App.jsx')) return null

      let next = code

      // App.jsx predates the shared Atlas feedback surface. Keep this bridge
      // deliberately narrow so every remaining native browser confirm/alert is
      // rendered by Atlas itself without a risky large-file rewrite.
      next = next.replace(
        'const handleReset = () => {',
        'const handleReset = async () => {'
      )
      next = next.replace(/window\.confirm\(/g, 'await window.__atlasConfirm(')
      next = next.replace(/(?<![\w$.])alert\(/g, 'window.__atlasAlert(')

      if (/window\.confirm\(|(?<![\w$.])alert\(/.test(next)) {
        throw new Error('Atlas browser-dialog bridge left a native prompt in App.jsx')
      }

      return { code: next, map: null }
    }
  }
}

function atlasProductPolishBridge() {
  return {
    name: 'atlas-product-polish-bridge',
    enforce: 'pre',
    transform(code, id) {
      const normalizedId = id.replace(/\\/g, '/')

      if (normalizedId.endsWith('/src/App.jsx')) {
        let next = code

        // Replace the dense multi-series telemetry chart with a compact,
        // decision-oriented change summary and remove the chart dependency from
        // the main bundle.
        next = replaceRequired(
          next,
          'import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";',
          '',
          'remove Recharts import'
        )
        next = replaceRequired(
          next,
          'import { cn } from "./lib/utils";',
          'import { cn } from "./lib/utils";\nimport CompetitivePulse from "./CompetitivePulse.jsx";',
          'import CompetitivePulse'
        )
        next = replaceRequired(
          next,
          /const CHART_COLORS = \[[^\n]+\];\r?\n/,
          '',
          'remove chart palette'
        )
        next = replaceRequired(
          next,
          /const DashboardTelemetry = memo\(function DashboardTelemetry\([\s\S]*?\r?\n\}\);\r?\n\r?\nconst TrendingTargets/,
          'const TrendingTargets',
          'remove telemetry component'
        )
        next = replaceRequired(
          next,
          '<DashboardTelemetry historyData={historyData} isDarkMode={isDarkMode} />',
          '<CompetitivePulse historyData={historyData} />',
          'render discovery pulse'
        )

        // The testing-era reset control is no longer part of the production
        // scan workflow.
        next = replaceRequired(
          next,
          /\r?\n\s*<button onClick=\{handleReset\} disabled=\{isScanning\} title="Clear latest scan view"[\s\S]*?<\/button>/,
          '',
          'remove scan reset button'
        )

        // Keep list-row hover feedback neutral rather than washing the row in
        // the accent color.
        next = replaceRequired(
          next,
          'className="w-full flex items-center gap-3 md:gap-4 px-4 md:px-5 py-3.5 text-left hover:bg-input-bg/60 focus-visible:bg-input-bg/60 focus-visible:outline-none transition-colors group"',
          'className="w-full flex items-center gap-3 md:gap-4 px-4 md:px-5 py-3.5 text-left hover:bg-black/[0.025] dark:hover:bg-white/[0.035] focus-visible:bg-black/[0.025] dark:focus-visible:bg-white/[0.035] focus-visible:outline-none transition-colors group"',
          'neutralize trending row hover'
        )
        next = replaceRequired(
          next,
          'className="text-xs md:text-sm font-semibold text-text-main truncate group-hover:text-electric-blue transition-colors"',
          'className="text-xs md:text-sm font-semibold text-text-main truncate transition-colors"',
          'keep trending title neutral'
        )

        // Make theme switching a first-class header control instead of hiding it
        // inside the account menu.
        const helpButton = '<button type="button" onClick={() => setIsGuideOpen(true)} className="w-10 h-10 rounded-full hover:bg-input-bg flex items-center justify-center text-text-muted hover:text-text-main transition-colors" title="How Atlas works">'
        next = replaceRequired(
          next,
          helpButton,
          `<button\n            type="button"\n            onClick={() => setIsDarkMode(!isDarkMode)}\n            className="w-10 h-10 rounded-full hover:bg-input-bg flex items-center justify-center text-text-muted hover:text-text-main transition-colors"\n            title={isDarkMode ? "Switch to light theme" : "Switch to dark theme"}\n            aria-label={isDarkMode ? "Switch to light theme" : "Switch to dark theme"}\n          >\n            <span className="material-symbols-outlined text-[20px]">{isDarkMode ? "light_mode" : "dark_mode"}</span>\n          </button>\n\n          ${helpButton}`,
          'pin theme toggle in header'
        )
        next = replaceRequired(
          next,
          /\s*<button type="button" onClick=\{\(\) => \{ setIsDarkMode\(!isDarkMode\); setActiveDropdown\(null\); \}\} className="w-full flex items-center gap-3 px-3 py-2\.5 rounded-xl hover:bg-input-bg text-left transition-colors">[\s\S]*?<\/button>/,
          '',
          'remove duplicate theme menu item'
        )

        // Use the card surface for the app bar. The page canvas remains distinct
        // but no longer introduces a navy strip.
        next = replaceRequired(
          next,
          'className="fixed top-0 left-0 right-0 h-16 z-50 bg-bg-base/95 backdrop-blur-xl border-b border-border-subtle flex items-center px-3 sm:px-4 gap-3"',
          'className="fixed top-0 left-0 right-0 h-16 z-50 bg-surface-solid/95 backdrop-blur-xl border-b border-border-subtle flex items-center px-3 sm:px-4 gap-3"',
          'neutral app bar'
        )

        // Retire the old email-recipient UI and language while leaving unrelated
        // batch-list and saved-competitor management untouched.
        next = replaceRequired(
          next,
          'Manage saved competitors, batch lists, and email reporting targets.',
          'Manage saved competitors and reusable batch lists.',
          'update Targets description'
        )
        next = next.replace(
          /\s*fetchJson\(`\$\{API_BASE\}\/api\/emails`\)\.then\(data => setEmailLists\(Array\.isArray\(data\) \? data : \[\]\)\),/,
          ''
        )
        next = replaceRequired(
          next,
          /<div className="bg-surface-solid border border-border-subtle rounded-\[24px\] p-6 shadow-sm">(?=\s*<h2 className="text-base font-semibold text-text-main mb-5 flex items-center gap-2"><span className="material-symbols-outlined text-electric-blue text-\[22px\]">contact_mail<\/span> Add Recipient<\/h2>)/,
          '<div className="hidden" aria-hidden="true">',
          'retire Add Recipient panel'
        )
        next = replaceRequired(
          next,
          /<div className="bg-surface-solid border border-border-subtle rounded-\[24px\] p-6 min-h-\[250px\] shadow-sm">(?=\s*<h2 className="text-sm font-semibold text-text-main mb-5 flex items-center gap-2"><span className="material-symbols-outlined text-\[18px\]">mail<\/span> Report recipients<\/h2>)/,
          '<div className="hidden" aria-hidden="true">',
          'retire Report recipients panel'
        )

        // Settings now describes and shows only active configuration surfaces.
        next = replaceRequired(
          next,
          'Configure Google Sheets integrations and PDF report templates.',
          'Configure Atlas integrations and system preferences.',
          'update Settings description'
        )
        next = replaceRequired(
          next,
          /<div className="bg-surface-solid border border-border-subtle rounded-\[24px\] p-6 shadow-sm space-y-6">(?=\s*<h3 className="text-base font-semibold text-text-main flex items-center gap-2">\s*<span className="material-symbols-outlined text-text-muted text-\[22px\]">description<\/span> PDF template<\/h3>)/,
          '<div className="hidden" aria-hidden="true">',
          'retire PDF template panel'
        )

        return { code: next, map: null }
      }

      if (normalizedId.endsWith('/src/AtlasIntelligenceLayer.jsx')) {
        let next = code

        next = replaceRequired(
          next,
          'import { createPortal } from "react-dom";',
          'import { createPortal } from "react-dom";\nimport AtlasSelect from "./AtlasSelect.jsx";',
          'import AtlasSelect'
        )

        next = replaceRequired(
          next,
          /<select value=\{sort\} onChange=\{e => setSort\(e\.target\.value\)\} className="h-11 px-3\.5 rounded-\[14px\] bg-input-bg border border-transparent hover:border-border-subtle text-\[11px\] text-text-main outline-none transition-colors">[\s\S]*?<\/select>/,
          `<AtlasSelect\n            value={sort}\n            onChange={setSort}\n            ariaLabel="Sort video library"\n            options={[\n              { value: "recent", label: "Most recently seen" },\n              { value: "reused", label: "Most reused" },\n              { value: "duration", label: "Longest duration" },\n              { value: "oldest", label: "First discovered" }\n            ]}\n          />`,
          'replace native Video Library sort select'
        )

        next = replaceRequired(
          next,
          '  const [keywordTarget, setKeywordTarget] = useState(null);',
          `  const [keywordTarget, setKeywordTarget] = useState(null);\n\n  useEffect(() => {\n    const root = document.documentElement;\n    if (videoOpen) root.dataset.atlasVideoOpen = "true";\n    else delete root.dataset.atlasVideoOpen;\n    return () => { delete root.dataset.atlasVideoOpen; };\n  }, [videoOpen]);`,
          'sync Video Library navigation state'
        )

        return { code: next, map: null }
      }

      return null
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [atlasBrowserDialogBridge(), atlasProductPolishBridge(), react()],
})
