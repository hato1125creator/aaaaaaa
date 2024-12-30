const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mysql = require('mysql2');
const path = require('path');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken'); // jwtのインポート
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3006;

// Middleware configuration
app.use('/guest', express.static(path.join(__dirname, 'server/public/guest')));
app.use(express.static(path.join(__dirname, 'server/public')));
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// MySQL connection setup
const connection = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'reservation_system'
});

// Validate environment variables
if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.error("Please set EMAIL_USER and EMAIL_PASSWORD in your environment variables.");
    process.exit(1);
}

connection.connect(err => {
    if (err) {
        handleError('MySQL connection error:', err);
        return;
    }
    console.log('Connected to MySQL as ID:', connection.threadId);
});

// Nodemailer configuration
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

// Common error handling function
function handleError(message, res, err, status = 500) {
    console.error(`[${new Date().toISOString()}] ${message}`, err.message || err);
    return res.status(status).json({ message });
}

// QR code generation function
async function generateQRCode(qrData, reservationId) {
    const filePath = path.join(__dirname, `qrcode_${reservationId}.png`);
    await QRCode.toFile(filePath, qrData);
    return filePath;
}

// ユーザーの配列（簡易データベース）
let users = [
    { id: 1, username: 'admin', password: 'haya1125' } // 例: 管理者ユーザー
];

// 予約の配列
let reservations = []; // 予約データ
let inviteCodes = []; // 招待コードデータ

// JWTトークンの秘密鍵
const JWT_SECRET = 'your_jwt_secret';

// ログインエンドポイント
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password); // ユーザーの確認
    
    if (user) {
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET); // JWTトークンの生成
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, message: '無効な資格情報' }); // 認証失敗
    }
});

// Invite code validation endpoint
app.post('/api/validate-invite-code', [
    body('inviteCode').isString().withMessage('Invite code must be a string')
], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return handleError('Validation failed', res, errors.array(), 400);
    }

    const { inviteCode } = req.body;
    const sql = 'SELECT * FROM invite_codes WHERE code = ? AND used = 0';

    connection.query(sql, [inviteCode], (err, results) => {
        if (err) {
            return handleError('Invite code validation error', res, err);
        }
        res.json({ valid: results.length > 0 });
    });
});

// Reservation endpoint
app.post('/api/reserve', [
    body('name').isString().notEmpty().withMessage('Name is required'),
    body('contact').isEmail().withMessage('Valid email is required'),
    body('relationship').isString().withMessage('Relationship is required'),
    body('invite-code').isString().withMessage('Invite code is required'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return handleError('Validation failed', res, errors.array(), 400);
    }

    const { name, contact, relationship, 'invite-code': inviteCode } = req.body;

    connection.query('SELECT * FROM invite_codes WHERE code = ? AND used = 0', [inviteCode], async (err, results) => {
        if (err) {
            return handleError('Error checking invite code', res, err);
        }

        if (results.length === 0) {
            return handleError('Invalid or already used invite code', res, null, 400);
        }

        const sql = 'INSERT INTO reservations (name, contact, relationship, invite_code) VALUES (?, ?, ?, ?)';
        connection.query(sql, [name, contact, relationship, inviteCode], async (err, result) => {
            if (err) {
                return handleError('Error inserting reservation', res, err);
            }

            const qrData = `http://localhost:${port}/guest/verify?id=${result.insertId}`;
            try {
                const qrCodePath = await generateQRCode(qrData, result.insertId);
                const mailOptions = {
                    from: process.env.EMAIL_USER,
                    to: contact,
                    subject: '2025梨花祭予約完了のお知らせ',
                    text: `※このメールはシステムからの自動返信です。

お世話になっております。
千葉英和高校生徒会です。

この度は、2025梨花祭にお申し込みいただきありがとうございます。
以下の内容で参加受付を完了しております。
—————————————————
開催日時：2025年6月◯日（土）9時00分～14時00分
開催場所：千葉英和高等学校
住所：〒276-0028 千葉県八千代市村上709-1
地図：
—————————————————
▼ご質問・お問い合わせ等はこちらから
千葉英和生徒会：example.email
梨花祭特設ページ：example.jp

    以下に添付されているQRコードを当日受付に出せるようにしてください。⇓　⇓　⇓`,
                    attachments: [{ filename: `qrcode_${result.insertId}.png`, path: qrCodePath }]
                };

                await transporter.sendMail(mailOptions);
                
                // Update the invite code to mark it as used
                connection.query('UPDATE invite_codes SET used = 1 WHERE code = ?', [inviteCode], (err) => {
                    if (err) handleError('Error updating invite code', res, err);
                });

                res.json({ message: 'Reservation completed' });
            } catch (err) {
                return handleError('QR code generation failed', res, err);
            }
        });
    });
});

// Update status endpoint
app.post('/api/update-status', [
    body('id').notEmpty().withMessage('ID is required'),
    body('status').isString().withMessage('Status is required'),
], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return handleError('Validation failed', res, errors.array(), 400);
    }

    const { id, status } = req.body;

    const sql = 'UPDATE reservations SET status = ? WHERE id = ?';
    connection.query(sql, [status, id], (err, result) => {
        if (err) {
            return handleError('Status update error', res, err);
        }

        res.json({ message: 'Status updated' });
    });
});

