import { beforeEach, expect, test } from 'bun:test';
import { readLineLimit, writeLineLimit, splitTranscriptLines, validLineMinutes } from '../../src/lib/transcript-line-limit';
import { mergeInterleavedSpeakerTurns } from '../../src/lib/nearLiveCaptions';
beforeEach(() => {
  const store = new Map<string,string>();
  globalThis.localStorage = {getItem:key=>store.get(key)??null,setItem:(key,value)=>{store.set(key,value)},removeItem:key=>{store.delete(key)},clear:()=>store.clear(),key:()=>null,get length(){return store.size}};
  globalThis.window = { dispatchEvent:()=>true } as any;
});
test('disabled is unlimited; first enable defaults to one minute and choices persist', () => {
  expect(readLineLimit()).toEqual({enabled:false,minutes:1});
  writeLineLimit({enabled:true,minutes:1});
  expect(readLineLimit()).toEqual({enabled:true,minutes:1});
  writeLineLimit({enabled:false,minutes:3});
  expect(readLineLimit()).toEqual({enabled:false,minutes:3});
  for(const value of [0,-1,0.5,1.5,NaN,Infinity]) expect(validLineMinutes(value)).toBe(false);
  expect(()=>writeLineLimit({enabled:true,minutes:0})).toThrow();
});
test('long timed rows split without changing words, text, IDs for editing or image placement', () => {
  const words = Array.from({length:150},(_,index)=>({wordID:String(index),text:`word${index}`,startTime:index*1000,endTime:index*1000+900}));
  const segment = {id:'source',speaker:'Host',timestamp:0,endTime:150,text:words.map(word=>word.text).join(' '),words,translatedText:'translation stays intact here',imagesAfter:[{id:'image'}] as any};
  const parts = splitTranscriptLines([segment],60);
  expect(parts).toHaveLength(3);
  expect(parts.map(part=>part.text).join('')).toBe(segment.text);
  expect(parts.flatMap(part=>part.words??[])).toEqual(words);
  expect(parts.map(part=>part.translatedText).join('')).toBe(segment.translatedText);
  expect(parts.every(part=>part.sourceId==='source' && part.endTime-part.timestamp<=60)).toBe(true);
  expect(parts[0].imagesAfter).toBeUndefined();
  expect(parts[2].imagesAfter).toEqual(segment.imagesAfter);
  expect(segment.words).toEqual(words);
  expect(splitTranscriptLines([segment],Infinity)[0]).toBe(segment);
});
test('legacy speech remains complete and live interleaving cannot merge beyond the duration', () => {
  const legacy={id:'long',speaker:'Host',timestamp:5,endTime:305,text:'one two three four five six seven eight nine ten'};
  expect(splitTranscriptLines([legacy],60).map(part=>part.text).join('')).toBe(legacy.text);
  const chunks=Array.from({length:12},(_,index)=>({id:String(index),speaker:'Host',timestamp:index*10,endTime:index*10+10,text:String(index)}));
  expect(mergeInterleavedSpeakerTurns(chunks,2.5,60)).toHaveLength(2);
  expect(mergeInterleavedSpeakerTurns(chunks)).toHaveLength(1);
});
