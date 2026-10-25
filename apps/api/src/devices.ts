import { AccessError,type Principal } from '../../../packages/application/src/access';
import { parseAccountDevicesDto,type AccountDevicesDto } from '../../../packages/application/src/account-devices';
export interface NativeDeviceRow {device_id:string;account_id:string;issuer:string;platform:'ios'|'android';registered_at:number;last_seen_at:number}
export function parseNativeDeviceInput(value:unknown):{deviceId:string;platform:'ios'|'android'}{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AccessError('INVALID_REQUEST',400,'Use the reported native installation identity and platform.');
  const item=value as Record<string,unknown>;
  if(Object.keys(item).length!==2||Object.keys(item).some(key=>!['deviceId','platform'].includes(key))||typeof item.deviceId!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(item.deviceId)||!['ios','android'].includes(String(item.platform)))throw new AccessError('INVALID_REQUEST',400,'Use a canonical installation identity and reported iOS or Android platform.');
  return{deviceId:item.deviceId,platform:item.platform as 'ios'|'android'};
}
export function ownDevicesDto(principal:Principal,legacy:{id:string;account_id:string}[],native:NativeDeviceRow[],nowMs:number):AccountDevicesDto{
  if(legacy.some(row=>row.account_id!==principal.accountId)||native.some(row=>row.account_id!==principal.accountId||row.issuer!==principal.issuer))throw new Error('OWN_DEVICE_SCOPE_REQUIRED');
  const nativeIds=new Set(native.map(row=>row.device_id));
  return parseAccountDevicesDto({kind:'recognised-devices',accountId:principal.accountId,asOf:new Date(nowMs).toISOString(),devices:[...native.map(row=>({deviceId:row.device_id,source:'native_app_enrolment',label:null,platform:row.platform,platformVerified:false,registeredAt:new Date(row.registered_at).toISOString(),lastSeenAt:new Date(row.last_seen_at).toISOString()})),...legacy.filter(row=>!nativeIds.has(row.id)).map(row=>({deviceId:row.id,source:'match_controller_enrolment',label:null,platform:null,platformVerified:false,registeredAt:null,lastSeenAt:null}))],remoteRevocationAvailable:false});
}
