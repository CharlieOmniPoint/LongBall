-- SEC12 opaque invitation verifiers and first-account reservations; no raw URL/token storage.
CREATE TABLE longball.spectator_invitations(
 id text PRIMARY KEY,club_id text NOT NULL,team_id text NOT NULL,season_id text NOT NULL,inviter_account_id text NOT NULL REFERENCES longball.accounts(id),
 credential_kind text NOT NULL CHECK(credential_kind IN('sha256','legacy_retired')),credential_version integer NOT NULL DEFAULT 1 CHECK(credential_version=1),
 token_hash text UNIQUE CHECK(token_hash~'^[a-f0-9]{64}$'),legacy_fingerprint text CHECK(legacy_fingerprint~'^[a-f0-9]{64}$'),retired_at bigint,
 requires_reissue boolean NOT NULL DEFAULT false,created_at bigint NOT NULL,expires_at bigint NOT NULL,
 accepted_by text REFERENCES longball.accounts(id),accepted_at bigint,revoked_at bigint,reissued_from_invitation_id text REFERENCES longball.spectator_invitations(id),policy_version text,
 UNIQUE(id,token_hash,club_id,team_id,season_id),FOREIGN KEY(club_id,team_id,season_id) REFERENCES longball.team_seasons(club_id,team_id,season_id),
 CHECK((credential_kind='sha256' AND token_hash IS NOT NULL AND legacy_fingerprint IS NULL AND retired_at IS NULL AND NOT requires_reissue AND NULLIF(policy_version,'') IS NOT NULL)
 OR(credential_kind='legacy_retired' AND token_hash IS NULL AND legacy_fingerprint IS NOT NULL AND retired_at IS NOT NULL)),
 CHECK((accepted_by IS NULL)=(accepted_at IS NULL)),CHECK(expires_at>created_at));
CREATE UNIQUE INDEX spectator_invitation_single_reissue ON longball.spectator_invitations(reissued_from_invitation_id) WHERE reissued_from_invitation_id IS NOT NULL;
CREATE TABLE longball.lb_spectator_activation_accounts(
 account_id text PRIMARY KEY REFERENCES longball.accounts(id),invitation_id text NOT NULL UNIQUE,invitation_token_hash text NOT NULL UNIQUE,
 club_id text NOT NULL,team_id text NOT NULL,season_id text NOT NULL,username text NOT NULL,
 state text NOT NULL CHECK(state IN('provisioning','pending_activation','active')),provider_issuer text,provider_subject text,
 created_request_id text NOT NULL,request_signature text NOT NULL,created_at bigint NOT NULL,
 UNIQUE(account_id,invitation_token_hash,club_id,team_id,season_id),UNIQUE(provider_issuer,provider_subject),
 FOREIGN KEY(invitation_id,invitation_token_hash,club_id,team_id,season_id) REFERENCES longball.spectator_invitations(id,token_hash,club_id,team_id,season_id),
 CHECK((provider_issuer IS NULL)=(provider_subject IS NULL)),CHECK(state<>'active' OR provider_subject IS NOT NULL));
CREATE UNIQUE INDEX spectator_activation_username ON longball.lb_spectator_activation_accounts(lower(username));
CREATE TABLE longball.lb_spectator_activation_attempts(
 id text PRIMARY KEY,account_id text NOT NULL REFERENCES longball.lb_spectator_activation_accounts(account_id),request_id text NOT NULL,request_signature text NOT NULL,device_id text NOT NULL,
 flow_id text,expires_at bigint NOT NULL,created_at bigint NOT NULL,state text NOT NULL CHECK(state IN('provisioning','pending_activation','completed','cancelled')),
 generation integer NOT NULL CHECK(generation>0),completed_at bigint,cancelled_at bigint,
 UNIQUE(account_id,request_id),UNIQUE(account_id,generation),CHECK(expires_at>created_at),
 CHECK(state NOT IN('pending_activation','completed') OR NULLIF(flow_id,'') IS NOT NULL),CHECK(state<>'completed' OR completed_at IS NOT NULL),CHECK(state<>'cancelled' OR cancelled_at IS NOT NULL));
CREATE UNIQUE INDEX spectator_activation_current_attempt ON longball.lb_spectator_activation_attempts(account_id) WHERE state IN('provisioning','pending_activation');

