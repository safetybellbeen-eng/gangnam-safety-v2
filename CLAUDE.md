# 강남구 사업장 안전지도 V2 — CLAUDE.md

## 프로젝트 성격
개발 중인 프로토타입 V2. 코드 리포지토리는 V1과 별도(V1은 참고 전용, 수정 금지).
Supabase 프로젝트는 V1과 동일(motorrad-pulse)하며, V2는 `gnmap_v2_*` 테이블만 사용한다.

## Supabase 프로젝트 공유 (중요)
Supabase 무료 티어는 조직당 활성 프로젝트 2개로 제한되며 이미 2개를 사용 중이므로,
V2는 새 Supabase 프로젝트를 만들지 않고 **기존 V1 프로젝트(motorrad-pulse)를 공유**한다.
V1 테이블(schema/RLS/RPC)은 절대 읽지도, 수정하지도, 삭제하지도, 정책을 변경하지도 않는다.
V2는 같은 프로젝트 안에서 `gnmap_v2_*` namespace로 완전히 분리하여 운영한다.

**V2 실제 테이블명 (STEP 2에서 생성 완료, 확정):**
- gnmap_v2_profiles
- gnmap_v2_sites
- gnmap_v2_favorites
- gnmap_v2_site_notes
- gnmap_v2_upload_history
- gnmap_v2_supervisions

앞으로의 모든 V2 작업(SQL/RLS/RPC/코드)은:
- 위 `gnmap_v2_*` 테이블만 대상으로 한다.
- 기존 V1의 `gnmap_*`(접두사 없는) 테이블은 읽기/쓰기/수정/삭제/정책변경 일체 금지.
- 테이블명을 임의로 `gnmap_*`(V1 이름)로 되돌리거나 새로 짓지 않는다. 위 6개 확정 이름을 그대로 사용한다.

## LOW TOKEN MODE (항상 적용)
- 요청 파일만 읽는다. 전체 repo 재탐색 금지.
- 거대 GeoJSON은 경계 수정 요청이 아니면 읽지 않는다.
- 요청 없는 리팩터링/UI변경/기능추가 금지.
- 정보 부족 시 추측 금지, 질문은 최대 3개.
- 한 번에 하나의 STEP만 수행. 다음 STEP은 사용자가 명시적으로 지시할 때만.
- diff 중심, 미수정 파일 전체 출력 금지.

## 기술 스택
HTML/CSS/Vanilla JS(ES Modules), Kakao Maps SDK, Supabase(Auth/RLS/RPC/Edge Functions), GitHub Pages, PWA.
React/Vue/Next 도입 금지.

## 디렉터리 구조
```
gangnam-safety-v2/
  index.html, manifest.json, sw.js
  assets/icons/, assets/data/gangnam-boundary.geojson
  css/ base.css layout.css components.css map.css mobile.css
  js/ app.js config.js state.js api.js auth.js map.js sites.js
      filters.js favorites.js notes.js admin.js upload.js
      supervision.js ui.js
  supabase/ schema.sql policies.sql functions.sql seed.sql migrations/
  CLAUDE.md
```

## 사업장 ID 원칙
- `gnmap_v2_sites.id`는 불변 PK. gnmap_v2_favorites/gnmap_v2_site_notes는 이 id를 FK로 참조. supervision과 sites의 관계는 STEP 14까지 미확정.
- 식별키 후보: 사업개시번호 단독 / 산재관리번호+사업개시번호 / 기타 공식번호 조합. **실제 데이터로 고유성·결측률 검증 전까지 확정 금지.**
- 공식 번호는 전부 TEXT (앞자리 0 손실 방지).
- UPDATE 과정에서 매칭에 사용한 식별자 컬럼이 의도치 않게 NULL로 바뀌거나 변경되지 않도록 검증한다.
- UPDATE 적용 전후로 stable identifier 값이 그대로 보존되는지 확인하는 테스트를 마련한다.
- NULL인 식별자로는 기존 행과 임의로 매칭하지 않는다.
- 매칭 결과가 불확실한 경우(여러 행 매칭, 형식 불일치 등) 조용히 진행하지 말고 validation 오류로 처리한다.

## Excel Import 원칙
- DELETE ALL → INSERT ALL 금지.
- 흐름: parsing → 식별번호 추출 → validation → geocoding → RPC(단일 트랜잭션).
- 기존 매칭 시 UPDATE(id 유지), 신규는 INSERT, 사라진 사업장은 `is_active=false` (하드 DELETE 금지 — gnmap_v2_sites FK는 RESTRICT로 보호하며, 누락 사업장은 is_active=false 처리).
- RPC 내부 오류 시 전체 rollback.

## Kakao API 보안
- REST Key를 프론트 JS에 절대 하드코딩하지 않는다.
- 주소 검색/지오코딩: Browser → Supabase Edge Function → Kakao REST API.
- REST Key는 Supabase secret으로만 관리.
- STEP 4는 Kakao Maps JS SDK(지도 표시·마커·오버레이 등)만 사용한다. REST 지오코딩 기능은 STEP 11(geocoding Edge Function) 전까지 구현하지 않는다.

## 인증/보안
- 고정 가입코드를 프론트에 하드코딩 금지. 흐름: 회원가입 → pending → 관리자 승인 → 접근.
- RLS 필수. 일반 사용자는 본인 favorites/notes만 CRUD.
- 관리자 작업은 반드시 DB(RLS 또는 SECURITY DEFINER 함수 내 auth.uid() 검증)에서도 확인 — UI 숨김만으로 보안 구현 금지.
- SECURITY DEFINER 함수: search_path 고정, 스키마 명시, 권한 최소화, 관리자 검증 필수.
- service_role/secret key 프론트 포함 금지.

## UI/UX
1차 단계는 기능 완성 우선. 대규모 리디자인 금지. V1 UI 참고해 기능 재현. 모바일 최적화는 STEP 15에서.

## PWA
Service Worker 캐시 버전 전략으로 구버전 JS/CSS 잔존 방지. Offline 불가 기능(Map/Supabase)을 오해시키지 않는다.

## Excel 원본 데이터
STEP 10 이전에는 Excel 파일을 읽거나 분석하지 않는다.
STEP 10에서는 V1 작업 시 이미 검증된 실제 원본 Excel 파일을 그대로 재사용한다 (신규 파일 요청 금지).

## STEP 순서
1 골격/CLAUDE.md 2 Supabase schema 3 RLS/Auth/승인 4 Kakao Map 기본
5 조회/marker/list/detail 6 검색/filter/sort 7 favorites/notes
8 현재위치/길찾기 9 관리자 사용자관리 10 Excel parser+식별번호
11 geocoding Edge Function 12 transactional import RPC
13 업로드 검증/이력 14 supervision 이식 15 모바일 UX
16 PWA/cache 17 보안점검 18 regression test 19 배포/최종검증

## 진행 규칙
- 한 번에 한 STEP. 사용자가 "STEP N 시작"이라고 명시할 때만 진행.
- 이전 STEP 완료 여부 확인 후 다음 STEP.
