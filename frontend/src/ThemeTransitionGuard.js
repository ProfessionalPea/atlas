const THEME_KEY = "atlas_theme";
const ROOT = document.documentElement;

// Apply the persisted theme before React mounts so Atlas never paints the
// opposite theme first and then corrects itself a frame later.
try {
  const savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme === "light") ROOT.classList.remove("dark");
  else if (savedTheme === "dark") ROOT.classList.add("dark");
} catch {}

let lastDark = ROOT.classList.contains("dark");
let settleTimer = null;

function markThemeSwitch() {
  ROOT.classList.add("atlas-theme-switching");
  if (settleTimer) window.clearTimeout(settleTimer);

  // Keep the transition guard around just long enough for the new CSS custom
  // properties and dark selectors to commit in one paint. Existing component
  // transitions then resume without each card/input independently tweening.
  settleTimer = window.setTimeout(() => {
    ROOT.classList.remove("atlas-theme-switching");
    settleTimer = null;
  }, 140);
}

const observer = new MutationObserver(() => {
  const nextDark = ROOT.classList.contains("dark");
  if (nextDark === lastDark) return;
  lastDark = nextDark;
  markThemeSwitch();
});

observer.observe(ROOT, { attributes: true, attributeFilter: ["class"] });
