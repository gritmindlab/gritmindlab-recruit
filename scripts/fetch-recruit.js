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

// 학력정보(R7000)의 고졸 코드
const HS_EDU_CODE = 'R7030';

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
    isHighSchoolTrack: eduNames.includes('고졸'),
    replImprYn: item.replmprYn || 'N',
    daysLeft: item.decimalDay ?? null,                // API가 계산해주는 마감까지 남은 일수
    srcUrl: item.srcUrl || null,
    aplyQlfcCn: item.aplyQlfcCn || '',                // 지원자격 원문 (참고용, 전공 등 파싱 가능)
  };
}

async function main() {
  const res = await axios.get(LIST_URL, {
    params: {
      serviceKey: SERVICE_KEY,
      resultType: 'json',
      numOfRows: 100,
      pageNo: 1,
      ongoingYn: 'Y',
      acbgCondLst: HS_EDU_CODE,
    },
  });

  const rawItems = extractItems(res.data);
  console.log(`[fetch-recruit] fetched ${rawItems.length} items`);

  const items = rawItems.map(normalizeItem).filter(it => it.sn);

  const output = {
    updatedAt: new Date().toISOString(),
    count: items.length,
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
