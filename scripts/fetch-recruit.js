/**
 * 그릿마인드랩 · 공공기관 고졸채용 캘린더 — 데이터 수집 스크립트
 *
 * GitHub Actions가 이 스크립트를 주기적으로 실행해서
 * 공공데이터포털 API 결과를 data/recruit.json 파일로 저장 → 자동 커밋.
 *
 * 실행: node scripts/fetch-recruit.js
 * 필요 환경변수: DATAGO_SERVICE_KEY (GitHub Actions Secret으로 등록)
 *
 * ⚠️ 중요: 이 API는 "총 채용인원"만 줄 뿐, 학력조건별(고졸/대졸 등) 세부 인원을
 * 나눠서 주지 않아요. acbgCondNmLst("고졸,대졸(4년)" 같은 문자열)는
 * "이 채용에 어떤 학력 조건이 허용되는지"만 알려주고, recrutNope(모집인원)는
 * 그 채용 전체 인원 하나뿐이에요. 즉 "고졸 15명 / 전체 80명" 같은 세부 분리는
 * 이 API만으로는 불가능하고, 공고 원문(srcUrl)을 봐야 확인할 수 있어요.
 *
 * ⚠️ 추가 주의: acbgCondNmLst가 공고 전체를 대표하는 값 "하나"만 주기 때문에,
 * 한 공고 안에 여러 채용 트랙(예: 일반 6급 / 보훈전형 / 장애인전형 / 고졸전형 7급)이
 * 섞여있는 경우 실제로는 고졸전형이 있는데도 acbgCondNmLst가 "학력무관"만 찍혀서
 * 고졸 채용 목록에서 누락되는 경우가 있음(예: 근로복지공단 '26년 2차 신규직원 공고,
 * sn 303549 - 지원자격 원문엔 "행정직 일반 7급(고졸전형)"이 명시돼 있었으나
 * acbgCondNmLst엔 "학력무관"만 표기됨).
 * → 이를 보정하기 위해 aplyQlfcCn(지원자격 원문) 텍스트에서
 *    "고졸전형" 등의 키워드를 추가로 검사해서 isHighSchoolTrack을 보정함.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SERVICE_KEY = process.env.DATAGO_SERVICE_KEY;
if (!SERVICE_KEY) {
  console.error('DATAGO_SERVICE_KEY 환경변수가 없습니다.');
  process.exit(1);
}

const BASE_URL = 'https://apis.data.go.kr/1051000/recruitment';
const LIST_URL = `${BASE_URL}/list`;

// 네트워크 요청 관련 설정
// - 공공데이터포털 API가 간헐적으로 연결 지연/타임아웃을 일으키는 경우가 있어
//   짧은 timeout + 재시도(retry)로 자체 복구하도록 함
const REQUEST_TIMEOUT_MS = 15000; // 요청당 15초 제한 (기존엔 무제한 → 실패 시 2분 이상 걸림)
const MAX_RETRIES = 3;             // 최대 3회까지 재시도
const RETRY_DELAYS_MS = [1000, 3000, 5000]; // 재시도 간격 (점점 늘림)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 재시도 가능한 에러인지 판단 (네트워크/타임아웃/5xx 서버 오류)
function isRetryableError(err) {
  if (!err.response) {
    // 응답 자체를 못 받음 → 타임아웃, ETIMEDOUT, ECONNRESET, ECONNREFUSED 등
    return true;
  }
  const status = err.response.status;
  return status >= 500 && status < 600; // 서버 쪽 일시 오류
}

// axios.get을 timeout + 재시도 로직으로 감싼 래퍼
async function getWithRetry(url, config) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await axios.get(url, { ...config, timeout: REQUEST_TIMEOUT_MS });
    } catch (err) {
      lastErr = err;
      const reason = err.response
        ? `HTTP ${err.response.status}`
        : (err.code || err.message);

      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
        console.warn(`[fetch-recruit] 요청 실패 (${reason}), ${delay}ms 후 재시도 (${attempt + 1}/${MAX_RETRIES})...`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// 학력정보(R7000)의 고졸 코드
const HS_EDU_CODE = 'R7030';

// 제외할 고용유형 키워드 — 기간제/단기계약직/임시직 등은 캘린더에서 뺌
// hireTypeNmLst(고용유형) 뿐 아니라 공고 제목(title)에도 이 키워드가 있으면 제외
// → API의 고용유형 필드가 비어있거나 부정확해도, 제목에 "기간제" 등이 명시된 경우를 잡아내기 위함
// (필요시 이 배열만 수정하면 제외 기준을 바꿀 수 있음)
const EXCLUDE_HIRE_TYPE_KEYWORDS = ['기간제', '계약직', '단기', '임시직', '촉탁'];

// 채용형 인턴은 서류상 고용유형이 "계약직/기간제"로 분류돼 있어도
// 정규직 전환을 전제로 한 채용이므로 제외 대상에서 예외 처리함
const KEEP_EVEN_IF_MATCHED_KEYWORDS = ['채용형인턴', '채용형 인턴', '채용형인턴제'];

function isExcludedHireType(hireTypeNmStr, titleStr) {
  const combinedText = `${hireTypeNmStr || ''} ${titleStr || ''}`;
  if (!combinedText.trim()) return false;

  const isKeepException = KEEP_EVEN_IF_MATCHED_KEYWORDS.some(keyword => combinedText.includes(keyword));
  if (isKeepException) return false;

  return EXCLUDE_HIRE_TYPE_KEYWORDS.some(keyword => combinedText.includes(keyword));
}

// acbgCondNmLst(학력조건 필드)가 공고 전체를 대표하는 값 "하나"만 주다 보니,
// 여러 채용 트랙이 섞인 공고(예: 일반전형/보훈전형/고졸전형이 한 공고에 같이 있는 경우)에서
// 실제로는 고졸전형이 존재하는데도 "학력무관"만 찍혀서 누락되는 경우가 있음.
// → 지원자격 원문(aplyQlfcCn)에서 "고졸전형" 류 표현을 추가로 탐지해 보정.
const HS_TRACK_KEYWORDS_IN_TEXT = [
  '고졸전형',
  '고졸부문',
  '고졸수준',
  '고졸 제한경쟁',
  '고졸제한경쟁',
];

function detectHighSchoolTrackFromText(aplyQlfcCn) {
  if (!aplyQlfcCn) return false;
  return HS_TRACK_KEYWORDS_IN_TEXT.some(keyword => aplyQlfcCn.includes(keyword));
}

// NCS분류(R6000) 대분류 25개 전체 → 우리 직군 라벨로 매핑
// (코드정의서 MOEF_NKOD_DB_05_v1.2 기준 NCS 대분류 전체 목록 반영)
const NCS_TO_JOB_TRACK = {
  '전기.전자': '전기',
  '기계': '기계',
  '건설': '토목',
  '재료': '토목',
  '식품가공': '생산',
  '섬유.의복': '생산',
  '화학': '생산',
  '인쇄.목재.가구.공예': '생산',
  '환경.에너지.안전': '시설',
  '경비.청소': '시설',
  '운전.운송': '시설',
  '정보통신': 'IT',
  '사업관리': '사무',
  '경영.회계.사무': '사무',
  '금융.보험': '사무',
  '법률.경찰.소방.교도.국방': '사무',
  '문화.예술.디자인.방송': '사무',
  '영업판매': '사무',
  '보건.의료': '보건복지',
  '사회복지.종교': '보건복지',
  '이용.숙박.여행.오락.스포츠': '서비스',
  '음식서비스': '서비스',
  '농림어업': '농림',
  '연구': '연구',
  '교육.자연.사회과학': '연구',
};
function mapNcsToJobTrack(ncsNameStr) {
  if (!ncsNameStr) return '기타';
  const names = ncsNameStr.split(',').map(s => s.trim());
  for (const n of names) {
    if (NCS_TO_JOB_TRACK[n]) return NCS_TO_JOB_TRACK[n];
  }
  return '기타';
}

// YYYYMMDD -> YYYY-MM-DD
function toIsoDate(ymd) {
  if (!ymd || ymd.length !== 8) return null;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

// 실제 응답 구조: { resultCode, resultMsg, totalCount, result: [ ...items ] }
function extractItems(rawData) {
  return rawData?.result || [];
}

function normalizeItem(item) {
  const eduNames = (item.acbgCondNmLst || '').split(',').map(s => s.trim()).filter(Boolean);

  // acbgCondNmLst에 "고졸"이 명시된 경우뿐 아니라, 지원자격 원문에
  // "고졸전형" 등의 트랙이 언급된 경우도 고졸 지원 가능으로 판단
  // (혼합 트랙 공고에서 acbgCondNmLst가 "학력무관"으로만 대표되는 경우 보정)
  const hasHsEduCond = eduNames.includes('고졸');
  const hasHsTrackInText = detectHighSchoolTrackFromText(item.aplyQlfcCn);

  return {
    sn: item.recrutPblntSn || null,              // 채용공시 일련번호 (detail 조회 시 sn 파라미터로 사용)
    orgName: item.instNm || '',
    orgCode: item.pblntInstCd || null,
    title: item.recrutPbancTtl || '',
    startDate: toIsoDate(item.pbancBgngYmd),
    endDate: toIsoDate(item.pbancEndYmd),
    hireTypeNm: item.hireTypeNmLst || '',          // 고용유형 (예: "정규직")
    recrutSeNm: item.recrutSeNm || '',              // 채용구분 (예: "신입")
    workRgnNm: item.workRgnNmLst || '',             // 근무지역 (콤마 구분 문자열)
    ncsNm: item.ncsCdNmLst || '',                   // NCS분류명 (콤마 구분 문자열)
    jobTrack: mapNcsToJobTrack(item.ncsCdNmLst),    // 우리 직군 라벨로 변환
    totalCount: Number(item.recrutNope || 0),        // 모집인원 (전체, 학력별 분리 없음)
    eduCondNm: eduNames,                              // 허용 학력조건 목록 (예: ["고졸","대졸(4년)"])
    isHighSchoolTrack: hasHsEduCond || hasHsTrackInText,
    hsTrackDetectedFromText: !hasHsEduCond && hasHsTrackInText, // 원문 텍스트로만 감지된 경우 표시(검수용)
    replImprYn: item.replmprYn || 'N',
    daysLeft: item.decimalDay ?? null,                // API가 계산해주는 마감까지 남은 일수
    srcUrl: item.srcUrl || null,
    aplyQlfcCn: item.aplyQlfcCn || '',                // 지원자격 원문 (참고용, 전공 등 파싱 가능)
    isExcludedHireType: isExcludedHireType(item.hireTypeNmLst, item.recrutPbancTtl), // 기간제/단기계약직 등 제외 대상 여부 (채용형 인턴은 예외)
  };
}

async function fetchPagesForInstType(instType) {
  const all = [];
  let pageNo = 1;
  const numOfRows = 100;
  const MAX_PAGES = 15; // 안전장치: 최대 1500건까지만

  while (pageNo <= MAX_PAGES) {
    const res = await getWithRetry(LIST_URL, {
      params: {
        serviceKey: SERVICE_KEY,
        resultType: 'json',
        numOfRows,
        pageNo,
        ongoingYn: 'Y',
        instType, // 기관유형 - 공기업(시장형/준시장형)만 필터링
      },
    });
    const pageItems = extractItems(res.data);
    all.push(...pageItems);

    const totalCount = res.data?.totalCount ?? pageItems.length;
    console.log(`[fetch-recruit] instType=${instType} page ${pageNo}: ${pageItems.length}건 (누적 ${all.length}/${totalCount})`);

    if (all.length >= totalCount || pageItems.length === 0) break;
    pageNo++;
  }
  return all;
}

// 기관유형(A2000): 공기업(시장형 A2001, 준시장형 A2002) + 준정부기관(기금관리형 A2003, 위탁집행형 A2004)
// → 기타공공기관(A2005)만 제외하고 나머지 다 포함
// instType 파라미터는 한 번에 값 하나만 받는 것으로 보여서, 유형별로 나눠 호출 후 합침
async function fetchAllPages() {
  const instTypes = ['A2001', 'A2002', 'A2003', 'A2004'];
  const results = await Promise.all(instTypes.map(t => fetchPagesForInstType(t)));
  const merged = results.flat();
  const seen = new Set();
  return merged.filter(it => {
    const key = it.recrutPblntSn;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  const rawItems = await fetchAllPages();
  console.log(`[fetch-recruit] 전체 fetched ${rawItems.length} items`);

  const normalized = rawItems.map(normalizeItem).filter(it => it.sn);

  const excludedCount = normalized.filter(it => it.isExcludedHireType).length;
  const items = normalized.filter(it => !it.isExcludedHireType);
  console.log(`[fetch-recruit] 기간제/단기계약직 등 제외: ${excludedCount}건 (채용형 인턴은 유지)`);

  const hsCount = items.filter(it => it.isHighSchoolTrack).length;
  const hsFromTextCount = items.filter(it => it.hsTrackDetectedFromText).length;
  console.log(`[fetch-recruit] 그 중 고졸 지원 가능: ${hsCount}건 (지원자격 원문으로만 보정 감지된 건: ${hsFromTextCount}건)`);

  const output = {
    updatedAt: new Date().toISOString(),
    count: items.length,
    highSchoolCount: hsCount,
    items,
  };

  const outPath = path.join(__dirname, '..', 'data', 'recruit.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`[fetch-recruit] wrote ${items.length} items to ${outPath}`);
}

main().catch(err => {
  console.error('[fetch-recruit] failed:', err.response?.data || err.message);
  process.exit(1);
});
