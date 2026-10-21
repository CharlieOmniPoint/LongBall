import { AccessError, type Role } from '../../../packages/application/src/access';

/** Server-selected route intent. A path/role is never proof of membership. */
export interface DatabaseRequestScope {
  operation: string;
  requestedRole: Role | 'default';
  teamId?: string;
  seasonId?: string;
  matchId?: string;
  staffTargetAccountId?: string;
  newSeasonId?: string;
  invitationTokenHash?: string;
}
const object = (value: unknown): value is Record<string,unknown> => Boolean(value && typeof value==='object'&&!Array.isArray(value));
const opaque = (value:unknown):value is string => typeof value==='string'&&/^[A-Za-z0-9_-]{1,150}$/.test(value);

export function requestDatabaseScope(input:{method:string;parts:string[];seasonId:string;role?:string;body:Record<string,unknown>|null}):DatabaseRequestScope {
  const {method,parts,body}=input;
  if(input.role&&!['administrator','manager','player','spectator'].includes(input.role))throw new AccessError('NOT_FOUND',404,'The requested role context is unavailable.');
  const scope:DatabaseRequestScope={operation:'unavailable',requestedRole:input.role as Role|undefined??'default'};
  const command=object(body?.command)?body.command:null;
  if(parts[0]!=='v1')return scope;
  if(parts[1]==='me')scope.operation=parts[2]==='push-registrations'?(method==='GET'?'push.read':method==='POST'?'push.register':method==='DELETE'?'push.revoke':'unavailable'):'account.read';
  else if(parts[1]==='identity'&&parts[2]==='devices')scope.operation=method==='GET'?'identity.devices':'identity.enrol';
  else if(parts[1]==='contracts')scope.operation='contracts.read';
  else if(parts[1]==='privacy'&&parts[2]==='requests')scope.operation=method==='GET'?'privacy.read':'privacy.request';
  else if(parts[1]==='accounts'&&['link-requests','recovery-requests'].includes(parts[2])){
    scope.operation=parts[2]==='link-requests'?'account.link_request':'account.recovery_request';
    if(opaque(body?.teamId)&&opaque(body?.seasonId)){scope.teamId=body.teamId;scope.seasonId=body.seasonId;}
  }
  else if(parts[1]==='exports'){
    scope.operation=method==='POST'&&parts.length===2?'exports.request':method==='GET'&&parts.length===3?'exports.read':method==='GET'&&parts.length===4&&parts[3]==='download'?'exports.download':'unavailable';
    if(scope.operation==='exports.request'&&opaque(body?.teamId)&&opaque(body?.seasonId)){scope.teamId=body.teamId;scope.seasonId=body.seasonId;}
  }
  else if(parts[1]==='matches'&&opaque(parts[2])){
    scope.matchId=parts[2];scope.operation=method==='GET'&&parts.length===3?'match.read':'match.manage';
    if(scope.operation==='match.manage'&&input.role&&input.role!=='manager')throw new AccessError('NOT_FOUND',404,'Choose the current manager context for match recording.');
  }
  else if(parts[1]==='teams'&&opaque(parts[2])){
    scope.teamId=parts[2];scope.seasonId=input.seasonId;
    switch(parts[3]){
      case 'matches':scope.operation='match.read';break;
      case 'managers':{
        scope.operation=method==='GET'?'staff.read':parts[4]==='revoke'?'staff.revoke':'staff.assign';
        const target=command?.accountId??body?.accountId;if(opaque(target))scope.staffTargetAccountId=target;
        break;
      }
      case 'configuration':scope.operation=method==='GET'?'configuration.read':'configuration.write';break;
      case 'seasons':scope.operation=method==='GET'?'season.options':'season.create';if(method==='POST'&&opaque(command?.idForSeason))scope.newSeasonId=command.idForSeason;break;
      case 'preparation':scope.operation=`preparation.${parts[4]==='own'?'own.':''}${method==='GET'?'read':'write'}`;break;
      case 'records':scope.operation=method==='GET'?(parts[4]==='export'?'records.export':'records.read'):'records.write';break;
      case 'privileges':scope.operation=method==='GET'?(parts[4]==='own'?'privileges.own':'privileges.read'):'privileges.write';break;
      case 'community':scope.operation=method==='GET'?'community.read':'community.write';break;
      case 'spectator-invites':scope.operation=method==='GET'?'invite.list':method==='DELETE'?'invite.revoke':parts[5]==='reissue'?'invite.reissue':'invite.issue';break;
      case 'media':scope.operation=parts[4]==='photos'?'media.gateway':method==='GET'?'media.list':method==='PUT'?'media.upload':parts[5]==='prepare'?'media.prepare':'media.complete';break;
      case 'activation':scope.operation=parts[4]==='pending-child'?'activation.pending_child':'activation.issue';break;
      case 'branding':scope.operation=method==='GET'?(parts[4]==='assets'?'branding.gateway':'branding.read'):method==='PUT'?'branding.upload':parts[4]==='uploads'?'branding.complete':parts[5]==='uploads'?'branding.prepare':parts[5]==='publish'?'branding.publish':'branding.remove';break;
    }
  }
  if(!input.role&&(scope.operation.startsWith('staff.')||scope.operation==='season.create'||scope.operation==='configuration.write'&&command?.type==='club.updated'))scope.requestedRole='administrator';
  return scope;
}
