import { AccessError, type Principal } from "../../../packages/application/src/access";
import { assertClubAdministration } from "../../../packages/application/src/club-administration";
import { DEFAULT_SIGN_IN_RULES, parseSignInRules, type SignInRules, type SignInRulesDto } from "../../../packages/application/src/identity-policy";
import type { ActivationProvider } from "./activation";
import type { DevelopmentStore } from "./store";
import type { PostgresStore } from "./postgres-store";

type Source = DevelopmentStore | PostgresStore;
const pg = (source: Source): source is PostgresStore => "db" in source;
const ddl = `CREATE TABLE IF NOT EXISTS application_sign_in_rules(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,rules_json TEXT NOT NULL,provider_revision INTEGER);`;
interface SavedRules { revision: number; rules: SignInRules; providerRevision: number | null }
async function saved(source: Source): Promise<SavedRules> {
  let row: { revision: number; rules_json: string | SignInRules; provider_revision: number | null };
  if (pg(source)) {
    const result = await source.one(source.db.migrationMode === "apply" ? "SELECT jsonb_build_object('revision',revision,'rules_json',rules_json,'provider_revision',provider_revision) AS value FROM application_sign_in_rules WHERE singleton=1" : "SELECT longball.sign_in_rules_read() AS value");
    if (!result?.value) throw new AccessError("SIGN_IN_RULES_UNAVAILABLE",503,"Sign-in rules are unavailable. Try again shortly.");
    row = typeof result.value === "string" ? JSON.parse(result.value) : result.value as typeof row;
  } else {
    source.database.exec(ddl);
    source.database.prepare("INSERT INTO application_sign_in_rules(singleton,revision,rules_json) VALUES(1,0,?) ON CONFLICT DO NOTHING").run(JSON.stringify(DEFAULT_SIGN_IN_RULES));
    row = source.database.prepare("SELECT revision,rules_json,provider_revision FROM application_sign_in_rules WHERE singleton=1").get() as unknown as typeof row;
  }
  return { revision:Number(row.revision), rules:parseSignInRules(typeof row.rules_json === "string" ? JSON.parse(row.rules_json) : row.rules_json), providerRevision: row.provider_revision === null ? null : Number(row.provider_revision) };
}
function dto(value: SavedRules, providerConfigured = false): SignInRulesDto {
  const status = !providerConfigured ? "not_configured" : value.providerRevision === value.revision ? "applied" : "pending";
  return { kind:"sign-in-rules",revision:value.revision,rules:value.rules,provider:{status,detail:status === "applied" ? "Rules apply to newly chosen provider credentials and new usernames. Existing sign-ins stay valid." : status === "not_configured" ? "Demo sign-ins keep their existing credentials. New spectator usernames and passcodes use these rules; the password provider is not connected." : "The password provider has not yet confirmed this rule revision. Save the rules to apply them before enabling new provider accounts."} };
}
/** Safe public policy metadata; never includes usernames, verifiers or account existence. */
export async function loadSignInRules(source: Source): Promise<SignInRulesDto> { return dto(await saved(source)); }
/** Synchronise the configured provider before creating an identity or credential flow. */
export async function ensureProviderSignInRules(source: Source, provider?: ActivationProvider): Promise<SignInRulesDto> {
  const current=await saved(source);
  if(!provider) return dto(current);
  const adapter=provider as ActivationProvider & {applySignInRules?: (input:{revision:number;rules:SignInRules})=>Promise<{revision:number;enforced:true}>};
  if(!adapter.applySignInRules)throw new AccessError("SIGN_IN_RULES_PROVIDER_UNAVAILABLE",503,"The identity provider cannot enforce the current sign-in rules.");
  try {
    const confirmation=await adapter.applySignInRules({revision:current.revision,rules:current.rules});
    if(confirmation.revision!==current.revision||confirmation.enforced!==true)throw new Error("unconfirmed");
    if(pg(source) && source.db.migrationMode === "apply"){
      const result=await source.one("UPDATE application_sign_in_rules SET provider_revision=$1 WHERE singleton=1 AND revision=$1 RETURNING true AS confirmed",[current.revision]);
      if(result?.confirmed!==true)throw new Error("changed");
    }else if(pg(source)){
      const result=await source.one("SELECT longball.sign_in_rules_provider_confirm($1) AS confirmed",[current.revision]);
      if(result?.confirmed!==true)throw new Error("changed");
    }else{
      const result=source.database.prepare("UPDATE application_sign_in_rules SET provider_revision=? WHERE singleton=1 AND revision=?").run(current.revision,current.revision);
      if(!result.changes)throw new Error("changed");
    }
    return dto({...current,providerRevision:current.revision},true);
  }catch {throw new AccessError("SIGN_IN_RULES_PROVIDER_UNAVAILABLE",503,"The identity provider did not confirm the current sign-in rules. Retry before creating credentials.");}
}
export class SignInRulesService {
  constructor(private readonly source: Source, private readonly provider?: ActivationProvider) {}
  async currentRules(): Promise<SignInRules> { return (await saved(this.source)).rules; }
  async view(): Promise<SignInRulesDto> { return dto(await saved(this.source),!!this.provider); }
  async authorize(principal: Principal): Promise<void> {
    const fresh=await this.source.principal({issuer:principal.issuer,subject:principal.subject,strongAuth:principal.strongAuth,authenticatedAt:principal.authenticatedAt});
    assertClubAdministration(fresh,undefined,true,this.source.now());
  }
  async adminView(principal: Principal): Promise<SignInRulesDto> { await this.authorize(principal); return this.view(); }
  async save(principal: Principal, input: unknown): Promise<SignInRulesDto> {
    await this.authorize(principal);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 || !("expectedRevision" in input) || !("rules" in input) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision)<0) throw new AccessError("INVALID_REQUEST",400,"Use the current rule revision and documented rules.");
    const rules=parseSignInRules(input.rules);
    if(pg(this.source)) await this.source.one("SELECT longball.sign_in_rules_lock() AS revision");
    const current=await saved(this.source);
    if(current.revision!==input.expectedRevision) throw new AccessError("SIGN_IN_RULES_CONFLICT",409,"The sign-in rules changed. Reload them before saving.");
    const revision=current.revision+1;
    let applied: number|null=null;
    if(this.provider){
      const adapter=this.provider as ActivationProvider & {applySignInRules?: (input:{revision:number;rules:SignInRules})=>Promise<{revision:number;enforced:true}>};
      if(!adapter.applySignInRules) throw new AccessError("SIGN_IN_RULES_PROVIDER_UNAVAILABLE",503,"The configured identity provider cannot enforce these rules yet. No rules were changed.");
      try { const confirmation=await adapter.applySignInRules({revision,rules});if(confirmation.revision!==revision||confirmation.enforced!==true)throw new Error("unconfirmed");applied=revision; }
      catch {throw new AccessError("SIGN_IN_RULES_PROVIDER_UNAVAILABLE",503,"The identity provider did not confirm the rules. No rules were changed; retry before creating accounts.");}
    }
    if(pg(this.source)) await this.source.one("SELECT longball.sign_in_rules_save($1,$2::jsonb,$3) AS revision",[current.revision,JSON.stringify(rules),applied]);
    else {
      const result=this.source.database.prepare("UPDATE application_sign_in_rules SET revision=?,rules_json=?,provider_revision=? WHERE singleton=1 AND revision=?").run(revision,JSON.stringify(rules),applied,current.revision);
      if(!result.changes)throw new AccessError("SIGN_IN_RULES_CONFLICT",409,"The sign-in rules changed. Reload them before saving.");
    }
    await this.source.audit(principal,"application.sign_in_rules.updated",String(revision),"accepted");
    return this.view();
  }
}
