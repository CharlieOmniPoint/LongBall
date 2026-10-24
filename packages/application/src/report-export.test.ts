import { describe, expect, it } from 'vitest';
import { parseReportExportRequest, REPORT_EXPORT_KINDS } from './report-export';

const scope={teamId:'team-roma-u10',seasonId:'season-2026-27'};
describe('canonical report export request boundary',()=>{
  it('accepts all canonical report kinds in both supported primitive formats',()=>{
    for(const kind of REPORT_EXPORT_KINDS)for(const format of ['csv','pdf'] as const){
      const request={...scope,kind,format,...(kind==='match_summary'?{matchId:'match-roma-maple'}:{})};
      expect(parseReportExportRequest(request)).toEqual({...request,matchId:kind==='match_summary'?'match-roma-maple':null});
    }
  });
  it('rejects format coercion that would render CSV bytes with a PDF filename',()=>{
    for(const format of [['pdf'],['csv'],new String('pdf'),{value:'pdf'},true,1,null,undefined])expect(()=>parseReportExportRequest({...scope,kind:'season_results',format})).toThrow();
  });
  it('requires the match identifier exactly for a match summary',()=>{
    for(const matchId of [undefined,null,'',42])expect(()=>parseReportExportRequest({...scope,kind:'match_summary',format:'pdf',matchId})).toThrow();
    for(const kind of REPORT_EXPORT_KINDS.filter(item=>item!=='match_summary'))expect(()=>parseReportExportRequest({...scope,kind,format:'csv',matchId:'other-match'})).toThrow();
  });
  it('rejects unknown fields, unsupported formats and malformed scope without changing values',()=>{
    const valid={...scope,kind:'attendance',format:'csv'};
    for(const request of [null,[],valid.kind,{...valid,audience:'manager'},{...valid,format:'json'},{...valid,teamId:''},{...valid,seasonId:'a'.repeat(151)},{...valid,teamId:'team\nother'}])expect(()=>parseReportExportRequest(request)).toThrow();
  });
});
