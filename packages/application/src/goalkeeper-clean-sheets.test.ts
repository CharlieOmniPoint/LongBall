import { describe, expect, it } from 'vitest';
import { goalkeeperCleanSheetOutcomes, type GoalkeeperInterval } from './goalkeeper-clean-sheets';
const interval=(playerId:string,startMs:number,endMs:number,position='GK'):GoalkeeperInterval=>({playerId,startMs,endMs,position,state:'playing'});
const calculate=(intervals:GoalkeeperInterval[],goals:number[]=[],extra={})=>goalkeeperCleanSheetOutcomes({completed:true,reviewRequired:false,activeDurationMs:100,intervals,oppositionGoals:goals.map(atMs=>({atMs})),recordedOppositionScore:goals.length,...extra});
describe('clean sheets from completed active goalkeeper stints',()=>{
  it('credits a keeper whose stints were clear even when the team conceded with someone else in goal',()=>{
    expect(calculate([interval('a',0,40),interval('a',40,100,'CM'),interval('b',0,40,'CM'),interval('b',40,100)],[75])).toEqual([{playerId:'a',outcome:'clean_sheet'},{playerId:'b',outcome:'conceded'}]);
  });
  it('counts any opposition beneficiary including an own goal, and a goal at the final whistle',()=>{
    expect(calculate([interval('a',0,100)],[100])).toEqual([{playerId:'a',outcome:'conceded'}]);
  });
  it('merges contiguous accepted checkpoints and counts at most one clean sheet per player/game',()=>{
    expect(calculate([interval('a',0,25),interval('a',25,50),interval('a',50,100)],[25])).toEqual([{playerId:'a',outcome:'conceded'}]);
    expect(calculate([interval('a',0,25),interval('a',75,100)])).toEqual([{playerId:'a',outcome:'clean_sheet'}]);
  });
  it('keeps an unresolved keeper-change timestamp unknown, instead of assigning an invented clean sheet',()=>{
    expect(calculate([interval('a',0,50),interval('b',50,100)],[50])).toEqual([{playerId:'a',outcome:'unknown'},{playerId:'b',outcome:'unknown'}]);
  });
  it('does not credit active, abandoned, recovering or incomplete goal histories',()=>{
    for(const extra of [{completed:false},{reviewRequired:true},{recordedOppositionScore:1},{oppositionGoals:[{atMs:null}],recordedOppositionScore:1}])expect(calculate([interval('a',0,100)],[],extra)).toEqual([{playerId:'a',outcome:'unknown'}]);
  });
  it('ignores bench/outfield time and rejects malformed interval bounds or an uncovered goal',()=>{
    expect(calculate([interval('a',0,100,'CM')])).toEqual([]);
    expect(calculate([interval('a',-1,100)])).toEqual([{playerId:'a',outcome:'unknown'}]);
    expect(calculate([interval('a',0,10)],[20])).toEqual([{playerId:'a',outcome:'unknown'}]);
  });
});
