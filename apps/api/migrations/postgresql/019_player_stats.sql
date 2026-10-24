-- Administrator access is limited to names and numeric accepted stats. Existing
-- document/match/profile/attendance/feedback policies are deliberately unchanged.
CREATE FUNCTION longball.stats_positions_only(value jsonb) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,longball AS $$
 SELECT COALESCE(jsonb_object_agg(key,val),'{}'::jsonb)
 FROM jsonb_each(CASE WHEN jsonb_typeof(value)='object' THEN value ELSE '{}'::jsonb END) e(key,val)
 WHERE key~'^[A-Z]{2}$' AND jsonb_typeof(val)='number' $$;

CREATE FUNCTION longball.stats_scorer_totals(value jsonb) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,longball AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',player_id,'knownGoals',goals,'knownOwnGoals',own_goals) ORDER BY player_id),'[]'::jsonb)
 FROM (SELECT g->>'scorerPlayerId' player_id,
 count(*) FILTER(WHERE g->>'beneficiary'='us' AND COALESCE((g->>'isOwnGoal')::boolean,false)=false) goals,
 count(*) FILTER(WHERE g->>'beneficiary'='opposition' AND COALESCE((g->>'isOwnGoal')::boolean,false)=true) own_goals
 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(value)='array' THEN value ELSE '[]'::jsonb END) g
 WHERE g->>'scorerPlayerId' IS NOT NULL AND COALESCE((g->>'voided')::boolean,false)=false
 GROUP BY g->>'scorerPlayerId') totals $$;

CREATE FUNCTION longball.stats_scoring_coverage(value jsonb,score jsonb) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,longball AS $$
 SELECT CASE WHEN jsonb_typeof(score)='object'
 AND count(*) FILTER(WHERE g->>'beneficiary'='us')=COALESCE((score->>'for')::integer,-1)
 AND count(*) FILTER(WHERE g->>'beneficiary'='opposition')=COALESCE((score->>'against')::integer,-1)
 AND count(*) FILTER(WHERE ((g->>'beneficiary'='us' AND COALESCE((g->>'isOwnGoal')::boolean,false)=false)
 OR(g->>'beneficiary'='opposition' AND COALESCE((g->>'isOwnGoal')::boolean,false)=true)) AND g->>'scorerPlayerId' IS NULL)=0
 THEN 'complete' WHEN jsonb_typeof(score)='object' OR count(*)>0 THEN 'partial' ELSE 'unknown' END
 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(value)='array' THEN value ELSE '[]'::jsonb END) g
 WHERE COALESCE((g->>'voided')::boolean,false)=false $$;

