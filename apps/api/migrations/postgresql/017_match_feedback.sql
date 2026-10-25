-- Private post-game feedback is deliberately separate from generic team documents and statistics.
CREATE TABLE match_feedback (
 club_id text NOT NULL,team_id text NOT NULL,season_id text NOT NULL,match_id text NOT NULL REFERENCES matches(id),account_id text NOT NULL REFERENCES accounts(id),player_id text NOT NULL,
 rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5),note text CHECK(note IS NULL OR length(note)<=256),revision integer NOT NULL CHECK(revision>=1),
 completed_at bigint NOT NULL,closes_at bigint NOT NULL,created_at bigint NOT NULL,updated_at bigint NOT NULL,
 PRIMARY KEY(match_id,account_id),UNIQUE(match_id,player_id),FOREIGN KEY(club_id,team_id,season_id) REFERENCES team_seasons(club_id,team_id,season_id),
 CHECK(completed_at>=0 AND closes_at>completed_at AND created_at>=completed_at AND updated_at>=created_at AND updated_at<closes_at)
);
CREATE INDEX match_feedback_scope ON match_feedback(team_id,season_id,match_id);
CREATE TABLE match_feedback_receipts (
 club_id text NOT NULL,account_id text NOT NULL REFERENCES accounts(id),command_id text NOT NULL CHECK(command_id ~ '^[A-Za-z0-9_-]{8,150}$'),team_id text NOT NULL,season_id text NOT NULL,match_id text NOT NULL,player_id text NOT NULL,
 signature text NOT NULL CHECK(signature ~ '^[a-f0-9]{64}$'),receipt_json jsonb NOT NULL,created_at bigint NOT NULL,
 PRIMARY KEY(account_id,command_id),FOREIGN KEY(match_id,account_id) REFERENCES match_feedback(match_id,account_id),FOREIGN KEY(club_id,team_id,season_id) REFERENCES team_seasons(club_id,team_id,season_id)
);
ALTER TABLE match_feedback ENABLE ROW LEVEL SECURITY;ALTER TABLE match_feedback FORCE ROW LEVEL SECURITY;
ALTER TABLE match_feedback_receipts ENABLE ROW LEVEL SECURITY;ALTER TABLE match_feedback_receipts FORCE ROW LEVEL SECURITY;

CREATE FUNCTION feedback_player(c text,t text,s text,a text,p text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
 SELECT COALESCE(longball.runtime_purpose()='api' AND longball.actor_valid() AND longball.context_json()->>'accountId'=a
 AND longball.context_json()->>'teamId'=t AND longball.context_json()->>'seasonId'=s AND longball.context_matches(c,t,s)
 AND longball.context_json()->>'operation' IN('feedback.read','feedback.write') AND longball.actor_role(c,t,s)='player'
 AND (SELECT count(DISTINCT m.player_id) FROM longball.memberships m WHERE m.account_id=a AND m.club_id=c AND m.team_id=t AND m.season_id=s AND m.role='player' AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>floor(extract(epoch FROM clock_timestamp())*1000)::bigint))=1
 AND EXISTS(SELECT 1 FROM longball.memberships m WHERE m.account_id=a AND m.club_id=c AND m.team_id=t AND m.season_id=s AND m.role='player' AND m.player_id=p AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>floor(extract(epoch FROM clock_timestamp())*1000)::bigint)),false);
$fn$;
CREATE FUNCTION feedback_reader(c text,t text,s text,a text,p text) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,longball AS $fn$
 SELECT longball.feedback_player(c,t,s,a,p) OR (longball.runtime_purpose()='api' AND longball.context_json()->>'operation'='feedback.read' AND longball.context_json()->>'teamId'=t AND longball.context_json()->>'seasonId'=s AND longball.actor_manager(c,t,s));
$fn$;
CREATE POLICY match_feedback_read ON match_feedback FOR SELECT USING(feedback_reader(club_id,team_id,season_id,account_id,player_id));
CREATE POLICY match_feedback_insert ON match_feedback FOR INSERT WITH CHECK(context_json()->>'operation'='feedback.write' AND feedback_player(club_id,team_id,season_id,account_id,player_id));
CREATE POLICY match_feedback_update ON match_feedback FOR UPDATE USING(context_json()->>'operation'='feedback.write' AND feedback_player(club_id,team_id,season_id,account_id,player_id)) WITH CHECK(context_json()->>'operation'='feedback.write' AND feedback_player(club_id,team_id,season_id,account_id,player_id));
CREATE POLICY match_feedback_receipt_read ON match_feedback_receipts FOR SELECT USING(feedback_player(club_id,team_id,season_id,account_id,player_id));
CREATE POLICY match_feedback_receipt_insert ON match_feedback_receipts FOR INSERT WITH CHECK(context_json()->>'operation'='feedback.write' AND feedback_player(club_id,team_id,season_id,account_id,player_id));

