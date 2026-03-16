# KCSHOP - Premium Mall

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. (Optional) Environment Variables
```bash
cp .env.example .env
# Edit .env: SMTP, SESSION_SECRET, FOOTER_*, etc.
```

### 3. Run the Server
```bash
npm start
```

### 4. Access
- Main: http://localhost:3000
- Login: http://localhost:3000/login
- Register: http://localhost:3000/register
- My Page: http://localhost:3000/mypage
- Cart: http://localhost:3000/cart
- **Admin**: http://localhost:3000/admin (admin / admin123)
- Forgot Password: http://localhost:3000/forgot-password

## Features

- **Authentication**: Session-based signup/login
- **Password Reset**: Email reset link (requires SMTP config)
- **Shopping Cart**: Add to cart (login required), stock validation
- **Admin Panel**: Product CRUD, member management
- **Profile Management**: Edit profile, withdraw membership
- **Product Database**: SQLite products table (auto-migration from JSON)
- **Image Upload**: Admin product registration via upload API
- **Error Handling**: Global error handler, 404 page
- **Logging**: Winston (logs/ folder)
- **SEO**: Meta tags, sitemap.xml, robots.txt

## Tech Stack

- Frontend: HTML, CSS, JavaScript
- Backend: Node.js, Express
- Database: SQLite (better-sqlite3)
- Auth: express-session, bcryptjs
- Email: nodemailer
- Logging: winston
- Security: helmet, express-rate-limit, connect-sqlite3 (sessions)

## Deployment

### Production Checklist
1. Create `.env` and change `SESSION_SECRET`
2. Set `ADMIN_INITIAL_PASSWORD` (initial admin password)
3. Configure `FOOTER_*` with real contact info and address
4. Set `BASE_URL` to your domain
5. Set `NODE_ENV=production`

### Run with PM2
```bash
npm run pm2:start
```

### Nginx Reverse Proxy
Use `nginx.conf.example` as reference, then enable HTTPS (Let's Encrypt)

### Database Backup
```bash
npm run backup
# Or cron: 0 2 * * * /path/to/kcshop/scripts/backup-db.sh
```
