import { ReportExportRepository } from '../apps/api/src/report-export-repository';
import { ReportExportService } from '../apps/api/src/report-export-service';
import { runDueReportExports } from '../apps/worker/src/report-export-jobs';
import type { ReportExportOptions } from '../apps/api/src/report-export-config';
/** Disposable operational proof. No provider is contacted and no token/key is logged. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { PostgresStore, SYNTHETIC_IDS } from "../apps/api/src/postgres-store";
import { PushRegistrationService } from "../apps/api/src/push-registrations";
import { PostgresPushRepository } from "../apps/api/src/postgres-push-registrations";
import {
  createPushTokenCipher,
  type PushTokenCipher,
} from "../apps/api/src/push-token-crypto";
import { TeamPrivilegeService } from "../apps/api/src/team-privileges-service";
import { PostgresTeamPrivilegeRepository } from "../apps/api/src/postgres-team-privileges";
import { enqueueTeamNotification } from "../apps/worker/src/notification-jobs";
import { createTeamNotificationJob } from "../packages/application/src/team-notifications";
import type { Principal } from "../packages/application/src/access";
import type { PgApplicationContext, PgDatabase } from "../apps/api/src/pg";

const scope = {
  teamId: SYNTHETIC_IDS.teamId,
  seasonId: SYNTHETIC_IDS.seasonId,
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/** Never relabel an earlier checkpoint: read and assert every installed version. */
export async function verifyRuntimeProofSchema(database: PgDatabase) {
  const versions = (
    await database.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    )
  ).rows.map((row) => row.version);
  const mediaVersions = (
    await database.query<{ version: number }>(
      "SELECT version FROM media_schema_migrations ORDER BY version",
    )
  ).rows.map((row) => row.version);
  const activation = (
    await database.query<{ version: number }>(
      "SELECT version FROM lb_activation_schema",
    )
  ).rows;
  const protectedTables = Number(
    (
      await database.query(
        "SELECT count(*)::integer AS value FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='longball' AND c.relrowsecurity",
      )
    ).rows[0].value,
  );
  assert.deepEqual(versions, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  assert.deepEqual(mediaVersions, [1, 2, 3, 4]);
  assert.deepEqual(activation, [{ version: 2 }]);
  assert.equal(protectedTables, 45);
  const sourcePaths = [
    "apps/api/src/pg.ts",
    "apps/api/src/runtime-grants.ts",
    "apps/api/migrations/postgresql/013_team_privileges.sql",
    "apps/api/migrations/postgresql/014_push_registrations.sql",
    "apps/api/migrations/postgresql/015_team_privilege_audit_clock.sql",
    "apps/api/migrations/postgresql/016_report_exports.sql",
    "apps/api/migrations/postgresql/021_club_administration.sql",
    "apps/api/migrations/postgresql/022_team_documents.sql",
    "apps/api/migrations/postgresql/023_opposition_reviews.sql",
    "apps/api/migrations/postgresql/024_spectator_access.sql",
    "apps/api/migrations/postgresql/media_004_team_privileges.sql",
    "scripts/runtime-contribution-boundaries.ts",
    "scripts/runtime-heic.ts",
    "scripts/runtime-rls-restore.ts",
  ];
  const sourceSha256 = Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
  assert(
    process.argv[1]?.endsWith(".mjs"),
    "Run the explicitly bundled operational proof.",
  );
  const proofBundle = {
    file: basename(process.argv[1]),
    sha256: createHash("sha256")
      .update(await readFile(process.argv[1]))
      .digest("hex"),
  };
  return {
    versions,
    featureVersions: { media: 4, mediaVersions, activation: 2 },
    protectedTables,
    sourceSha256,
    proofBundle,
  };
}
const context = (
  principal: Principal,
  role: "manager" | "player",
  operation: string,
): Extract<PgApplicationContext, { kind: "actor" }> => ({
  kind: "actor",
  ...scope,
  clubId: "synthetic-richmond-rovers",
  accountId: principal.accountId,
  issuer: principal.issuer,
  subject: principal.subject,
  strongAuth: principal.strongAuth,
  authenticatedAtMs: principal.authenticatedAt,
  requestedRole: role,
  operation,
  nowMs: Date.now(),
});
async function principal(
  store: PostgresStore,
  accountId: string,
  strongAuth: boolean,
) {
  const identity = {
    issuer: "urn:longball:synthetic",
    subject: accountId,
    strongAuth,
    authenticatedAt: Date.now(),
  };
  return store.withIdentityContext(identity, () => store.principal(identity));
}
const rows = async (store: PostgresStore, deviceId: string) => ({
  privileges: await store.many(
    "SELECT team_id,club_id,revision,state_json FROM team_privilege_states WHERE team_id=$1",
    [scope.teamId],
  ),
  decisions: await store.many(
    "SELECT * FROM team_privilege_decisions WHERE team_id=$1 ORDER BY revision",
    [scope.teamId],
  ),
  registration: await store.many(
    "SELECT * FROM push_registrations WHERE device_id=$1",
    [deviceId],
  ),
  device: await store.many(
    "SELECT * FROM native_app_devices WHERE device_id=$1",
    [deviceId],
  ),
});
export interface RuntimeContributionCheckpoint {
  manager: Principal;
  player: Principal;
  otherPlayer: Principal;
  deviceId: string;
  jobId: string;
  cipher: PushTokenCipher;
  rawToken: string;
  recorded: Awaited<ReturnType<typeof rows>>;
  exportProof: {id:string; options:ReportExportOptions; row:Record<string,unknown>; sha256:string};
}

