import { readFileSync, statSync } from "node:fs";

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidShape(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Array.isArray(value.owners) &&
      Array.isArray(value.viewers) &&
      value.owners.every((email) => typeof email === "string") &&
      value.viewers.every((email) => typeof email === "string"),
  );
}

function roleFor(config, email) {
  const normalized = normalizeEmail(email);
  if (!normalized || !config) return null;
  if (config.owners.has(normalized)) return "owner";
  if (config.viewers.has(normalized)) return "viewer";
  return null;
}

function createAllowlist({ path, fsImpl = { readFileSync, statSync }, logger = console } = {}) {
  let config = null;
  let lastMtimeMs = null;
  let missingLogged = false;
  let hasLoadedGoodConfig = false;

  function getRole(email) {
    let mtimeMs;
    try {
      mtimeMs = fsImpl.statSync(path).mtimeMs;
    } catch {
      config = null;
      lastMtimeMs = null;
      if (!missingLogged) {
        logger.error("Allowlist is missing or unreadable; access is denied.");
        missingLogged = true;
      }
      return null;
    }
    missingLogged = false;
    if (mtimeMs !== lastMtimeMs) {
      lastMtimeMs = mtimeMs;
      try {
        const parsed = JSON.parse(fsImpl.readFileSync(path, "utf8"));
        if (!isValidShape(parsed)) throw new Error("invalid shape");
        config = {
          owners: new Set(parsed.owners.map(normalizeEmail).filter(Boolean)),
          viewers: new Set(parsed.viewers.map(normalizeEmail).filter(Boolean)),
        };
        hasLoadedGoodConfig = true;
      } catch {
        logger.error("Allowlist config is invalid; retaining the last valid config when available.");
        if (!hasLoadedGoodConfig) config = null;
      }
    }
    return roleFor(config, email);
  }

  return { getRole };
}

export { createAllowlist, normalizeEmail };