-- Retire historical plaintext credentials, including command/cache copies. Accepted grants stay intact.
CREATE FUNCTION longball.retire_invitation_commands(p_commands jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_object_agg(e.key,CASE WHEN e.value LIKE '%"reviewCode"%'
 THEN to_jsonb('invitation-command-retired:v1:'||encode(sha256(convert_to('longball.spectator-invitation.command-retired.v1:'||e.value,'UTF8')),'hex')) ELSE to_jsonb(e.value) END),'{}'::jsonb)
 FROM jsonb_each_text(COALESCE(p_commands,'{}'::jsonb))e $$;
CREATE FUNCTION longball.redact_invitation_cache(p_value jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,longball AS $fn$
DECLARE result jsonb;entry record; BEGIN
 IF jsonb_typeof(p_value)='array' THEN SELECT COALESCE(jsonb_agg(longball.redact_invitation_cache(a.value)),'[]'::jsonb) INTO result FROM jsonb_array_elements(p_value)a;RETURN result; END IF;
 IF jsonb_typeof(p_value)<>'object' THEN RETURN p_value; END IF;
 IF p_value ? 'shareUrl' THEN RETURN jsonb_build_object('id',p_value->'id','expiresAt',p_value->'expiresAt','teamId',p_value->'teamId','seasonId',p_value->'seasonId','credentialAvailable',false,'requiresReissue',true); END IF;
 IF p_value ? 'inviterAccountId' AND p_value ? 'seasonId' AND p_value ? 'id' THEN
  RETURN jsonb_build_object('id',p_value->'id','teamId',p_value->'teamId','seasonId',p_value->'seasonId','inviterAccountId',p_value->'inviterAccountId','createdAtMs',p_value->'createdAtMs','expiresAtMs',p_value->'expiresAtMs','acceptedBy',p_value->'acceptedBy','acceptedAtMs',p_value->'acceptedAtMs','revokedAtMs',p_value->'revokedAtMs','reissuedFromInvitationId',p_value->'reissuedFromInvitationId','requiresReissue',p_value->>'acceptedBy' IS NULL AND p_value->>'revokedAtMs' IS NULL);
 END IF;
 result='{}'::jsonb;
 FOR entry IN SELECT key,value FROM jsonb_each(p_value) LOOP
  IF entry.key IN('reviewCode','credential','tokenHash','token','activationToken','completionProof') THEN CONTINUE;
  ELSIF entry.key='appliedCommands' THEN result=result||jsonb_build_object(entry.key,longball.retire_invitation_commands(entry.value));
  ELSE result=result||jsonb_build_object(entry.key,longball.redact_invitation_cache(entry.value)); END IF;
 END LOOP;RETURN result;
END $fn$;
DO $retirement$ DECLARE d record;i jsonb;updated jsonb;credential jsonb;fingerprint text;changed boolean;next_value jsonb;commands jsonb;next_revision bigint;requires_reissue boolean;observed bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; BEGIN
 FOR d IN SELECT * FROM longball.documents WHERE kind='community' LOOP
  updated='[]'::jsonb;changed=false;
  FOR i IN SELECT value FROM jsonb_array_elements(COALESCE(d.value_json->'invitations','[]'::jsonb)) LOOP
   IF i#>>'{credential,kind}'='sha256' AND i#>>'{credential,tokenHash}'~'^[a-f0-9]{64}$' AND NOT(i ? 'reviewCode') THEN
    credential=i->'credential';
   ELSE
    IF i#>>'{credential,kind}'='legacy_retired' AND NOT(i ? 'reviewCode') THEN credential=i->'credential';
    ELSE
     changed=true;requires_reissue=i->>'acceptedBy' IS NULL AND i->>'acceptedAtMs' IS NULL AND i->>'revokedAtMs' IS NULL;
     fingerprint=encode(sha256(convert_to('longball.spectator-invitation.legacy-retired.v1:'||char_length(i->>'id')::text||':'||(i->>'id')||':'||COALESCE(i->>'reviewCode',i#>>'{credential,code}',''),'UTF8')),'hex');
     credential=jsonb_build_object('kind','legacy_retired','version',1,'redactedAtMs',observed,'fingerprint',fingerprint,'requiresReissue',requires_reissue);
     IF requires_reissue THEN i=jsonb_set(i,'{revokedAtMs}',to_jsonb(observed));END IF;
    END IF;
   END IF;
   i=jsonb_build_object('id',i->'id','teamId',i->'teamId','seasonId',i->'seasonId','inviterAccountId',i->'inviterAccountId','createdAtMs',i->'createdAtMs','expiresAtMs',i->'expiresAtMs','acceptedBy',i->'acceptedBy','acceptedAtMs',i->'acceptedAtMs','revokedAtMs',i->'revokedAtMs','credential',credential,'reissuedFromInvitationId',i->'reissuedFromInvitationId','policyVersion',i->'policyVersion');updated=updated||jsonb_build_array(i);
   IF credential->>'kind'='legacy_retired' THEN i=i-'policyVersion';updated=jsonb_set(updated,ARRAY[(jsonb_array_length(updated)-1)::text],i);END IF;
   IF d.club_id IS NOT NULL AND i->>'teamId'=d.team_id AND i->>'seasonId'=d.season_id THEN
    INSERT INTO longball.spectator_invitations(id,club_id,team_id,season_id,inviter_account_id,credential_kind,token_hash,legacy_fingerprint,retired_at,requires_reissue,created_at,expires_at,accepted_by,accepted_at,revoked_at,reissued_from_invitation_id,policy_version)
    VALUES(i->>'id',d.club_id,d.team_id,d.season_id,i->>'inviterAccountId',credential->>'kind',credential->>'tokenHash',credential->>'fingerprint',(credential->>'redactedAtMs')::bigint,COALESCE((credential->>'requiresReissue')::boolean,false),(i->>'createdAtMs')::bigint,(i->>'expiresAtMs')::bigint,i->>'acceptedBy',(i->>'acceptedAtMs')::bigint,(i->>'revokedAtMs')::bigint,NULL,CASE WHEN credential->>'kind'='sha256' THEN i->>'policyVersion' ELSE NULL END);
   END IF;
  END LOOP;
  commands=longball.retire_invitation_commands(d.value_json->'appliedCommands');changed=changed OR commands IS DISTINCT FROM COALESCE(d.value_json->'appliedCommands','{}'::jsonb);
  next_value=jsonb_set(jsonb_set(d.value_json,'{invitations}',updated),'{appliedCommands}',commands);next_revision=COALESCE((d.value_json->>'revision')::bigint,d.revision);
  IF changed THEN next_revision=next_revision+1;next_value=jsonb_set(jsonb_set(next_value,'{revision}',to_jsonb(next_revision)),'{audit}',COALESCE(d.value_json->'audit','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id','invitation-retirement:'||next_revision,'actorAccountId',NULL,'action','service.invitation_legacy_credentials_retired','atMs',observed)));END IF;
  UPDATE longball.documents SET value_json=next_value,revision=next_revision WHERE team_id=d.team_id AND season_id=d.season_id AND kind='community';
 END LOOP;
 UPDATE longball.spectator_invitations target SET reissued_from_invitation_id=x.value->>'reissuedFromInvitationId' FROM longball.documents recorded CROSS JOIN LATERAL jsonb_array_elements(COALESCE(recorded.value_json->'invitations','[]'::jsonb))x WHERE recorded.kind='community' AND x.value->>'id'=target.id AND x.value->>'reissuedFromInvitationId' IS NOT NULL;
 UPDATE longball.idempotency SET response_json=longball.redact_invitation_cache(response_json) WHERE response_json::text~'"(reviewCode|shareUrl|credential|tokenHash|appliedCommands|token|activationToken|completionProof)"';
END $retirement$;
REVOKE ALL ON FUNCTION longball.retire_invitation_commands(jsonb),longball.redact_invitation_cache(jsonb) FROM PUBLIC;

-- Metadata is separate from controller credentials and grants no game authority.
CREATE TABLE longball.native_app_devices(
 device_id text PRIMARY KEY CHECK(char_length(device_id) BETWEEN 1 AND 120 AND device_id~'^[A-Za-z0-9_-]+$'),
 account_id text NOT NULL REFERENCES longball.accounts(id),issuer text NOT NULL,platform text NOT NULL CHECK(platform IN('ios','android')),
 registered_at bigint NOT NULL,last_seen_at bigint NOT NULL,CHECK(last_seen_at>=registered_at));
CREATE FUNCTION longball.native_device_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
DECLARE observed bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.device_id,NEW.account_id,NEW.issuer) IS DISTINCT FROM ROW(OLD.device_id,OLD.account_id,OLD.issuer) THEN RAISE EXCEPTION 'Device belongs to another account' USING ERRCODE='42501'; END IF;
  NEW.registered_at=OLD.registered_at;NEW.last_seen_at=greatest(OLD.last_seen_at,observed);
 ELSE NEW.registered_at=observed;NEW.last_seen_at=observed;END IF;RETURN NEW;
END $fn$;
CREATE TRIGGER native_device_boundary BEFORE INSERT OR UPDATE ON longball.native_app_devices FOR EACH ROW EXECUTE FUNCTION longball.native_device_guard();
ALTER TABLE longball.native_app_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY native_devices_read ON longball.native_app_devices FOR SELECT USING(longball.actor_valid() AND account_id=longball.context_json()->>'accountId' AND issuer=longball.context_json()->>'issuer' AND longball.context_json()->>'operation' IN('identity.devices','identity.enrol'));
CREATE POLICY native_devices_insert ON longball.native_app_devices FOR INSERT WITH CHECK(longball.actor_valid() AND account_id=longball.context_json()->>'accountId' AND issuer=longball.context_json()->>'issuer' AND longball.context_json()->>'operation'='identity.enrol');
CREATE POLICY native_devices_update ON longball.native_app_devices FOR UPDATE USING(longball.actor_valid() AND account_id=longball.context_json()->>'accountId' AND issuer=longball.context_json()->>'issuer' AND longball.context_json()->>'operation'='identity.enrol') WITH CHECK(longball.actor_valid() AND account_id=longball.context_json()->>'accountId' AND issuer=longball.context_json()->>'issuer');
REVOKE ALL ON FUNCTION longball.native_device_guard() FROM PUBLIC;

CREATE FUNCTION longball.invitation_live(p_hash text,p_account text DEFAULT NULL) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT longball.runtime_purpose() IN('api','maintenance') AND p_hash~'^[a-f0-9]{64}$' AND EXISTS(
 SELECT 1 FROM longball.spectator_invitations i JOIN longball.teams t ON t.id=i.team_id AND t.club_id=i.club_id
 JOIN longball.documents d ON d.club_id=i.club_id AND d.team_id=i.team_id AND d.season_id=i.season_id AND d.kind='community'
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.value_json->'seasons','[]'::jsonb))s(value)
 WHERE i.token_hash=p_hash AND i.credential_kind='sha256' AND i.revoked_at IS NULL AND i.created_at<=longball.context_now() AND i.expires_at>longball.context_now()
 AND(i.accepted_by IS NULL OR i.accepted_by=p_account) AND s.value->>'id'=i.season_id AND s.value->>'teamId'=i.team_id
 AND(s.value->>'accessEndsAtMs')::bigint>longball.context_now() AND i.expires_at<=(s.value->>'accessEndsAtMs')::bigint AND t.scope_status='resolved') $$;
CREATE FUNCTION longball.invitation_record_matches(p_id text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT count(*)=1 FROM longball.spectator_invitations i JOIN longball.documents d ON d.club_id=i.club_id AND d.team_id=i.team_id AND d.season_id=i.season_id AND d.kind='community'
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.value_json->'invitations','[]'::jsonb))x(value)
 WHERE i.id=p_id AND x.value->>'id'=i.id AND x.value->>'teamId'=i.team_id AND x.value->>'seasonId'=i.season_id AND x.value->>'inviterAccountId'=i.inviter_account_id
 AND i.credential_kind='sha256' AND x.value#>>'{credential,kind}'='sha256' AND x.value#>>'{credential,version}'='1' AND x.value#>>'{credential,tokenHash}'=i.token_hash
 AND(x.value->>'createdAtMs')::bigint=i.created_at AND(x.value->>'expiresAtMs')::bigint=i.expires_at
 AND(x.value->>'acceptedBy') IS NOT DISTINCT FROM i.accepted_by AND(x.value->>'acceptedAtMs')::bigint IS NOT DISTINCT FROM i.accepted_at
 AND(x.value->>'revokedAtMs')::bigint IS NOT DISTINCT FROM i.revoked_at $$;
