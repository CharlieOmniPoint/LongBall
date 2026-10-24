import { describe,expect,it } from 'vitest';
import { requestDatabaseScope } from './request-context';

describe('trusted HTTP intent for PostgreSQL contexts',()=>{
  const base={method:'GET',parts:['v1','teams','team-a','records'],seasonId:'season-a',body:null};
  it('binds tenant hints to the route, never a body-supplied actor, club or alternate team',()=>{
    expect(requestDatabaseScope({...base,body:{accountId:'another-account',clubId:'club-b',teamId:'team-b',seasonId:'season-b'}})).toEqual({operation:'records.read',requestedRole:'default',teamId:'team-a',seasonId:'season-a'});
    expect(requestDatabaseScope({...base,parts:['v1','matches','match-a'],body:{teamId:'team-b'}})).toEqual({operation:'match.read',requestedRole:'default',matchId:'match-a'});
  });
  it('distinguishes export, own-player and administrator service intent without creating a role',()=>{
    expect(requestDatabaseScope({...base,parts:[...base.parts,'export'],role:'player'})).toMatchObject({operation:'records.export',requestedRole:'player'});
    expect(requestDatabaseScope({...base,parts:['v1','teams','team-a','preparation','own'],role:'player'}).operation).toBe('preparation.own.read');
    expect(requestDatabaseScope({...base,parts:['v1','teams','team-a','managers'],role:'administrator'}).operation).toBe('staff.read');
    expect(()=>requestDatabaseScope({...base,role:'operator'})).toThrow('role context');
  });
  it('rejects manager-only match subroutes in a selected player or spectator context',()=>{
    for(const role of ['player','spectator','administrator'])for(const action of ['download','controller','events','clock','reconciliation'])expect(()=>requestDatabaseScope({...base,parts:['v1','matches','match-a',action],role})).toThrow('manager context');
    expect(requestDatabaseScope({...base,parts:['v1','matches','match-a','download'],role:'manager'}).operation).toBe('match.manage');
  });
  it('extracts only a known target and destination after the server chooses the staff or rollover route',()=>{
    const command={id:'request-id',type:'manager.assigned',accountId:'known-adult',provisionAccountId:'forged-child'};
    expect(requestDatabaseScope({...base,method:'POST',parts:['v1','teams','team-a','managers'],body:{command}})).toEqual({operation:'staff.assign',requestedRole:'administrator',teamId:'team-a',seasonId:'season-a',staffTargetAccountId:'known-adult'});
    expect(requestDatabaseScope({...base,method:'POST',parts:['v1','teams','team-a','seasons'],body:{command:{idForSeason:'season-next'}}})).toMatchObject({operation:'season.create',newSeasonId:'season-next'});
    expect(requestDatabaseScope({...base,method:'POST',body:{command}})).not.toHaveProperty('staffTargetAccountId');
  });
  it('never turns legacy client credentials into database authority and maps only canonical scoped invitation intent',()=>{
    const body={command:{id:'accept-id',type:'invite.accepted',reviewCode:'exact fictional CODE'}};
    const context=requestDatabaseScope({...base,method:'POST',parts:['v1','teams','team-a','community'],body});
    expect(context).toMatchObject({operation:'community.write'});expect(context).not.toHaveProperty('invitationTokenHash');expect(JSON.stringify(context)).not.toContain(body.command.reviewCode);
    expect(requestDatabaseScope({...base,method:'POST',parts:['v1','teams','team-a','community'],body:{command:{...body.command,type:'preferences.changed'}}})).not.toHaveProperty('invitationTokenHash');
    expect(requestDatabaseScope({...base,method:'POST',parts:['v1','teams','team-a','spectator-invites'],role:'player',body:{seasonId:'season-a',expiresInHours:1}})).toMatchObject({operation:'invite.issue',requestedRole:'player',teamId:'team-a',seasonId:'season-a'});
    expect(requestDatabaseScope({...base,method:'DELETE',parts:['v1','teams','team-a','spectator-invites','invite-a']})).toMatchObject({operation:'invite.revoke'});
  });
  it('keeps global own-account intent separate from scoped authenticated link requests and anonymous activation',()=>{
    expect(requestDatabaseScope({...base,method:'POST',parts:['v1','privacy','requests'],body:{kind:'leave_team',teamId:'team-b',seasonId:'season-b'}})).toEqual({operation:'privacy.request',requestedRole:'default'});
    expect(requestDatabaseScope({...base,method:'POST',parts:['v1','accounts','link-requests'],body:{teamId:'team-a',seasonId:'season-a'}})).toMatchObject({operation:'account.link_request',teamId:'team-a',seasonId:'season-a'});
    expect(requestDatabaseScope({...base,method:'POST',parts:['v1','activation','complete'],body:{activationId:'not-authority'}})).toEqual({operation:'unavailable',requestedRole:'default'});
  });
});
