-- Team review notes are visible to team players and staff, never spectators.
CREATE TABLE longball.opposition_reviews (
 club_id text NOT NULL,team_id text NOT NULL,season_id text NOT NULL,match_id text NOT NULL,
 rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5),note text CHECK(note IS NULL OR length(note)<=256),revision integer NOT NULL CHECK(revision>=1),
 updated_by text NOT NULL REFERENCES longball.accounts(id),updated_at bigint NOT NULL,
 PRIMARY KEY(team_id,season_id,match_id),FOREIGN KEY(club_id,team_id,season_id) REFERENCES longball.team_seasons(club_id,team_id,season_id)
);
CREATE TABLE longball.opposition_review_receipts (
 club_id text NOT NULL,account_id text NOT NULL REFERENCES longball.accounts(id),command_id text NOT NULL CHECK(command_id~'^[A-Za-z0-9_-]{8,150}$'),team_id text NOT NULL,season_id text NOT NULL,
 signature text NOT NULL CHECK(signature~'^[a-f0-9]{64}$'),receipt_json jsonb NOT NULL,PRIMARY KEY(account_id,command_id),
 FOREIGN KEY(club_id,team_id,season_id) REFERENCES longball.team_seasons(club_id,team_id,season_id)
);
ALTER TABLE longball.opposition_reviews ENABLE ROW LEVEL SECURITY;ALTER TABLE longball.opposition_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE longball.opposition_review_receipts ENABLE ROW LEVEL SECURITY;ALTER TABLE longball.opposition_review_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY opposition_reviews_read ON longball.opposition_reviews FOR SELECT USING(
 longball.runtime_purpose()='api' AND longball.context_json()->>'operation' IN('opposition.read','opposition.write')
 AND longball.context_matches(club_id,team_id,season_id) AND longball.actor_role(club_id,team_id,season_id) IN('manager','administrator','player'));
CREATE POLICY opposition_reviews_insert ON longball.opposition_reviews FOR INSERT WITH CHECK(
 longball.runtime_purpose()='api' AND longball.context_json()->>'operation'='opposition.write'
 AND longball.context_matches(club_id,team_id,season_id) AND (longball.actor_manager(club_id,team_id,season_id) OR longball.actor_admin(club_id,team_id,season_id)) AND updated_by=longball.context_json()->>'accountId');
CREATE POLICY opposition_reviews_update ON longball.opposition_reviews FOR UPDATE USING(
 longball.runtime_purpose()='api' AND longball.context_json()->>'operation'='opposition.write'
 AND longball.context_matches(club_id,team_id,season_id) AND (longball.actor_manager(club_id,team_id,season_id) OR longball.actor_admin(club_id,team_id,season_id))) WITH CHECK(
 longball.runtime_purpose()='api' AND longball.context_json()->>'operation'='opposition.write'
 AND longball.context_matches(club_id,team_id,season_id) AND (longball.actor_manager(club_id,team_id,season_id) OR longball.actor_admin(club_id,team_id,season_id)) AND updated_by=longball.context_json()->>'accountId');
CREATE POLICY opposition_review_receipts_read ON longball.opposition_review_receipts FOR SELECT USING(
 longball.runtime_purpose()='api' AND longball.context_json()->>'operation'='opposition.write' AND longball.context_matches(club_id,team_id,season_id)
 AND account_id=longball.context_json()->>'accountId' AND (longball.actor_manager(club_id,team_id,season_id) OR longball.actor_admin(club_id,team_id,season_id)));
CREATE POLICY opposition_review_receipts_insert ON longball.opposition_review_receipts FOR INSERT WITH CHECK(
 longball.runtime_purpose()='api' AND longball.context_json()->>'operation'='opposition.write' AND longball.context_matches(club_id,team_id,season_id)
 AND account_id=longball.context_json()->>'accountId' AND (longball.actor_manager(club_id,team_id,season_id) OR longball.actor_admin(club_id,team_id,season_id)));

