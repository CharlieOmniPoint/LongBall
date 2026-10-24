-- Administration grants are explicit; existing team-only administrators are not promoted.
CREATE TABLE longball.administrative_memberships(account_id text NOT NULL,team_id text NOT NULL,season_id text NOT NULL,role text NOT NULL,PRIMARY KEY(account_id,team_id,season_id,role),FOREIGN KEY(account_id,team_id,season_id,role) REFERENCES longball.memberships(account_id,team_id,season_id,role) ON DELETE CASCADE);
ALTER TABLE longball.administrative_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY inherited_membership_own ON longball.administrative_memberships FOR SELECT USING(longball.actor_valid() AND(account_id=longball.context_json()->>'accountId' OR EXISTS(SELECT 1 FROM longball.team_seasons ts WHERE ts.team_id=administrative_memberships.team_id AND ts.season_id=administrative_memberships.season_id AND longball.actor_admin(ts.club_id,ts.team_id,ts.season_id))));
CREATE TABLE longball.administration_grants(account_id text NOT NULL REFERENCES longball.accounts(id),scope_key text NOT NULL,level text NOT NULL CHECK(level IN('super','club')),club_id text REFERENCES longball.clubs(id),PRIMARY KEY(account_id,scope_key),CHECK((level='super' AND club_id IS NULL AND scope_key='*') OR (level='club' AND club_id=scope_key)));
ALTER TABLE longball.administration_grants ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION longball.administration_scope(p_account text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE result jsonb;
BEGIN
 IF longball.runtime_purpose() NOT IN('api','maintenance') OR NOT EXISTS(SELECT 1 FROM longball.accounts a WHERE a.id=p_account AND a.status='active' AND a.issuer=longball.context_json()->>'issuer' AND a.subject=longball.context_json()->>'subject' AND a.classification='adult_individual' AND a.adult_verified=1 AND (longball.context_json()->>'kind'='identity' OR longball.context_json()->>'accountId'=a.id)) THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('level',CASE WHEN bool_or(level='super') THEN 'super' ELSE 'club' END,'clubIds',COALESCE(jsonb_agg(club_id) FILTER(WHERE club_id IS NOT NULL),'[]'::jsonb)) INTO result FROM longball.administration_grants WHERE account_id=p_account HAVING count(*)>0;
 RETURN result;
END $$;
CREATE POLICY administration_own ON longball.administration_grants FOR SELECT USING(account_id=longball.context_json()->>'accountId' AND longball.actor_valid());
CREATE FUNCTION longball.administration_allowed(p_club text DEFAULT NULL,p_super boolean DEFAULT false) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT longball.actor_valid() AND longball.context_json()->>'operation' IN('administration.read','administration.write','club_reports.read') AND longball.context_json()->>'strongAuth'='true' AND EXISTS(SELECT 1 FROM longball.accounts a JOIN longball.administration_grants g ON g.account_id=a.id WHERE a.id=longball.context_json()->>'accountId' AND a.classification='adult_individual' AND a.adult_verified=1 AND a.strong_auth_enrolled=1 AND (g.level='super' OR (NOT p_super AND (p_club IS NULL OR g.club_id=p_club))))
$$;
CREATE FUNCTION longball.sync_administrative_memberships() RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
BEGIN
 DELETE FROM longball.memberships m WHERE EXISTS(SELECT 1 FROM longball.administrative_memberships a WHERE a.account_id=m.account_id AND a.team_id=m.team_id AND a.season_id=m.season_id AND a.role=m.role);
 WITH inserted AS(INSERT INTO longball.memberships(account_id,club_id,team_id,season_id,role)
 SELECT DISTINCT g.account_id,ts.club_id,ts.team_id,ts.season_id,r.role FROM longball.administration_grants g JOIN longball.team_seasons ts ON g.level='super' OR g.club_id=ts.club_id CROSS JOIN (VALUES('administrator'),('manager'))r(role)
 ON CONFLICT(account_id,team_id,season_id,role) DO NOTHING RETURNING account_id,team_id,season_id,role) INSERT INTO longball.administrative_memberships SELECT * FROM inserted;
 UPDATE longball.controller_grants cg SET frozen=1 FROM longball.matches m WHERE m.id=cg.match_id AND NOT EXISTS(SELECT 1 FROM longball.memberships mm WHERE mm.account_id=cg.account_id AND mm.team_id=m.team_id AND mm.season_id=m.season_id AND mm.role='manager' AND mm.revoked_at IS NULL AND(mm.expires_at IS NULL OR mm.expires_at>longball.context_now()));
END $$;
CREATE FUNCTION longball.administration_directory() RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE clubs_data jsonb;teams_data jsonb;grants_data jsonb;candidate_data jsonb;scope jsonb;
BEGIN
 IF NOT longball.administration_allowed() THEN RETURN NULL; END IF;
 scope=longball.administration_scope(longball.context_json()->>'accountId');
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) ORDER BY c.name,c.id),'[]'::jsonb) INTO clubs_data FROM longball.clubs c WHERE longball.administration_allowed(c.id);
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',t.id,'clubId',t.club_id,'name',COALESCE(d.value_json#>>'{team,name}',t.name),'ageGroup',COALESCE(d.value_json#>>'{team,ageGroup}',''),'seasonId',ts.season_id,'seasonLabel',COALESCE(ts.label,ts.season_id),'leagueName',COALESCE(d.value_json#>>'{team,league}','')) ORDER BY t.name,ts.season_id),'[]'::jsonb) INTO teams_data FROM longball.teams t JOIN longball.team_seasons ts ON ts.team_id=t.id LEFT JOIN longball.documents d ON d.team_id=t.id AND d.season_id=ts.season_id AND d.kind='preparation' WHERE longball.administration_allowed(t.club_id);
 SELECT COALESCE(jsonb_agg(jsonb_build_object('accountId',g.account_id,'level',g.level,'clubId',g.club_id) ORDER BY g.account_id,g.scope_key),'[]'::jsonb) INTO grants_data FROM longball.administration_grants g WHERE longball.administration_allowed(NULL,true) OR(g.club_id IS NOT NULL AND longball.administration_allowed(g.club_id));
 SELECT COALESCE(jsonb_agg(jsonb_build_object('accountId',a.id,'label',a.subject) ORDER BY a.subject),'[]'::jsonb) INTO candidate_data FROM longball.accounts a WHERE longball.administration_allowed(NULL,true) AND a.status='active' AND a.classification='adult_individual' AND a.adult_verified=1 AND a.strong_auth_enrolled=1;
 RETURN jsonb_build_object('kind','club-administration','administration',scope,'clubs',clubs_data,'teams',teams_data,'administrators',grants_data,'candidates',candidate_data);