CREATE FUNCTION longball.invitation_preflight(p_hash text)
 RETURNS TABLE(id text,club_id text,team_id text,season_id text,expires_at bigint,policy_version text,inviter_account_id text)
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT i.id,i.club_id,i.team_id,i.season_id,i.expires_at,i.policy_version,i.inviter_account_id FROM longball.spectator_invitations i
 WHERE longball.context_json()->>'kind'='invitation_activation' AND p_hash=longball.context_json()->>'tokenHash'
 AND i.token_hash=p_hash AND longball.invitation_record_matches(i.id) AND longball.invitation_live(p_hash,(SELECT a.account_id FROM longball.lb_spectator_activation_accounts a WHERE a.invitation_id=i.id)) $$;
CREATE FUNCTION longball.invitation_accept_scope(p_hash text) RETURNS TABLE(id text,club_id text,team_id text,season_id text,expires_at bigint,team_name text,season_label text)
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT i.id,i.club_id,i.team_id,i.season_id,i.expires_at,t.name,s.label FROM longball.spectator_invitations i
 JOIN longball.teams t ON t.id=i.team_id AND t.club_id=i.club_id JOIN longball.team_seasons s ON s.club_id=i.club_id AND s.team_id=i.team_id AND s.season_id=i.season_id
 WHERE longball.actor_valid() AND longball.context_json()->>'operation'='invite.resolve' AND p_hash=longball.context_json()->>'invitationTokenHash'
 AND i.token_hash=p_hash AND longball.invitation_record_matches(i.id) AND i.revoked_at IS NULL AND i.credential_kind='sha256'
 AND((i.accepted_by IS NULL AND longball.invitation_live(p_hash)) OR(i.accepted_by=longball.context_json()->>'accountId' AND longball.raw_spectator_grant(i.accepted_by,i.club_id,i.team_id,i.season_id))) $$;
