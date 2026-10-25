import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { DEFAULT_SIGN_IN_RULES, type SignInRulesDto } from "../../../packages/application/src/identity-policy";
import { createApi } from "./server";
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from "./store";

describe("global sign-in rule HTTP authority and persistence", () => {
  it("allows public safe metadata, restricts writes to Super Admin, rejects stale edits and applies new spectator rules without changing existing logins", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lb-sign-in-rules-"));
    const options = { databasePath: join(directory,"db.sqlite"), syntheticAuth:true,demoScenario:true,publicAppEntryUrl:"https://example.invalid/",invitationPolicyVersion:"test-rules-v1" };
    let app = createApi(options);
    const start = async () => { await new Promise<void>(resolve=>app.server.listen(0,"127.0.0.1",resolve));return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`; };
    let base = await start();
    const call = async (path:string,token?:string,body?:object,key=randomUUID()) => {
      const result=await fetch(base+path,{method:body?"POST":"GET",headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body?{"Content-Type":"application/json","X-Api-Contract-Version":EVENT_CONTRACT_VERSION,"Idempotency-Key":key}:{})},...(body?{body:JSON.stringify(body)}:{})});
      return {status:result.status,body:await result.json() as SignInRulesDto & {code?:string;shareUrl?:string;accessToken?:string}};
    };
    try {
      const publicRules=await call("/v1/sign-in-rules"); expect(publicRules.status).toBe(200); expect(publicRules.body.rules).toEqual(DEFAULT_SIGN_IN_RULES);expect(JSON.stringify(publicRules.body)).not.toMatch(/accountId|hash|salt|subject/);
      const path="/v1/administration/sign-in-rules", changed={...DEFAULT_SIGN_IN_RULES,username:{...DEFAULT_SIGN_IN_RULES.username,allowNumbers:false},password:{...DEFAULT_SIGN_IN_RULES.password,minLength:16}};
      for(const token of ["synthetic-club-admin","synthetic-manager-1","synthetic-account-player-01","synthetic-spectator"]){ expect([403,404]).toContain((await call(path,token)).status); expect([403,404]).toContain((await call(path,token,{expectedRevision:0,rules:changed})).status); }
      const saveKey=randomUUID(), update={expectedRevision:0,rules:changed};
      const saved=await call(path,"synthetic-admin",update,saveKey);expect(saved.status).toBe(200);expect(saved.body).toMatchObject({revision:1,rules:changed,provider:{status:"not_configured"}});
      expect((await call(path,"synthetic-admin",update,saveKey)).body.revision).toBe(1);
      expect((await call(path,"synthetic-admin",update)).status).toBe(409);
      expect((await call(path,"synthetic-admin",{expectedRevision:1,rules:{...changed,password:{...changed.password,minLength:1}}})).status).toBe(400);
      const {teamId,seasonId}=SYNTHETIC_IDS;
      const issued=await call(`/v1/teams/${teamId}/spectator-invites?seasonId=${seasonId}`,"synthetic-manager-1",{seasonId,expiresInHours:1}); expect(issued.status).toBe(201);
      const token=new URLSearchParams(new URL(issued.body.shareUrl!).hash.slice(1)).get("code");
      expect((await call("/v1/spectator-access/register",undefined,{token,username:"Roma.Fan2",passcode:"4729",requestId:randomUUID()})).status).toBe(400);
      const created=await call("/v1/spectator-access/register",undefined,{token,username:"Roma.Fan",passcode:"4729",requestId:randomUUID()});expect(created.status).toBe(201);
      await app.close();app=createApi(options);base=await start();
      expect((await call(path,"synthetic-admin")).body).toMatchObject({revision:1,rules:changed});
      expect((await call("/v1/spectator-access/login",undefined,{username:"ROMA.FAN",passcode:"4729"})).status).toBe(201);
      expect((await call("/v1/me","synthetic-manager-1")).status).toBe(200);
    } finally {app.server.closeAllConnections();await app.close();await rm(directory,{recursive:true,force:true});}
  });
});
