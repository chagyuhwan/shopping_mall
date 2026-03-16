require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const nodemailer = require('nodemailer');
const winston = require('winston');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const SQLiteStore = require('connect-sqlite3')(session);

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Trust proxy (프록시/리버스 프록시 뒤에서 HTTPS 판단)
if (isProduction) app.set('trust proxy', 1);

// ===== 로거 =====
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.simple() }),
    ...(process.env.NODE_ENV === 'production' ? [
      new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
      new winston.transports.File({ filename: 'logs/combined.log' })
    ] : [])
  ]
});
if (!fs.existsSync(path.join(__dirname, 'logs'))) fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });

// data 폴더 생성
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// DB 초기화
const db = new Database(path.join(dataDir, 'users.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try { db.exec('ALTER TABLE users ADD COLUMN role TEXT DEFAULT "user"'); } catch (e) {}
try { db.exec('ALTER TABLE products ADD COLUMN updated_at DATETIME'); } catch (e) {}
try { db.exec('ALTER TABLE products ADD COLUMN hidden INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE products ADD COLUMN detail_desc TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE products ADD COLUMN category TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN username TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN address TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN marketing_agree INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN zipcode TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN address_detail TEXT'); } catch (e) {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL'); } catch (e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS cart (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 1,
    size TEXT,
    color TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    original_price INTEGER,
    image TEXT,
    desc TEXT,
    tags TEXT,
    section TEXT,
    stock INTEGER DEFAULT 0,
    detail_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS password_reset (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// 관리자 계정: 개발 시 admin/admin123, 프로덕션은 env 기반
const adminEmail = process.env.ADMIN_EMAIL || 'admin';
const adminInitPassword = process.env.ADMIN_INITIAL_PASSWORD;
const adminUser = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
if (!adminUser) {
  if (isProduction && !adminInitPassword) {
    logger.warn('프로덕션: ADMIN_INITIAL_PASSWORD를 설정하고 관리자 계정을 수동 생성하세요.');
  } else {
    const pw = adminInitPassword || 'admin123';
    const hashed = bcrypt.hashSync(pw, 10);
    db.prepare('INSERT INTO users (email, password, name, role) VALUES (?, ?, ?, ?)').run(adminEmail, hashed, '관리자', 'admin');
    logger.info(`관리자 계정 생성: ${adminEmail} / ${isProduction ? '(env 비밀번호)' : pw}`);
  }
} else {
  db.prepare('UPDATE users SET role = ? WHERE email = ?').run('admin', adminEmail);
}

// detail_json 파싱 (실패 시 빈 객체)
function parseDetailJson(detailJson) {
  if (!detailJson) return {};
  try {
    const parsed = typeof detailJson === 'string' ? JSON.parse(detailJson) : detailJson;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

// 상품 조회 헬퍼
function getProducts() {
  return db.prepare('SELECT * FROM products ORDER BY id').all().map(p => {
    const parsed = parseDetailJson(p.detail_json);
    return {
      id: p.id,
      name: p.name,
      price: p.price,
      originalPrice: p.original_price,
      image: p.image,
      desc: p.desc,
      tags: p.tags,
      section: p.section,
      category: p.category || '',
      stock: p.stock ?? 0,
      hidden: p.hidden ? 1 : 0,
      created_at: p.created_at,
      updated_at: p.updated_at,
      ...parsed,
      detailDesc: parsed.detailDesc || p.detail_desc || undefined
    };
  });
}

function getProductById(id) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!p) return null;
  const parsed = parseDetailJson(p.detail_json);
  return {
    id: p.id,
    name: p.name,
    price: p.price,
    originalPrice: p.original_price,
    image: p.image,
    desc: p.desc,
    tags: p.tags,
    section: p.section,
    category: p.category || '',
    stock: p.stock ?? 0,
    hidden: p.hidden ? 1 : 0,
    created_at: p.created_at,
    updated_at: p.updated_at,
    ...parsed,
    detailDesc: parsed.detailDesc || p.detail_desc || undefined
  };
}

// ===== 보안: SESSION_SECRET 검사 (프로덕션) =====
const sessionSecret = process.env.SESSION_SECRET || 'kcshop-secret-key-2025';
if (isProduction && sessionSecret === 'kcshop-secret-key-2025') {
  logger.warn('경고: SESSION_SECRET을 .env에서 반드시 변경하세요!');
}

// ===== 미들웨어 =====
app.use(helmet({ contentSecurityPolicy: false })); // CSP는 정적 HTML에 맞게 비활성화
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting: 로그인/회원가입/비밀번호 재설정
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }
});
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/password-reset-request', authLimiter);

// 일반 API rate limit
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100
});
app.use('/api/', apiLimiter);

