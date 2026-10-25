-- All current roles may read safe team/schedule metadata, including unprepared
-- fixtures. This creates no access to private preparation, rosters or scores.
CREATE FUNCTION longball.team_overview_source(p_team text,p_season text) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE c text; role text; prep jsonb; games jsonb; season_label text;
BEGIN
 IF longball.runtime_purpose() IS DISTINCT FROM 'api'
 OR longball.context_json()->>'operation' IS DISTINCT FROM 'team_overview.read'
 OR p_team IS DISTINCT FROM longball.context_json()->>'teamId'
 OR p_season IS DISTINCT FROM longball.context_json()->>'seasonId'
 OR COALESCE(longball.context_json()->>'requestedRole','') NOT IN('administrator','manager','player','spectator') THEN RETURN NULL; END IF;
 SELECT club_id INTO c FROM longball.teams WHERE id=p_team AND scope_status='resolved';
 IF c IS NULL OR c IS DISTINCT FROM longball.context_json()->>'clubId' THEN RETURN NULL; END IF;
 role=longball.actor_role(c,p_team,p_season);
 IF role IS NULL OR role IS DISTINCT FROM longball.context_json()->>'requestedRole' THEN RETURN NULL; END IF;
 -- actor_role rechecks current membership and, for spectators, the live grant.
 SELECT value_json INTO prep FROM longball.documents WHERE club_id=c AND team_id=p_team AND season_id=p_season AND kind='preparation';
 IF prep IS NULL THEN RETURN NULL; END IF;
 SELECT s->>'label' INTO season_label FROM jsonb_array_elements(COALESCE(prep->'seasons','[]'::jsonb))s WHERE s->>'id'=p_season;
 WITH deleted AS (
  SELECT t#>>'{fixture,id}' id FROM jsonb_array_elements(COALESCE(prep#>'{fixtureManagement,tombstones}','[]'::jsonb))t
 ), scheduled AS (
  SELECT f->>'id' id,f FROM jsonb_array_elements(COALESCE(prep->'fixtures','[]'::jsonb))f
  WHERE f->>'seasonId'=p_season AND NOT EXISTS(SELECT 1 FROM deleted d WHERE d.id=f->>'id')
 ), accepted AS (
  SELECT m.id,m.state_json->>'status' status,m.state_json#>'{config,fixture}' fixture
  FROM longball.matches m WHERE m.club_id=c AND m.team_id=p_team AND m.season_id=p_season
  AND m.state_json#>>'{config,fixture,teamId}'=p_team AND m.state_json#>>'{config,fixture,seasonId}'=p_season
  AND NOT EXISTS(SELECT 1 FROM deleted d WHERE d.id=m.id)
 ), projected AS (
  SELECT COALESCE(s.id,a.id) id,COALESCE(s.f->>'opponent',a.fixture->>'opponent') opponent,
   COALESCE(s.f->>'playedDate',a.fixture->>'playedDate','') played_date,
   CASE WHEN s.id IS NOT NULL THEN s.f->'kickoff' ELSE a.fixture->'kickoff' END kickoff,
   CASE WHEN s.id IS NOT NULL THEN to_jsonb(NULLIF(s.f->>'venue','')) ELSE NULL END venue,
   CASE WHEN s.f->>'status' IS NOT NULL AND s.f->>'status'<>'scheduled' THEN s.f->>'status' ELSE COALESCE(a.status,s.f->>'status','scheduled') END status
  FROM scheduled s FULL JOIN accepted a ON a.id=s.id
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'opponent',opponent,'playedDate',played_date,'kickoff',kickoff,'venue',venue,'status',status,
 'active',status IN('first_half_running','first_half_paused','half_time','second_half_running','second_half_paused')) ORDER BY played_date,id),'[]'::jsonb)
 INTO games FROM projected WHERE COALESCE(opponent,'')<>'';
 RETURN jsonb_build_object('kind','team-overview','teamId',p_team,'seasonId',p_season,
 'team',jsonb_build_object('name',prep#>>'{team,name}','ageGroup',prep#>>'{team,ageGroup}','clubName',prep#>>'{club,name}','seasonLabel',COALESCE(season_label,p_season)),
 'games',games);
END $$;
REVOKE ALL ON FUNCTION longball.team_overview_source(text,text) FROM PUBLIC;
