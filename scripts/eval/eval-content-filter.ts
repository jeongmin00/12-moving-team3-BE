/**
 * 채팅 콘텐츠 필터 성능 평가 스크립트.
 *
 * 실행: npx ts-node --transpile-only scripts/eval/eval-content-filter.ts [--cases <파일>]
 *   - --cases: 테스트 세트 JSON 경로 (기본 scripts/eval/content-filter-cases.json).
 *     결과는 기본 세트면 content-filter-eval-result.md, 그 외에는 content-filter-eval-result.<파일명>.md
 *   - OPENAI_API_KEY가 있으면 임베딩 유사도 조건까지 평가한다. (DB 불필요: 금칙어 임베딩을 메모리에서 비교)
 *   - 키가 없으면 정확 일치·전화/계좌 탐지만 평가한다.
 *   - 금칙어 임베딩은 scripts/eval/.embedding-cache.json에 캐시해 재실행 비용을 줄인다.
 *
 * 비교 조건
 *   [욕설]  A~D는 개선 전 정확 일치·후보 추출을 이 파일에 고정해 재현한다.
 *     A. 정확 일치만 (구분자 허용 패턴)
 *     B. 정확 일치 + 유사도 0.82 (초기 임계값)
 *     C. 정확 일치 + 유사도 0.55, 자모 예외 없음 (8/18 상태)
 *     D. 정확 일치 + 유사도 0.55, 자모 예외 적용 (프로젝트 종료 시점)
 *     E. D + 허용어 제거 + 정확 일치 전 정규화 (현재 src 코드)
 *   [전화·계좌]
 *     L. 초기 정규식 (8/15 커밋 패턴)
 *     F. 최종 정규화 파이프라인 (collectPersonalInfoHits)
 */
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';

