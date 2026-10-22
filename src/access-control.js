const publicRoutes = new Set([
  "POST /callback",
  "POST /seatalk/callback",
  "POST /webhook/seatalk",
  "GET /healthz",
  "GET /login",
  "GET /login.html",
  "GET /auth/login",
  "GET /auth/google/callback",
]);

const viewerRoutes = new Set([
  "GET /api/me",
  "GET /api/messages",
  "GET /api/stream",
  "GET /api/health",
  "GET /api/google/status",
  "POST /auth/logout",
]);

const ownerRoutes = new Set([
  "DELETE /api/messages",
  "POST /api/test-message",
]);

function isStaticPath(pathname) {
  if (!pathname.startsWith("/")) return false;
  if (["/callback", "/seatalk/callback", "/webhook/seatalk", "/healthz"].includes(pathname)) return false;
  return !pathname.startsWith("/api/") && !pathname.startsWith("/auth/");
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(String(host || "").trim().toLowerCase());
}

function isSameOrigin(origin, host) {
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(host || "").toLowerCase();
  } catch {
    return false;
  }
}

function authorizeRequest({ method, pathname, accept = "", role = null, authDisabled = false } = {}) {
  const routeKey = `${String(method || "").toUpperCase()} ${pathname}`;
  if (publicRoutes.has(routeKey)) return "allow";
  const effectiveRole = authDisabled ? "owner" : role;
  if (viewerRoutes.has(routeKey)) return effectiveRole === "owner" || effectiveRole === "viewer" ? "allow" : "unauthorized";
  if (ownerRoutes.has(routeKey)) {
    if (effectiveRole === "owner") return "allow";
    return effectiveRole === "viewer" ? "forbidden" : "unauthorized";
  }
  if (String(method || "").toUpperCase() === "GET" && isStaticPath(pathname)) {
    if (effectiveRole === "owner" || effectiveRole === "viewer") return "allow";
    return String(accept).toLowerCase().includes("text/html") || pathname === "/" ? "redirect-login" : "unauthorized";
  }
  return effectiveRole === "owner" || effectiveRole === "viewer" ? "forbidden" : "unauthorized";
}

export { authorizeRequest, isLoopbackHost, isSameOrigin, isStaticPath };
