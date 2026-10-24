-- Private FA team sheets are team-scoped and never included in player/spectator projections.
CREATE TABLE team_documents (
 club_id text NOT NULL REFERENCES clubs(id),team_id text PRIMARY KEY REFERENCES teams(id),revision integer NOT NULL CHECK(revision>0),
 file_name text CHECK(file_name IS NULL OR length(file_name) BETWEEN 5 AND 120),pdf_base64 text CHECK(pdf_base64 IS NULL OR length(pdf_base64)<=6990508),
 sha256 text CHECK(sha256 IS NULL OR sha256~'^[a-f0-9]{64}$'),byte_length integer NOT NULL CHECK(byte_length BETWEEN 0 AND 5242880),updated_at bigint NOT NULL CHECK(updated_at>=0),
 CHECK((pdf_base64 IS NULL AND file_name IS NULL AND sha256 IS NULL AND byte_length=0) OR (pdf_base64 IS NOT NULL AND file_name IS NOT NULL AND sha256 IS NOT NULL AND byte_length>0))
);
ALTER TABLE team_documents ENABLE ROW LEVEL SECURITY;ALTER TABLE team_documents FORCE ROW LEVEL SECURITY;
CREATE FUNCTION team_document_staff(c text,t text) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,longball AS $$
 SELECT COALESCE(longball.runtime_purpose()='api' AND longball.context_json()->>'operation' IN('team_document.read','team_document.write')
 AND longball.context_json()->>'teamId'=t AND longball.context_json()->>'clubId'=c
 AND longball.context_json()->>'requestedRole' IN('manager','administrator')
 AND longball.context_matches(c,t,longball.context_json()->>'seasonId')
 AND (longball.actor_manager(c,t,longball.context_json()->>'seasonId') OR longball.actor_admin(c,t,longball.context_json()->>'seasonId')),false) $$;
CREATE POLICY team_document_read ON team_documents FOR SELECT USING(team_document_staff(club_id,team_id));
CREATE POLICY team_document_insert ON team_documents FOR INSERT WITH CHECK(context_json()->>'operation'='team_document.write' AND team_document_staff(club_id,team_id));
CREATE POLICY team_document_update ON team_documents FOR UPDATE USING(context_json()->>'operation'='team_document.write' AND team_document_staff(club_id,team_id)) WITH CHECK(context_json()->>'operation'='team_document.write' AND team_document_staff(club_id,team_id));
