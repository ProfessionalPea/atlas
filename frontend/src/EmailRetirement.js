// Atlas email reporting is retired.
//
// This compatibility layer removes the old email controls from the existing
// App.jsx surface and prevents legacy clients/components from sending report
// fields to the backend. It intentionally does not touch Google Sheets sync.

const nativeFetch = typeof window !== "undefined" ? window.fetch.bind(window) : null;
const RETIRED_EMAIL_API = /\/api\/emails(?:\/|$)/;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

if (nativeFetch && !window.__atlasEmailRetirementInstalled) {
  window.__atlasEmailRetirementInstalled = true;

  window.fetch = async function atlasFetchWithoutEmail(input, init = {}) {
    const rawUrl = typeof input === "string" ? input : input?.url;
    let url;
    try {
      url = new URL(rawUrl, window.location.origin);
    } catch {
      return nativeFetch(input, init);
    }

    const method = String(init?.method || input?.method || "GET").toUpperCase();

    // Saved report recipients no longer exist as an Atlas feature. Returning an
    // empty list for old GET callers keeps older App.jsx code harmless while the
    // UI is removed. Mutations receive an explicit retired response.
    if (RETIRED_EMAIL_API.test(url.pathname)) {
      if (method === "GET") return jsonResponse([]);
      return jsonResponse({ error: "Email reporting has been retired from Atlas." }, 410);
    }

    // Defense in depth for older frontend code: strip all report-delivery fields
    // before a scan request leaves the browser.
    if (url.pathname === "/api/scan" && method === "POST" && typeof init?.body === "string") {
      try {
        const payload = JSON.parse(init.body);
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          delete payload.sendReport;
          delete payload.emailListId;
          delete payload.reportEmail;
          init = { ...init, body: JSON.stringify(payload) };
        }
      } catch {
        // Non-JSON scan bodies are passed through unchanged.
      }
    }

    return nativeFetch(input, init);
  };
}

function retireEmailControls() {
  if (typeof document === "undefined") return;

  for (const label of document.querySelectorAll("label")) {
    if (label.textContent?.trim() === "Email report") {
      const control = label.parentElement;
      if (control) {
        control.style.display = "none";
        control.setAttribute("aria-hidden", "true");
        control.dataset.atlasRetiredEmail = "1";
      }
    }
  }

  const retiredHeadings = new Set(["Add Recipient", "Report recipients"]);
  for (const heading of document.querySelectorAll("h1, h2, h3")) {
    if (!retiredHeadings.has(heading.textContent?.trim())) continue;
    const card = heading.parentElement;
    if (card) {
      card.style.display = "none";
      card.setAttribute("aria-hidden", "true");
      card.dataset.atlasRetiredEmail = "1";
    }
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const start = () => {
    retireEmailControls();
    const observer = new MutationObserver(() => retireEmailControls());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("beforeunload", () => observer.disconnect(), { once: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
