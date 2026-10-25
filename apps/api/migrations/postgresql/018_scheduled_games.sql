-- Staff schedule management returns fixture metadata, never private roster data.
-- A deleted schedule item retains its full private audit/tombstone and canonical match rows.
CREATE FUNCTION longball.schedule_has_recording(p_team text,p_season text,p_fixture text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT EXISTS(SELECT 1 FROM longball.matches m WHERE m.id=p_fixture AND m.team_id=p_team AND m.season_id=p_season AND(
  COALESCE((m.state_json->>'revision')::bigint,-1)<>0 OR m.state_json->>'status'<>'preparation'
  OR EXISTS(SELECT 1 FROM longball.controller_grants g WHERE g.match_id=m.id)
  OR EXISTS(SELECT 1 FROM longball.controller_history h WHERE h.match_id=m.id)
  OR EXISTS(SELECT 1 FROM longball.events e WHERE e.match_id=m.id)
  OR EXISTS(SELECT 1 FROM longball.conflicting_submissions c WHERE c.match_id=m.id)
  OR EXISTS(SELECT 1 FROM longball.transfers t WHERE t.match_id=m.id))) $$;

CREATE FUNCTION longball.scheduled_games(p_team text,p_season text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
DECLARE c text; r text; d jsonb; items jsonb;
BEGIN
 SELECT club_id INTO c FROM longball.teams WHERE id=p_team AND scope_status='resolved';
 r=longball.actor_role(c,p_team,p_season);
 IF c IS NULL OR NOT COALESCE(longball.actor_valid(),false) OR COALESCE(r,'') NOT IN('manager','administrator')
  OR longball.context_json()->>'requestedRole' IS DISTINCT FROM r
  OR longball.context_json()->>'teamId' IS DISTINCT FROM p_team OR longball.context_json()->>'seasonId' IS DISTINCT FROM p_season
  OR NOT longball.context_matches(c,p_team,p_season)
  OR COALESCE(longball.context_json()->>'operation','') NOT IN('scheduled_games.read','scheduled_games.write')
 THEN RAISE EXCEPTION 'Scheduled-game scope unavailable' USING ERRCODE='42501'; END IF;
 SELECT value_json INTO d FROM longball.documents WHERE team_id=p_team AND season_id=p_season AND kind='preparation';
 IF d IS NULL OR d->>'activeSeasonId' IS DISTINCT FROM p_season THEN RETURN jsonb_build_object('error','NOT_FOUND'); END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'id',f->>'id','seasonId',f->>'seasonId','opponent',f->>'opponent','playedDate',f->>'playedDate',
  'kickoff',f->'kickoff','arrival',f->'arrival','venue',f->>'venue','homeAway',f->>'homeAway',
  'format',f->'format','plannedHalfDurationMs',f->'plannedHalfDurationMs','status',f->>'status',
  'canCancel',NOT longball.schedule_has_recording(p_team,p_season,f->>'id') AND f->>'status'<>'cancelled',
  'canDelete',NOT longball.schedule_has_recording(p_team,p_season,f->>'id'),
  'blockedReason',CASE WHEN longball.schedule_has_recording(p_team,p_season,f->>'id') THEN 'recording_exists' ELSE NULL END)
  ORDER BY f->>'playedDate',COALESCE(f->>'kickoff',''),f->>'id'),'[]'::jsonb) INTO items
 FROM jsonb_array_elements(COALESCE(d->'fixtures','[]'::jsonb)) f
 WHERE f->>'seasonId'=p_season AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(d#>'{fixtureManagement,tombstones}','[]'::jsonb)) t WHERE t#>>'{fixture,id}'=f->>'id');
 RETURN jsonb_build_object('kind','scheduled-game-management','teamId',p_team,'seasonId',p_season,
  'revision',d->'revision','teamName',d#>>'{team,name}','fixtures',items);
END $fn$;

CREATE FUNCTION longball.manage_scheduled_game(p_team text,p_season text,p_command jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
DECLARE c text; r text; d jsonb; f jsonb; changed jsonb; action jsonb; sig text; prior jsonb;
 cmd_id text; fixture_id text; command_type text; reason text; rev bigint; at_ms bigint; at_text text;
 recipient record; job_id text; business text; job jsonb;
BEGIN
 -- This barrier also protects direct function calls and conflicts with the shared
 -- global barrier held by every team match/controller write transaction.
 PERFORM pg_advisory_xact_lock(hashtextextended('longball:domain-write:v1',0));
 PERFORM longball.scheduled_games(p_team,p_season);
 IF longball.context_json()->>'operation' IS DISTINCT FROM 'scheduled_games.write' THEN RAISE EXCEPTION 'Scheduled-game write unavailable' USING ERRCODE='42501'; END IF;
 SELECT club_id INTO c FROM longball.teams WHERE id=p_team AND scope_status='resolved';
 r=longball.actor_role(c,p_team,p_season);
 IF jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_command) k WHERE k NOT IN('id','expectedRevision','fixtureId','type','reason','confirm'))
  OR COALESCE(p_command->>'id','')!~'^[A-Za-z0-9_-]{8,150}$' OR COALESCE(p_command->>'fixtureId','')!~'^[A-Za-z0-9_.:-]{1,150}$'
  OR jsonb_typeof(p_command->'expectedRevision') IS DISTINCT FROM 'number' OR COALESCE(p_command->>'expectedRevision','')!~'^(0|[1-9][0-9]{0,14})$'
  OR COALESCE(p_command->>'type','') NOT IN('fixture.cancelled','fixture.deleted') OR p_command->'confirm' IS DISTINCT FROM 'true'::jsonb
  OR jsonb_typeof(p_command->'reason') IS DISTINCT FROM 'string' OR char_length(btrim(p_command->>'reason')) NOT BETWEEN 5 AND 500
 THEN RETURN jsonb_build_object('error','INVALID_REQUEST'); END IF;
 cmd_id=p_command->>'id'; fixture_id=p_command->>'fixtureId'; command_type=p_command->>'type'; reason=btrim(p_command->>'reason');
 sig=concat_ws(E'\n',cmd_id,p_command->>'expectedRevision',fixture_id,command_type,reason,'true');
 SELECT value_json INTO d FROM longball.documents WHERE team_id=p_team AND season_id=p_season AND kind='preparation' FOR UPDATE;
 IF d IS NULL OR d->>'activeSeasonId' IS DISTINCT FROM p_season THEN RETURN jsonb_build_object('error','NOT_FOUND'); END IF;
 SELECT a INTO prior FROM jsonb_array_elements(COALESCE(d#>'{fixtureManagement,actions}','[]'::jsonb)) a WHERE a->>'commandId'=cmd_id LIMIT 1;
 IF prior IS NOT NULL THEN
  IF prior->>'signature' IS DISTINCT FROM sig THEN RETURN jsonb_build_object('error','IDEMPOTENCY_CONFLICT'); END IF;
  RETURN longball.scheduled_games(p_team,p_season);
 END IF;
 IF d->'appliedCommands' ? cmd_id THEN RETURN jsonb_build_object('error','IDEMPOTENCY_CONFLICT'); END IF;
 IF (p_command->>'expectedRevision')::bigint IS DISTINCT FROM (d->>'revision')::bigint THEN RETURN jsonb_build_object('error','STALE_REVISION'); END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(d#>'{fixtureManagement,tombstones}','[]'::jsonb)) t WHERE t#>>'{fixture,id}'=fixture_id) THEN RETURN jsonb_build_object('error','FIXTURE_DELETED'); END IF;
 SELECT x INTO f FROM jsonb_array_elements(d->'fixtures') x WHERE x->>'id'=fixture_id AND x->>'seasonId'=p_season LIMIT 1;
 IF f IS NULL THEN RETURN jsonb_build_object('error','NOT_FOUND'); END IF;
 IF longball.schedule_has_recording(p_team,p_season,fixture_id) THEN RETURN jsonb_build_object('error','MATCH_HISTORY_EXISTS'); END IF;
 IF command_type='fixture.cancelled' AND f->>'status'='cancelled' THEN RETURN jsonb_build_object('error','ALREADY_CANCELLED'); END IF;
 rev=(d->>'revision')::bigint+1; at_ms=longball.context_now();
 at_text=to_char(to_timestamp(at_ms::numeric/1000) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 action=jsonb_build_object('commandId',cmd_id,'fixtureId',fixture_id,'type',command_type,'actorId',longball.context_json()->>'accountId','role',r,'reason',reason,'at',at_text,'signature',sig);
 d=jsonb_set(d,'{fixtureManagement}',COALESCE(d->'fixtureManagement',jsonb_build_object('actions','[]'::jsonb,'tombstones','[]'::jsonb)));
 d=jsonb_set(d,'{fixtureManagement,actions}',COALESCE(d#>'{fixtureManagement,actions}','[]'::jsonb)||jsonb_build_array(action));
 IF command_type='fixture.deleted' THEN
  d=jsonb_set(d,'{fixtureManagement,tombstones}',COALESCE(d#>'{fixtureManagement,tombstones}','[]'::jsonb)||jsonb_build_array(jsonb_build_object('fixture',f,'action',action)));
  SELECT COALESCE(jsonb_agg(x),'[]'::jsonb) INTO changed FROM jsonb_array_elements(d->'fixtures') x WHERE x->>'id'<>fixture_id;
 ELSE
  changed=jsonb_set(f,'{status}','"cancelled"'::jsonb);
  changed=jsonb_set(changed,'{history}',COALESCE(f->'history','[]'::jsonb)||jsonb_build_array(jsonb_build_object('revision',rev,'action','cancelled','playedDate',f->>'playedDate','kickoff',f->'kickoff','status','cancelled')));
  SELECT jsonb_agg(CASE WHEN x->>'id'=fixture_id THEN changed ELSE x END) INTO changed FROM jsonb_array_elements(d->'fixtures') x;
 END IF;
 d=jsonb_set(d,'{fixtures}',changed);
 d=jsonb_set(d,'{revision}',to_jsonb(rev));
 d=jsonb_set(d,'{appliedCommands}',COALESCE(d->'appliedCommands','{}'::jsonb)||jsonb_build_object(cmd_id,sig));
 d=jsonb_set(d,'{audit}',COALESCE(d->'audit','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id',cmd_id,'revision',rev,'type',command_type)));
 UPDATE longball.documents SET value_json=d,revision=rev WHERE team_id=p_team AND season_id=p_season AND kind='preparation';
 INSERT INTO longball.audit(id,actor_id,action,object_id,outcome,created_at) VALUES(gen_random_uuid()::text,longball.context_json()->>'accountId',command_type,fixture_id,'schedule_changed_history_retained',at_ms);
 -- Generic jobs retain only opaque scope; dispatch still rechecks current grants,
 -- entity availability and user notification preferences before delivery.
 FOR recipient IN SELECT DISTINCT ON(m.account_id) m.account_id,m.role,m.player_id FROM longball.memberships m
  WHERE m.club_id=c AND m.team_id=p_team AND m.season_id=p_season AND m.role IN('manager','player','spectator') AND m.revoked_at IS NULL AND(m.expires_at IS NULL OR m.expires_at>at_ms)
  ORDER BY m.account_id,CASE m.role WHEN 'manager' THEN 3 WHEN 'player' THEN 2 ELSE 1 END DESC
 LOOP
  IF recipient.role='player' AND recipient.player_id IS NULL THEN CONTINUE; END IF;
  job_id=gen_random_uuid()::text;
  business='notify:'||encode(sha256(convert_to(jsonb_build_array(p_team,p_season,'schedule',fixture_id,cmd_id,recipient.account_id,recipient.role)::text,'UTF8')),'hex');
  job=jsonb_build_object('id',job_id,'businessKey',business,'accountId',recipient.account_id,'teamId',p_team,'seasonId',p_season,'audience',recipient.role,'playerId',CASE WHEN recipient.role='player' THEN recipient.player_id ELSE NULL END,
   'category','schedule','entityId',fixture_id,'dueAtMs',at_ms,'schemaVersion',1,'revision',0,'state','pending','attempts',0,'deliveryAttempts',0,'lease',NULL,'lastCode',NULL,'providerReceiptId',NULL,'acceptedAtMs',NULL);
  INSERT INTO longball.jobs(id,business_key,kind,payload_json,due_at) VALUES(job_id,business,'notification.dispatch',job,at_ms) ON CONFLICT(business_key) DO NOTHING;
 END LOOP;
 RETURN longball.scheduled_games(p_team,p_season);
END $fn$;
REVOKE ALL ON FUNCTION longball.schedule_has_recording(text,text,text),longball.scheduled_games(text,text),longball.manage_scheduled_game(text,text,jsonb) FROM PUBLIC;
