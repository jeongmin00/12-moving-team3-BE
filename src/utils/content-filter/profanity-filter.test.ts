import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectSimilarityCandidates,
  containsExactProfanity,
  findSimilarityProfanity,
} from './profanity-filter';

describe('containsExactProfanity', () => {
  it('금칙어 원문을 탐지한다', () => {
    assert.equal(
      containsExactProfanity('씨발', [
        { id: 1, word: '씨발', normalizedWord: '씨발' },
      ]),
      true
    );
  });

  it('! 구분자 우회를 탐지한다', () => {
    assert.equal(
      containsExactProfanity('씨!발', [
        { id: 1, word: '씨발', normalizedWord: '씨발' },
      ]),
      true
    );
  });

  it('금칙어 없으면 false', () => {
    assert.equal(
      containsExactProfanity('안녕하세요', [
        { id: 1, word: '씨발', normalizedWord: '씨발' },
      ]),
      false
    );
  });
});

describe('containsExactProfanity 허용어', () => {
  const words = [
    { id: 1, word: '시발', normalizedWord: '시발' },
    { id: 2, word: '미친', normalizedWord: '미친' },
  ];

  it('금칙어를 포함한 허용어는 탐지하지 않는다', () => {
    assert.equal(
      containsExactProfanity('이사가 새 출발의 시발점이네요', words),
      false
    );
    assert.equal(
      containsExactProfanity('미친 듯이 바빠서 답이 늦었어요', words),
      false
    );
  });

  it('허용어와 같은 문장에 있는 다른 욕설은 탐지한다', () => {
    assert.equal(
      containsExactProfanity('시발점은 여기고 시발 왜 늦어', words),
      true
    );
  });
});

describe('containsExactProfanity 정규화', () => {
  it('한글 사이 숫자 삽입을 탐지한다', () => {
    assert.equal(
      containsExactProfanity('시1발 뭐하는거야', [
        { id: 1, word: '시발', normalizedWord: '시발' },
      ]),
      true
    );
  });

  it('변형 음절을 탐지한다', () => {
    assert.equal(
      containsExactProfanity('씨빨', [
        { id: 1, word: '씨발', normalizedWord: '씨발' },
      ]),
      true
    );
    assert.equal(
      containsExactProfanity('개쉐끼', [
        { id: 1, word: '개새끼', normalizedWord: '개새끼' },
      ]),
      true
    );
  });

  it('금칙어 목록이 변형 표기만 있어도 표준 표기를 탐지한다', () => {
    assert.equal(
      containsExactProfanity('병신', [
        { id: 1, word: '병쉰', normalizedWord: '병쉰' },
      ]),
      true
    );
  });

  it('정규화 사본은 공백을 건너 이어 붙이지 않는다', () => {
    assert.equal(
      containsExactProfanity('아저씨 빨리 와 주세요', [
        { id: 1, word: '씨발', normalizedWord: '씨발' },
      ]),
      false
    );
  });
});

describe('collectSimilarityCandidates', () => {
  it('자모로만 된 토큰(ㅋㅋ·ㅎㅎ·ㅠㅠ)은 유사도 후보에서 제외한다', () => {
    assert.deepEqual(
      collectSimilarityCandidates('ㅋㅋ 진짜 감사합니다 ㅎㅎ ㅠㅠ'),
      ['진짜', '감사합니다']
    );
  });

  it('자모만 있는 메시지는 후보가 없다', () => {
    assert.deepEqual(collectSimilarityCandidates('ㅋㅋㅋㅋ ㅎㅎ'), []);
  });

  it('허용어 구간은 유사도 후보에서 빠진다', () => {
    assert.deepEqual(collectSimilarityCandidates('병원 근처로 이사 가요'), [
      '근처로',
      '이사',
      '가요',
    ]);
    assert.deepEqual(collectSimilarityCandidates('기사님 정말 존경합니다'), [
      '기사님',
      '정말',
      '합니다',
    ]);
  });

  it('완성형 한글 사이에 붙은 자모는 후보에 섞이지 않는다', () => {
    assert.deepEqual(collectSimilarityCandidates('네ㅋㅋ 내일뵙겠습니다'), [
      '내일뵙겠습니다',
    ]);
  });
});

describe('findSimilarityProfanity', () => {
  it('자모만 있는 메시지는 임베딩을 호출하지 않고 통과한다', async () => {
    let embedCalled = false;

    const result = await findSimilarityProfanity(
      'ㅋㅋㅋ ㅎㅎ',
      {
        hasEmbeddingApiKey: true,
        embed: async () => {
          embedCalled = true;
          return [];
        },
        searchSimilarBannedWords: async () => [],
      },
      0.55
    );

    assert.equal(result, null);
    assert.equal(embedCalled, false);
  });
});
