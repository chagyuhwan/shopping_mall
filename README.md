# KCSHOP - Premium Mall

## 실행 방법

### 1. 패키지 설치
```bash
npm install
```

### 2. (선택) 환경변수 설정
```bash
cp .env.example .env
# .env 파일에서 SMTP, SESSION_SECRET, FOOTER_* 등 수정
```

### 3. 서버 실행
```bash
npm start
```

### 4. 접속
- 메인: http://localhost:3000
- 로그인: http://localhost:3000/login
- 회원가입: http://localhost:3000/register
- 회원정보: http://localhost:3000/mypage
- 장바구니: http://localhost:3000/cart
- **관리자**: http://localhost:3000/admin (admin / admin123)
- 비밀번호 찾기: http://localhost:3000/forgot-password

## 기능

- **회원가입/로그인**: 세션 기반 인증
- **비밀번호 재설정**: 이메일로 재설정 링크 발송 (SMTP 설정 시)
- **장바구니**: 로그인 후 상품 담기, 재고 검증
- **관리자 패널**: 상품 CRUD, 회원 목록 조회
- **회원정보 수정/탈퇴**: 마이페이지에서 수정 및 탈퇴
- **상품 DB**: SQLite products 테이블 (JSON에서 자동 마이그레이션)
- **이미지 업로드**: 관리자 상품 등록 시 업로드 API
- **에러 처리**: 전역 에러 핸들러, 404 페이지
- **로깅**: Winston (logs/ 폴더)
- **SEO**: 메타 태그, sitemap.xml, robots.txt

## 기술 스택

- Frontend: HTML, CSS, JavaScript
- Backend: Node.js, Express
- Database: SQLite (better-sqlite3)
- 인증: express-session, bcryptjs
- 이메일: nodemailer
- 로깅: winston
- 보안: helmet, express-rate-limit, connect-sqlite3 (세션)

## 배포

### 프로덕션 체크리스트
1. `.env` 생성 후 `SESSION_SECRET` 반드시 변경
2. `ADMIN_INITIAL_PASSWORD` 설정 (최초 관리자 비밀번호)
3. `FOOTER_*` 변수로 푸터 연락처/주소 등 실제 정보 입력
4. `BASE_URL`을 실제 도메인으로 설정
5. `NODE_ENV=production` 설정

### PM2로 실행
```bash
npm run pm2:start
```

### Nginx 리버스 프록시
`nginx.conf.example`을 참고하여 설정 후 HTTPS(Let's Encrypt) 적용

### DB 백업
```bash
npm run backup
# 또는 cron: 0 2 * * * /path/to/kcshop/scripts/backup-db.sh
```