-- The trusted source is accepted server match history plus its original verified finish context.
-- Runtime SQL cannot submit an invented completion, change the original day, or create eligibility.
CREATE FUNCTION guard_match_feedback() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
DECLARE match_row longball.matches%ROWTYPE; community jsonb; game jsonb; selected text[]; present text[]; played text[]; moment bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; finished bigint; closes bigint; BEGIN
 SELECT * INTO match_row FROM longball.matches WHERE id=NEW.match_id FOR SHARE;
 IF NOT FOUND OR match_row.team_id<>NEW.team_id OR match_row.season_id<>NEW.season_id OR (NEW.club_id IS NOT NULL AND NEW.club_id<>match_row.club_id) THEN RAISE EXCEPTION 'Feedback scope unavailable' USING ERRCODE='42501'; END IF;
 NEW.club_id=match_row.club_id;
 IF NOT longball.feedback_player(NEW.club_id,NEW.team_id,NEW.season_id,NEW.account_id,NEW.player_id) OR longball.context_json()->>'operation'<>'feedback.write' THEN RAISE EXCEPTION 'Feedback actor unavailable' USING ERRCODE='42501'; END IF;
 SELECT value_json INTO community FROM longball.documents WHERE team_id=NEW.team_id AND season_id=NEW.season_id AND kind='community' FOR SHARE;
 SELECT value INTO game FROM jsonb_array_elements(COALESCE(community->'matches','[]'::jsonb)) WHERE value->>'id'=NEW.match_id AND value->>'teamId'=NEW.team_id AND value->>'seasonId'=NEW.season_id;
 IF game IS NULL OR game->>'finishQuality'<>'trusted' OR match_row.state_json->>'status'<>'completed' OR COALESCE((match_row.state_json->>'recoveryRequired')::boolean,false) OR jsonb_typeof(game->'actualFullTimeAtMs') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Feedback finish requires review' USING ERRCODE='23514'; END IF;
 finished=(game->>'actualFullTimeAtMs')::bigint;
 closes=floor(extract(epoch FROM ((((to_timestamp(finished::double precision/1000) AT TIME ZONE 'Europe/London')::date+1)::timestamp) AT TIME ZONE 'Europe/London'))*1000)::bigint;
 SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::text[]) INTO selected FROM jsonb_array_elements_text(match_row.state_json->'config'->'selectedPlayerIds') id;
 SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::text[]) INTO present FROM unnest(selected) id WHERE match_row.state_json->'attendance'->>id='present';
 SELECT COALESCE(array_agg(DISTINCT i->>'playerId' ORDER BY i->>'playerId'),ARRAY[]::text[]) INTO played FROM jsonb_array_elements(match_row.state_json->'intervals') i WHERE i->>'state'='playing' AND (i->>'endMs')::bigint>(i->>'startMs')::bigint AND i->>'playerId'=ANY(selected);
 IF selected IS DISTINCT FROM (SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::text[]) FROM jsonb_array_elements_text(game->'selectedPlayerIds') id)
 OR present IS DISTINCT FROM (SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::text[]) FROM jsonb_array_elements_text(game->'presentPlayerIds') id)
 OR played IS DISTINCT FROM (SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::text[]) FROM jsonb_array_elements_text(game->'playedPlayerIds') id)
 OR NOT played<@present OR NOT NEW.player_id=ANY(played) OR NEW.completed_at<>finished OR NEW.closes_at<>closes OR moment<finished OR moment>=closes THEN RAISE EXCEPTION 'Feedback window or participation unavailable' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'Feedback initial revision unavailable' USING ERRCODE='23514'; END IF;
  NEW.created_at=moment;
 ELSE
  IF ROW(NEW.club_id,NEW.team_id,NEW.season_id,NEW.match_id,NEW.account_id,NEW.player_id,NEW.completed_at,NEW.closes_at,NEW.created_at) IS DISTINCT FROM ROW(OLD.club_id,OLD.team_id,OLD.season_id,OLD.match_id,OLD.account_id,OLD.player_id,OLD.completed_at,OLD.closes_at,OLD.created_at) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Feedback immutable scope or revision changed' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.updated_at=moment; RETURN NEW;
END $fn$;
CREATE TRIGGER match_feedback_guard BEFORE INSERT OR UPDATE ON match_feedback FOR EACH ROW EXECUTE FUNCTION guard_match_feedback();
CREATE FUNCTION guard_match_feedback_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
DECLARE parent longball.match_feedback%ROWTYPE; BEGIN
 SELECT * INTO parent FROM longball.match_feedback WHERE match_id=NEW.match_id AND account_id=NEW.account_id;
 IF NOT FOUND OR parent.team_id<>NEW.team_id OR parent.season_id<>NEW.season_id OR parent.player_id<>NEW.player_id OR (NEW.club_id IS NOT NULL AND NEW.club_id<>parent.club_id) OR NOT longball.feedback_player(parent.club_id,parent.team_id,parent.season_id,parent.account_id,parent.player_id) OR longball.context_json()->>'operation'<>'feedback.write'
 OR NEW.receipt_json->>'kind'<>'match-feedback-receipt' OR NEW.receipt_json->>'commandId'<>NEW.command_id OR NEW.receipt_json->>'teamId'<>NEW.team_id OR NEW.receipt_json->>'seasonId'<>NEW.season_id OR NEW.receipt_json->>'matchId'<>NEW.match_id OR (NEW.receipt_json->>'revision')::integer<>parent.revision THEN RAISE EXCEPTION 'Feedback receipt unavailable' USING ERRCODE='42501'; END IF;
 NEW.club_id=parent.club_id;NEW.created_at=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;RETURN NEW;
END $fn$;
CREATE TRIGGER match_feedback_receipt_guard BEFORE INSERT ON match_feedback_receipts FOR EACH ROW EXECUTE FUNCTION guard_match_feedback_receipt();
REVOKE ALL ON FUNCTION feedback_player(text,text,text,text,text),feedback_reader(text,text,text,text,text),guard_match_feedback(),guard_match_feedback_receipt() FROM PUBLIC;