END $$;
CREATE FUNCTION longball.administration_command(p_command jsonb,p_id text,p_documents jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE c text;team_id text; season text; kind text; target text; command_type text;
BEGIN
 command_type=p_command->>'type';c=p_command->>'clubId';
 IF longball.context_json()->>'operation' IS DISTINCT FROM 'administration.write' OR NOT longball.administration_allowed(CASE WHEN command_type='team.create' THEN c ELSE NULL END,command_type<>'team.create') THEN RAISE EXCEPTION 'Administration scope unavailable' USING ERRCODE='42501'; END IF;
 IF p_id !~ '^[a-f0-9-]{36}$' THEN RAISE EXCEPTION 'Invalid administration identity' USING ERRCODE='23514'; END IF;
 IF command_type='club.create' THEN
  IF char_length(trim(p_command->>'name')) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid club name' USING ERRCODE='23514'; END IF;
  INSERT INTO longball.clubs(id,name)VALUES(p_id,p_command->>'name');
 ELSIF command_type='team.create' THEN
  IF NOT EXISTS(SELECT 1 FROM longball.clubs WHERE id=c) OR p_command->>'ageGroup' !~ '^U([5-9]|1[0-9]|2[01])$' OR (p_command->>'format')::integer NOT BETWEEN 5 AND 11 OR char_length(trim(p_command->>'name')) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid team' USING ERRCODE='23514'; END IF;
  season=p_documents->>'seasonId';
  IF p_documents#>>'{preparation,club,id}' IS DISTINCT FROM c OR p_documents#>>'{preparation,team,id}' IS DISTINCT FROM p_id OR jsonb_array_length(p_documents#>'{preparation,profiles}')<>0 OR jsonb_array_length(p_documents#>'{preparation,fixtures}')<>0 OR jsonb_array_length(p_documents#>'{records,results}')<>0 OR jsonb_array_length(p_documents#>'{community,grants}')<>0 THEN RAISE EXCEPTION 'New team must have empty scoped documents' USING ERRCODE='23514'; END IF;
  INSERT INTO longball.teams(id,name,club_id,scope_status)VALUES(p_id,p_command->>'name',c,'resolved');
  INSERT INTO longball.team_seasons(club_id,team_id,season_id,label,start_year,start_date,end_date)VALUES(c,p_id,season,p_documents->>'label',(p_command->>'seasonStartYear')::integer,(p_documents#>>'{preparation,seasons,0,startDate}')::date,(p_documents#>>'{preparation,seasons,0,endDate}')::date);
  FOREACH kind IN ARRAY ARRAY['preparation','records','community'] LOOP
   INSERT INTO longball.documents(club_id,team_id,season_id,kind,revision,value_json)VALUES(c,p_id,season,kind,0,p_documents->kind);
  END LOOP;
 ELSIF command_type IN('administrator.grant','administrator.revoke') THEN
  target=p_command->>'accountId';
  IF NOT EXISTS(SELECT 1 FROM longball.accounts WHERE id=target AND status='active' AND classification='adult_individual' AND adult_verified=1 AND strong_auth_enrolled=1) OR (p_command->>'level'='club' AND NOT EXISTS(SELECT 1 FROM longball.clubs WHERE id=c)) OR p_command->>'level' NOT IN('super','club') OR(p_command->>'level'='super' AND c IS NOT NULL) THEN RAISE EXCEPTION 'Verified adult administration target required' USING ERRCODE='42501'; END IF;
  IF command_type='administrator.grant' THEN
   INSERT INTO longball.administration_grants(account_id,scope_key,level,club_id)VALUES(target,COALESCE(c,'*'),p_command->>'level',c) ON CONFLICT DO NOTHING;
  ELSE
   IF p_command->>'level'='super' AND (SELECT count(*) FROM longball.administration_grants WHERE level='super')<=1 THEN RAISE EXCEPTION 'Keep at least one Super Admin' USING ERRCODE='23514'; END IF;
   DELETE FROM longball.administration_grants WHERE account_id=target AND scope_key=COALESCE(c,'*');
  END IF;
 ELSE RAISE EXCEPTION 'Unsupported administration command' USING ERRCODE='23514'; END IF;
 PERFORM longball.sync_administrative_memberships();
 INSERT INTO longball.audit(id,actor_id,action,object_id,outcome,created_at)VALUES(p_id,longball.context_json()->>'accountId',command_type,COALESCE(c,p_id),'accepted',longball.context_now());
END $$;
CREATE FUNCTION longball.club_report(p_club text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE teams_data jsonb;club_data jsonb;
BEGIN
 IF longball.context_json()->>'operation' IS DISTINCT FROM 'club_reports.read' OR NOT longball.administration_allowed(p_club) THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('id',id,'name',name) INTO club_data FROM longball.clubs WHERE id=p_club;
 IF club_data IS NULL THEN RETURN NULL; END IF;
 WITH scoped AS(SELECT t.id,t.name,ts.season_id,ts.label,p.value_json prep,(SELECT jsonb_build_object('results',COALESCE(jsonb_agg(result),'[]'::jsonb)) FROM (
 SELECT rr result FROM jsonb_array_elements(COALESCE(r.value_json->'results','[]'::jsonb))rr WHERE NOT EXISTS(SELECT 1 FROM longball.matches m WHERE m.team_id=t.id AND m.season_id=ts.season_id AND m.id=rr->>'id' AND m.state_json->>'status' IN('completed','abandoned') AND(m.state_json->>'revision')::bigint>=COALESCE((rr->>'sourceMatchRevision')::bigint,0))
 UNION ALL SELECT jsonb_build_object('status','completed','finalScore',m.state_json->'score') FROM longball.matches m WHERE m.team_id=t.id AND m.season_id=ts.season_id AND m.state_json->>'status'='completed' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(r.value_json->'results','[]'::jsonb))rr WHERE rr->>'id'=m.id AND COALESCE((rr->>'sourceMatchRevision')::bigint,0)>(m.state_json->>'revision')::bigint)
 ) result_rows) records FROM longball.teams t JOIN longball.team_seasons ts ON ts.team_id=t.id LEFT JOIN longball.documents p ON p.team_id=t.id AND p.season_id=ts.season_id AND p.kind='preparation' LEFT JOIN longball.documents r ON r.team_id=t.id AND r.season_id=ts.season_id AND r.kind='records' WHERE t.club_id=p_club), projected AS(SELECT id,jsonb_build_object('id',id,'clubId',p_club,'name',COALESCE(prep#>>'{team,name}',name),'ageGroup',COALESCE(prep#>>'{team,ageGroup}',''),'seasonId',season_id,'seasonLabel',COALESCE(label,season_id),'leagueName',COALESCE(prep#>>'{team,league}',''),'players',(SELECT count(*) FROM jsonb_array_elements(COALESCE(prep->'profiles','[]'::jsonb)) p WHERE p->>'active'='true' AND p->>'seasonId'=scoped.season_id),'completedGames',(SELECT count(*) FROM jsonb_array_elements(COALESCE(records->'results','[]'::jsonb)) r WHERE r->>'status'='completed'),'scoredGames',(SELECT count(*) FROM jsonb_array_elements(COALESCE(records->'results','[]'::jsonb)) r WHERE r->>'status'='completed' AND r->>'finalScore' IS NOT NULL),'wins',(SELECT count(*) FROM jsonb_array_elements(COALESCE(records->'results','[]'::jsonb)) r WHERE r->>'status'='completed' AND(r#>>'{finalScore,for}')::integer>(r#>>'{finalScore,against}')::integer),'draws',(SELECT count(*) FROM jsonb_array_elements(COALESCE(records->'results','[]'::jsonb)) r WHERE r->>'status'='completed' AND(r#>>'{finalScore,for}')::integer=(r#>>'{finalScore,against}')::integer),'losses',(SELECT count(*) FROM jsonb_array_elements(COALESCE(records->'results','[]'::jsonb)) r WHERE r->>'status'='completed' AND(r#>>'{finalScore,for}')::integer<(r#>>'{finalScore,against}')::integer),'goalsFor',(SELECT COALESCE(sum((r#>>'{finalScore,for}')::integer),0) FROM jsonb_array_elements(COALESCE(records->'results','[]'::jsonb)) r WHERE r->>'status'='completed'),'goalsAgainst',(SELECT COALESCE(sum((r#>>'{finalScore,against}')::integer),0) FROM jsonb_array_elements(COALESCE(records->'results','[]'::jsonb)) r WHERE r->>'status'='completed')) value FROM scoped)
 SELECT COALESCE(jsonb_agg(value ORDER BY id),'[]'::jsonb) INTO teams_data FROM projected;
 RETURN jsonb_build_object('kind','club-report','club',club_data,'teams',teams_data);
END $$;
REVOKE ALL ON FUNCTION longball.administration_scope(text),longball.administration_allowed(text,boolean),longball.sync_administrative_memberships(),longball.administration_directory(),longball.administration_command(jsonb,text,jsonb),longball.club_report(text) FROM PUBLIC;

CREATE FUNCTION longball.inherit_administration_for_season(p_team text,p_season text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE c text;
BEGIN
 SELECT club_id INTO c FROM longball.team_seasons WHERE team_id=p_team AND season_id=p_season;
 IF longball.runtime_purpose() NOT IN('api','maintenance') OR longball.context_json()->>'operation' IS DISTINCT FROM 'season.create' OR p_team IS DISTINCT FROM longball.context_json()->>'teamId' OR p_season IS DISTINCT FROM longball.context_json()->>'newSeasonId' OR NOT longball.actor_admin(c,p_team,longball.context_json()->>'seasonId') THEN RAISE EXCEPTION 'Season administration unavailable' USING ERRCODE='42501'; END IF;
 PERFORM longball.sync_administrative_memberships();
END $$;
REVOKE ALL ON FUNCTION longball.inherit_administration_for_season(text,text) FROM PUBLIC;

-- Rename current club display metadata atomically across preparation documents;
-- match snapshots, recorded results, identity and ancestry are untouched.
CREATE FUNCTION longball.sync_club_configuration(p_team text,p_season text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE c text;n text;
BEGIN
 IF longball.runtime_purpose() NOT IN('api','maintenance') OR NOT longball.actor_valid() OR longball.context_json()->>'operation' NOT IN('configuration.write','preparation.write') OR p_team IS DISTINCT FROM longball.context_json()->>'teamId' OR p_season IS DISTINCT FROM longball.context_json()->>'seasonId' OR longball.context_json()->>'strongAuth' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Club configuration unavailable' USING ERRCODE='42501'; END IF;
 SELECT t.club_id INTO c FROM longball.teams t WHERE t.id=p_team;
 IF NOT EXISTS(SELECT 1 FROM longball.memberships m JOIN longball.accounts a ON a.id=m.account_id WHERE m.account_id=longball.context_json()->>'accountId' AND m.club_id=c AND m.team_id=p_team AND m.season_id=p_season AND m.role='administrator' AND m.revoked_at IS NULL AND(m.expires_at IS NULL OR m.expires_at>longball.context_now()) AND a.classification='adult_individual' AND a.adult_verified=1 AND a.status='active') THEN RAISE EXCEPTION 'Club configuration unavailable' USING ERRCODE='42501'; END IF;
 SELECT value_json#>>'{club,name}' INTO n FROM longball.documents WHERE team_id=p_team AND season_id=p_season AND kind='preparation';
 IF char_length(n) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid club name' USING ERRCODE='23514'; END IF;
 UPDATE longball.clubs SET name=n WHERE id=c;
 UPDATE longball.documents SET revision=revision+1,value_json=jsonb_set(jsonb_set(value_json,'{club,name}',to_jsonb(n)),'{revision}',to_jsonb(revision+1)) WHERE club_id=c AND kind='preparation' AND value_json#>>'{club,name}' IS DISTINCT FROM n;
END $$;
REVOKE ALL ON FUNCTION longball.sync_club_configuration(text,text) FROM PUBLIC;

-- Explicit Admin presentation may read preparation only when the same actor has
-- current Manager authority. This adds no access to records or private feedback.
CREATE FUNCTION longball.inherited_admin_manager(c text,t text,s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT longball.actor_admin(c,t,s) AND EXISTS(SELECT 1 FROM longball.memberships m WHERE m.account_id=longball.context_json()->>'accountId' AND m.club_id=c AND m.team_id=t AND m.season_id=s AND m.role='manager' AND m.revoked_at IS NULL AND(m.expires_at IS NULL OR m.expires_at>longball.context_now()))
$$;
CREATE POLICY inherited_admin_preparation_read ON longball.documents FOR SELECT USING(kind='preparation' AND longball.context_json()->>'operation'='preparation.read' AND longball.inherited_admin_manager(club_id,team_id,season_id));
REVOKE ALL ON FUNCTION longball.inherited_admin_manager(text,text,text) FROM PUBLIC;