/** Writes through restricted application repositories before the paired archive. */
export async function prepareRuntimeContributions(
  owner: PostgresStore,
  api: PostgresStore,
  worker: PostgresStore,
): Promise<RuntimeContributionCheckpoint> {
  const manager = await principal(api, "synthetic-account-manager", true);
  const player = await principal(api, "synthetic-account-player-01", false);
  const otherPlayer = await principal(
    api,
    "synthetic-account-player-02",
    false,
  );
  const privileges = new TeamPrivilegeService(
    new PostgresTeamPrivilegeRepository(api),
  );
  const managerSession = { principal: manager, ...scope, role: "manager" };
  for (const privilege of ["uploads", "invitations"] as const) {
    const current = await api.db.withContext(
      context(manager, "manager", "privileges.read"),
      () => privileges.view(managerSession),
    );
    await api.db.withContext(
      context(manager, "manager", "privileges.write"),
      () =>
        privileges.command(managerSession, {
          id: randomUUID(),
          type: "privilege.suspended",
          expectedRevision: current.revision,
          targetAccountId: player.accountId,
          privilege,
          reasonCode: "runtime_restore_probe",
          privateNote:
            "Fictional private operational evidence; never in own-account DTO.",
          confirm: true,
        }),
    );
  }
  const deviceId = `runtime-push-${randomUUID()}`;
  await api.db.withContext(context(player, "player", "identity.enrol"), () =>
    api.enrolDevice(player, { deviceId, platform: "android" }),
  );
  // Ephemeral, explicitly generated test key. It is retained by this process across
  // the restore, separate from the database archive, and is never a deployment key.
  const cipher = createPushTokenCipher(
    "operational-fixture",
    new Map([["operational-fixture", randomBytes(32)]]),
  );
  const rawToken = `fictional-runtime-destination-${randomUUID()}`;
  const push = new PushRegistrationService(new PostgresPushRepository(api.db), {
    pushPlatforms: {
      android: {
        transport: "fcm",
        providerConfigId: "explicit-operational-fixture",
      },
    },
    pushTokenCipher: cipher,
    pushDeliveryConfigured: false,
  });
  await api.db.withContext(context(player, "player", "push.register"), () =>
    push.register(
      player,
      {
        deviceId,
        platform: "android",
        transport: "fcm",
        token: rawToken,
        appBuild: "disposable-runtime-restore",
        permission: "granted",
      },
      0,
      randomUUID(),
    ),
  );
  const jobId = randomUUID();
  await enqueueTeamNotification(
    owner,
    createTeamNotificationJob({
      id: jobId,
      businessKey: `runtime-restore:${jobId}`,
      accountId: player.accountId,
      ...scope,
      audience: "player",
      playerId: "synthetic-player-01",
      category: "schedule",
      entityId: SYNTHETIC_IDS.matchId,
      dueAtMs: Date.now() - 1_000,
    }),
  );
  const exportOptions:ReportExportOptions={encryptionKey:randomBytes(32),ttlMs:3_600_000};
  const exportService=new ReportExportService(new ReportExportRepository(api),api,exportOptions);
  const queued=await api.db.withContext(context(player,"player","exports.request"),()=>api.transaction(()=>exportService.create(player,{...scope,kind:'own_participation',format:'csv'},'player')));
  assert.equal((await runDueReportExports(worker,exportOptions)).completed,1);
  const artifact=await api.withActorContext(player,{operation:'exports.download',requestedRole:'player'},()=>exportService.download(player,queued.id,'player'));
  const exportRow=await owner.one('SELECT * FROM report_exports WHERE id=$1',[queued.id]);assert(exportRow);
  assert.equal(exportRow.snapshot_ciphertext,null);assert.equal(exportRow.status,'ready');
  assert(!JSON.stringify(exportRow).includes('playingMs'));
  const exportProof={id:queued.id,options:exportOptions,row:exportRow,sha256:createHash('sha256').update(artifact.bytes).digest('hex')};
  const recorded = await rows(owner, deviceId);
  assert.equal(recorded.registration.length, 1);
  assert.equal(recorded.decisions.length, 2);
  assert(!JSON.stringify(recorded).includes(rawToken));
  return {
    manager,
    player,
    otherPlayer,
    deviceId,
    jobId,
    cipher,
    rawToken,
    recorded,
    exportProof,
  };
}