// HTTPS 리다이렉트 (프로덕션 + FORCE_HTTPS=true)
if (isProduction && process.env.FORCE_HTTPS === 'true') {
  app.use((req, res, next) => {
    if (req.secure) return next();
    res.redirect(301, 'https://' + req.headers.host + req.url);
  });
}

const sessionConfig = {
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
};
if (isProduction) {
  sessionConfig.store = new SQLiteStore({
    db: 'sessions.db',
    dir: dataDir
  });
}
app.use(session(sessionConfig));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// 관리자 체크 미들웨어
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '관리자 권한이 필요합니다.' });
  }
  next();
}

// ===== API: 회원가입 =====
app.post('/api/register', (req, res) => {
  try {
    const { username, password, name, zipcode, address, addressDetail, phone, email, agreeTerms, agreePrivacy, agreeMarketing } = req.body;
    if (!username || !password || !name || !email) {
      return res.status(400).json({ success: false, message: '아이디, 비밀번호, 이름, 이메일은 필수입니다.' });
    }
    if (!agreeTerms || !agreePrivacy) {
      return res.status(400).json({ success: false, message: '필수 동의 항목에 모두 동의해주세요.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: '비밀번호는 6자 이상이어야 합니다.' });
    }
    const hashedPassword = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (email, password, name, phone, username, zipcode, address, address_detail, marketing_agree) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      email, hashedPassword, name, phone || null, username, zipcode || null, address || null, addressDetail || null, agreeMarketing ? 1 : 0
    );
    logger.info('회원가입:', username);
    res.json({ success: true, message: '회원가입이 완료되었습니다.' });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ success: false, message: '이미 사용 중인 아이디 또는 이메일입니다.' });
    }
    logger.error(err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== API: 로그인 =====
app.post('/api/login', (req, res) => {
  try {
    const { email, password } = req.body;
    const loginId = (email || '').trim();
    if (!loginId || !password) {
      return res.status(400).json({ success: false, message: '아이디, 비밀번호를 입력해주세요.' });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(loginId, loginId);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    let role = user.role || 'user';
    if (email === adminEmail && role !== 'admin') {
      db.prepare('UPDATE users SET role = ? WHERE email = ?').run('admin', email);
      role = 'admin';
    }
    req.session.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role
    };
    logger.info('로그인:', user.email);
    res.json({ success: true, message: '로그인되었습니다.', user: req.session.user });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true, message: '로그아웃되었습니다.' });
});

// ===== API: 상품 =====
app.get('/api/products', (req, res) => {
  try {
    let products = getProducts().filter(p => !p.hidden);
    const category = (req.query.category || '').trim();
    const group = (req.query.group || '').trim().toLowerCase();
    if (category) {
      products = products.filter(p => (p.category || '') === category);
    }
    if (group === 'best') {
      products = products.filter(p => (p.section || '').toLowerCase() === 'best' || p.badgeBest);
    }
    res.json(products);
  } catch (err) {
    logger.error(err);
    res.status(500).json({ error: '상품 조회 실패' });
  }
});

app.get('/api/products/search', (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const all = getProducts().filter(p => !p.hidden);
    const filtered = q ? all.filter(p =>
      (p.name && p.name.toLowerCase().includes(q)) ||
      (p.desc && p.desc.toLowerCase().includes(q))
    ) : all;
    res.json(filtered);
  } catch (err) {
    logger.error(err);
    res.status(500).json({ error: '검색 실패' });
  }
});

app.get('/api/products/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const product = getProductById(id);
  if (!product || product.hidden) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
  res.json(product);
});

