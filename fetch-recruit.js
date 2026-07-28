/**
 * 그릿마인드랩 · 공공기관 고졸채용 캘린더 — 데이터 수집 스크립트 (Firebase 없는 버전)
 *
 * GitHub Actions가 이 스크립트를 주기적으로 실행해서
 * 공공데이터포털 API 결과를 data/recruit.json 파일로 저장 → 자동 커밋.
 * 프론트엔드(캘린더 페이지)는 이 JSON 파일을 fetch로 읽기만 하면 됨.
 *
 * 실행: node scripts/fetch-recruit.js
 * 필요 환경변수: DATAGO_SERVICE_KEY (GitHub Actions Secret으로 등록)
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

// NCS분류(R6000) 대분류 → 우리 직군 라벨
const NCS_TO_JOB_TRACK = {
  '전기.전자': '전기',
  '기계': '기계',
  '건설': '토목',
  '재료': '토목',
  '식품가공': '생산',
  '섬유.의복': '생산',
  '화학': '생산',
  '환경.에너지.안전': '시설',
  '경비.청소': '시설',
};
function mapNcsToJobTrack(ncsNameList) {
  if (!ncsNameList) return '기타';
  const names = Array.isArray(ncsNameList) ? ncsNameList : [ncsNameList];
  for (const n of names) {
    if (NCS_TO_JOB_TRACK[n]) return NCS_TO_JOB_TRACK[n];
  }
  return '기타';
}

// TODO: 실제 응답 JSON에서 공고 배열 경로 확인 후 교체
function extractItems(rawData) {
  return rawData?.response?.body?.items?.item || [];
}

function normalizeItem(item) {
  const ncsNameList = item.ncsCdNmLst || item.ncsNmLst || null;
  const eduNameList = item.acbgCondNmLst || null;

  return {
    sn: item.sn || null,
    orgName: item.pblntInstNm || item.instNm || '',
    orgCode: item.pblntInstCd || null,
    title: item.recrutPbancTtl || '',
    startDate: item.pbancBgngYmd || null,
    endDate: item.pbancEndYmd || null,
    hireTypeNmLst: item.hireTypeNmLst || [],
    recrutSeNmLst: item.recrutSeNmLst || [],
    workRgnNmLst: item.workRgnNmLst || [],
    ncsNmLst: ncsNameList || [],
    jobTrack: mapNcsToJobTrack(ncsNameList),
    eduCondNmLst: eduNameList || [],
    isHighSchoolTrack: Array.isArray(eduNameList) && eduNameList.includes('고졸'),
    replImprYn: item.replImprYn || 'N',
  };
}

async function main() {
  const res = await axios.get(LIST_URL, {
    params: {
      serviceKey: SERVICE_KEY,
      resultType: 'json',
      numOfRows: 100,
      pageNo: 1,
      ongoingYn: 'Y',           // 진행중인 공고만
      acbgCondLst: HS_EDU_CODE, // 고졸(R7030)만 서버단 필터링
    },
  });

  const rawItems = extractItems(res.data);
  console.log(`[fetch-recruit] fetched ${rawItems.length} items`);
  if (rawItems.length > 0) {
    console.log('[fetch-recruit] sample raw item:', JSON.stringify(rawItems[0], null, 2));
  }

  const items = rawItems.map(normalizeItem).filter(it => it.sn);

  const output = {
    updatedAt: new Date().toISOString(),
    count: items.length,
    items,
  };

  const outPath = path.join(__dirname, '..', 'data', 'recruit.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`[fetch-recruit] wrote ${items.length} items to ${outPath}`);
}

main().catch(err => {
  console.error('[fetch-recruit] failed:', err.response?.data || err.message);
  process.exit(1);
});
