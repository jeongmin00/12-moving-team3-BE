import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeForProfanityMatch,
  removeAllowlistedSpans,
} from './profanity-normalize.util';

describe('removeAllowlistedSpans', () => {
  it('허용어 구간을 지운다', () => {
    const result = removeAllowlistedSpans('이사가 새 출발의 시발점이네요');

    assert.equal(result.includes('시발'), false);
  });

  it('긴 허용어를 먼저 지워 남는 글자가 없다', () => {
    assert.equal(removeAllowlistedSpans('시발점'), '|');
  });

  it('허용어가 없는 문장은 그대로 둔다', () => {
    assert.equal(
      removeAllowlistedSpans('토요일 오전 가능할까요'),
      '토요일 오전 가능할까요'
    );
  });
});

describe('normalizeForProfanityMatch', () => {
  it('한글 사이에 낀 숫자·영문 한 글자를 지운다', () => {
    assert.equal(normalizeForProfanityMatch('시1발'), '시발');
    assert.equal(normalizeForProfanityMatch('병x신'), '병신');
    assert.equal(normalizeForProfanityMatch('ㅅ1ㅂ'), 'ㅅㅂ');
  });

  it('한글 사이가 아닌 숫자는 그대로 둔다', () => {
    assert.equal(normalizeForProfanityMatch('010-1234-5678'), '010-1234-5678');
    assert.equal(normalizeForProfanityMatch('박스 30개'), '박스 30개');
  });

  it('두 글자 이상 끼어 있으면 지우지 않는다', () => {
    assert.equal(normalizeForProfanityMatch('시12발'), '시12발');
  });

  it('변형 음절을 매핑 표대로 바꾼다', () => {
    assert.equal(normalizeForProfanityMatch('씨빨'), '씨발');
    assert.equal(normalizeForProfanityMatch('개쉐끼'), '개새끼');
    assert.equal(normalizeForProfanityMatch('개세끼'), '개새끼');
    assert.equal(normalizeForProfanityMatch('병씬'), '병신');
    assert.equal(normalizeForProfanityMatch('빙쉰'), '빙신');
    assert.equal(normalizeForProfanityMatch('미친넘'), '미친놈');
  });

  it('영문은 소문자로 맞춘다', () => {
    assert.equal(normalizeForProfanityMatch('SiBaL'), 'sibal');
  });
});
