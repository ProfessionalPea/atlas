require("dotenv").config();

// Email reporting has been retired from Atlas.
//
// server.js historically imports generateAndSendReport() and registers the
// /api/emails routes inline. Keeping this tiny compatibility module lets older
// server wiring start safely while removing all Gmail/SMTP/report-generation
// behavior. It also blocks the retired routes and strips legacy report fields
// from scan requests before the existing scan handler sees them.
//
// IMPORTANT: Google Sheets sync does NOT use this module. Sheets continues to
// use GoogleSheetsSync.js + GOOGLE_CREDENTIALS_JSON/google-credentials.json.

const express = require("express");

const EMAIL_ROUTE = /^\/api\/emails(?:\/|$)/;
const PATCH_FLAG = Symbol.for("atlas.emailReportingRetired");

function sanitizeScanBody(req) {
  if (!req?.body || typeof req.body !== "object" || Array.isArray(req.body)) return;
  delete req.body.sendReport;
  delete req.body.emailListId;
  delete req.body.reportEmail;
}

function installEmailRetirementGuard() {
  if (express.application[PATCH_FLAG]) return;
  express.application[PATCH_FLAG] = true;

  for (const method of ["get", "post", "delete"]) {
    const original = express.application[method];

    express.application[method] = function retiredEmailRouteGuard(path, ...handlers) {
      if (typeof path === "string" && EMAIL_ROUTE.test(path)) {
        // Return clean empty payload so frontend requests don't error out with 404
        if (method === "get") {
          return original.call(this, path, (_req, res) => res.json([]));
        }
        return original.call(this, path, (_req, res) => res.json({ success: true, retired: true }));
      }

      if (method === "post" && path === "/api/scan") {
        const guardedHandlers = handlers.map(handler => {
          if (typeof handler !== "function") return handler;
          return function atlasScanWithoutEmail(req, res, next) {
            sanitizeScanBody(req);
            return handler.call(this, req, res, next);
          };
        });
        return original.call(this, path, ...guardedHandlers);
      }

      return original.call(this, path, ...handlers);
    };
  }
}

installEmailRetirementGuard();

// Compatibility export for the historical server import. The request guard
// above removes all report flags, so this should never be called by a normal
// Atlas scan. It intentionally performs no I/O and sends no email.
async function generateAndSendReport() {
  return { status: "retired" };
}

module.exports = { generateAndSendReport };