CREATE FUNCTION longball.admin_player_stats_source(p_team text,p_season text) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE c text; r jsonb; prep jsonb; result jsonb; formation jsonb;
BEGIN
 IF longball.runtime_purpose() IS DISTINCT FROM 'api' OR longball.context_json()->>'operation' IS DISTINCT FROM 'stats.read'
 OR longball.context_json()->>'requestedRole' IS DISTINCT FROM 'administrator'
 OR p_team IS DISTINCT FROM longball.context_json()->>'teamId'
 OR p_season IS DISTINCT FROM longball.context_json()->>'seasonId' THEN RETURN NULL; END IF;
 SELECT club_id INTO c FROM longball.teams WHERE id=p_team AND scope_status='resolved';
 IF c IS NULL OR c IS DISTINCT FROM longball.context_json()->>'clubId' OR NOT COALESCE(longball.actor_admin(c,p_team,p_season),false) THEN RETURN NULL; END IF;
 SELECT value_json INTO r FROM longball.documents WHERE club_id=c AND team_id=p_team AND season_id=p_season AND kind='records';
 IF r IS NULL THEN RETURN NULL; END IF;
 SELECT value_json INTO prep FROM longball.documents WHERE club_id=c AND team_id=p_team AND season_id=p_season AND kind='preparation';
 SELECT jsonb_build_object('id',f->>'id','label',f->>'name','slots',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s->>'id','positionCode',s->>'position','label',s->>'label','x',s->'x','y',s->'y')) FROM jsonb_array_elements(f->'slots')s),'[]'::jsonb))
 INTO formation FROM jsonb_array_elements(COALESCE(prep->'formations','[]'::jsonb)) f
 WHERE f->'format'=prep->'team'->'defaultPitchPlaces' ORDER BY f->>'id' LIMIT 1;

 WITH historical AS (
  SELECT e->>'id' id,COALESCE((e->>'sourceMatchRevision')::bigint,-1) source_revision,COALESCE((e->>'revision')::bigint,0) revision,1 priority,
   e->>'status' status,e->>'recordMode' mode,e->>'detailCompleteness' completeness,e->'updatedAt' updated,
   e->'goals' goals,e->'finalScore' score,
   CASE WHEN jsonb_typeof(e->'participation')='array' THEN (SELECT jsonb_agg(jsonb_build_object('playerId',p->>'playerId','playedMs',p->'playedMs','positionMs',longball.stats_positions_only(p->'positionMs'))) FROM jsonb_array_elements(e->'participation')p) ELSE NULL END participation
  FROM jsonb_array_elements(COALESCE(r->'results','[]'::jsonb)) e
  WHERE e->>'teamId'=p_team AND e->>'seasonId'=p_season
 ), canonical AS (
  SELECT m.id,(m.state_json->>'revision')::bigint source_revision,0::bigint revision,0 priority,
   CASE WHEN m.state_json->>'status'='completed' THEN 'completed' WHEN m.state_json->>'status'='abandoned' THEN 'abandoned' ELSE 'incomplete' END status,
   'detailed_live' mode,CASE WHEN COALESCE((m.state_json->>'recoveryRequired')::boolean,false) OR m.state_json->>'schemaVersion' IS DISTINCT FROM '2' THEN 'review_required' ELSE 'complete' END completeness,
   CASE WHEN COALESCE(m.state_json->'eventHistory'->-1->'sample'->>'wallTimeMs',m.state_json->>'completedAtMs',m.state_json->'anchor'->'sample'->>'wallTimeMs') IS NULL THEN NULL
   ELSE to_jsonb(to_char(to_timestamp(COALESCE(m.state_json->'eventHistory'->-1->'sample'->>'wallTimeMs',m.state_json->>'completedAtMs',m.state_json->'anchor'->'sample'->>'wallTimeMs')::double precision/1000) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END updated,
   m.state_json->'goals' goals,m.state_json->'score' score,
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',pid,'playedMs',COALESCE(facts.played,0),'positionMs',COALESCE(facts.positions,'{}'::jsonb))),'[]'::jsonb)
    FROM jsonb_array_elements_text(COALESCE(m.state_json->'config'->'selectedPlayerIds','[]'::jsonb)) AS ids(pid)
    CROSS JOIN LATERAL (
     SELECT (SELECT COALESCE(sum((i->>'endMs')::bigint-(i->>'startMs')::bigint),0) FROM jsonb_array_elements(COALESCE(m.state_json->'intervals','[]'::jsonb))i WHERE i->>'playerId'=pid AND i->>'state'='playing') played,
     (SELECT jsonb_object_agg(position,duration) FROM (SELECT i->>'position' position,sum((i->>'endMs')::bigint-(i->>'startMs')::bigint) duration FROM jsonb_array_elements(COALESCE(m.state_json->'intervals','[]'::jsonb))i WHERE i->>'playerId'=pid AND i->>'state'='playing' AND i->>'position'~'^[A-Z]{2}$' GROUP BY i->>'position') per_position) positions
    )facts) participation
  FROM longball.matches m WHERE m.club_id=c AND m.team_id=p_team AND m.season_id=p_season AND m.state_json->>'status'<>'preparation'
  AND (m.state_json->'config'->'fixture' IS NULL OR m.state_json->'config'->'fixture'='null'::jsonb OR(m.state_json->'config'->'fixture'->>'teamId'=p_team AND m.state_json->'config'->'fixture'->>'seasonId'=p_season))
 ), candidates AS (SELECT * FROM historical UNION ALL SELECT * FROM canonical), selected AS (
  SELECT DISTINCT ON(id) * FROM candidates ORDER BY id,source_revision DESC,revision DESC,priority DESC
 )
 SELECT jsonb_build_object('clubId',c,'teamId',p_team,'seasonId',p_season,'seasonLabel',r->>'seasonLabel','revision',r->'revision',
  'players',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p->>'id','label',p->>'label')) FROM jsonb_array_elements(COALESCE(r->'players','[]'::jsonb))p),'[]'::jsonb),
  'matches',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'teamId',p_team,'seasonId',p_season,'status',status,'recordMode',mode,'detailCompleteness',completeness,'revision',revision,'sourceMatchRevision',CASE WHEN source_revision<0 THEN NULL ELSE source_revision END,'updatedAt',updated,'finalScore',NULL,'goals','[]'::jsonb,'participation',participation,'scorerTotals',longball.stats_scorer_totals(goals),'scoringCoverage',longball.stats_scoring_coverage(goals,score)) ORDER BY id) FROM selected),'[]'::jsonb),
  'positions',COALESCE((SELECT jsonb_agg(jsonb_build_object('code',p->>'code','label',p->>'label','active',p->'active')) FROM jsonb_array_elements(COALESCE(prep->'positionCatalogue','[]'::jsonb))p),'[]'::jsonb),
  'formation',formation) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION longball.stats_positions_only(jsonb),longball.stats_scorer_totals(jsonb),longball.stats_scoring_coverage(jsonb,jsonb),longball.admin_player_stats_source(text,text) FROM PUBLIC;
