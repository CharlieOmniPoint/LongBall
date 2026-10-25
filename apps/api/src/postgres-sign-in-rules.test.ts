import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { DEFAULT_SIGN_IN_RULES } from "../../../packages/application/src/identity-policy";
import { PostgresStore } from "./postgres-store";
import { PgMediaService } from "./postgres-media";
import { PostgresActivationService } from "./postgres-activation";
import { applyRuntimeGrants } from "./runtime-grants";
import { SignInRulesService } from "./sign-in-rules";
import { PgDatabase } from "./pg";

const configured=process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configured)("restricted PostgreSQL global sign-in rule enforcement",()=>{
  it("denies direct tables and non-Super writes, validates direct function input and saves atomically under the current grant",async()=>{
    const admin=new Pool({connectionString:configured,max:2}),suffix=randomUUID().replaceAll("-",""),database=`lb_rules_${suffix}`,roles={apiRole:`lb_rules_api_${suffix}`,workerRole:`lb_rules_worker_${suffix}`},directory=await mkdtemp(join(tmpdir(),"lb-rules-pg-"));
    let owner:PostgresStore|undefined,api:PostgresStore|undefined,worker:PgDatabase|undefined,media:PgMediaService|undefined;
    try{
      await admin.query(`CREATE DATABASE "${database}"`);
      for(const role of Object.values(roles))await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
      const url=new URL(configured!);url.pathname=`/${database}`;owner=await PostgresStore.open(url.href);await owner.seedSynthetic({demoSharing:true});media=await PgMediaService.open({directory:join(directory,"media"),database:owner.db});await new PostgresActivationService({store:owner}).initialize();await applyRuntimeGrants(owner.db,roles);
      const apiUrl=new URL(url);apiUrl.username=roles.apiRole;apiUrl.password="";api=await PostgresStore.open(apiUrl.href,undefined,{migrationMode:"verify"});
      const workerUrl=new URL(url);workerUrl.username=roles.workerRole;workerUrl.password="";worker=new PgDatabase(workerUrl.href,{migrationMode:"verify"});
      const service=new SignInRulesService(api);expect((await service.view()).revision).toBe(0);
      await expect(api.execute("UPDATE application_sign_in_rules SET revision=900")).rejects.toMatchObject({code:"42501"});
      await expect(worker.query("SELECT sign_in_rules_read()")).rejects.toMatchObject({code:"42501"});
      const identity=(subject:string)=>({issuer:"urn:longball:synthetic",subject,strongAuth:true,authenticatedAt:Date.now()});
      const superIdentity=identity("synthetic-account-admin"),clubIdentity=identity("synthetic-account-club-admin");
      const superPrincipal=await api.withIdentityContext(superIdentity,()=>api!.principal(superIdentity));
      const clubPrincipal=await api.withIdentityContext(clubIdentity,()=>api!.principal(clubIdentity));
      await expect(api.withActorContext(clubPrincipal,{operation:"administration.write",requestedRole:"administrator"},()=>api!.one("SELECT sign_in_rules_save(0,$1::jsonb,NULL)",[JSON.stringify(DEFAULT_SIGN_IN_RULES)]))).rejects.toMatchObject({code:"42501"});
      const invalid=[{...DEFAULT_SIGN_IN_RULES,password:{...DEFAULT_SIGN_IN_RULES.password,minLength:null}},{...DEFAULT_SIGN_IN_RULES,password:{...DEFAULT_SIGN_IN_RULES.password,minLength:"12"}},{...DEFAULT_SIGN_IN_RULES,username:{...DEFAULT_SIGN_IN_RULES.username,minLength:null}},{...DEFAULT_SIGN_IN_RULES,username:{...DEFAULT_SIGN_IN_RULES.username,maxLength:"40"}}];
      for(const rules of invalid)await expect(api.withActorContext(superPrincipal,{operation:"administration.write",requestedRole:"administrator"},()=>api!.one("SELECT sign_in_rules_save(0,$1::jsonb,NULL)",[JSON.stringify(rules)]))).rejects.toMatchObject({code:"23514"});
      expect((await service.view()).revision).toBe(0);
      const rules={...DEFAULT_SIGN_IN_RULES,password:{...DEFAULT_SIGN_IN_RULES.password,minLength:16}};
      const saved=await api.withActorContext(superPrincipal,{operation:"administration.write",requestedRole:"administrator"},()=>api!.transaction(()=>service.save(superPrincipal,{expectedRevision:0,rules})));
      expect(saved).toMatchObject({revision:1,rules,provider:{status:"not_configured"}});
      await owner.execute("DELETE FROM administration_grants WHERE account_id='synthetic-account-admin'");
      await expect(api.withActorContext(superPrincipal,{operation:"administration.write",requestedRole:"administrator"},()=>api!.transaction(()=>service.save(superPrincipal,{expectedRevision:1,rules})))).rejects.toMatchObject({status:404});
      expect((await service.view()).revision).toBe(1);
    }finally{
      await media?.close();await api?.close();await worker?.close();await owner?.close();
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);for(const role of Object.values(roles))await admin.query(`DROP ROLE IF EXISTS "${role}"`);await admin.end();await rm(directory,{recursive:true,force:true});
    }
  });
});
