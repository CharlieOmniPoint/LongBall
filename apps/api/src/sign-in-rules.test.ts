import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SIGN_IN_RULES } from "../../../packages/application/src/identity-policy";
import { DevelopmentStore } from "./store";
import { SignInRulesService, ensureProviderSignInRules } from "./sign-in-rules";
import type { ActivationProvider } from "./activation";

describe("sign-in policy provider confirmation",()=>{
  let source:DevelopmentStore;
  beforeEach(()=>{source=new DevelopmentStore(":memory:");source.seedSynthetic({demoSharing:true});});
  afterEach(()=>source.close());
  const provider=(applySignInRules?:ActivationProvider["applySignInRules"])=>({applySignInRules} as ActivationProvider);
  const principal=()=>source.principal({issuer:"urn:longball:synthetic",subject:"synthetic-account-admin",strongAuth:true,authenticatedAt:source.now()});
  it("does not save rules when provider enforcement is unsupported, fails, or acknowledges the wrong revision",async()=>{
    await expect(ensureProviderSignInRules(source,provider())).rejects.toMatchObject({status:503});
    for(const apply of [undefined,vi.fn(async()=>{throw new Error("provider private error");}),vi.fn(async()=>({revision:500,enforced:true as const}))]){
      const service=new SignInRulesService(source,provider(apply));
      await expect(service.save(principal(),{expectedRevision:0,rules:DEFAULT_SIGN_IN_RULES})).rejects.toMatchObject({status:503});
      expect((await service.view()).revision).toBe(0);
    }
  });
  it("confirms the bound revision and applies rules before provider credential creation",async()=>{
    const apply=vi.fn(async(input:{revision:number})=>({revision:input.revision,enforced:true as const})), p=provider(apply), service=new SignInRulesService(source,p);
    expect((await ensureProviderSignInRules(source,p)).provider.status).toBe("applied");
    expect(apply).toHaveBeenLastCalledWith({revision:0,rules:DEFAULT_SIGN_IN_RULES});
    expect((await service.save(principal(),{expectedRevision:0,rules:DEFAULT_SIGN_IN_RULES})).provider.status).toBe("applied");
    expect(apply).toHaveBeenLastCalledWith({revision:1,rules:DEFAULT_SIGN_IN_RULES});
    expect((await service.view()).revision).toBe(1);
  });
  it("rechecks current Super Admin grant and strong authentication",async()=>{
    const service=new SignInRulesService(source);
    const actor=principal();
    await expect(service.save({...actor,strongAuth:false},{expectedRevision:0,rules:DEFAULT_SIGN_IN_RULES})).rejects.toMatchObject({status:403});
    source.database.prepare("DELETE FROM administration_grants WHERE account_id=?").run(actor.accountId);
    await expect(service.save(actor,{expectedRevision:0,rules:DEFAULT_SIGN_IN_RULES})).rejects.toMatchObject({status:404});
    expect((await service.view()).revision).toBe(0);
  });
});
