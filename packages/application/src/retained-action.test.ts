import { describe, expect, it } from 'vitest';
import { RetainedAction } from './retained-action';

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
  it('retains rate-limited requests but allows a new change after a definitive rejection', async () => {
    const action = new RetainedAction<{name:string}, string>(); let keys = 0;
    await expect(action.run({name:'A'}, () => String(++keys), async () => {throw {status:429};})).rejects.toEqual({status:429});
    await expect(action.run({name:'B'}, () => String(++keys), async () => 'B')).rejects.toThrow('unconfirmed');
    await expect(action.run({name:'A'}, () => String(++keys), async () => {throw {status:403};})).rejects.toEqual({status:403});
    expect(await action.run({name:'B'}, () => String(++keys), async (_command,key) => key)).toBe('2');
  });
});