// 로컬 DB 없이 돌리기 위해 Prisma 의존 모듈을 스텁한다. (EVAL_STUB_DB=0 이면 비활성)
if (process.env.EVAL_STUB_DB !== '0') {
  const originalLoad = (Module as any)._load;
  (Module as any)._load = function (request: string, ...rest: unknown[]) {
    if (/repositories[\\/]banned-word\.repository$/.test(request)) {
      return {
        findActiveBannedWords: async () => [],
        searchSimilarBannedWords: async () => [],
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
require('dotenv/config');
const {
  DEFAULT_BANNED_WORDS,
  BANNED_WORD_SIMILARITY_TOP_K,
  BANNED_WORD_MAX_SIMILARITY_CANDIDATES,
} = require('../../src/constants/banned-words');
const {
  containsExactProfanity,
  collectSimilarityCandidates,
} = require('../../src/utils/content-filter/profanity-filter');
const {
  collectPersonalInfoHits,
} = require('../../src/utils/content-filter/personal-info-filter');
/* eslint-enable @typescript-eslint/no-require-imports */

type Label = 'profanity' | 'phone' | 'account' | 'clean';
interface Case {
  label: Label;
  group: string;
  text: string;
}

const defaultCasesPath = path.join(__dirname, 'content-filter-cases.json');
const casesArgIndex = process.argv.indexOf('--cases');
const casesArg = casesArgIndex >= 0 ? process.argv[casesArgIndex + 1] : undefined;
if (casesArgIndex >= 0 && !casesArg) {
  console.error('--cases 뒤에 테스트 세트 파일 경로를 지정하세요.');
  process.exit(1);
}
const casesPath = casesArg ? path.resolve(process.cwd(), casesArg) : defaultCasesPath;
const cases: Case[] = JSON.parse(fs.readFileSync(casesPath, 'utf8')).cases;
const resultFileName =
  casesPath === defaultCasesPath
    ? 'content-filter-eval-result.md'
    : `content-filter-eval-result.${path.basename(casesPath, path.extname(casesPath))}.md`;

const bannedWords = (DEFAULT_BANNED_WORDS as string[]).map((word, index) => ({
  id: index + 1,
  word,
  normalizedWord: word.toLowerCase().replace(/[\s._\-*@#$%^&()]+/g, ''),
}));

/* ---------------- 욕설: 개선 전 로직 고정 (A~D) ---------------- */

const LEGACY_SEPARATOR_CLASS = '[\\s._@#$%^&*()!~\\-]*';
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const legacyExactPatterns = [
  ...new Set(bannedWords.flatMap((w) => [w.word, w.normalizedWord]).filter(Boolean)),
].map((word) => new RegExp([...word].map(escapeRegExp).join(LEGACY_SEPARATOR_CLASS), 'i'));
/** 개선 전 containsExactProfanity: 원문에 구분자 허용 패턴만 적용 */
const legacyExact = (text: string): boolean => legacyExactPatterns.some((p) => p.test(text));

const LEGACY_TOKEN_PATTERN = /[가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9]{2,12}/g; // 8/20 이전 (자모 포함)
const legacyCandidates = (text: string): string[] =>
  [...new Set(text.match(LEGACY_TOKEN_PATTERN) ?? [])].slice(
    0,
    BANNED_WORD_MAX_SIMILARITY_CANDIDATES
  );

const PRE_ALLOWLIST_TOKEN_PATTERN = /[가-힣a-zA-Z0-9]{2,12}/g; // 8/20 ~ 종료 (자모 제외, 허용어 없음)
const preAllowlistCandidates = (text: string): string[] =>
  [...new Set(text.match(PRE_ALLOWLIST_TOKEN_PATTERN) ?? [])].slice(
    0,
    BANNED_WORD_MAX_SIMILARITY_CANDIDATES
  );

type CandidateMode = 'legacy' | 'preAllowlist' | 'current';
const candidatesOf = (text: string, mode: CandidateMode): string[] =>
  mode === 'legacy'
    ? legacyCandidates(text)
    : mode === 'preAllowlist'
      ? preAllowlistCandidates(text)
      : collectSimilarityCandidates(text);

/* ---------------- 욕설: 유사도 ---------------- */

const cachePath = path.join(__dirname, '.embedding-cache.json');
const cache: Record<string, number[]> = fs.existsSync(cachePath)
  ? JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  : {};

const embedMany = async (texts: string[]): Promise<Record<string, number[]>> => {
  const missing = [...new Set(texts)].filter((t) => !cache[t]);
  if (missing.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { embed } = require('../../src/utils/embeddings.util');
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100);
      const vectors: number[][] = await embed(batch);
      batch.forEach((t, j) => {
        cache[t] = vectors[j];
      });
    }
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  }
  return cache;
};

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

/** pgvector `1 - (embedding <=> q)` 와 같은 코사인 유사도로 top-K 중 최고 점수 */
const bestSimilarity = (
  tokens: string[],
  vectors: Record<string, number[]>
): { score: number; token: string; word: string } | null => {
  let best: { score: number; token: string; word: string } | null = null;
  for (const token of tokens) {
    const q = vectors[token];
    const ranked = bannedWords
      .map((w) => ({ word: w.word, score: cosine(q, vectors[w.word]) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, BANNED_WORD_SIMILARITY_TOP_K);
    const top = ranked[0];
    if (top && (!best || top.score > best.score)) {
      best = { score: top.score, token, word: top.word };
    }
  }
  return best;
};

/* ---------------- 전화·계좌: 초기 정규식 ---------------- */

const LEGACY_PHONE_PATTERNS: RegExp[] = [
  /01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g,
  /0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}/g,
  /\d{2,4}[-\s]\d{3,5}[-\s]\d{4}/g,
];
const LEGACY_ACCOUNT_CARD_PATTERNS: RegExp[] = [
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
  /\b\d{10,14}\b/g,
];
const legacyPersonalInfo = (text: string): boolean =>
  [...LEGACY_PHONE_PATTERNS, ...LEGACY_ACCOUNT_CARD_PATTERNS].some((p) => {
    p.lastIndex = 0;
    return p.test(text);
  });

const finalPersonalInfo = (text: string): boolean =>
  collectPersonalInfoHits({ text, maskPhone: true, maskAccount: true }).length > 0;

/* ---------------- 집계 ---------------- */

const pct = (n: number, d: number): string =>
  d === 0 ? '-' : `${((n / d) * 100).toFixed(1)}% (${n}/${d})`;

const main = async () => {
  const hasKey = Boolean(process.env.OPENAI_API_KEY);
  const profanity = cases.filter((c) => c.label === 'profanity');
  const cleanText = cases.filter(
    (c) => c.label === 'clean' && c.group !== '숫자 포함 정상'
  );
  const personal = cases.filter((c) => c.label === 'phone' || c.label === 'account');
  const cleanNumeric = cases.filter((c) => c.group === '숫자 포함 정상');

  /** 현재 src 코드: 허용어 제거 + 정규화 */
  const currentExact = (t: string) => containsExactProfanity(t, bannedWords);

  let vectors: Record<string, number[]> = {};
  if (hasKey) {
    // 문장별 상세 표는 전화·계좌 문장에도 유사도 조건을 적용하므로 전체 문장의 토큰을 임베딩한다.
    const tokens = cases.flatMap((c) => [
      ...candidatesOf(c.text, 'legacy'),
      ...candidatesOf(c.text, 'preAllowlist'),
      ...candidatesOf(c.text, 'current'),
    ]);
    vectors = await embedMany([...bannedWords.map((w) => w.word), ...tokens]);
  }

  const simHit = (t: string, threshold: number, mode: CandidateMode): boolean => {
    if (!hasKey) return false;
    const best = bestSimilarity(candidatesOf(t, mode), vectors);
    return Boolean(best && best.score >= threshold);
  };

  const conditions: Array<{ key: string; name: string; fn: (t: string) => boolean; needsKey: boolean }> = [
    { key: 'A', name: '정확 일치만', fn: legacyExact, needsKey: false },
    { key: 'B', name: '정확 일치 + 유사도 0.82', fn: (t) => legacyExact(t) || simHit(t, 0.82, 'preAllowlist'), needsKey: true },
    { key: 'C', name: '정확 일치 + 유사도 0.55 (자모 예외 없음)', fn: (t) => legacyExact(t) || simHit(t, 0.55, 'legacy'), needsKey: true },
    { key: 'D', name: '정확 일치 + 유사도 0.55 (자모 예외, 종료 시점)', fn: (t) => legacyExact(t) || simHit(t, 0.55, 'preAllowlist'), needsKey: true },
    { key: 'E', name: 'D + 허용어 + 정규화 (개선 후)', fn: (t) => currentExact(t) || simHit(t, 0.55, 'current'), needsKey: true },
  ];

  const lines: string[] = [];
  lines.push(`# 채팅 콘텐츠 필터 평가 결과`);
  lines.push('');
  lines.push(`- 테스트 세트: ${path.relative(process.cwd(), casesPath)}`);
  lines.push(`- 테스트 문장: 총 ${cases.length}개 (욕설 ${profanity.length} / 정상 대화 ${cleanText.length} / 전화·계좌 ${personal.length} / 숫자 포함 정상 ${cleanNumeric.length})`);
  lines.push(`- 금칙어 목록: ${bannedWords.length}개 (DEFAULT_BANNED_WORDS)`);
  lines.push(`- 임베딩 유사도 평가: ${hasKey ? '실행' : '건너뜀 (OPENAI_API_KEY 없음)'}`);
  lines.push('');
  lines.push(`## 1. 욕설 필터`);
  lines.push('');
  lines.push(`| 조건 | 욕설 탐지율 | 정상 대화 오탐률 | 자모 일상 표현 오탐 | 숫자 포함 정상 문장 욕설 오탐 |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  const jamo = cleanText.filter((c) => c.group === '자모 일상 표현');
  for (const cond of conditions) {
    if (cond.needsKey && !hasKey) continue;
    const tp = profanity.filter((c) => cond.fn(c.text)).length;
    const fp = cleanText.filter((c) => cond.fn(c.text)).length;
    const fpJamo = jamo.filter((c) => cond.fn(c.text)).length;
    const fpNumeric = cleanNumeric.filter((c) => cond.fn(c.text)).length;
    lines.push(`| ${cond.key}. ${cond.name} | ${pct(tp, profanity.length)} | ${pct(fp, cleanText.length)} | ${fpJamo}/${jamo.length}건 | ${fpNumeric}/${cleanNumeric.length}건 |`);
  }
  if (hasKey) {
    const d = conditions.find((c) => c.key === 'D')!;
    const e = conditions.find((c) => c.key === 'E')!;
    const changed = [...profanity, ...cleanText, ...cleanNumeric].filter(
      (c) => d.fn(c.text) !== e.fn(c.text)
    );
    lines.push('');
    lines.push(`### D → E 판정이 바뀐 문장 (${changed.length}개)`);
    lines.push('');
    lines.push(`| 정답 | 유형 | 문장 | D | E | 결과 |`);
    lines.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const c of changed) {
      const eHit = e.fn(c.text);
      const good = (c.label === 'profanity') === eHit;
      lines.push(`| ${c.label} | ${c.group} | ${c.text} | ${d.fn(c.text) ? '●' : '·'} | ${eHit ? '●' : '·'} | ${good ? '개선' : '악화'} |`);
    }
  }
  lines.push('');
  lines.push(`### 유형별 욕설 탐지 (조건별)`);
  lines.push('');
  const groups = [...new Set(profanity.map((c) => c.group))];
  lines.push(`| 유형 | ${conditions.filter((c) => !c.needsKey || hasKey).map((c) => c.key).join(' | ')} |`);
  lines.push(`| --- | ${conditions.filter((c) => !c.needsKey || hasKey).map(() => '---').join(' | ')} |`);
  for (const g of groups) {
    const items = profanity.filter((c) => c.group === g);
    lines.push(`| ${g} | ${conditions.filter((c) => !c.needsKey || hasKey).map((cond) => `${items.filter((c) => cond.fn(c.text)).length}/${items.length}`).join(' | ')} |`);
  }
  lines.push('');
  lines.push(`## 2. 전화번호·계좌번호 필터`);
  lines.push('');
  lines.push(`| 조건 | 탐지율 | 숫자 포함 정상 문장 오탐 |`);
  lines.push(`| --- | --- | --- |`);
  for (const [name, fn] of [
    ['L. 초기 정규식 (8/15)', legacyPersonalInfo],
    ['F. 최종 정규화 파이프라인', finalPersonalInfo],
  ] as const) {
    const tp = personal.filter((c) => fn(c.text)).length;
    const fp = cleanNumeric.filter((c) => fn(c.text)).length;
    lines.push(`| ${name} | ${pct(tp, personal.length)} | ${fp}/${cleanNumeric.length}건 |`);
  }
  lines.push('');
  lines.push(`### 유형별 탐지`);
  lines.push('');
  lines.push(`| 유형 | 초기 정규식 | 최종 |`);
  lines.push(`| --- | --- | --- |`);
  for (const g of [...new Set(personal.map((c) => `${c.label}|${c.group}`))]) {
    const [label, group] = g.split('|');
    const items = personal.filter((c) => c.label === label && c.group === group);
    lines.push(`| ${label === 'phone' ? '전화' : '계좌'} · ${group} | ${items.filter((c) => legacyPersonalInfo(c.text)).length}/${items.length} | ${items.filter((c) => finalPersonalInfo(c.text)).length}/${items.length} |`);
  }
  lines.push('');
  lines.push(`## 3. 문장별 상세`);
  lines.push('');
  const headerConds = conditions.filter((c) => !c.needsKey || hasKey);
  lines.push(`| 정답 | 유형 | 문장 | ${headerConds.map((c) => c.key).join(' | ')} | L | F |`);
  lines.push(`| --- | --- | --- | ${headerConds.map(() => '---').join(' | ')} | --- | --- |`);
  const mark = (v: boolean) => (v ? '●' : '·');
  for (const c of cases) {
    lines.push(`| ${c.label} | ${c.group} | ${c.text} | ${headerConds.map((cond) => mark(cond.fn(c.text))).join(' | ')} | ${mark(legacyPersonalInfo(c.text))} | ${mark(finalPersonalInfo(c.text))} |`);
  }
  if (hasKey) {
    lines.push('');
    lines.push(`## 4. 유사도 점수 (후보 토큰 기준 최고값)`);
    lines.push('');
    lines.push(`| 정답 | 문장 | D 최고 유사도 | D 토큰 → 금칙어 | E 최고 유사도 (허용어 제거) | 자모 포함 시 최고값 |`);
    lines.push(`| --- | --- | --- | --- | --- | --- |`);
    const fmt = (b: ReturnType<typeof bestSimilarity>) => (b ? `${b.score.toFixed(3)} (${b.token})` : '-');
    for (const c of [...profanity, ...cleanText, ...cleanNumeric]) {
      const b = bestSimilarity(candidatesOf(c.text, 'preAllowlist'), vectors);
      const cur = bestSimilarity(candidatesOf(c.text, 'current'), vectors);
      const l = bestSimilarity(candidatesOf(c.text, 'legacy'), vectors);
      lines.push(`| ${c.label} | ${c.text} | ${b ? b.score.toFixed(3) : '-'} | ${b ? `${b.token} → ${b.word}` : '-'} | ${fmt(cur)} | ${fmt(l)} |`);
    }
  }

  const out = lines.join('\n');
  const outPath = path.join(__dirname, resultFileName);
  fs.writeFileSync(outPath, out);
  console.log(out.split('## 3.')[0]);
  console.log(`\n전체 결과: ${outPath}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