CREATE FUNCTION longball.opposition_completed_games(p_team text,p_season text) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE c text;records jsonb;result jsonb;
BEGIN
 SELECT club_id INTO c FROM longball.teams WHERE id=p_team AND scope_status='resolved';
 IF c IS NULL OR longball.runtime_purpose() IS DISTINCT FROM 'api' OR NOT longball.context_matches(c,p_team,p_season)
 OR longball.context_json()->>'operation' NOT IN('opposition.read','opposition.write')
 OR COALESCE(longball.actor_role(c,p_team,p_season),'') NOT IN('administrator','manager','player') THEN RETURN NULL; END IF;
 SELECT value_json INTO records FROM longball.documents WHERE team_id=p_team AND season_id=p_season AND kind='records';
 WITH historical AS (
  SELECT e->>'id' id,e->>'opponent' opponent,e->>'playedDate' played_date,e->>'status' status,0 priority FROM jsonb_array_elements(COALESCE(records->'results','[]'::jsonb))e WHERE e->>'teamId'=p_team AND e->>'seasonId'=p_season
 ), canonical AS (
  SELECT m.id,m.state_json#>>'{config,fixture,opponent}' opponent,m.state_json#>>'{config,fixture,playedDate}' played_date,m.state_json->>'status' status,1 priority
  FROM longball.matches m WHERE m.club_id=c AND m.team_id=p_team AND m.season_id=p_season AND m.state_json->>'status'<>'preparation'
  AND m.state_json#>>'{config,fixture,teamId}'=p_team AND m.state_json#>>'{config,fixture,seasonId}'=p_season
 ), chosen AS (SELECT DISTINCT ON(id) * FROM(SELECT * FROM historical UNION ALL SELECT * FROM canonical)all_games ORDER BY id,priority DESC)
 SELECT COALESCE(jsonb_agg(jsonb_build_object('matchId',id,'opponent',opponent,'playedDate',played_date) ORDER BY played_date DESC,id),'[]'::jsonb) INTO result FROM chosen WHERE status='completed';
 RETURN result;
END $$;
CREATE FUNCTION longball.guard_opposition_review() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE c text;
BEGIN
 SELECT club_id INTO c FROM longball.teams WHERE id=NEW.team_id AND scope_status='resolved';
 IF c IS NULL OR (NEW.club_id IS NOT NULL AND NEW.club_id<>c) OR NOT longball.context_matches(c,NEW.team_id,NEW.season_id)
 OR longball.context_json()->>'operation' IS DISTINCT FROM 'opposition.write' OR NEW.updated_by IS DISTINCT FROM longball.context_json()->>'accountId'
 OR NOT (longball.actor_manager(c,NEW.team_id,NEW.season_id) OR longball.actor_admin(c,NEW.team_id,NEW.season_id))
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(longball.opposition_completed_games(NEW.team_id,NEW.season_id))g WHERE g->>'matchId'=NEW.match_id) THEN RAISE EXCEPTION 'Opposition review scope unavailable' USING ERRCODE='42501'; END IF;
 NEW.club_id=c;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'Opposition review initial revision unavailable' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.club_id,NEW.team_id,NEW.season_id,NEW.match_id) IS DISTINCT FROM ROW(OLD.club_id,OLD.team_id,OLD.season_id,OLD.match_id) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Opposition review revision changed' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.updated_at=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; RETURN NEW;
END $$;
CREATE TRIGGER opposition_review_guard BEFORE INSERT OR UPDATE ON longball.opposition_reviews FOR EACH ROW EXECUTE FUNCTION longball.guard_opposition_review();
CREATE FUNCTION longball.guard_opposition_review_receipt() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE c text;parent longball.opposition_reviews%ROWTYPE;
BEGIN
 SELECT * INTO parent FROM longball.opposition_reviews WHERE team_id=NEW.team_id AND season_id=NEW.season_id AND match_id=NEW.receipt_json->>'matchId';
 c=parent.club_id;
 IF c IS NULL OR NEW.account_id IS DISTINCT FROM longball.context_json()->>'accountId' OR NEW.account_id<>parent.updated_by OR (NEW.club_id IS NOT NULL AND NEW.club_id<>c)
 OR NEW.receipt_json->>'kind' IS DISTINCT FROM 'opposition-review-receipt' OR NEW.receipt_json->>'commandId' IS DISTINCT FROM NEW.command_id OR NEW.receipt_json->>'teamId' IS DISTINCT FROM NEW.team_id OR NEW.receipt_json->>'seasonId' IS DISTINCT FROM NEW.season_id OR (NEW.receipt_json->>'revision')::integer IS DISTINCT FROM parent.revision
 THEN RAISE EXCEPTION 'Opposition review receipt unavailable' USING ERRCODE='42501'; END IF;
 NEW.club_id=c;RETURN NEW;
