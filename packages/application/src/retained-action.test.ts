import { describe, expect, it } from 'vitest';
import { RetainedAction, retainedActionFailureIsUnconfirmed } from './retained-action';

describe('connected club creation with an uncertain response', () => {
  it('reuses the exact request after the server commits and the response is lost', async () => {
    const action = new RetainedAction<{ name: string }, { id: string }>();
    const receipts = new Map<string, { id: string }>();
    let writes = 0, attempts = 0, keys = 0;
    const send = async (_command: {name:string}, key: string) => {
      if (!receipts.has(key)) { writes++; receipts.set(key, { id: 'created-club' }); }
      if (++attempts === 1) throw new Error('Connection lost after commit');
      return receipts.get(key)!;
    };
    const command = { name: 'Rovers' };
    await expect(action.run(command, () => String(++keys), send)).rejects.toThrow('Connection lost');
    await expect(action.run({name:'Different club'}, () => String(++keys), send)).rejects.toThrow('unconfirmed outcome');
    expect(await action.run(command, () => String(++keys), send)).toEqual({id:'created-club'});
    expect({writes, keys}).toEqual({writes:1, keys:1});
  });
  it('retains a rate-limited request through later refusals until a receipt is returned', async () => {
    const action = new RetainedAction<{name:string}, string>(); let keys = 0;
    await expect(action.run({name:'A'}, () => String(++keys), async () => {throw {status:429};})).rejects.toEqual({status:429});
    await expect(action.run({name:'B'}, () => String(++keys), async () => 'B')).rejects.toThrow('unconfirmed');
    await expect(action.run({name:'A'}, () => String(++keys), async () => {throw {status:403};})).rejects.toEqual({status:403});
    await expect(action.run({name:'B'}, () => String(++keys), async () => 'B')).rejects.toThrow('unconfirmed');
    expect(await action.run({name:'A'}, () => String(++keys), async (_command,key) => key)).toBe('1');
    expect(await action.run({name:'B'}, () => String(++keys), async (_command,key) => key)).toBe('2');
  });
  it('never duplicates an accepted creation when fresh authentication is required before receipt lookup', async () => {
    const action = new RetainedAction<{name:string}, {id:string}>();
    const receipts = new Map<string,{id:string}>();
    const attempts: {command:{name:string};key:string}[] = [];
    let keys = 0, writes = 0, freshAuthentication = true, loseResponse = true;
    const send = async (command:{name:string}, key:string) => {
      attempts.push({command:{...command},key});
      if (!freshAuthentication) throw {status:403,code:'RECENT_AUTH_REQUIRED'};
      if (!receipts.has(key)) {writes++;receipts.set(key,{id:'one-created-club'});}
      if (loseResponse) {loseResponse=false;throw new Error('Receipt lost after commit');}
      return receipts.get(key)!;
    };
    await expect(action.run({name:'Rovers'},()=>String(++keys),send)).rejects.toThrow('Receipt lost');
    freshAuthentication=false;
    await expect(action.run({name:'Rovers'},()=>String(++keys),send)).rejects.toEqual({status:403,code:'RECENT_AUTH_REQUIRED'});
    await expect(action.run({name:'Different club'},()=>String(++keys),send)).rejects.toThrow('unconfirmed');
    freshAuthentication=true;
    expect(await action.run({name:'Rovers'},()=>String(++keys),send)).toEqual({id:'one-created-club'});
    expect({writes,keys}).toEqual({writes:1,keys:1});
    expect(attempts).toEqual(Array.from({length:3},()=>({command:{name:'Rovers'},key:'1'})));
  });
  it('keeps unknown outcomes sticky across later client refusals', async () => {
    for (const firstError of [new Error('Disconnected'),{status:408},{status:429},{status:500}]) {
      const action=new RetainedAction<{name:string},string>();let keys=0;
      await expect(action.run({name:'A'},()=>String(++keys),async()=>{throw firstError;})).rejects.toEqual(firstError);
      for (const status of [400,401,403,404,409,422]) {
        await expect(action.run({name:'A'},()=>String(++keys),async()=>{throw {status};})).rejects.toEqual({status});
        await expect(action.run({name:'B'},()=>String(++keys),async()=> 'wrong')).rejects.toThrow('unconfirmed');
      }
      expect(await action.run({name:'A'},()=>String(++keys),async(_command,key)=>key)).toBe('1');
      expect(keys).toBe(1);
    }
  });
  it('still allows correction after an immediate definite refusal on the first attempt', async () => {
    for (const status of [400,401,403,404,409,422]) {
      const action=new RetainedAction<{name:string},string>();let keys=0;
      await expect(action.run({name:'A'},()=>String(++keys),async()=>{throw {status};})).rejects.toEqual({status});
      expect(await action.run({name:'Corrected'},()=>String(++keys),async(_command,key)=>key)).toBe('2');
    }
  });
  it('shares the same sticky-outcome classification with UI owners', () => {
    for (const status of [400,401,403,404,409,422]) {
      expect(retainedActionFailureIsUnconfirmed({status})).toBe(false);
      expect(retainedActionFailureIsUnconfirmed({status},true)).toBe(true);
    }
    for (const error of [new Error('No receipt'),null,{status:408},{status:429},{status:503}]) expect(retainedActionFailureIsUnconfirmed(error)).toBe(true);
  });
});
