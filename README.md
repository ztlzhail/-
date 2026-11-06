# 🥊 FIGHT PICK — 격투 승부 예측

## Vercel 배포
1. vercel.com 에 GitHub 로 로그인 → **Add New → Project** → 이 저장소 Import → **Deploy**
2. 만들어진 프로젝트 → **Storage** 탭 → **Create Database** → **Upstash (Redis)** → 무료 플랜 → 프로젝트에 **Connect**
3. **Deployments** 탭 → 최신 배포 `⋯` → **Redeploy**

Redis 를 연결하면 `KV_REST_API_URL`, `KV_REST_API_TOKEN` 환경변수가 자동으로 들어가고, 투표·가입·경기 정보가 거기에 저장됩니다.
관리자 비밀번호를 바꾸려면 Settings → Environment Variables 에 `ADMIN_PASSWORD` 를 추가하고 다시 배포하세요.

- 메인: `https://<프로젝트>.vercel.app`
- 운영자: `/admin`
- 타이머 전광판(프로젝터용): `/?display`

## 로컬 실행 (Redis 없이)
```bash
node server.js          # http://localhost:3000, 데이터는 data/kv.json
```

## 규칙
- 가입: 닉네임 + 숫자 4자리 PIN → 100 응원 포인트 (현금 구매·환전·양도 없음, 활동 점수)
- 경기마다 1인 1표, 변경 불가
- 언더독: 실제 투표에서 지지율이 낮은 선수에게 표시, 투표 전에는 '집계 전'
- 결과 등록 시 적중 +20P, 언더독 적중이면 +30P 추가 (결과 취소 시 회수)
- 1라운드 시작 버튼을 누르면 투표가 자동 마감
- 사진은 브라우저에서 자동으로 줄여서 업로드. 영상은 3MB 이하 파일 또는 유튜브 링크
