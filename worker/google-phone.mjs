import { createRemoteJWKSet, jwtVerify, errors } from "jose";
import { phoneDigest } from "../shared/auth-wire.mjs";

const keys = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

export async function verifiedPhoneEvent(
  token,
  project,
  phoneHash,
  issued,
  now,
) {
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ["RS256"],
      issuer: "https://securetoken.google.com/" + project,
      audience: project,
      requiredClaims: ["exp", "iat", "sub", "auth_time"],
    });
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > 128 ||
      payload.firebase?.sign_in_provider !== "phone" ||
      payload.firebase?.tenant ||
      !Number.isSafeInteger(payload.auth_time) ||
      payload.auth_time < issued ||
      payload.auth_time > now ||
      payload.iat > now ||
      typeof payload.phone_number !== "string" ||
      (await phoneDigest(payload.phone_number)) !== phoneHash
    )
      return null;
    // Refreshing a token does not change the time of the original phone sign-in.
    return String(payload.auth_time);
  } catch (error) {
    if (
      error instanceof errors.JOSEError &&
      !(error instanceof errors.JWKSTimeout)
    )
      return null;
    throw error;
  }
}
