-- Seasonless club/team branding has its own ancestry. Never invent a game or season.
CREATE TABLE longball.brand_assets(
 id text PRIMARY KEY,asset_id text NOT NULL,revision integer NOT NULL CHECK(revision>0),
 kind text NOT NULL CHECK(kind IN('club_logo','team_logo')),club_id text NOT NULL REFERENCES longball.clubs(id),team_id text,
 scope_key text GENERATED ALWAYS AS(COALESCE(team_id,'')) STORED,season_id text CHECK(season_id IS NULL),match_id text CHECK(match_id IS NULL),
 owner_id text NOT NULL REFERENCES longball.accounts(id),request_id text NOT NULL,request_signature text NOT NULL,
 status text NOT NULL CHECK(status IN('prepared','uploading','uploaded','processing','processed','linked','rejected')),
 expected_bytes integer NOT NULL CHECK(expected_bytes>0 AND expected_bytes<=15728640),expected_sha text NOT NULL CHECK(expected_sha~'^[a-f0-9]{64}$'),
 declared_mime text NOT NULL CHECK(declared_mime IN('image/jpeg','image/png','jpeg','png')),token_hash text NOT NULL CHECK(token_hash~'^[a-f0-9]{64}$'),
 expires_at bigint NOT NULL,created_at bigint NOT NULL,processed_at bigint,original_key text,display_key text,thumbnail_key text,
 width integer CHECK(width>0),height integer CHECK(height>0),scanner_engine text,failure_code text,attempt text,lease_until bigint,
 CHECK((kind='club_logo' AND team_id IS NULL) OR(kind='team_logo' AND team_id IS NOT NULL AND team_id<>'')),
 CHECK(expires_at>created_at),UNIQUE(owner_id,request_id),UNIQUE(asset_id,revision),
 UNIQUE(asset_id,revision,kind,club_id,scope_key),FOREIGN KEY(team_id,club_id) REFERENCES longball.teams(id,club_id));
CREATE TABLE longball.brand_slots(
 kind text NOT NULL CHECK(kind IN('club_logo','team_logo')),club_id text NOT NULL REFERENCES longball.clubs(id),team_id text,
 scope_key text GENERATED ALWAYS AS(COALESCE(team_id,'')) STORED,version integer NOT NULL DEFAULT 0 CHECK(version>=0),
 asset_id text,asset_revision integer,reviewed_revision integer,policy_version text,confirmed_by text REFERENCES longball.accounts(id),confirmed_at bigint,
 PRIMARY KEY(kind,club_id,scope_key),FOREIGN KEY(team_id,club_id) REFERENCES longball.teams(id,club_id),
 FOREIGN KEY(asset_id,asset_revision,kind,club_id,scope_key) REFERENCES longball.brand_assets(asset_id,revision,kind,club_id,scope_key),
 CHECK((kind='club_logo' AND team_id IS NULL) OR(kind='team_logo' AND team_id IS NOT NULL AND team_id<>'')),
 CHECK((asset_id IS NULL AND asset_revision IS NULL AND reviewed_revision IS NULL AND policy_version IS NULL) OR
       (asset_id IS NOT NULL AND asset_revision>0 AND reviewed_revision=asset_revision AND policy_version='logo-rights-v1' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)));