CREATE FUNCTION longball.spectator_activation_account(p_account text,p_verified boolean DEFAULT false) RETURNS boolean
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT longball.runtime_purpose() IN('api','maintenance') AND longball.context_json()->>'kind'='invitation_activation'
 AND(NOT p_verified OR(longball.context_json()->>'completionVerified'='true' AND longball.context_json()->>'activationId' IS NOT NULL))
 AND EXISTS(SELECT 1 FROM longball.lb_spectator_activation_accounts a WHERE a.account_id=p_account AND a.invitation_token_hash=longball.context_json()->>'tokenHash'
 AND longball.invitation_live(a.invitation_token_hash,a.account_id)
 AND(longball.context_json()->>'activationId' IS NULL OR EXISTS(SELECT 1 FROM longball.lb_spectator_activation_attempts x WHERE x.account_id=a.account_id AND x.id=longball.context_json()->>'activationId'
 AND((NOT p_verified AND x.state='provisioning') OR x.state IN('pending_activation','completed')) AND x.expires_at>longball.context_now()))) $$;
CREATE OR REPLACE FUNCTION longball.invite_capability(c text,t text,s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT longball.actor_valid() AND longball.context_matches(c,t,s) AND longball.context_json()->>'teamId'=t AND longball.context_json()->>'seasonId'=s AND longball.context_json()->>'operation'='invite.accept'
 AND EXISTS(SELECT 1 FROM longball.spectator_invitations i WHERE i.club_id=c AND i.team_id=t AND i.season_id=s AND i.token_hash=longball.context_json()->>'invitationTokenHash' AND i.revoked_at IS NULL AND i.credential_kind='sha256' AND((i.accepted_by IS NULL AND longball.invitation_live(i.token_hash)) OR(i.accepted_by=longball.context_json()->>'accountId' AND longball.raw_spectator_grant(i.accepted_by,c,t,s)))) $$;
CREATE OR REPLACE FUNCTION longball.document_write(c text,t text,s text,k text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT
 longball.actor_manager(c,t,s)
 OR(longball.actor_admin(c,t,longball.context_json()->>'seasonId') AND((k='preparation' AND longball.context_json()->>'operation'='configuration.write' AND s=longball.context_json()->>'seasonId') OR(k='staff' AND longball.context_json()->>'operation' IN('staff.assign','staff.revoke') AND s=longball.context_json()->>'seasonId') OR(longball.context_json()->>'operation'='season.create' AND s=longball.context_json()->>'newSeasonId')))
 OR(longball.actor_role(c,t,s) IN('player','spectator') AND((k='community' AND longball.context_json()->>'operation'='community.write') OR(k='preparation' AND longball.context_json()->>'operation'='preparation.own.write')))
 OR(k='community' AND longball.actor_role(c,t,s)='player' AND longball.context_json()->>'operation' IN('invite.issue','invite.reissue','invite.revoke'))
 OR(k='community' AND longball.invite_capability(c,t,s))
 OR(k='community' AND longball.worker_job_valid(c,t,s) AND longball.worker_kind()='award.finalise') $$;
-- Invitation/award/comment updates do not recreate unchanged game contexts or grant game authority.
CREATE OR REPLACE FUNCTION longball.record_game_contexts() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
DECLARE item jsonb;p record;game_id text;BEGIN
 IF TG_TABLE_NAME='matches' THEN
  game_id=NEW.id;SELECT * INTO p FROM longball.game_contexts WHERE id=game_id;
  IF FOUND AND(p.club_id<>NEW.club_id OR p.team_id<>NEW.team_id OR p.season_id<>NEW.season_id) THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501';END IF;
  IF NOT FOUND THEN INSERT INTO longball.game_contexts(id,club_id,team_id,season_id,source) VALUES(game_id,NEW.club_id,NEW.team_id,NEW.season_id,'accepted_match');END IF;
 ELSIF NEW.kind='community' THEN
  IF TG_OP='UPDATE' AND NEW.value_json->'matches' IS NOT DISTINCT FROM OLD.value_json->'matches' THEN RETURN NEW;END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.value_json->'matches','[]'::jsonb)) LOOP
   IF item->>'teamId'=NEW.team_id AND item->>'seasonId'=NEW.season_id THEN
    SELECT * INTO p FROM longball.game_contexts WHERE id=item->>'id';
    IF FOUND AND(p.club_id<>NEW.club_id OR p.team_id<>NEW.team_id OR p.season_id<>NEW.season_id) THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501';END IF;
    IF NOT FOUND THEN INSERT INTO longball.game_contexts(id,club_id,team_id,season_id,source) VALUES(item->>'id',NEW.club_id,NEW.team_id,NEW.season_id,'community_match');END IF;
   END IF;
  END LOOP;
 END IF;RETURN NEW;
