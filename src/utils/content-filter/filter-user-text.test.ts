import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterUserText } from './index';

const filterPersonalInfoOnly = (content: string) =>
  filterUserText(content, {
    maskPhone: true,
    maskAccount: true,
    maskProfanity: false,
  });

describe('filterUserText personal info', () => {
  it('문장 안 전화는 mask', async () => {
    const result = await filterPersonalInfoOnly('연락처 010-1234-5678 입니다');

    assert.equal(result.decision.action, 'mask');
    assert.match(result.maskedContent, /\[전화번호\]/);
  });

  it('번호만 있으면 block', async () => {
    const result = await filterPersonalInfoOnly('01012345678');

    assert.equal(result.decision.action, 'block');
  });

  it('한글 숫자 우회 전화는 block', async () => {
    const result = await filterPersonalInfoOnly('공일공 1234 5678');

    assert.equal(result.decision.action, 'block');
    assert.equal(
      result.decision.reasons.some((reason) => reason.method === 'normalized'),
      true
    );
  });

  it('전각 숫자 전화도 탐지한다', async () => {
    const result = await filterPersonalInfoOnly('０１０１２３４５６７８');

    assert.equal(result.decision.action, 'block');
    assert.equal(
      result.decision.reasons.some(
        (reason) => reason.code === 'PERSONAL_INFO_PHONE'
      ),
      true
    );
  });

  it('전각 하이픈(－) 전화도 block', async () => {
    const result = await filterPersonalInfoOnly('０１０－１２３４－５６７８');

    assert.equal(result.decision.action, 'block');
  });
});

describe('filterUserText profanity normalization', () => {
  const filterWithBannedWords = (content: string) =>
    filterUserText(
      content,
      { maskPhone: true, maskAccount: true, maskProfanity: true },
      {
        findActiveBannedWords: async () => [
          { id: 1, word: '시발', normalizedWord: '시발' },
        ],
        hasEmbeddingApiKey: false,
      }
    );

  it('허용어·정규화는 원문과 전화번호 마스킹 위치를 바꾸지 않는다', async () => {
    const content = '신발장 2개랑 시발점 근처 010-1234-5678 연락 주세요';
    const result = await filterWithBannedWords(content);
    const personalInfoOnly = await filterPersonalInfoOnly(content);

    assert.equal(result.decision.action, 'mask');
    assert.equal(result.rawContent, content);
    assert.equal(result.maskedContent, personalInfoOnly.maskedContent);
    assert.match(
      result.maskedContent,
      /^신발장 2개랑 시발점 근처 \[전화번호\]/
    );
  });

  it('숫자를 끼운 욕설은 정규화로 block', async () => {
    const result = await filterWithBannedWords('시1발 왜 안 와요');

    assert.equal(result.decision.action, 'block');
    assert.equal(result.rawContent, '시1발 왜 안 와요');
  });
});
