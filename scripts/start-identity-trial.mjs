import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, access, chmod } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const dir = resolve(root, ".local/identity/trial");
const ttl = Number(process.env.LONGBALL_TRIAL_ACTIVATION_TTL_MS);
const amrAge = Number(process.env.LONGBALL_TRIAL_AMR_MAX_AGE_SECONDS);
if (
  !Number.isSafeInteger(ttl) ||
  ttl <= 0 ||
  !Number.isSafeInteger(amrAge) ||
  amrAge <= 0
)
  throw new Error(
    "Supply explicit positive LONGBALL_TRIAL_ACTIVATION_TTL_MS and LONGBALL_TRIAL_AMR_MAX_AGE_SECONDS. These are fictional experiment inputs, not approved production policy.",
  );
const dockerEnv = { ...process.env };
for (const key of [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
])
  delete dockerEnv[key];
const docker = async (...args) =>
  exec("docker", ["--host=unix:///var/run/docker.sock", ...args], {
    env: dockerEnv,
    maxBuffer: 2_000_000,
  });
await access(
  resolve(
    root,
    ".local/keycloak-extension-build/longball-keycloak-activation-0.0.1.jar",
  ),
);
await mkdir(dir, { recursive: true, mode: 0o700 });
const configuration = resolve(dir, "configuration.json");
let config;
try {
  config = JSON.parse(await readFile(configuration, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const secret = () => randomBytes(32).toString("base64url");
  config = {
    issuer: "https://localhost:8443/realms/longball-fictional",
    publicClientId: "longball-mobile-trial",
    serviceClientId: "longball-activation-service",
    serviceClientSecret: secret(),
    bootstrapClientId: `longball-bootstrap-${randomBytes(6).toString("hex")}`,
    bootstrapClientSecret: secret(),
    adultSubject: randomUUID(),
    adultUsername: "fictional.manager",
    adultPassword: secret(),
    policy: {
      version: "explicit-local-fictional-trial",
      activationTtlMs: ttl,
      fictionalOnly: true,
    },
    amrMaxAgeSeconds: amrAge,
    completionRedirectUri: "https://localhost:8443/activation/callback",
    nativeCompletionRedirectUri: "longball://activation/callback",
  };
  await writeFile(configuration, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}
if (config.policy.activationTtlMs !== ttl || config.amrMaxAgeSeconds !== amrAge)
  throw new Error(
    "The existing trial has different explicit policy inputs. Preserve it and use a separately named trial directory rather than silently changing authority or expiry.",
  );
await writeFile(
  resolve(dir, "provider-runtime.json"),
  JSON.stringify(
    {
      issuer: config.issuer,
      publicClientId: config.publicClientId,
      serviceClientId: config.serviceClientId,
      serviceClientSecret: config.serviceClientSecret,
      completionRedirectUri: config.completionRedirectUri,
      nativeCompletionRedirectUri: config.nativeCompletionRedirectUri,
      adultSubject: config.adultSubject,
      policy: config.policy,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
await writeFile(
  resolve(dir, "manager-fixture.json"),
  JSON.stringify(
    {
      username: config.adultUsername,
      password: config.adultPassword,
      issuer: config.issuer,
      publicClientId: config.publicClientId,
      apiBaseUrl: "https://localhost:8444",
      nativeRedirectUri: "longball://auth/callback",
      fictionalOnly: true,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
try {
  await access(resolve(dir, "tls.crt"));
} catch {
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:3072",
    "-sha256",
    "-nodes",
    "-days",
    "7",
    "-subj",
    "/CN=LongBall isolated fictional trial CA",
    "-keyout",
    resolve(dir, "ca.key"),
    "-out",
    resolve(dir, "ca.crt"),
  ]);
  await exec("openssl", [
    "req",
    "-new",
    "-newkey",
    "rsa:3072",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-keyout",
    resolve(dir, "tls.key"),
    "-out",
    resolve(dir, "tls.csr"),
  ]);
  await writeFile(
    resolve(dir, "tls.ext"),
    "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n",
    { mode: 0o600 },
  );
  await exec("openssl", [
    "x509",
    "-req",
    "-in",
    resolve(dir, "tls.csr"),
    "-CA",
    resolve(dir, "ca.crt"),
    "-CAkey",
    resolve(dir, "ca.key"),
    "-CAcreateserial",
    "-days",
    "7",
    "-sha256",
    "-extfile",
    resolve(dir, "tls.ext"),
    "-out",
    resolve(dir, "tls.crt"),
  ]);
  for (const file of ["ca.key", "tls.key", "tls.crt", "ca.crt"])
    await chmod(resolve(dir, file), 0o600);
}
const action = (alias, providerId, priority) => ({
  alias,
  name: alias,
  providerId,
  enabled: true,
  defaultAction: false,
  priority,
  config: {},
});
const execution = (authenticator, requirement, priority, extra = {}) => ({
  authenticator,
  authenticatorFlow: false,
  requirement,
  priority,
  userSetupAllowed: false,
  ...extra,
});
const amr = (alias, value) => ({
  alias,
  config: {
    "default.reference.value": value,
    "default.reference.maxAge": String(amrAge),
  },
});
const realm = {
  realm: "longball-fictional",
  enabled: true,
  sslRequired: "all",
  registrationAllowed: false,
  resetPasswordAllowed: false,
  loginWithEmailAllowed: false,
  duplicateEmailsAllowed: false,
  editUsernameAllowed: false,
  rememberMe: false,
  attributes: { "longball.fictionalActivationTrial": "enabled" },
  roles: {
    realm: [
      { name: "longball-activation-provisioner" },
      { name: "trial-adult-mfa" },
    ],
  },
  requiredActions: [
    action("longball-update-password", "longball-update-password", 10),
    action("longball-recovery-codes", "longball-recovery-codes", 20),
    action("longball-finish-activation", "longball-finish-activation", 30),
    action("CONFIGURE_TOTP", "CONFIGURE_TOTP", 40),
    action("UPDATE_PASSWORD", "UPDATE_PASSWORD", 50),
    action(
      "CONFIGURE_RECOVERY_AUTHN_CODES",
      "CONFIGURE_RECOVERY_AUTHN_CODES",
      60,
    ),
  ],
  clients: [
    {
      clientId: config.publicClientId,
      enabled: true,
      publicClient: true,
      protocol: "openid-connect",
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      redirectUris: [
        "longball://auth/callback",
        "longball://activation/callback",
        "https://localhost:8443/oidc/callback",
        "https://localhost:8443/activation/callback",
      ],
      webOrigins: [],
      attributes: {
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": "longball://auth/callback",
      },
      protocolMappers: [
        {
          name: "LongBall API audience",
          protocol: "openid-connect",
          protocolMapper: "oidc-audience-mapper",
          config: {
            "included.custom.audience": "longball-api",
            "access.token.claim": "true",
            "id.token.claim": "false",
          },
        },
        {
          name: "Verified authentication methods",
          protocol: "openid-connect",
          protocolMapper: "oidc-amr-mapper",
          config: {
            "access.token.claim": "true",
            "id.token.claim": "true",
            "introspection.token.claim": "true",
          },
        },
      ],
    },
    {
      clientId: config.serviceClientId,
      secret: config.serviceClientSecret,
      enabled: true,
      publicClient: false,
      protocol: "openid-connect",
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: true,
    },
  ],
  users: [
    {
      id: config.adultSubject,
      username: config.adultUsername,
      enabled: true,
      emailVerified: false,
      requiredActions: ["CONFIGURE_TOTP", "CONFIGURE_RECOVERY_AUTHN_CODES"],
      realmRoles: ["trial-adult-mfa"],
      credentials: [
        { type: "password", value: config.adultPassword, temporary: false },
      ],
      attributes: { "longball.classification": ["adult_individual"] },
    },
    {
      username: `service-account-${config.serviceClientId}`,
      enabled: true,
      serviceAccountClientId: config.serviceClientId,
      realmRoles: ["longball-activation-provisioner"],
    },
  ],
  authenticationFlows: [
    {
      alias: "longball-browser",
      providerId: "basic-flow",
      topLevel: true,
      builtIn: false,
      authenticationExecutions: [
        execution("auth-cookie", "ALTERNATIVE", 10),
        execution(undefined, "ALTERNATIVE", 20, {
          authenticatorFlow: true,
          flowAlias: "longball-forms",
        }),
      ],
    },
    {
      alias: "longball-forms",
      providerId: "basic-flow",
      topLevel: false,
      builtIn: false,
      authenticationExecutions: [
        execution("auth-username-password-form", "REQUIRED", 10, {
          authenticatorConfig: "longball-pwd-amr",
        }),
        execution(undefined, "CONDITIONAL", 20, {
          authenticatorFlow: true,
          flowAlias: "longball-adult-otp",
        }),
      ],
    },
    {
      alias: "longball-adult-otp",
      providerId: "basic-flow",
      topLevel: false,
      builtIn: false,
      authenticationExecutions: [
        execution("conditional-user-role", "REQUIRED", 10, {
          authenticatorConfig: "longball-adult-condition",
        }),
        execution("auth-otp-form", "REQUIRED", 20, {
          authenticatorConfig: "longball-otp-amr",
        }),
      ],
    },
  ],
  authenticatorConfig: [
    amr("longball-pwd-amr", "pwd"),
    amr("longball-otp-amr", "otp"),
    {
      alias: "longball-adult-condition",
      config: { condUserRole: "trial-adult-mfa" },
    },
  ],
  browserFlow: "longball-browser",
};
await mkdir(resolve(dir, "import"), { recursive: true, mode: 0o700 });
await writeFile(
  resolve(dir, "import/longball-fictional-realm.json"),
  JSON.stringify(realm),
  {
    mode: 0o600,
  },
);
await writeFile(
  resolve(dir, "keycloak.env"),
  `KC_BOOTSTRAP_ADMIN_CLIENT_ID=${config.bootstrapClientId}\nKC_BOOTSTRAP_ADMIN_CLIENT_SECRET=${config.bootstrapClientSecret}\n`,
  { mode: 0o600 },
);
await mkdir(resolve(dir, "data"), { recursive: true, mode: 0o700 });
try {
  const inspected = await docker(
    "inspect",
    "--format",
    "{{.State.Running}}",
    "longball-keycloak-trial",
  );
  if (inspected.stdout.trim() !== "true")
    await docker("start", "longball-keycloak-trial");
  console.log(
    "Existing isolated trial container retained. Reusing its original policy and credentials.",
  );
} catch {
  await docker(
    "run",
    "--detach",
    "--name",
    "longball-keycloak-trial",
    "--memory",
    "1400m",
    "--cpus",
    "2",
    "--publish",
    "127.0.0.1:8443:8443",
    "--env-file",
    resolve(dir, "keycloak.env"),
    "--mount",
    `type=bind,src=${dir}/data,dst=/opt/keycloak/data`,
    "--mount",
    `type=bind,src=${dir}/import,dst=/opt/keycloak/data/import,readonly`,
    "--mount",
    `type=bind,src=${dir}/tls.crt,dst=/run/longball-tls.crt,readonly`,
    "--mount",
    `type=bind,src=${dir}/tls.key,dst=/run/longball-tls.key,readonly`,
    "--mount",
    `type=bind,src=${root}/.local/keycloak-extension-build/longball-keycloak-activation-0.0.1.jar,dst=/opt/keycloak/providers/longball-activation.jar,readonly`,
    "quay.io/keycloak/keycloak:26.8.1@sha256:79c623a22abacf3fe6c00a5fb30f5b7843d717b234033b80995891c06116d244",
    "start-dev",
    "--http-enabled=false",
    "--hostname=https://localhost:8443",
    "--https-certificate-file=/run/longball-tls.crt",
    "--https-certificate-key-file=/run/longball-tls.key",
    "--import-realm",
  );
  console.log(
    "Started Keycloak 26.8.1 fictional trial, loopback TLS port 8443. Credentials and CA are in .local/identity/trial (not printed). This is not production configuration.",
  );
}
