-- Spectator-only local PIN credentials. Anonymous functions never grant Player or staff authority.
CREATE TABLE longball.spectator_pin_credentials(
 account_id text PRIMARY KEY REFERENCES longball.accounts(id),username text NOT NULL UNIQUE CHECK(username~'^[a-z0-9][a-z0-9._-]{2,39}$'),
 salt text NOT NULL CHECK(salt~'^[A-Za-z0-9_-]{22}$'),verifier text NOT NULL CHECK(verifier~'^[a-f0-9]{64}$'),created_request_id text NOT NULL UNIQUE,
 failed_count integer NOT NULL DEFAULT 0 CHECK(failed_count>=0),locked_until bigint NOT NULL DEFAULT 0 CHECK(locked_until>=0));
ALTER TABLE longball.spectator_pin_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY spectator_pin_no_direct_access ON longball.spectator_pin_credentials USING(false) WITH CHECK(false);
CREATE TABLE longball.invite_requests(
 id text PRIMARY KEY,club_id text NOT NULL,team_id text NOT NULL,season_id text NOT NULL,requested_role text NOT NULL CHECK(requested_role IN('player','spectator')),
 name text NOT NULL CHECK(char_length(name) BETWEEN 2 AND 80),email text NOT NULL CHECK(char_length(email) BETWEEN 3 AND 254),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','handled','declined')),created_at bigint NOT NULL,decided_by text REFERENCES longball.accounts(id),decided_at bigint,
 FOREIGN KEY(club_id,team_id,season_id) REFERENCES longball.team_seasons(club_id,team_id,season_id));
ALTER TABLE longball.invite_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY invite_requests_staff_read ON longball.invite_requests FOR SELECT USING(longball.actor_manager(club_id,team_id,season_id) OR longball.actor_admin(club_id,team_id,season_id));
CREATE POLICY invite_requests_staff_update ON longball.invite_requests FOR UPDATE USING(status='pending' AND(longball.actor_manager(club_id,team_id,season_id) OR longball.actor_admin(club_id,team_id,season_id))) WITH CHECK(status IN('handled','declined') AND decided_by=longball.context_json()->>'accountId' AND(longball.actor_manager(club_id,team_id,season_id) OR longball.actor_admin(club_id,team_id,season_id)));

CREATE FUNCTION longball.spectator_pin_preview(p_hash text,p_now bigint)
 RETURNS TABLE(invitation_id text,club_id text,team_id text,season_id text,expires_at bigint,club_name text,team_name text,age_group text,season_label text)
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT i.id,i.club_id,i.team_id,i.season_id,i.expires_at,d.value_json#>>'{club,name}',d.value_json#>>'{team,name}',d.value_json#>>'{team,ageGroup}',s->>'label'
 FROM longball.spectator_invitations i JOIN longball.documents d ON d.club_id=i.club_id AND d.team_id=i.team_id AND d.season_id=i.season_id AND d.kind='preparation'
 JOIN longball.documents c ON c.club_id=i.club_id AND c.team_id=i.team_id AND c.season_id=i.season_id AND c.kind='community'
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.value_json->'seasons','[]'::jsonb))s
 WHERE longball.runtime_purpose() IN('api','maintenance') AND p_hash~'^[a-f0-9]{64}$' AND p_now>=0
 AND i.token_hash=p_hash AND i.credential_kind='sha256' AND i.revoked_at IS NULL AND i.accepted_by IS NULL AND i.expires_at>p_now
 AND s->>'id'=i.season_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.value_json->'seasons')cs WHERE cs->>'id'=i.season_id AND(cs->>'accessEndsAtMs')::bigint>p_now)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.value_json->'invitations')ci WHERE ci->>'id'=i.id AND ci#>>'{credential,tokenHash}'=p_hash AND ci->>'acceptedBy' IS NULL AND ci->>'revokedAtMs' IS NULL)
 LIMIT 1 $$;