END $fn$;
CREATE FUNCTION longball.spectator_account_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
BEGIN
 IF longball.context_json()->>'kind'='invitation_activation' THEN
  IF NEW.classification<>'unclassified' OR NEW.adult_verified<>0 OR NEW.strong_auth_enrolled<>0 THEN RAISE EXCEPTION 'Spectator account authority unavailable' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' AND(NEW.id IS DISTINCT FROM OLD.id OR(OLD.status='active' AND NEW.status<>'active') OR(NEW.status='active' AND(NOT longball.spectator_activation_account(OLD.id,true) OR NEW.issuer IS DISTINCT FROM OLD.issuer OR NEW.subject IS DISTINCT FROM OLD.subject))) THEN RAISE EXCEPTION 'Spectator account activation unavailable' USING ERRCODE='42501'; END IF;
 END IF;RETURN NEW;
END $fn$;
CREATE TRIGGER spectator_account_boundary BEFORE INSERT OR UPDATE ON longball.accounts FOR EACH ROW EXECUTE FUNCTION longball.spectator_account_guard();
CREATE FUNCTION longball.guard_spectator_reservation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
BEGIN
 IF ROW(NEW.account_id,NEW.invitation_id,NEW.invitation_token_hash,NEW.club_id,NEW.team_id,NEW.season_id,NEW.username,NEW.created_request_id,NEW.request_signature,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.account_id,OLD.invitation_id,OLD.invitation_token_hash,OLD.club_id,OLD.team_id,OLD.season_id,OLD.username,OLD.created_request_id,OLD.request_signature,OLD.created_at)
 OR(OLD.provider_subject IS NOT NULL AND ROW(NEW.provider_issuer,NEW.provider_subject) IS DISTINCT FROM ROW(OLD.provider_issuer,OLD.provider_subject))
 OR(OLD.state='active' AND NEW.state<>'active') OR(NEW.state='active' AND NOT longball.spectator_activation_account(NEW.account_id,true)) THEN RAISE EXCEPTION 'Spectator reservation identity unavailable' USING ERRCODE='42501'; END IF;RETURN NEW;
