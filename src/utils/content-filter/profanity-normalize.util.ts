import { PROFANITY_ALLOWLIST } from '../../constants/profanity-allowlist';
import { PROFANITY_VARIANT_SYLLABLE_MAP } from '../../constants/profanity-variants';

/**
 * 허용어를 지운 자리에 넣는 문자.
 * Exact 구분자 클래스·유사도 토큰 패턴 어디에도 속하지 않아, 앞뒤 글자가 이어져 새 금칙어가 되지 않는다.
 */
const ALLOWLIST_PLACEHOLDER = '|';

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 긴 허용어부터 매칭해 '시발점'이 '시발'보다 먼저 지워지도록 한다. */
const ALLOWLIST_PATTERN: RegExp | null =
  PROFANITY_ALLOWLIST.length === 0
    ? null
    : new RegExp(
        [...PROFANITY_ALLOWLIST]
          .sort((left, right) => right.length - left.length)
          .map(escapeRegExp)
          .join('|'),
        'gi'
      );

/** 한글(자모 포함) 사이에 낀 숫자·영문 한 글자. "시1발" → "시발" */
const INSERTED_ALNUM_PATTERN =
  /(?<=[가-힣ㄱ-ㅎㅏ-ㅣ])[0-9a-zA-Z](?=[가-힣ㄱ-ㅎㅏ-ㅣ])/g;

const VARIANT_SYLLABLE_PATTERN: RegExp | null =
  Object.keys(PROFANITY_VARIANT_SYLLABLE_MAP).length === 0
    ? null
    : new RegExp(
        Object.keys(PROFANITY_VARIANT_SYLLABLE_MAP).map(escapeRegExp).join('|'),
        'g'
      );

/** 허용어 구간을 지운 비교용 문자열. 원문은 바꾸지 않는다. */
export const removeAllowlistedSpans = (text: string): string =>
  ALLOWLIST_PATTERN
    ? text.replace(ALLOWLIST_PATTERN, ALLOWLIST_PLACEHOLDER)
    : text;

/**
 * 금칙어 비교용 정규화 사본. 원문·마스킹 위치 계산에는 쓰지 않는다.
 * 1) 한글 사이 숫자·영문 한 글자 제거  2) 변형 음절 매핑  3) 소문자화
 */
export const normalizeForProfanityMatch = (text: string): string => {
  const withoutInserted = text.replace(INSERTED_ALNUM_PATTERN, '');
  const mapped = VARIANT_SYLLABLE_PATTERN
    ? withoutInserted.replace(
        VARIANT_SYLLABLE_PATTERN,
        (syllable) => PROFANITY_VARIANT_SYLLABLE_MAP[syllable] ?? syllable
      )
    : withoutInserted;
  return mapped.toLowerCase();
};
