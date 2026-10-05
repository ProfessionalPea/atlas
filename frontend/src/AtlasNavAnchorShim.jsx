import { useEffect } from "react";

// App.jsx's Material Symbols are literal text nodes (for example
// "track_changes"), so the rendered button text is not exactly "Targets".
// This tiny bridge supplies an invisible semantic anchor for the modular Video
// Library host without changing the large core App component. It also closes
// the library when a native Atlas destination is chosen.
export default function AtlasNavAnchorShim() {
  useEffect(() => {
    const anchors = new Set();
    let scheduled = false;

    const scan = () => {
      scheduled = false;
      const buttons = [...document.querySelectorAll("button")];
      for (const button of buttons) {
        if (button.hasAttribute("data-atlas-video-nav") || button.hasAttribute("data-atlas-video-anchor")) continue;
        const text = String(button.textContent || "").replace(/\s+/g, " ").trim();
        if (!text.includes("Targets")) continue;
        if (!button.closest("aside") && !button.closest("nav")) continue;

        const parent = button.parentElement;
        if (!parent || parent.querySelector(':scope > [data-atlas-video-anchor="1"]')) continue;

        const anchor = document.createElement("button");
        anchor.type = "button";
        anchor.textContent = "Targets";
        anchor.dataset.atlasVideoAnchor = "1";
        anchor.tabIndex = -1;
        anchor.setAttribute("aria-hidden", "true");
        anchor.style.display = "none";
        parent.insertBefore(anchor, button);
        anchors.add(anchor);
      }
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(scan);
    };

    const closeVideoLibraryOnNativeNavigation = event => {
      const button = event.target.closest?.("button");
      if (!button || button.hasAttribute("data-atlas-video-nav") || button.hasAttribute("data-atlas-video-anchor")) return;
      const text = String(button.textContent || "").replace(/\s+/g, " ").trim();
      if (!["Dashboard", "Directory", "Country Scans", "Targets", "Settings"].some(label => text.includes(label))) return;

      window.requestAnimationFrame(() => {
        const closeButton = [...document.querySelectorAll('button[title="Close"]')]
          .find(candidate => candidate.closest("section")?.querySelector("h1")?.textContent?.includes("Video Library"));
        closeButton?.click();
      });
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("click", closeVideoLibraryOnNativeNavigation, true);
    scan();

    return () => {
      observer.disconnect();
      document.removeEventListener("click", closeVideoLibraryOnNativeNavigation, true);
      anchors.forEach(anchor => anchor.remove());
    };
  }, []);

  return null;
}
