import { describe, expect, it } from 'vitest';
import { mergeHeaders, normalizeHeaders, responseHeadersToRecord, type HeaderInput } from '../../src/headers.js';

describe('normalizeHeaders', () => {
    it('普通对象：key 小写化', () => {
        expect(normalizeHeaders({ 'X-Custom': 'a', Accept: 'b' })).toEqual({ 'x-custom': 'a', accept: 'b' });
    });

    it('null 值字段被剔除', () => {
        expect(normalizeHeaders({ 'X-A': '1', 'X-B': null, 'X-C': undefined } as object)).toEqual({ 'x-a': '1' });
    });

    it('Headers 实例', () => {
        expect(normalizeHeaders(new Headers({ 'X-A': '1' }) as unknown as HeaderInput)).toEqual({ 'x-a': '1' });
    });

    it('[k,v] 对数组', () => {
        expect(normalizeHeaders([['X-A', '1'], ['X-B', '2']])).toEqual({ 'x-a': '1', 'x-b': '2' });
    });

    it('undefined / null 输入 → 空对象', () => {
        expect(normalizeHeaders(undefined)).toEqual({});
        expect(normalizeHeaders(null)).toEqual({});
    });

    it('数组值用逗号连接', () => {
        expect(normalizeHeaders({ 'X-A': ['1', '2'] } as object)).toEqual({ 'x-a': '1, 2' });
    });

    it('number / boolean 值正常字符串化', () => {
        expect(normalizeHeaders({ 'X-Port': 8080, 'X-Flag': true } as object)).toEqual({
            'x-port': '8080',
            'x-flag': 'true',
        });
    });

    it('对象等复杂值被丢弃（不产出 [object Object]）', () => {
        // 纯对象值与「数组内含对象」均整体丢弃
        expect(normalizeHeaders({ 'X-Obj': { token: 'x' }, 'X-Mixed': ['a', { b: 1 }] } as object)).toEqual({});
    });
});

describe('mergeHeaders', () => {
    it('override 覆盖同名默认头', () => {
        expect(mergeHeaders({ authorization: 'default', accept: 'json' }, { authorization: 'override' })).toEqual({
            authorization: 'override',
            accept: 'json',
        });
    });

    it('大小写不敏感覆盖', () => {
        expect(mergeHeaders({ 'X-Trace': 'a' }, { 'x-trace': 'b' })).toEqual({ 'x-trace': 'b' });
    });

    it('两侧均可为空', () => {
        expect(mergeHeaders(undefined, { a: '1' })).toEqual({ a: '1' });
        expect(mergeHeaders({ a: '1' }, undefined)).toEqual({ a: '1' });
    });
});

describe('responseHeadersToRecord', () => {
    it('快照响应头且 set-cookie 保留数组', () => {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        headers.append('set-cookie', 'a=1');
        headers.append('set-cookie', 'b=2');
        const record = responseHeadersToRecord(headers);
        expect(record['content-type']).toBe('application/json');
        expect(record['set-cookie']).toEqual(['a=1', 'b=2']);
    });
});
