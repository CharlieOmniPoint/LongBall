/** Additive fictional SQLite migration; production uses PostgreSQL migration013 and row security. */
export const SQLITE_TEAM_PRIVILEGES_DDL = `
CREATE TABLE team_privilege_states(team_id TEXT PRIMARY KEY REFERENCES teams(id),revision INTEGER NOT NULL CHECK(revision>=0),state_json TEXT NOT NULL CHECK(json_valid(state_json)));
CREATE TABLE team_privilege_decisions(team_id TEXT NOT NULL REFERENCES teams(id),revision INTEGER NOT NULL CHECK(revision>0),command_id TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES accounts(id),target_account_id TEXT NOT NULL REFERENCES accounts(id),privilege TEXT NOT NULL CHECK(privilege IN('uploads','invitations')),suspended INTEGER NOT NULL CHECK(suspended IN(0,1)),reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 80),private_note TEXT CHECK(length(private_note)<=1000),created_at INTEGER NOT NULL,PRIMARY KEY(team_id,revision),UNIQUE(team_id,actor_id,command_id));
INSERT INTO team_privilege_states(team_id,revision,state_json) SELECT id,0,json_object('schemaVersion',1,'teamId',id,'revision',0,'restrictions',json('[]')) FROM teams;
CREATE TRIGGER team_privileges_new_team AFTER INSERT ON teams BEGIN INSERT INTO team_privilege_states(team_id,revision,state_json) VALUES(NEW.id,0,json_object('schemaVersion',1,'teamId',NEW.id,'revision',0,'restrictions',json('[]'))); END;
CREATE TRIGGER team_privilege_state_identity BEFORE UPDATE ON team_privilege_states WHEN NEW.team_id<>OLD.team_id OR NEW.revision<>OLD.revision+1 OR json_extract(NEW.state_json,'$.teamId')<>NEW.team_id OR json_extract(NEW.state_json,'$.revision')<>NEW.revision BEGIN SELECT RAISE(ABORT,'Invalid team privilege revision'); END;
CREATE TRIGGER team_privilege_decision_immutable_update BEFORE UPDATE ON team_privilege_decisions BEGIN SELECT RAISE(ABORT,'Immutable team privilege decision'); END;
CREATE TRIGGER team_privilege_decision_immutable_delete BEFORE DELETE ON team_privilege_decisions BEGIN SELECT RAISE(ABORT,'Immutable team privilege decision'); END;
`;