// ===== API: 관리자 - 상품 CRUD =====
app.get('/api/admin/products', requireAdmin, (req, res) => {
  try {
    res.json(getProducts());
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false });
  }
});

app.get('/api/admin/products/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const product = getProductById(id);
    if (!product) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
    res.json(product);
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false });
  }
});

app.post('/api/admin/products', requireAdmin, (req, res) => {
  try {
    const { name, price, originalPrice, image, desc, tags, section, category, stock, detail_json, detailDesc: bodyDetailDesc } = req.body;
    if (!name || price == null) {
      return res.status(400).json({ success: false, message: '상품명과 가격은 필수입니다.' });
    }
    let detailObj = {};
    try {
      detailObj = typeof detail_json === 'object' ? detail_json : (detail_json ? JSON.parse(detail_json) : {});
    } catch (e) {}
    const detailDesc = (detailObj && typeof detailObj.detailDesc === 'string' ? detailObj.detailDesc : '') || (typeof bodyDetailDesc === 'string' ? bodyDetailDesc : '');
    if (detailDesc) detailObj = { ...(detailObj || {}), detailDesc };
    const detailStr = JSON.stringify(detailObj);
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO products (name, price, original_price, image, desc, tags, section, category, stock, detail_json, detail_desc, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(name, price || 0, originalPrice || null, image || '', desc || '', tags || '', section || '', category || '', stock ?? 0, detailStr || null, detailDesc || null, now, now);
    const id = db.prepare('SELECT last_insert_rowid() as id').get().id;
    logger.info('상품 등록:', name);
    res.json({ success: true, id });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false });
  }
});

app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, price, originalPrice, image, desc, tags, section, category, stock, hidden, detail_json, detailDesc: bodyDetailDesc } = req.body;
    const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ success: false });
    let detailObj = {};
    try {
      detailObj = typeof detail_json === 'object' ? detail_json : (detail_json ? JSON.parse(detail_json) : {});
    } catch (e) {}
    const detailDesc = (detailObj && typeof detailObj.detailDesc === 'string' ? detailObj.detailDesc : '') || (typeof bodyDetailDesc === 'string' ? bodyDetailDesc : '');
    if (detailDesc) detailObj = { ...(detailObj || {}), detailDesc };
    const detailStr = JSON.stringify(detailObj);
    db.prepare(`
      UPDATE products SET name=?, price=?, original_price=?, image=?, desc=?, tags=?, section=?, category=?, stock=?, hidden=?, detail_json=?, detail_desc=?, updated_at=?
      WHERE id=?
    `).run(name || '', price ?? 0, originalPrice || null, image || '', desc || '', tags || '', section || '', category || '', stock ?? 0, hidden ? 1 : 0, detailStr || null, detailDesc || null, new Date().toISOString(), id);
    logger.info('상품 수정:', id);
    res.json({ success: true });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false });
  }
});

app.patch('/api/admin/products/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { hidden } = req.body;
    const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ success: false });
    db.prepare('UPDATE products SET hidden=?, updated_at=? WHERE id=?').run(hidden ? 1 : 0, new Date().toISOString(), id);
    res.json({ success: true });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false });
  }
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    logger.info('상품 삭제:', id);
    res.json({ success: true });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false });
  }
});

// ===== API: 관리자 - 대시보드 통계 =====
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    const productCount = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const cartCount = db.prepare('SELECT COUNT(*) as c FROM cart').get().c;
    const recentUsers = db.prepare('SELECT id, email, name, created_at FROM users ORDER BY id DESC LIMIT 5').all();
    const recentProducts = db.prepare('SELECT id, name, price, created_at FROM products ORDER BY id DESC LIMIT 5').all();
    // 매출 그래프용 (주문 미구현 시 장바구니 금액 기반, 추후 orders 테이블 연동)
    let cartRows = [];
    try {
      cartRows = db.prepare('SELECT c.quantity, p.price FROM cart c JOIN products p ON c.product_id = p.id').all();
    } catch (e) {}
    const totalCartValue = cartRows.reduce((s, r) => s + (r.quantity || 0) * (r.price || 0), 0);
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const base = totalCartValue || 50000;
      last7Days.push({
        date: d.toISOString().slice(0, 10),
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        sales: Math.round(base * (0.5 + (7 - i) / 14) + Math.random() * base * 0.2)
      });
    }
    res.json({
      success: true,
      stats: { productCount, userCount, cartCount },
      recentUsers,
      recentProducts,
      salesChart: last7Days
    });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false });
  }
});