CREATE FUNCTION longball.spectator_pin_register(p_hash text,p_username text,p_salt text,p_verifier text,p_account text,p_request text,p_now bigint) RETURNS text
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE inv longball.spectator_invitations%ROWTYPE;doc longball.documents%ROWTYPE;state jsonb;next_invites jsonb;ending bigint;original text;ctx jsonb;
BEGIN
 IF longball.runtime_purpose() NOT IN('api','maintenance') OR longball.runtime_purpose() IS NULL OR p_account!~'^[a-f0-9-]{36}$' OR p_request!~'^[A-Za-z0-9_-]{1,150}$' OR p_username!~'^[a-z0-9][a-z0-9._-]{2,39}$' OR p_salt!~'^[A-Za-z0-9_-]{22}$' OR p_verifier!~'^[a-f0-9]{64}$' OR p_now<0 THEN RETURN NULL; END IF;
 SELECT * INTO inv FROM longball.spectator_invitations WHERE token_hash=p_hash FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM longball.spectator_pin_preview(p_hash,p_now)) THEN RETURN NULL; END IF;
 SELECT * INTO doc FROM longball.documents WHERE club_id=inv.club_id AND team_id=inv.team_id AND season_id=inv.season_id AND kind='community' FOR UPDATE;
 state=doc.value_json;
 SELECT(cs->>'accessEndsAtMs')::bigint INTO ending FROM jsonb_array_elements(state->'seasons')cs WHERE cs->>'id'=inv.season_id;
 IF ending IS NULL OR ending<=p_now THEN RETURN NULL; END IF;
 INSERT INTO longball.accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled,status) VALUES(p_account,'urn:longball:spectator-pin',p_account,'unclassified',0,0,'active');
 INSERT INTO longball.spectator_pin_credentials(account_id,username,salt,verifier,created_request_id) VALUES(p_account,p_username,p_salt,p_verifier,p_request);
 original=current_setting('longball.context',true);
 ctx=jsonb_build_object('kind','actor','accountId',p_account,'issuer','urn:longball:spectator-pin','subject',p_account,'strongAuth',false,'authenticatedAtMs',p_now,'requestedRole','spectator','clubId',inv.club_id,'teamId',inv.team_id,'seasonId',inv.season_id,'operation','invite.accept','invitationTokenHash',p_hash,'nowMs',p_now);
 PERFORM set_config('longball.context',ctx::text,true);
 UPDATE longball.spectator_invitations SET accepted_by=p_account,accepted_at=p_now WHERE id=inv.id AND accepted_by IS NULL;
 SELECT jsonb_agg(CASE WHEN ci->>'id'=inv.id THEN ci||jsonb_build_object('acceptedBy',p_account,'acceptedAtMs',p_now) ELSE ci END) INTO next_invites FROM jsonb_array_elements(state->'invitations')ci;
 state=jsonb_set(state,'{invitations}',next_invites);
 state=jsonb_set(state,'{grants}',COALESCE(state->'grants','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id','grant:'||inv.id,'invitationId',inv.id,'accountId',p_account,'teamId',inv.team_id,'seasonId',inv.season_id,'startsAtMs',p_now,'expiresAtMs',ending,'revokedAtMs',NULL)));
 state=jsonb_set(state,'{revision}',to_jsonb(doc.revision+1));
 state=jsonb_set(state,'{audit}',COALESCE(state->'audit','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id','pin-register-'||p_request,'actorAccountId',p_account,'action','invite.accepted_verified','atMs',p_now)));
 UPDATE longball.documents SET revision=doc.revision+1,value_json=state WHERE club_id=inv.club_id AND team_id=inv.team_id AND season_id=inv.season_id AND kind='community';
 INSERT INTO longball.memberships(account_id,club_id,team_id,season_id,role,expires_at,revoked_at) VALUES(p_account,inv.club_id,inv.team_id,inv.season_id,'spectator',ending,NULL);
 INSERT INTO longball.audit(id,actor_id,action,object_id,outcome,created_at,club_id,team_id,season_id,context_operation) VALUES('pin-register-'||p_account,p_account,'spectator.pin_registered',inv.id,'accepted',p_now,inv.club_id,inv.team_id,inv.season_id,'invite.accept');
 PERFORM set_config('longball.context',COALESCE(original,''),true);
 RETURN p_account;