CREATE FUNCTION longball.branding_member(c text,t text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT longball.runtime_purpose() IN('api','maintenance') AND c IS NOT NULL AND longball.context_json()->>'clubId'=c
 AND longball.context_json()->>'teamId' IS NOT NULL AND longball.context_json()->>'seasonId' IS NOT NULL
 AND(t IS NULL OR t=longball.context_json()->>'teamId')
 AND longball.actor_role(c,longball.context_json()->>'teamId',longball.context_json()->>'seasonId') IS NOT NULL
 AND EXISTS(SELECT 1 FROM longball.teams x WHERE x.id=longball.context_json()->>'teamId' AND x.club_id=c AND x.scope_status='resolved') $$;
CREATE FUNCTION longball.branding_authority(k text,c text,t text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT longball.branding_member(c,t) AND ((k='club_logo' AND t IS NULL AND longball.actor_role(c,longball.context_json()->>'teamId',longball.context_json()->>'seasonId')='administrator')
 OR(k='team_logo' AND t=longball.context_json()->>'teamId' AND longball.actor_role(c,t,longball.context_json()->>'seasonId')='manager')) $$;
-- Only these names cross the administrator configuration boundary; no raw preparation DTO.
CREATE FUNCTION longball.branding_context(p_team text,p_season text)
 RETURNS TABLE(club_id text,team_id text,club_name text,team_name text,age_group text)
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT t.club_id,t.id,COALESCE(NULLIF(d.value_json#>>'{club,name}',''),c.name),COALESCE(NULLIF(d.value_json#>>'{team,name}',''),t.name),NULLIF(d.value_json#>>'{team,ageGroup}','')
 FROM longball.teams t JOIN longball.clubs c ON c.id=t.club_id
 LEFT JOIN longball.documents d ON d.team_id=t.id AND d.season_id=p_season AND d.kind='preparation'
 WHERE t.id=p_team AND p_team=longball.context_json()->>'teamId' AND p_season=longball.context_json()->>'seasonId'
 AND longball.context_json()->>'operation' LIKE 'branding.%' AND longball.branding_member(t.club_id,t.id) $$;
CREATE FUNCTION longball.guard_brand_asset() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.asset_id,NEW.revision,NEW.kind,NEW.club_id,NEW.team_id,NEW.owner_id,NEW.request_id,NEW.request_signature,NEW.expected_bytes,NEW.expected_sha,NEW.declared_mime,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.asset_id,OLD.revision,OLD.kind,OLD.club_id,OLD.team_id,OLD.owner_id,OLD.request_id,OLD.request_signature,OLD.expected_bytes,OLD.expected_sha,OLD.declared_mime,OLD.expires_at,OLD.created_at) THEN RAISE EXCEPTION 'Immutable branding identity' USING ERRCODE='23514'; END IF;
 -- Retried preparation may rotate its opaque transport capability; linked bytes/evidence stay fixed.
 IF TG_OP='UPDATE' AND OLD.status='linked' AND(to_jsonb(NEW)-'token_hash'-'scope_key') IS DISTINCT FROM(to_jsonb(OLD)-'token_hash'-'scope_key') THEN RAISE EXCEPTION 'Published branding revision is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM longball.brand_slots s WHERE s.asset_id=OLD.asset_id AND s.asset_revision=OLD.revision)
 AND NOT(NEW.status IN(OLD.status,'linked') AND(to_jsonb(NEW)-'status'-'token_hash'-'scope_key') IS NOT DISTINCT FROM(to_jsonb(OLD)-'status'-'token_hash'-'scope_key')) THEN RAISE EXCEPTION 'Current branding bytes are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER brand_asset_guard BEFORE UPDATE ON longball.brand_assets FOR EACH ROW EXECUTE FUNCTION longball.guard_brand_asset();
CREATE FUNCTION longball.guard_brand_slot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
DECLARE a record; BEGIN
 IF TG_OP='UPDATE' AND(ROW(NEW.kind,NEW.club_id,NEW.team_id) IS DISTINCT FROM ROW(OLD.kind,OLD.club_id,OLD.team_id) OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'Invalid branding pointer revision' USING ERRCODE='23514'; END IF;
 IF NEW.asset_id IS NOT NULL THEN
  SELECT * INTO a FROM longball.brand_assets WHERE asset_id=NEW.asset_id AND revision=NEW.asset_revision AND kind=NEW.kind AND club_id=NEW.club_id AND team_id IS NOT DISTINCT FROM NEW.team_id;
  IF NOT FOUND OR a.owner_id IS DISTINCT FROM longball.context_json()->>'accountId' OR a.status NOT IN('processed','linked') OR a.processed_at IS NULL OR NULLIF(a.scanner_engine,'') IS NULL OR a.width IS NULL OR a.height IS NULL OR a.display_key IS NULL OR a.thumbnail_key IS NULL
   OR NEW.reviewed_revision<>a.revision OR NEW.policy_version<>'logo-rights-v1' OR NEW.confirmed_by IS DISTINCT FROM longball.context_json()->>'accountId' THEN RAISE EXCEPTION 'Branding revision was not reviewed and processed' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER brand_slot_guard BEFORE INSERT OR UPDATE ON longball.brand_slots FOR EACH ROW EXECUTE FUNCTION longball.guard_brand_slot();
ALTER TABLE longball.brand_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE longball.brand_slots ENABLE ROW LEVEL SECURITY;
CREATE POLICY brand_assets_read ON longball.brand_assets FOR SELECT USING (
 (owner_id=longball.context_json()->>'accountId' AND longball.branding_authority(kind,club_id,team_id)) OR
 (longball.branding_member(club_id,team_id) AND EXISTS(SELECT 1 FROM longball.brand_slots s WHERE s.kind=brand_assets.kind AND s.club_id=brand_assets.club_id AND s.scope_key=brand_assets.scope_key AND s.asset_id=brand_assets.asset_id AND s.asset_revision=brand_assets.revision)));
CREATE POLICY brand_assets_insert ON longball.brand_assets FOR INSERT WITH CHECK(longball.branding_authority(kind,club_id,team_id) AND owner_id=longball.context_json()->>'accountId' AND status='prepared' AND processed_at IS NULL AND scanner_engine IS NULL AND display_key IS NULL AND thumbnail_key IS NULL);
CREATE POLICY brand_assets_update ON longball.brand_assets FOR UPDATE USING(longball.branding_authority(kind,club_id,team_id) AND owner_id=longball.context_json()->>'accountId') WITH CHECK(longball.branding_authority(kind,club_id,team_id) AND owner_id=longball.context_json()->>'accountId');
CREATE POLICY brand_slots_read ON longball.brand_slots FOR SELECT USING(longball.branding_member(club_id,team_id));
CREATE POLICY brand_slots_insert ON longball.brand_slots FOR INSERT WITH CHECK(longball.branding_authority(kind,club_id,team_id));
CREATE POLICY brand_slots_update ON longball.brand_slots FOR UPDATE USING(longball.branding_authority(kind,club_id,team_id)) WITH CHECK(longball.branding_authority(kind,club_id,team_id));
REVOKE ALL ON FUNCTION longball.branding_member(text,text),longball.branding_authority(text,text,text),longball.branding_context(text,text),longball.guard_brand_asset(),longball.guard_brand_slot() FROM PUBLIC;