// ===== API: 관리자 - 회원 목록 =====
app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, email, username, name, phone, zipcode, address, address_detail, role, created_at FROM users ORDER BY id DESC').all();
    const pick = (o, ...keys) => { for (const k of keys) { const v = o?.[k]; if (v != null && v !== '') return v; } return null; };
    const users = rows.map(u => ({
      id: u.id,
      email: u.email,
      username: u.username,
      name: u.name,
      phone: u.phone,
      zipcode: pick(u, 'zipcode', 'ZIPCODE'),
      address: pick(u, 'address', 'ADDRESS'),
      address_detail: pick(u, 'address_detail', 'ADDRESS_DETAIL'),
      addressDetail: pick(u, 'address_detail', 'addressDetail', 'ADDRESS_DETAIL'),
      role: u.role,
      created_at: u.created_at
    }));
    res.json({ success: true, users });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false });
  }
});

// ===== API: 관리자 - 회원 수정 =====
app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, message: '회원 ID가 필요합니다.' });
  const body = req.body || {};
  const name = (body.name || '').trim();
  const phone = (body.phone || '').trim() || null;
  const zipcode = (body.zipcode || '').trim() || null;
  const address = (body.address || '').trim() || null;
  const addressDetail = (body.addressDetail || '').trim() || null;
  const role = (body.role || 'user').trim().toLowerCase();
  if (!name) return res.status(400).json({ success: false, message: '이름은 필수입니다.' });
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ success: false, message: '역할은 user 또는 admin만 가능합니다.' });
  try {
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ success: false, message: '회원을 찾을 수 없습니다.' });
    db.prepare('UPDATE users SET name = ?, phone = ?, zipcode = ?, address = ?, address_detail = ?, role = ? WHERE id = ?').run(
      name, phone, zipcode, address, addressDetail, role, id
    );
    const updated = db.prepare('SELECT id, email, username, name, phone, zipcode, address, address_detail, role, created_at FROM users WHERE id = ?').get(id);
    res.json({ success: true, message: '수정되었습니다.', user: updated });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false, message: err.message || '수정 중 오류가 발생했습니다.' });
  }
});

// ===== API: 현재 사용자 =====
app.get('/api/me', (req, res) => {
  if (req.session.user) {
    const u = db.prepare('SELECT id, email, username, name, phone, zipcode, address, address_detail, role FROM users WHERE id = ?').get(req.session.user.id);
    if (u) res.json({ success: true, user: { ...u, role: u.role || 'user' } });
    else res.json({ success: false, user: null });
  } else {
    res.json({ success: false, user: null });
  }
});

app.put('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  const body = req.body || {};
  const name = (body.name || '').trim() || req.session.user.name;
  const phone = (body.phone || '').trim() || null;
  const zipcode = (body.zipcode || '').trim() || null;
  const address = (body.address || '').trim() || null;
  const addressDetail = (body.addressDetail || '').trim() || null;
  try {
    db.prepare('UPDATE users SET name = ?, phone = ?, zipcode = ?, address = ?, address_detail = ? WHERE id = ?').run(
      name, phone, zipcode, address, addressDetail, req.session.user.id
    );
    req.session.user.name = name;
    const updated = db.prepare('SELECT id, email, username, name, phone, zipcode, address, address_detail, role FROM users WHERE id = ?').get(req.session.user.id);
    res.json({ success: true, message: '수정되었습니다.', user: updated ? { ...updated, role: updated.role || 'user' } : req.session.user });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false, message: err.message || '수정 중 오류가 발생했습니다.' });
  }
});

app.delete('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false });
  try {
    db.prepare('DELETE FROM cart WHERE user_id = ?').run(req.session.user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.session.user.id);
    req.session.destroy();
    res.json({ success: true, message: '탈퇴되었습니다.' });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false });
  }
});