END $$;
CREATE TRIGGER opposition_review_receipt_guard BEFORE INSERT ON longball.opposition_review_receipts FOR EACH ROW EXECUTE FUNCTION longball.guard_opposition_review_receipt();
REVOKE ALL ON FUNCTION longball.opposition_completed_games(text,text),longball.guard_opposition_review(),longball.guard_opposition_review_receipt() FROM PUBLIC;

-- Narrow keeper-only aggregate preserves the administrator source's privacy boundary.
CREATE FUNCTION longball.stats_keeper_outcomes(s jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,longball AS $$
 WITH intervals AS (SELECT i FROM jsonb_array_elements(COALESCE(s->'intervals','[]'::jsonb))i WHERE i->>'state'='playing' AND i->>'position'='GK' AND (i->>'endMs')::bigint>(i->>'startMs')::bigint),
 keepers AS (SELECT DISTINCT i->>'playerId' player FROM intervals),
 goals AS (SELECT g,COALESCE((g#>>'{effective,matchElapsedMs}')::bigint,-1) at FROM jsonb_array_elements(COALESCE(s->'goals','[]'::jsonb))g WHERE g->>'beneficiary'='opposition' AND NOT COALESCE((g->>'voided')::boolean,false)),
 candidates AS (SELECT goals.at,array(SELECT DISTINCT i->>'playerId' FROM intervals WHERE (i->>'startMs')::bigint<=goals.at AND (i->>'endMs')::bigint>=goals.at) players FROM goals),
 evaluated AS (SELECT player,CASE
  WHEN s->>'status'<>'completed' OR s->>'schemaVersion' IS DISTINCT FROM '2' OR COALESCE((s->>'recoveryRequired')::boolean,false) OR COALESCE((s->>'matchActiveMs')::bigint,0)<=0
  OR (SELECT count(*) FROM goals) IS DISTINCT FROM (s#>>'{score,against}')::bigint
  OR EXISTS(SELECT 1 FROM goals WHERE at<0 OR at>(s->>'matchActiveMs')::bigint)
  OR EXISTS(SELECT 1 FROM intervals WHERE (i->>'startMs')::bigint<0 OR (i->>'endMs')::bigint>(s->>'matchActiveMs')::bigint) THEN 'unknown'
  WHEN EXISTS(SELECT 1 FROM candidates WHERE array_length(players,1)=1 AND player=ANY(players)) THEN 'conceded'
  WHEN EXISTS(SELECT 1 FROM candidates WHERE COALESCE(array_length(players,1),0)=0 OR array_length(players,1)>1 AND player=ANY(players)) THEN 'unknown'
  ELSE 'clean_sheet' END outcome FROM keepers)
 SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',player,'outcome',outcome) ORDER BY player),'[]'::jsonb) FROM evaluated $$;
ALTER FUNCTION longball.admin_player_stats_source(text,text) RENAME TO admin_player_stats_source_v19;
CREATE FUNCTION longball.admin_player_stats_source(p_team text,p_season text) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE result jsonb;rows jsonb;
BEGIN
 result=longball.admin_player_stats_source_v19(p_team,p_season);
 IF result IS NULL THEN RETURN NULL; END IF;
 SELECT COALESCE(jsonb_agg(CASE WHEN m.id IS NULL THEN e ELSE e||jsonb_build_object('goalkeeperOutcomes',longball.stats_keeper_outcomes(m.state_json)) END),'[]'::jsonb) INTO rows
 FROM jsonb_array_elements(COALESCE(result->'matches','[]'::jsonb))e LEFT JOIN longball.matches m ON m.id=e->>'id' AND m.team_id=p_team AND m.season_id=p_season AND (m.state_json->>'revision')::bigint=(e->>'sourceMatchRevision')::bigint;
 RETURN jsonb_set(result,'{matches}',rows);
END $$;
REVOKE ALL ON FUNCTION longball.stats_keeper_outcomes(jsonb),longball.admin_player_stats_source_v19(text,text),longball.admin_player_stats_source(text,text) FROM PUBLIC;
