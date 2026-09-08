'use strict';

// Direct web clients must use this request's origin. Reverse proxies may supply
// an explicit allowlist; do not trust arbitrary forwarded headers.
function isAllowedOrigin(info, allowedOrigins = []) {
  if (!info.origin) return true; // non-browser clients; not authentication
  try {
    const origin = new URL(info.origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== info.origin) return false;
    if (allowedOrigins.includes(origin.origin)) return true;
    const requestOrigin = `${info.secure ? 'https' : 'http'}://${info.req.headers.host}`;
    if (origin.origin === new URL(requestOrigin).origin) return true;
    // Electron UI servers bind to these eleven loopback ports only.
    return origin.protocol === 'http:' && origin.hostname === '127.0.0.1'
      && Number(origin.port) >= 55510 && Number(origin.port) <= 55520;
  } catch { return false; }
}

module.exports = { isAllowedOrigin };