// ===== API: 장바구니 =====
app.get('/api/cart', (req, res) => {
  if (!req.session.user) return res.json({ success: false, items: [], count: 0 });
  const items = db.prepare('SELECT * FROM cart WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  const enriched = items.map(item => {
    const p = getProductById(item.product_id);
    return {
      id: item.id,
      product_id: item.product_id,
      quantity: item.quantity,
      size: item.size,
      color: item.color,
      name: p ? p.name : '상품',
      price: p ? p.price : 0,
      image: p ? p.image : ''
    };
  });
  res.json({ success: true, items: enriched, count: enriched.reduce((s, i) => s + i.quantity, 0) });
});

app.post('/api/cart', (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  const { product_id, quantity = 1, size, color } = req.body;
  if (!product_id) return res.status(400).json({ success: false, message: '상품 정보가 없습니다.' });
  const product = getProductById(parseInt(product_id, 10));
  if (!product) return res.status(404).json({ success: false, message: '상품을 찾을 수 없습니다.' });
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  if (product.stock != null && product.stock < qty) {
    return res.status(400).json({ success: false, message: '재고가 부족합니다.' });
  }
  try {
    db.prepare('INSERT INTO cart (user_id, product_id, quantity, size, color) VALUES (?, ?, ?, ?, ?)').run(
      req.session.user.id, parseInt(product_id, 10), qty, size || null, color || null
    );
    const rows = db.prepare('SELECT quantity FROM cart WHERE user_id = ?').all(req.session.user.id);
    res.json({ success: true, message: '장바구니에 담았습니다.', count: rows.reduce((s, r) => s + r.quantity, 0) });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false, message: '장바구니 담기 실패.' });
  }
});

app.delete('/api/cart/:id', (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false });
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM cart WHERE id = ? AND user_id = ?').get(id, req.session.user.id);
  if (!row) return res.status(404).json({ success: false });
  db.prepare('DELETE FROM cart WHERE id = ?').run(id);
  res.json({ success: true, message: '삭제되었습니다.' });
});

app.get('/api/cart/count', (req, res) => {
  if (!req.session.user) return res.json({ count: 0 });
  const rows = db.prepare('SELECT quantity FROM cart WHERE user_id = ?').all(req.session.user.id);
  res.json({ count: rows.reduce((s, r) => s + r.quantity, 0) });
});

// ===== API: 비밀번호 재설정 =====
const crypto = require('crypto');
app.post('/api/password-reset-request', (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: '이메일을 입력해주세요.' });
    const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
    if (!user) return res.json({ success: true, message: '등록된 이메일이 있으면 재설정 링크를 발송합니다.' });
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    db.prepare('DELETE FROM password_reset WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO password_reset (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expires.toISOString());
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const link = `${baseUrl}/reset-password.html?token=${token}`;
    if (process.env.SMTP_USER) {
      transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: user.email,
        subject: '[KCSHOP] 비밀번호 재설정',
        html: `비밀번호 재설정 링크: <a href="${link}">${link}</a> (1시간 유효)`
      }).catch(e => logger.warn('이메일 발송 실패:', e.message));
    }
    res.json({ success: true, message: '등록된 이메일이 있으면 재설정 링크를 발송합니다.' });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false });
  }
});

app.post('/api/password-reset', (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password || password.length < 6) {
      return res.status(400).json({ success: false, message: '토큰과 새 비밀번호(6자 이상)를 입력해주세요.' });
    }
    const row = db.prepare('SELECT * FROM password_reset WHERE token = ? AND expires_at > datetime("now")').get(token);
    if (!row) return res.status(400).json({ success: false, message: '만료되었거나 유효하지 않은 링크입니다.' });
    const hashed = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, row.user_id);
    db.prepare('DELETE FROM password_reset WHERE token = ?').run(token);
    res.json({ success: true, message: '비밀번호가 변경되었습니다.' });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ success: false });
  }
});

