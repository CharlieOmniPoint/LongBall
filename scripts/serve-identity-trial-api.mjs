import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { readDatabaseUrl } from "../apps/api/src/database-config.ts";
import {
  PostgresStore,
  SYNTHETIC_IDS,
} from "../apps/api/src/postgres-store.ts";
import { createPostgresApi } from "../apps/api/src/postgres-server.ts";
import { createKeycloakActivationProvider } from "../apps/api/src/keycloak-activation-provider.ts";
import { readTrial, trialDirectory } from "./identity-trial-support.mjs";

const mode = process.argv[2];
const config =
  mode === "--bootstrap-fixture"
    ? await readTrial()
    : JSON.parse(
        await readFile(
          resolve(trialDirectory, "provider-runtime.json"),
          "utf8",
        ),
      );
if (process.env.LONGBALL_IDENTITY_TRIAL_BOOTSTRAP !== "1")
  throw new Error(
    "This isolated fictional identity trial requires explicit LONGBALL_IDENTITY_TRIAL_BOOTSTRAP=1; it is not a production bootstrap command.",
  );
function databaseUrl(name) {
  const value = readDatabaseUrl(process.env, name);
  if (!value)
    throw new Error(
      "Configure the dedicated identity-trial database URL_FILE selectors using the bounded database bootstrap.",
    );
  const parsed = new URL(value);
  if (
    parsed.pathname !== "/longball_identity_trial" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  )
    throw new Error(
      "The identity trial permits only the exact named loopback PostgreSQL database.",
    );
  return value;
}
const runtimeUrl = databaseUrl("LONGBALL_IDENTITY_TRIAL_RUNTIME_DATABASE_URL");
const marker = {
  version: 1,
  issuer: config.issuer,
  providerAdultSubject: config.adultSubject,
  teamId: SYNTHETIC_IDS.teamId,
  seasonId: SYNTHETIC_IDS.seasonId,
  playerId: "fictional-identity-activation-player",
  accountId: "synthetic-account-manager",
};
function matchesMarker(saved) {
  if (!saved || typeof saved.value_json !== "string") return false;
  const value = JSON.parse(saved.value_json);
  return (
    Object.keys(value).length === Object.keys(marker).length &&
    Object.entries(marker).every(([key, expected]) => value[key] === expected)
  );
}
if (mode === "--bootstrap-fixture") {
  const migrationUrl = databaseUrl(
    "LONGBALL_IDENTITY_TRIAL_MIGRATION_DATABASE_URL",
  );
  if (new URL(runtimeUrl).username === new URL(migrationUrl).username)
    throw new Error(
      "Serving credentials must be distinct from the schema owner.",
    );
  const store = await PostgresStore.open(migrationUrl, Date.now, {
    migrationMode: "apply",
  });
  try {
    await store.transaction(async () => {
      await store.db.query(
        "CREATE TABLE IF NOT EXISTS lb_identity_trial_fixture(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value_json JSONB NOT NULL)",
      );
      const saved = await store.one(
        "SELECT value_json FROM lb_identity_trial_fixture WHERE singleton=1",
      );
      if (saved) {
        if (!matchesMarker(saved))
          throw new Error(
            "A different provider fixture already owns this database; preserve it.",
          );
        return;
      }
      if (await store.one("SELECT id FROM teams LIMIT 1"))
        throw new Error(
          "Refusing to bind provider authority into a nonempty unmarked database.",
        );
      await store.seedSynthetic();
      // Explicit offline fixture authority only. Serving still verifies actual provider JWTs;
      // there is no auth selector, password grant, external signup or real adult verification.
      await store.execute(
        "UPDATE accounts SET issuer=$1,subject=$2 WHERE id=$3 AND issuer='urn:longball:synthetic'",
        [config.issuer, config.adultSubject, marker.accountId],
      );
      const preparation = await store.document(
        marker.teamId,
        marker.seasonId,
        "preparation",
      );
      preparation.profiles.push({
        ...preparation.profiles[0],
        id: randomUUID(),
        playerId: marker.playerId,
        displayName: "Fictional activation player",
        shirtNumber: null,
      });
      preparation.revision += 1;
      await store.saveDocument(
        marker.teamId,
        marker.seasonId,
        "preparation",
        preparation,
      );
      await store.execute(
        "INSERT INTO lb_identity_trial_fixture VALUES(1,$1)",
        [JSON.stringify(marker)],
      );
      const runtimeRole = decodeURIComponent(new URL(runtimeUrl).username);
      if (!/^longball_identity_trial_api$/.test(runtimeRole))
        throw new Error(
          "Use the existing dedicated restricted identity-trial API role.",
        );
      await store.db.query(
        'GRANT SELECT ON lb_identity_trial_fixture TO "longball_identity_trial_api"',
      );
    });
    await writeFile(
      resolve(trialDirectory, "api-fixture.json"),
      JSON.stringify(
        {
          ...marker,
          apiBaseUrl: "https://localhost:8444",
          nativeReturnUri: "longball://activation/callback",
          publicClientId: config.publicClientId,
          fictionalOnly: true,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(
      "Bound the actual provider subject only to the explicitly marked fictional Roma fixture. No production account or authority was bootstrapped.",
    );
  } finally {
    await store.close();
  }
} else if (mode === "--serve") {
  if (
    process.env.LONGBALL_IDENTITY_TRIAL_MIGRATION_DATABASE_URL ||
    process.env.LONGBALL_IDENTITY_TRIAL_MIGRATION_DATABASE_URL_FILE
  )
    throw new Error(
      "Remove migration database credential selectors from the serving process environment.",
    );
  // Runtime has no DDL credentials and cannot create its own marker or approved policy.
  const check = await PostgresStore.open(runtimeUrl, Date.now, {
    migrationMode: "verify",
  });
  try {
    const role = await check.one(
      "SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user",
    );
    if (!role || role.rolsuper || role.rolcreatedb || role.rolcreaterole)
      throw new Error(
        "Use the restricted trial API role, never a PostgreSQL administrator.",
      );
    const saved = await check.one(
      "SELECT value_json FROM lb_identity_trial_fixture WHERE singleton=1",
    );
    if (!matchesMarker(saved))
      throw new Error(
        "Run the explicit named fictional fixture bootstrap before serving.",
      );
  } finally {
    await check.close();
  }
  const provider = createKeycloakActivationProvider({
    issuer: config.issuer,
    serviceClientId: config.serviceClientId,
    serviceClientSecret: async () => config.serviceClientSecret,
    publicClientId: config.publicClientId,
    completionRedirectUri:
      process.env.LONGBALL_IDENTITY_TRIAL_NATIVE_CALLBACK === "1"
        ? config.nativeCompletionRedirectUri
        : config.completionRedirectUri,
  });
  const api = await createPostgresApi({
    connectionString: runtimeUrl,
    migrationMode: "verify",
    databasePath: resolve(trialDirectory, "unused-sqlite-path"),
    mediaDirectory:
      process.env.LONGBALL_IDENTITY_TRIAL_MEDIA_DIRECTORY ??
      resolve(trialDirectory, "media"),
    oidc: {
      issuer: config.issuer,
      audience: "longball-api",
      jwksUri: `${config.issuer}/protocol/openid-connect/certs`,
    },
    activationProvider: provider,
    activationPolicy: config.policy,
    // Actual existing static entry; this config never forwards capabilities to an API selected by a link.
    publicAppEntryUrl: "https://charlieomnipoint.github.io/LongBall/",
    invitationPolicyVersion: config.policy.version,
    allowedOrigins: (process.env.LONGBALL_IDENTITY_TRIAL_BROWSER_ORIGINS ?? "")
      .split(",")
      .filter(Boolean),
  });
  await new Promise((resolve, reject) => {
    api.server.once("error", reject);
    api.server.listen(4318, "127.0.0.1", resolve);
  });
  const secure = createHttpsServer(
    {
      key: await readFile(resolve(trialDirectory, "tls.key")),
      cert: await readFile(resolve(trialDirectory, "tls.crt")),
    },
    (incoming, outgoing) => {
      const target = httpRequest(
        {
          hostname: "127.0.0.1",
          port: 4318,
          path: incoming.url,
          method: incoming.method,
          headers: incoming.headers,
        },
        (result) => {
          outgoing.writeHead(result.statusCode ?? 502, result.headers);
          result.pipe(outgoing);
        },
      );
      target.on("error", () => {
        outgoing.writeHead(502, { "content-type": "application/json" });
        outgoing.end('{"error":{"code":"TRIAL_API_UNAVAILABLE"}}');
      });
      incoming.pipe(target);
    },
  );
  await new Promise((resolve, reject) => {
    secure.once("error", reject);
    secure.listen(8444, "127.0.0.1", resolve);
  });
  console.log(
    "Fictional Roma API serves verified real-provider JWTs on loopback HTTPS8444 using the restricted PostgreSQL role. No synthetic bearer aliases are accepted. Phone/LAN deployment remains unconfigured.",
  );
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await new Promise((resolve) => secure.close(resolve));
    await api.close();
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
} else throw new Error("Choose --bootstrap-fixture or --serve explicitly.");