END $$;

CREATE FUNCTION longball.spectator_pin_credential(p_username text) RETURNS TABLE(account_id text,salt text,verifier text,locked_until bigint)
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT p.account_id,p.salt,p.verifier,p.locked_until FROM longball.spectator_pin_credentials p JOIN longball.accounts a ON a.id=p.account_id
 WHERE longball.runtime_purpose() IN('api','maintenance') AND p.username=p_username AND a.status='active' AND a.classification='unclassified' AND a.issuer='urn:longball:spectator-pin' $$;
CREATE FUNCTION longball.spectator_pin_login_attempt(p_username text,p_success boolean,p_now bigint) RETURNS void
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 UPDATE longball.spectator_pin_credentials SET
 failed_count=CASE WHEN p_success THEN 0 WHEN locked_until>0 AND locked_until<=p_now THEN 1 ELSE failed_count+1 END,
 locked_until=CASE WHEN p_success THEN 0 WHEN locked_until>p_now THEN locked_until WHEN locked_until>0 AND locked_until<=p_now THEN 0 WHEN failed_count+1>=5 THEN p_now+900000 ELSE 0 END
 WHERE longball.runtime_purpose() IN('api','maintenance') AND username=p_username AND p_now>=0 $$;

CREATE FUNCTION longball.spectator_invite_directory() RETURNS TABLE(club_id text,club_name text,team_id text,team_name text,age_group text,season_id text,season_label text)
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT d.club_id,d.value_json#>>'{club,name}',d.team_id,d.value_json#>>'{team,name}',d.value_json#>>'{team,ageGroup}',d.season_id,s->>'label'
 FROM longball.documents d CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.value_json->'seasons','[]'::jsonb))s
 WHERE longball.runtime_purpose() IN('api','maintenance') AND d.kind='preparation' AND s->>'id'=d.season_id
 ORDER BY d.value_json#>>'{club,name}',d.value_json#>>'{team,ageGroup}',d.value_json#>>'{team,name}' LIMIT 5000 $$;
CREATE FUNCTION longball.spectator_invite_request(p_id text,p_club text,p_team text,p_season text,p_role text,p_name text,p_email text,p_now bigint) RETURNS text
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE prior longball.invite_requests%ROWTYPE;
BEGIN
 IF longball.runtime_purpose() NOT IN('api','maintenance') OR longball.runtime_purpose() IS NULL OR p_id!~'^[A-Za-z0-9_-]{1,150}$' OR p_role NOT IN('player','spectator') OR char_length(p_name) NOT BETWEEN 2 AND 80 OR char_length(p_email) NOT BETWEEN 3 AND 254 OR p_email~'[[:space:]]' OR p_now<0 OR NOT EXISTS(SELECT 1 FROM longball.spectator_invite_directory()d WHERE d.club_id=p_club AND d.team_id=p_team AND d.season_id=p_season) THEN RETURN NULL; END IF;
 SELECT * INTO prior FROM longball.invite_requests WHERE id=p_id FOR UPDATE;
 IF FOUND THEN
  IF ROW(prior.club_id,prior.team_id,prior.season_id,prior.requested_role,prior.name,prior.email) IS DISTINCT FROM ROW(p_club,p_team,p_season,p_role,p_name,p_email) THEN RAISE EXCEPTION 'Request identity conflict' USING ERRCODE='23505'; END IF;
  RETURN prior.id;
 END IF;
 INSERT INTO longball.invite_requests(id,club_id,team_id,season_id,requested_role,name,email,created_at) VALUES(p_id,p_club,p_team,p_season,p_role,p_name,p_email,p_now);
 RETURN p_id;
