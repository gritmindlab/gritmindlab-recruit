# 그릿마인드랩 고졸채용 캘린더 — 완전 무료 버전 (Firebase 없음)

## 왜 바꿨나
회사 구글 워크스페이스 조직 정책 때문에 Firebase 배포가 막혀서(서비스 계정 키 생성 금지,
외부 계정 초대 금지), Firebase Functions 없이 **GitHub Actions + GitHub Pages**만으로
가는 구조로 바꿨어요. 신용카드 등록도 필요 없어요.

## 구조
1. `scripts/fetch-recruit.js` — 공공데이터포털 API를 호출해서 결과를 `data/recruit.json`에 저장
2. `.github/workflows/fetch-recruit.yml` — 이 스크립트를 30분마다 자동 실행 + 결과를 자동으로 git commit/push
3. 캘린더 페이지(프론트엔드)는 `data/recruit.json`을 fetch로 읽어서 화면에 표시 (별도 안내 예정)

## 처음 설정 (한 번만 하면 됨)

**1. 이 폴더를 GitHub 저장소로 만들기 (이미 하시던 방식대로)**
```
git init
git add .
git commit -m "init"
git remote add origin <본인 저장소 주소>
git push -u origin main
```

**2. GitHub 저장소에 인증키 등록 (터미널 필요 없음, 웹에서 클릭만)**
1. GitHub 저장소 페이지 → **Settings** 탭
2. 왼쪽 메뉴 **Secrets and variables → Actions**
3. **New repository secret** 클릭
4. Name: `DATAGO_SERVICE_KEY`
5. Value: 공공데이터포털에서 받은 인증키 붙여넣기
6. **Add secret**

**3. GitHub Actions 켜기**
- 저장소 **Actions** 탭 클릭 → 워크플로 활성화 (버튼 있으면 클릭)
- 오른쪽에 "채용정보 자동 수집" 워크플로 보이면 **Run workflow** 버튼으로 수동 실행 한 번 해보기

**4. 결과 확인**
- 실행 끝나면 저장소에 `data/recruit.json` 파일이 생겨요
- Actions 탭 → 방금 실행 클릭 → 로그에서 `sample raw item` 부분을 보면
  실제 응답 필드명을 확인할 수 있어요 (이거 저한테 공유해주시면 필드 매핑 최종 확정)

## 참고: 코드 정의서 반영 (MOEF_NKOD_DB_05_v1.2)
- **고졸전형**: 학력정보(R7000)의 고졸=R7030을 `/list` 요청 파라미터(`acbgCondLst`)에 넣어서
  API가 서버단에서 이미 걸러줌
- **직군 분류**: NCS분류(R6000) 대분류를 `NCS_TO_JOB_TRACK`으로 우리 라벨(전기/기계/토목/생산/시설)에 매핑

## 앞으로 할 일
1. `sample raw item` 로그 보고 `normalizeItem()` 필드명 최종 확정
2. 캘린더 HTML이 목업 데이터 대신 `data/recruit.json`을 fetch하도록 연결
3. GitHub Pages로 캘린더 페이지 공개 (이미 하시던 방식 그대로)