// Route settings
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'server/public/guest/index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'server/public/admin/index.html'));
});

app.get('/guest/verify', (req, res) => {
    const id = req.query.id;
    if (id) {
        res.send(`Guest ID: ${id}`);
    } else {
        res.status(400).send('Invalid request');
    }
});

// Get reservation data endpoint
app.get('/api/reservations', (req, res) => {
    const sql = 'SELECT * FROM reservations';
    connection.query(sql, (err, results) => {
        if (err) {
            return handleError('Error retrieving reservations', res, err);
        }
        res.json(results);
    });
});

// Update reservation data endpoint
app.post('/api/reservations/:id', [
    body('status').isString().withMessage('Status is required'),
], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return handleError('Validation failed', res, errors.array(), 400);
    }

    const { status } = req.body;
    const { id } = req.params;

    const sql = 'UPDATE reservations SET status = ? WHERE id = ?';
    connection.query(sql, [status, id], (err, results) => {
        if (err) {
            return handleError('Error updating reservation', res, err);
        }
        res.json({ message: 'Reservation updated' });
    });
});

// Delete reservation data endpoint
app.delete('/api/reservations/:id', (req, res) => {
    const { id } = req.params;

    const sql = 'DELETE FROM reservations WHERE id = ?';
    connection.query(sql, [id], (err, results) => {
        if (err) {
            return handleError('Error deleting reservation', res, err);
        }
        res.json({ message: 'Reservation deleted' });
    });
});

// Search endpoint
app.get('/api/search', (req, res) => {
    const searchQuery = req.query.q;
    const sql = 'SELECT * FROM reservations WHERE name LIKE ? OR contact LIKE ?';
    const query = `%${searchQuery}%`;

    connection.query(sql, [query, query], (err, results) => {
        if (err) {
            return handleError('Search query error', res, err);
        }
        res.json(results);
    });
});

app.get('/api/search', (req, res) => {
    const { q, status, date_from, date_to } = req.query;
    let sql = 'SELECT * FROM reservations WHERE';
    let conditions = [];
    const query = `%${q}%`;

    if (q) {
        conditions.push('(name LIKE ? OR contact LIKE ?)');
    }
    if (status) {
        conditions.push('status = ?');
    }
    if (date_from && date_to) {
        conditions.push('created_at BETWEEN ? AND ?');
    }

    sql += conditions.join(' AND ');
    const params = [query, query, status, date_from, date_to].filter(param => param !== undefined);

    connection.query(sql, params, (err, results) => {
        if (err) {
            return handleError('Search query error', res, err);
        }
        res.json(results);
    });
});

app.get('/api/report', (req, res) => {
    const sql = `
        SELECT 
            COUNT(*) AS total_reservations, 
            SUM(CASE WHEN status = 'checked-in' THEN 1 ELSE 0 END) AS checked_in_count,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count
        FROM reservations;
    `;
    
    connection.query(sql, (err, results) => {
        if (err) {
            return handleError('Report query error', res, err);
        }
        res.json(results[0]);
    });
});


// Verify QR code endpoint
app.post('/api/verify', (req, res) => {
    const { qrData } = req.body;
    const reservationId = parseQRCodeData(qrData);

    if (!reservationId) {
        return handleError('Invalid QR code', res, null, 400);
    }

    const updateSql = 'UPDATE reservations SET status = ? WHERE id = ?';
    connection.query(updateSql, ['checked-in', reservationId], (err, result) => {
        if (err) {
            return handleError('Check-in approval error', res, err);
        }

        if (result.affectedRows > 0) {
            const detailsSql = 'SELECT * FROM reservations WHERE id = ?';
            connection.query(detailsSql, [reservationId], (err, rows) => {
                if (err) {
                    return handleError('Error retrieving reservation details', res, err);
                }

                if (rows.length > 0) {
                    return res.json({ message: 'Check-in approved', reservation: rows[0] });
                } else {
                    return handleError('Reservation not found', res, null, 404);
                }
            });
        } else {
            return handleError('Reservation ID not found', res, null, 404);
        }
    });
});

// Parse QR code data function
function parseQRCodeData(qrData) {
    try {
        const urlParams = new URLSearchParams(new URL(qrData).search);
        return urlParams.get('id');
    } catch (e) {
        handleError('Error parsing QR code data', null, e);
        return null;
    }
}

// 招待コード生成API
app.post('/api/generate-invite-codes', [
    body('count').isInt({ gt: 0 }).withMessage('Count must be a positive integer'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return handleError('Validation failed', res, errors.array(), 400);
    }

    const { count } = req.body;
    const codes = [];
    const existingCodes = new Set(); // 重複チェック用

    // 重複なしで招待コードを生成
    while (codes.length < count) {
        const code = Math.random().toString(36).substr(2, 8);
        if (!existingCodes.has(code)) {
            existingCodes.add(code);
            codes.push(code);
        }
    }

    // データベースに保存
    try {
        for (const code of codes) {
            await new Promise((resolve, reject) => {
                connection.query('INSERT INTO invite_codes (code, used) VALUES (?, ?)', [code, 0], (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });
        }
        res.json({ count: codes.length, codes });
    } catch (err) {
        return handleError('Error saving invite codes', res, err);
    }
});

// Start server
app.listen(port, () => {
    console.log(`Server started on http://localhost:${port}/`);
});