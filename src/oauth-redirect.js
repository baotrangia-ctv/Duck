const GOOGLE_CALLBACK_PATH = "/auth/google/callback";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function describeRedirectUri({ redirectUri = "", port, host = "", explicit = false } = {}) {
  const value = String(redirectUri);
  const warnings = [];
  let parsed;

  try {
    const candidate = new URL(value);
    if (["http:", "https:"].includes(candidate.protocol)) parsed = candidate;
  } catch {
    // Keep invalid values visible in the returned warnings.
  }

  if (!parsed) {
    warnings.push("Redirect URI phải là URL tuyệt đối bắt đầu bằng http:// hoặc https://.");
  } else {
    if (parsed.pathname !== GOOGLE_CALLBACK_PATH) {
      warnings.push(`Đường dẫn Redirect URI phải chính xác là ${GOOGLE_CALLBACK_PATH}.`);
    }
    if (parsed.pathname.endsWith("/") || /\s/.test(value)) {
      warnings.push("Redirect URI có dấu gạch chéo cuối hoặc khoảng trắng; hãy bỏ chúng.");
    }

    const redirectHost = parsed.hostname.toLowerCase();
    const loopback = LOOPBACK_HOSTS.has(redirectHost);
    if (loopback && Number.isFinite(Number(port))) {
      const redirectPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
      if (redirectPort !== Number(port)) {
        const source = explicit ? "được cấu hình" : "mặc định";
        warnings.push(`Cổng Redirect URI ${source} (${redirectPort}) khác PORT=${port}; server bind tại ${host}:${port}.`);
      }
    }
    if (parsed.protocol === "http:" && !loopback) {
      warnings.push("Google chỉ chấp nhận http:// cho host loopback; host khác cần dùng https://.");
    }
    if (redirectHost === "127.0.0.1") {
      warnings.push("Google cần đăng ký riêng 127.0.0.1; địa chỉ này không tương đương localhost.");
    }
  }

  if (/\s/.test(value) && !warnings.some((warning) => warning.includes("khoảng trắng"))) {
    warnings.push("Redirect URI có khoảng trắng; hãy bỏ chúng.");
  }

  return { ok: warnings.length === 0, warnings };
}

export { describeRedirectUri };
