import { expect, test } from 'bun:test';
import { interleaveTranscriptImages } from '../../src/lib/transcript-image-layout';
import type { TranscriptSegmentData } from '../../src/types';
const picture = (id: string, audioTime: number) => ({id, audioTime, path: `${id}.jpg`, createdAt: ''});
const segment: TranscriptSegmentData = {id:'turn', speaker:'Host', timestamp:0, endTime:3600,
  text:'opening middle ending', words:[
    {wordID:'0', text:'opening ', startTime:0, endTime:1000},
    {wordID:'1', text:'middle ', startTime:1200000, endTime:1201000},
    {wordID:'2', text:'ending', startTime:2400000, endTime:2401000},
  ]};
test('an hour of speech is split around screenshots using millisecond word times', () => {
  const before = JSON.stringify(segment);
  const rows = interleaveTranscriptImages([segment], [picture('b',1800),picture('a',600)]);
  expect(rows.map(row => row.text.trim())).toEqual(['opening','middle','ending']);
  expect(rows.map(row => row.imagesAfter?.map(image => image.id))).toEqual([['a'],['b'],undefined]);
  expect(rows.map(row => row.speaker)).toEqual(['Host','Host','Host']);
  expect(rows.map(row => row.timestamp)).toEqual([0,600,1800]);
  expect(rows.map(row => row.sourceId)).toEqual(['turn','turn','turn']);
  expect(rows.flatMap(row => row.words ?? [])).toEqual(segment.words!);
  expect(rows.map(row => row.text).join('')).toBe(segment.text);
  expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
  expect(JSON.stringify(segment)).toBe(before);
});
test('pictures at the start, in gaps and at the end retain chronological ordering', () => {
  const segments = [{id:'one',speaker:'Host',timestamp:10,endTime:20,text:'first words'},
    {id:'two',speaker:'Host',timestamp:30,endTime:40,text:'next words'}];
  const rows = interleaveTranscriptImages(segments,[picture('before',0),picture('gap',25),picture('boundary',30),picture('after',45)]);
  expect(rows.flatMap(row => row.imagesAfter ?? []).map(image => image.id)).toEqual(['before','gap','boundary','after']);
  expect(rows.find(row => row.text==='next words')?.timestamp).toBe(30);
  expect(rows.map(row => row.text).join('')).toBe('first wordsnext words');
});
test('legacy untimed text splits for display without inventing word metadata', () => {
  const rows = interleaveTranscriptImages([{id:'old',timestamp:0,endTime:100,speaker:'Host',text:'one two three four'}],[picture('half',50)]);
  expect(rows.map(row => row.text.trim())).toEqual(['one two','three four']);
  expect(rows.every(row => row.words===undefined)).toBe(true);
  expect(rows[0].imagesAfter?.[0].audioTime).toBe(50);
});
test('pagination delays future images, while simultaneous pictures stay together', () => {
  const rows = interleaveTranscriptImages([{id:'old',timestamp:0,endTime:10,text:'words'}],
    [picture('z',5),picture('a',5),picture('future',90),picture('invalid',NaN)],true);
  expect(rows.flatMap(row => row.imagesAfter ?? []).map(image => image.id)).toEqual(['a','z']);
  expect(rows.filter(row => row.imagesAfter?.length)).toHaveLength(1);
});
test('translations are partitioned once rather than repeated after every image', () => {
  const rows = interleaveTranscriptImages([segment],[picture('a',600),picture('b',1800)],false,{turn:'intro milieu fin'});
  expect(rows.map(row => row.translatedText).join('')).toBe('intro milieu fin');
});
