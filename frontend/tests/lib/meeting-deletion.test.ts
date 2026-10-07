import { expect, mock, test } from 'bun:test';
let result: any = {status:'success'};
const notices: Array<[string,string]> = [];
mock.module('@tauri-apps/api/core', () => ({invoke: async () => {if (result instanceof Error) throw result; return result;}}));
mock.module('sonner', () => ({toast: {success:(s:string)=>notices.push(['success',s]),warning:(s:string)=>notices.push(['warning',s]),error:(s:string)=>notices.push(['error',s])}}));
mock.module('@/lib/analytics', () => ({default:{trackMeetingDeleted:()=>{}}}));
mock.module('@/lib/workspace-api', () => ({announceChange:()=>{},setMeetingsGroup:async()=>{}}));
const {deleteMeetings}=await import('../../src/lib/meeting-actions');
test('committed deletion with cleanup failure refreshes the library and shows the warning', async () => {
 result={status:'success',warning:'Meeting removed, but local file cleanup failed; some files may remain'};
 expect(await deleteMeetings(['one'],true)).toBe(1);
 expect(notices).toContainEqual(['warning',result.warning]);
 expect(notices.some(([,text])=>text.includes('local files deleted'))).toBe(false);
});
test('ownership refusal surfaces the native reason and does not claim deletion', async () => {
 notices.length=0; result=new Error('Recording folder overlaps another meeting; files were kept');
 expect(await deleteMeetings(['one'],true)).toBe(0);
 expect(notices.some(([kind,text])=>kind==='error' && text.includes('overlaps another meeting'))).toBe(true);
 expect(notices.some(([kind])=>kind==='success')).toBe(false);
});
