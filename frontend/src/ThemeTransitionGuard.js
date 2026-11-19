const THEME_KEY = "atlas_theme";
const ACCENT_KEY = "atlas_accent";
const ROOT = document.documentElement;

try {
  const savedTheme = localStorage.getItem(THEME_KEY);
  const theme =
    savedTheme === "light" || savedTheme === "light-warm"
      ? "light-warm"
      : savedTheme === "light-crisp"
      ? "light-crisp"
      : "dark";
  const savedAccent = localStorage.getItem(ACCENT_KEY);
  const accent = savedAccent === "mono" ? "mono" : "cobalt";
  ROOT.dataset.theme = theme;
  ROOT.dataset.accent = accent;
  if (theme === "dark") ROOT.classList.add("dark");
  else ROOT.classList.remove("dark");
} catch {}

let lastSignature = `${ROOT.dataset.theme || ""}:${ROOT.dataset.accent || ""}`;
let settleTimer = null;

function markThemeSwitch() {
  ROOT.classList.add("atlas-theme-switching");
  if (settleTimer) window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    ROOT.classList.remove("atlas-theme-switching");
    settleTimer = null;
  }, 140);
}

const observer = new MutationObserver(() => {
  const nextSignature = `${ROOT.dataset.theme || ""}:${ROOT.dataset.accent || ""}`;
  if (nextSignature === lastSignature) return;
  lastSignature = nextSignature;
  markThemeSwitch();
});

observer.observe(ROOT, { attributes: true, attributeFilter: ["class", "data-theme", "data-accent"] });
