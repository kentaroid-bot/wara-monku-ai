// Shared by the static build, local server and Worker responses.
module.exports = Object.freeze({
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy-Report-Only": "default-src 'self'; script-src 'self' https://apis.google.com https://accounts.google.com; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' https:; frame-src 'self' https://*.firebaseapp.com https://accounts.google.com; object-src 'none'; base-uri 'self'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(self), geolocation=(), microphone=()",
});