END $fn$;
CREATE TRIGGER spectator_reservation_boundary BEFORE UPDATE ON longball.lb_spectator_activation_accounts FOR EACH ROW EXECUTE FUNCTION longball.guard_spectator_reservation();
CREATE FUNCTION longball.guard_spectator_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
BEGIN
 IF ROW(NEW.id,NEW.account_id,NEW.request_id,NEW.request_signature,NEW.device_id,NEW.created_at,NEW.generation)
 IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.request_id,OLD.request_signature,OLD.device_id,OLD.created_at,OLD.generation)
 OR NEW.expires_at>OLD.expires_at OR(OLD.flow_id IS NOT NULL AND NEW.flow_id IS DISTINCT FROM OLD.flow_id)
 OR(OLD.state IN('completed','cancelled') AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'Spectator activation attempt identity unavailable' USING ERRCODE='23514'; END IF;RETURN NEW;
END $fn$;
CREATE TRIGGER spectator_attempt_boundary BEFORE UPDATE ON longball.lb_spectator_activation_attempts FOR EACH ROW EXECUTE FUNCTION longball.guard_spectator_attempt();
CREATE FUNCTION longball.guard_spectator_invitation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
BEGIN
 IF ROW(NEW.id,NEW.club_id,NEW.team_id,NEW.season_id,NEW.inviter_account_id,NEW.credential_kind,NEW.credential_version,NEW.token_hash,NEW.legacy_fingerprint,NEW.retired_at,NEW.created_at,NEW.expires_at,NEW.reissued_from_invitation_id,NEW.policy_version)
 IS DISTINCT FROM ROW(OLD.id,OLD.club_id,OLD.team_id,OLD.season_id,OLD.inviter_account_id,OLD.credential_kind,OLD.credential_version,OLD.token_hash,OLD.legacy_fingerprint,OLD.retired_at,OLD.created_at,OLD.expires_at,OLD.reissued_from_invitation_id,OLD.policy_version)
 OR(NEW.requires_reissue IS DISTINCT FROM OLD.requires_reissue AND NOT(OLD.credential_kind='legacy_retired' AND OLD.requires_reissue AND NOT NEW.requires_reissue AND longball.context_json()->>'operation'='invite.reissue'))
 OR(OLD.accepted_by IS NOT NULL AND ROW(NEW.accepted_by,NEW.accepted_at) IS DISTINCT FROM ROW(OLD.accepted_by,OLD.accepted_at))
 OR(OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
 OR(ROW(NEW.accepted_by,NEW.accepted_at) IS DISTINCT FROM ROW(OLD.accepted_by,OLD.accepted_at) AND(longball.context_json()->>'operation' IS DISTINCT FROM 'invite.accept' OR NEW.accepted_by IS DISTINCT FROM longball.context_json()->>'accountId'))
 OR(longball.context_json()->>'kind'='actor' AND longball.context_json()->>'operation'='invite.accept' AND(NEW.accepted_by IS DISTINCT FROM longball.context_json()->>'accountId' OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at))
 THEN RAISE EXCEPTION 'Invitation identity is immutable' USING ERRCODE='23514'; END IF;RETURN NEW;
END $fn$;
CREATE TRIGGER spectator_invitation_boundary BEFORE UPDATE ON longball.spectator_invitations FOR EACH ROW EXECUTE FUNCTION longball.guard_spectator_invitation();
ALTER TABLE longball.spectator_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE longball.lb_spectator_activation_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE longball.lb_spectator_activation_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitations_read ON longball.spectator_invitations FOR SELECT USING(longball.actor_manager(club_id,team_id,season_id) OR(inviter_account_id=longball.context_json()->>'accountId' AND longball.actor_role(club_id,team_id,season_id)='player') OR longball.invite_capability(club_id,team_id,season_id) OR(longball.context_json()->>'kind'='invitation_activation' AND token_hash=longball.context_json()->>'tokenHash' AND longball.invitation_live(token_hash,accepted_by)));
CREATE POLICY invitations_insert ON longball.spectator_invitations FOR INSERT WITH CHECK(longball.context_json()->>'operation' IN('invite.issue','invite.reissue') AND longball.actor_role(club_id,team_id,season_id) IN('manager','player') AND inviter_account_id=longball.context_json()->>'accountId' AND credential_kind='sha256' AND accepted_by IS NULL AND revoked_at IS NULL);
CREATE POLICY invitations_update ON longball.spectator_invitations FOR UPDATE USING((longball.context_json()->>'operation' IN('invite.reissue','invite.revoke') AND(longball.actor_manager(club_id,team_id,season_id) OR(inviter_account_id=longball.context_json()->>'accountId' AND longball.actor_role(club_id,team_id,season_id)='player' AND accepted_by IS NULL))) OR longball.invite_capability(club_id,team_id,season_id)) WITH CHECK((longball.context_json()->>'operation' IN('invite.reissue','invite.revoke') AND(longball.actor_manager(club_id,team_id,season_id) OR(inviter_account_id=longball.context_json()->>'accountId' AND longball.actor_role(club_id,team_id,season_id)='player' AND accepted_by IS NULL))) OR(longball.invite_capability(club_id,team_id,season_id) AND accepted_by=longball.context_json()->>'accountId'));
-- Capability reservations may lock their row, but cannot alter invitation metadata anonymously.
CREATE POLICY invitations_capability_lock ON longball.spectator_invitations FOR UPDATE USING(longball.runtime_purpose()='api' AND longball.context_json()->>'kind'='invitation_activation' AND token_hash=longball.context_json()->>'tokenHash' AND longball.invitation_live(token_hash,accepted_by)) WITH CHECK(false);
CREATE POLICY spectator_reservation_read ON longball.lb_spectator_activation_accounts FOR SELECT USING(longball.spectator_activation_account(account_id));
CREATE POLICY spectator_reservation_insert ON longball.lb_spectator_activation_accounts FOR INSERT WITH CHECK(longball.runtime_purpose()='api' AND longball.context_json()->>'kind'='invitation_activation' AND account_id=longball.context_json()->>'provisionAccountId' AND invitation_token_hash=longball.context_json()->>'tokenHash' AND longball.invitation_live(invitation_token_hash) AND state='provisioning');
CREATE POLICY spectator_reservation_update ON longball.lb_spectator_activation_accounts FOR UPDATE USING(longball.spectator_activation_account(account_id)) WITH CHECK(longball.spectator_activation_account(account_id));
CREATE POLICY spectator_attempt_read ON longball.lb_spectator_activation_attempts FOR SELECT USING(longball.spectator_activation_account(account_id));
CREATE POLICY spectator_attempt_insert ON longball.lb_spectator_activation_attempts FOR INSERT WITH CHECK(longball.spectator_activation_account(account_id) AND state IN('provisioning','pending_activation'));
CREATE POLICY spectator_attempt_update ON longball.lb_spectator_activation_attempts FOR UPDATE USING(longball.spectator_activation_account(account_id)) WITH CHECK(longball.spectator_activation_account(account_id) AND(state<>'completed' OR longball.spectator_activation_account(account_id,true)));
CREATE POLICY spectator_accounts_read ON longball.accounts FOR SELECT USING(longball.spectator_activation_account(id) OR(longball.runtime_purpose()='api' AND longball.context_json()->>'kind'='invitation_activation' AND id=longball.context_json()->>'provisionAccountId' AND longball.invitation_live(longball.context_json()->>'tokenHash')));
CREATE POLICY spectator_accounts_insert ON longball.accounts FOR INSERT WITH CHECK(longball.runtime_purpose()='api' AND longball.context_json()->>'kind'='invitation_activation' AND id=longball.context_json()->>'provisionAccountId' AND longball.invitation_live(longball.context_json()->>'tokenHash') AND classification='unclassified' AND adult_verified=0 AND strong_auth_enrolled=0 AND status='disabled');
CREATE POLICY spectator_accounts_update ON longball.accounts FOR UPDATE USING(longball.spectator_activation_account(id)) WITH CHECK(longball.spectator_activation_account(id) AND(status='disabled' OR longball.spectator_activation_account(id,true)));
CREATE POLICY spectator_completion_audit ON longball.audit FOR INSERT WITH CHECK(longball.spectator_activation_account(actor_id,true) AND actor_id=object_id AND action='identity.spectator_activation_completed' AND outcome='provider_verified_sign_in_required' AND context_operation='spectator.activation.complete'
 AND EXISTS(SELECT 1 FROM longball.lb_spectator_activation_accounts a WHERE a.account_id=actor_id AND a.club_id=audit.club_id AND a.team_id=audit.team_id AND a.season_id=audit.season_id));
REVOKE ALL ON FUNCTION longball.invitation_live(text,text),longball.invitation_record_matches(text),longball.invitation_preflight(text),longball.invitation_accept_scope(text),longball.spectator_activation_account(text,boolean),longball.spectator_account_guard(),longball.guard_spectator_reservation(),longball.guard_spectator_attempt(),longball.guard_spectator_invitation() FROM PUBLIC;