// ===== 이미지 업로드 =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + (file.originalname || 'image').replace(/[^a-zA-Z0-9.-]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/admin/upload', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: '파일이 없습니다.' });
  const url = '/uploads/' + path.basename(req.file.filename);
  res.json({ success: true, url });
});

// ===== 푸터 플레이스홀더 (env 변수) =====
const siteConfig = {
  tel: process.env.FOOTER_TEL || '0000000',
  hours: process.env.FOOTER_HOURS || '평일 pm 13:00 - pm 19:00',
  account: process.env.FOOTER_ACCOUNT || '국민 : 00000-00-00000',
  address: process.env.FOOTER_ADDRESS || '서울시 강서구 마곡동',
  owner: process.env.FOOTER_OWNER || '차규환',
  ownerTel: process.env.FOOTER_OWNER_TEL || '010-0000-0000',
  returnAddress: process.env.FOOTER_RETURN_ADDRESS || '부산광역시 금정구 청량예진로 6 / 2층 KCSHOP',
  sns: process.env.FOOTER_SNS || 'Instagram @kcshop'
};

function servePage(filename, res) {
  try {
    let html = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    html = html.replace(/\{\{SITE_TEL\}\}/g, siteConfig.tel);
    html = html.replace(/\{\{SITE_HOURS\}\}/g, siteConfig.hours);
    html = html.replace(/\{\{SITE_ACCOUNT\}\}/g, siteConfig.account);
    html = html.replace(/\{\{SITE_ADDRESS\}\}/g, siteConfig.address);
    html = html.replace(/\{\{SITE_OWNER\}\}/g, siteConfig.owner);
    html = html.replace(/\{\{SITE_OWNER_TEL\}\}/g, siteConfig.ownerTel);
    html = html.replace(/\{\{SITE_RETURN_ADDRESS\}\}/g, siteConfig.returnAddress);
    html = html.replace(/\{\{SITE_SNS\}\}/g, siteConfig.sns);
    res.send(html);
  } catch (e) {
    res.status(500).send('페이지를 불러올 수 없습니다.');
  }
}

// ===== 페이지 라우트 =====
app.get('/', (req, res) => servePage('index.html', res));
app.get('/login', (req, res) => servePage('login.html', res));
app.get('/register', (req, res) => servePage('register.html', res));
app.get('/mypage', (req, res) => servePage('mypage.html', res));
app.get('/cart', (req, res) => servePage('cart.html', res));
app.get('/admin', (req, res) => servePage('admin.html', res));
app.get('/admin/', (req, res) => servePage('admin.html', res));
app.get('/admin.html', (req, res) => servePage('admin.html', res));
app.get('/reset-password', (req, res) => servePage('reset-password.html', res));
app.get('/forgot-password', (req, res) => servePage('forgot-password.html', res));
app.get('/product.html', (req, res) => servePage('product.html', res));
app.get('/shop', (req, res) => servePage('shop.html', res));
app.get('/shop.html', (req, res) => servePage('shop.html', res));
app.get('/404.html', (req, res) => servePage('404.html', res));

app.use(express.static(path.join(__dirname)));

// sitemap.xml (동적 생성)
app.get('/sitemap.xml', (req, res) => {
  const base = process.env.BASE_URL || 'http://localhost:3000';
  const products = getProducts();
  const urls = [
    { loc: base + '/', changefreq: 'daily', priority: '1.0' },
    { loc: base + '/login', changefreq: 'monthly', priority: '0.5' },
    { loc: base + '/register', changefreq: 'monthly', priority: '0.5' },
    ...products.map(p => ({ loc: base + '/product.html?id=' + p.id, changefreq: 'weekly', priority: '0.8' }))
  ];
  const xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    urls.map(u => `<url><loc>${u.loc}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('') +
    '</urlset>';
  res.type('xml').send(xml);
});

// 404 핸들러
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not Found' });
  }
  res.status(404);
  servePage('404.html', res);
});

// 전역 에러 핸들러
app.use((err, req, res, next) => {
  logger.error(err);
  res.status(500).json({ success: false, message: process.env.NODE_ENV === 'production' ? '서버 오류' : err.message });
});

app.listen(PORT, () => {
  logger.info(`KCSHOP 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