END $$;

-- Existing active spectators may issue scoped spectator links. No additional role or private data is granted.
CREATE POLICY spectator_inviter_read ON longball.spectator_invitations FOR SELECT USING(inviter_account_id=longball.context_json()->>'accountId' AND longball.actor_role(club_id,team_id,season_id)='spectator');
CREATE POLICY spectator_inviter_insert ON longball.spectator_invitations FOR INSERT WITH CHECK(longball.context_json()->>'operation' IN('invite.issue','invite.reissue') AND longball.actor_role(club_id,team_id,season_id)='spectator' AND inviter_account_id=longball.context_json()->>'accountId' AND credential_kind='sha256' AND accepted_by IS NULL AND revoked_at IS NULL);
CREATE POLICY spectator_inviter_reissue ON longball.spectator_invitations FOR UPDATE USING(longball.context_json()->>'operation'='invite.reissue' AND inviter_account_id=longball.context_json()->>'accountId' AND longball.actor_role(club_id,team_id,season_id)='spectator' AND accepted_by IS NULL) WITH CHECK(longball.context_json()->>'operation'='invite.reissue' AND inviter_account_id=longball.context_json()->>'accountId' AND longball.actor_role(club_id,team_id,season_id)='spectator' AND accepted_by IS NULL);
CREATE POLICY spectator_inviter_community_write ON longball.documents FOR UPDATE USING(kind='community' AND longball.context_json()->>'operation' IN('invite.issue','invite.reissue') AND longball.actor_role(club_id,team_id,season_id)='spectator') WITH CHECK(kind='community' AND longball.context_json()->>'operation' IN('invite.issue','invite.reissue') AND longball.actor_role(club_id,team_id,season_id)='spectator');

REVOKE ALL ON FUNCTION longball.spectator_pin_preview(text,bigint),longball.spectator_pin_register(text,text,text,text,text,text,bigint),longball.spectator_pin_credential(text),longball.spectator_pin_login_attempt(text,boolean,bigint),longball.spectator_invite_directory(),longball.spectator_invite_request(text,text,text,text,text,text,text,bigint) FROM PUBLIC;

-- A spectator may follow a named current player without receiving that player's private records.
CREATE FUNCTION longball.spectator_connection_catalog(p_team text,p_season text) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE c text;players jsonb;
BEGIN
 IF longball.runtime_purpose() NOT IN('api','maintenance') OR longball.runtime_purpose() IS NULL OR p_team IS DISTINCT FROM longball.context_json()->>'teamId' OR p_season IS DISTINCT FROM longball.context_json()->>'seasonId' THEN RETURN NULL; END IF;
 SELECT club_id INTO c FROM longball.teams WHERE id=p_team AND scope_status='resolved';
 IF c IS NULL OR longball.actor_role(c,p_team,p_season) IS DISTINCT FROM 'spectator' THEN RETURN NULL; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p->>'playerId','label',p->>'displayName')),'[]'::jsonb) INTO players
 FROM longball.documents d CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.value_json->'profiles','[]'::jsonb))p
 WHERE d.club_id=c AND d.team_id=p_team AND d.season_id=p_season AND d.kind='preparation' AND p->>'seasonId'=p_season AND p->>'active'='true';
 RETURN players;
END $$;
REVOKE ALL ON FUNCTION longball.spectator_connection_catalog(text,text) FROM PUBLIC;
-- saveDocument uses INSERT .. ON CONFLICT UPDATE, so the same narrow write intent is checked for INSERT too.
CREATE POLICY spectator_inviter_community_upsert ON longball.documents FOR INSERT WITH CHECK(kind='community' AND longball.context_json()->>'operation' IN('invite.issue','invite.reissue') AND longball.actor_role(club_id,team_id,season_id)='spectator');
