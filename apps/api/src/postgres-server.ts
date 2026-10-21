import { TeamPrivilegeService } from './team-privileges-service';
import { PostgresTeamPrivilegeRepository } from './postgres-team-privileges';
import { dirname, join } from 'node:path';
import { createRuntimeApi,createBrandMedia,assertDemoScenarioOptions, type ApiOptions } from './server';
import { PostgresStore } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import type { RuntimeStore } from './runtime-store';
import { PostgresBrandRepository } from './postgres-brand-repository';
import { SpectatorActivationService } from './spectator-activation';
import { PostgresSpectatorActivationRepository } from './postgres-spectator-activation';
import { SpectatorInvitationService } from './invitation-service';
import { PostgresInvitationRepository } from './postgres-invitation-repository';
import { PostgresPushRepository } from './postgres-push-registrations';
import { PushRegistrationService } from './push-registrations';

export async function createPostgresApi(options: ApiOptions & { connectionString: string; migrationMode?:'apply'|'verify'; seedSynthetic?:boolean; allowOwnerTestFixture?:true }) {
  assertDemoScenarioOptions(options);
  const store = await PostgresStore.open(options.connectionString, options.now, {migrationMode:options.migrationMode});
  try {
    if(options.allowOwnerTestFixture&&process.env.NODE_ENV!=='test')throw new Error('Owner-credential fixtures are available only in the isolated test process.');
    const explicitOwnerFixture=options.allowOwnerTestFixture===true&&options.syntheticAuth===true&&options.seedSynthetic!==false&&(options.migrationMode??'apply')==='apply';
    if(!explicitOwnerFixture)await store.assertRuntimeRole('api');
    if (options.syntheticAuth&&options.seedSynthetic!==false) await store.seedSynthetic({demoSharing:options.demoScenario===true});
    const media = await PgMediaService.open({ directory: options.mediaDirectory ?? join(dirname(options.databasePath), 'media'), database: store.db, scanner: options.mediaScanner, now: options.now });
    const activation = await new PostgresActivationService({ store, provider: options.activationProvider, policy: options.activationPolicy }).initialize();
    const port: RuntimeStore = store;
    const branding=createBrandMedia(options,port,new PostgresBrandRepository(store.db));
    const spectator=new SpectatorActivationService({repository:new PostgresSpectatorActivationRepository(store),provider:options.activationProvider,policy:options.activationPolicy,now:store.now});
    const invitations=new SpectatorInvitationService({...options,repository:new PostgresInvitationRepository(store),now:store.now});
    const privileges=new TeamPrivilegeService(new PostgresTeamPrivilegeRepository(store),store.now);
    const push=new PushRegistrationService(new PostgresPushRepository(store.db),options,store.now);
    return createRuntimeApi(options, store, port, media, activation,undefined,{branding,spectator,invitations,privileges,push});
  } catch (error) { await store.close(); throw error; }
}