/** Rechecks preserved evidence and DB-enforced authority after actual restoration. */
export async function verifyRuntimeContributions(
  owner: PostgresStore,
  api: PostgresStore,
  worker: PostgresStore,
  checkpoint: RuntimeContributionCheckpoint,
) {
  const { manager, player, otherPlayer, deviceId, jobId } = checkpoint;
  const restoredExport=await owner.one('SELECT * FROM report_exports WHERE id=$1',[checkpoint.exportProof.id]);
  assert.deepEqual(restoredExport,checkpoint.exportProof.row,'Restore preserves exact encrypted derived report bytes.');
  const exports=new ReportExportService(new ReportExportRepository(api),api,checkpoint.exportProof.options);
  const restoredArtifact=await api.withActorContext(player,{operation:'exports.download',requestedRole:'player'},()=>exports.download(player,checkpoint.exportProof.id,'player'));
  assert.equal(createHash('sha256').update(restoredArtifact.bytes).digest('hex'),checkpoint.exportProof.sha256);
  const unavailableExports=new ReportExportService(new ReportExportRepository(api),api,{...checkpoint.exportProof.options,encryptionKey:randomBytes(32)});
  await assert.rejects(api.withActorContext(player,{operation:'exports.download',requestedRole:'player'},()=>unavailableExports.download(player,checkpoint.exportProof.id,'player')),error=>(error as {code?:string}).code==='EXPORT_KEY_CHANGED');
  const clearedExport=await owner.one('SELECT status,failure_code,snapshot_ciphertext,artifact_ciphertext,artifact_sha256 FROM report_exports WHERE id=$1',[checkpoint.exportProof.id]);
  assert.deepEqual(clearedExport,{status:'failed',failure_code:'EXPORT_KEY_CHANGED',snapshot_ciphertext:null,artifact_ciphertext:null,artifact_sha256:null});
  const restored = await rows(owner, deviceId);
  assert(
    JSON.stringify(restored) === JSON.stringify(checkpoint.recorded),
    "Restore must preserve the exact private registration, device and privilege evidence.",
  );
  const privileges = new TeamPrivilegeService(
    new PostgresTeamPrivilegeRepository(api),
  );
  const own = await api.db.withContext(
    context(player, "player", "privileges.own"),
    () => privileges.own({ principal: player, ...scope, role: "player" }),
  );
  assert.equal(own.uploadsAllowed, false);
  assert.equal(own.invitationsAllowed, false);
  assert(!JSON.stringify(own).includes("privateNote"));
  await api.db.withContext(
    context(player, "player", "privileges.read"),
    async () => {
      assert.equal(
        (await api.many("SELECT * FROM team_privilege_states")).length,
        0,
      );
      assert.equal(
        (await api.many("SELECT * FROM team_privilege_decisions")).length,
        0,
      );
    },
  );
  await api.db.withContext(
    {
      ...context(manager, "manager", "privileges.read"),
      clubId: "synthetic-other-club",
      teamId: "synthetic-other-team",
    },
    async () => {
      assert.equal(
        (await api.many("SELECT * FROM team_privilege_states")).length,
        0,
      );
      assert.equal(
        (await api.many("SELECT * FROM team_privilege_decisions")).length,
        0,
      );
    },
  );
  const push = new PushRegistrationService(
    new PostgresPushRepository(api.db),
    {},
  );
  const dto = await api.db.withContext(
    context(player, "player", "push.read"),
    () => push.read(player),
  );
  assert.equal(dto.devices.length, 1);
  assert.equal(dto.devices[0].deviceId, deviceId);
  assert.equal(dto.devices[0].state, "registered");
  assert.equal(dto.deliveryConfigured, false);
  assert(!/token|ciphertext|digest/i.test(JSON.stringify(dto)));
  const original = restored.registration[0];
  assert(
    checkpoint.cipher.decrypt(String(original.token_ciphertext), {
      accountId: player.accountId,
      issuer: player.issuer,
      deviceId,
      transport: "fcm",
      providerConfigId: "explicit-operational-fixture",
    }) === checkpoint.rawToken,
    "The separately retained fixture key must decrypt the restored destination.",
  );
  await api.db.withContext(
    context(otherPlayer, "player", "push.read"),
    async () => {
      assert.equal(
        (
          await api.many(
            "SELECT * FROM push_registrations WHERE device_id=$1",
            [deviceId],
          )
        ).length,
        0,
      );
      assert.equal((await push.read(otherPlayer)).devices.length, 0);
    },
  );
  for (const table of [
    "team_privilege_states",
    "team_privilege_decisions",
    "push_registrations",
  ]) {
    assert.equal((await api.many(`SELECT * FROM ${table}`)).length, 0);
    await assert.rejects(worker.many(`SELECT * FROM ${table}`), {
      code: "42501",
    });
  }
  const repository = new PostgresPushRepository(worker.db);
  assert.equal((await repository.deliveryTargets(player.accountId)).length, 0);
  await assert.rejects(
    api.many("SELECT * FROM longball.push_targets_for_current_job($1)", [
      player.accountId,
    ]),
    { code: "42501" },
  );
  const leaseToken = randomBytes(32).toString("hex");
  const claimNow = Date.now();
  const claimed = await worker.db.withContext(
    {
      kind: "worker_claim",
      jobKind: "notification.dispatch",
      nowMs: claimNow,
    },
    () =>
      worker.one("SELECT * FROM longball.claim_due_job($1,$2,$3)", [
        "notification.dispatch",
        claimNow,
        leaseToken,
      ]),
  );
  assert(claimed, "The restored due notification must be claimable.");
  assert.equal(claimed.id, jobId);
  assert(Number(claimed.lease_until) > Date.now());
  const jobContext: Extract<PgApplicationContext, { kind: "worker_job" }> = {
    kind: "worker_job",
    jobId,
    leaseToken,
    clubId: String(claimed.club_id),
    teamId: String(claimed.team_id),
    seasonId: String(claimed.season_id),
    nowMs: Date.now(),
  };
  await worker.db.withContext(jobContext, async () => {
    const targets = await repository.deliveryTargets(player.accountId);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].device_id, deviceId);
    assert.equal(
      (await repository.deliveryTargets(otherPlayer.accountId)).length,
      0,
    );
  });
  await worker.db.withContext(
    { ...jobContext, leaseToken: randomBytes(32).toString("hex") },
    async () => {
      assert.equal(
        (await repository.deliveryTargets(player.accountId)).length,
        0,
      );
    },
  );
  return {
    exactPrivateRowsRestored: true,
    auditedSuspensionsPreserved: 2,
    ownPrivilegesRemainSuspended: true,
    privateDecisionNotesWithheld: true,
    exactEncryptedRegistrationPreserved: true,
    encryptedRegistrationSha256: hash(String(original.token_ciphertext)),
    decryptsWithSeparatelyRetainedEphemeralTestKey: true,
    ownStatusHasNoToken: true,
    otherAccountDenied: true,
    foreignTeamPrivilegesDenied: true,
    contextFreeNewTablesDenied: true,
    workerRawNewTablesDenied: true,
    apiWorkerFunctionDenied: true,
    unclaimedWorkerDestinationDenied: true,
    exactLeasedRecipientOnly: true,
    wrongLeaseCapabilityDenied: true,
    exactEncryptedReportRestored:true,
    reportDecryptsOnlyWithSeparateKey:true,
    missingReportKeyFailsClosedAndClearsArtifact:true,
    actualPushDelivered: false,
  };
}
