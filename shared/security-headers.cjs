// Shared by the static build, local server and Worker responses.
module.exports = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(self), geolocation=(), microphone=()",
});
