export interface ContentTrakerIdentityPolicyStatus {
  required: boolean;
  valid: boolean;
  requiredUserEmailConfigured: boolean;
  namedCredentialProfileConfigured: boolean;
  diagnostics: string[];
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["", "0", "false", "no", "off"]);

export function inspectContentTrakerIdentityPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ContentTrakerIdentityPolicyStatus {
  const requestedRequirement = env.CONTENTTRAKER_REQUIRE_IDENTITY_POLICY?.trim().toLowerCase() ?? "";
  const requirementValid = TRUE_VALUES.has(requestedRequirement) || FALSE_VALUES.has(requestedRequirement);
  const required = TRUE_VALUES.has(requestedRequirement);
  const requiredUserEmail = env.CONTENTTRAKER_REQUIRED_USER_EMAIL?.trim();
  const requiredUserEmailConfigured = Boolean(requiredUserEmail);
  const requiredUserEmailValid = !requiredUserEmail
    || /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(requiredUserEmail);
  const credentialProfile = env.CONTENTTRAKER_CREDENTIAL_PROFILE?.trim().toLowerCase();
  const namedCredentialProfileConfigured = Boolean(credentialProfile && credentialProfile !== "default");
  const diagnostics: string[] = [];

  if (!requirementValid) {
    diagnostics.push(
      "CONTENTTRAKER_REQUIRE_IDENTITY_POLICY must be true or false.",
    );
  }
  if (!requiredUserEmailValid) {
    diagnostics.push(
      "CONTENTTRAKER_REQUIRED_USER_EMAIL must be a valid email address when configured.",
    );
  }
  if (required && !requiredUserEmailConfigured) {
    diagnostics.push(
      "ContentTraker identity policy is required by this Codex plugin host, but CONTENTTRAKER_REQUIRED_USER_EMAIL is not configured. No stored credential will be restored or used.",
    );
  }
  if (required && !namedCredentialProfileConfigured) {
    diagnostics.push(
      "ContentTraker identity policy is required by this Codex plugin host, but CONTENTTRAKER_CREDENTIAL_PROFILE is missing or default. Set a named host-isolated profile; no stored credential will be restored or used.",
    );
  }

  return {
    required,
    valid: requirementValid
      && requiredUserEmailValid
      && (!required || (requiredUserEmailConfigured && namedCredentialProfileConfigured)),
    requiredUserEmailConfigured,
    namedCredentialProfileConfigured,
    diagnostics,
  };
}
