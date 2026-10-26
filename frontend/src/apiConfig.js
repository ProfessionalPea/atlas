// Single source of truth for the backend URL. Every module must import from here so
// tunnel URL changes only need to be made in one place.
export const NGROK_URL = "https://studio-bouncing-applicant.ngrok-free.dev";

export const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:3000"
  : (import.meta.env?.VITE_API_BASE_URL || NGROK_URL);
