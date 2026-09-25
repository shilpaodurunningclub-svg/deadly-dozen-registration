// ============================================================================
// Deadly Dozen – Category change requests
// ----------------------------------------------------------------------------
// Participant page : /categorychange.html
// Admin page       : /admin/category-changes.html  (same admin key as Coupons)
//
// How it works (amount-based codes, NOT percentage coupons)
//  1. Participant submits current category (+/- photo), new category, details
//     and a payment receipt.
//  2. We create CHANGE codes in the `change_codes` table, INACTIVE, single use:
//       - ENTRY code: a rupee amount towards the new category only
//           cheaper new category -> worth the full new entry (they pay 0)
//           dearer new category  -> worth what they paid (they pay the difference)
//       - CREDIT code (only when they paid more than the new entry): the excess,
//           usable on any category (future event or a friend's entry).
//     The photo package carries over: codes store photo_carried=true and the
//     pay page includes the photo free instead of charging Rs 1500 again.
//  3. On the pay page the participant can use a normal % coupon AND a
//     Change/Credit code: total = entry - % discount - code amount (+ photo).
//  4. Admin checks the receipt and clicks "Approve & activate" -> codes switch
//     on and the participant is emailed. "Reject" keeps them off.
//     A code is marked used when the registration that used it is paid.
// ============================================================================

const crypto = require('crypto');

const CATEGORIES = {
  Solo:  { id: 'solo',   price: 4719 },
  Pairs: { id: 'double', price: 5899 },
  Relay: { id: 'relay',  price: 8259 }
};
const PHOTO_PRICE = 1500;
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const RECEIPT_TYPES = /^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/;
const TEAM_EMAIL = process.env.DD_TEAM_EMAIL || 'india@deadlydozen.in';
const CREDIT_USE = 'a future Deadly Dozen event or a friend\u2019s entry';
const CREDIT_VALIDITY = '12 months';

// ---------- pricing ----------
function entryOf(name, photo) {
  const c = CATEGORIES[name];
  if (!c) return null;
  return { name, id: c.id, photo: !!photo, price: c.price, label: name + (photo ? ' + Photo' : ''), total: c.price + (photo ? PHOTO_PRICE : 0) };
}

// Amounts are GST-inclusive entry fees; the photo is not included because it carries over.
function plan(cur, nxt) {
  const diff = nxt.price - cur.price;
  return diff > 0
    ? { entryAmount: cur.price, payAtCheckout: diff, creditAmount: 0 }
    : { entryAmount: nxt.price, payAtCheckout: 0, creditAmount: -diff };
}

// Used by /api/register: is this Change/Credit code usable for this category?
async function checkChangeCode(db, code, categoryId) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return { ok: false, error: 'No code provided.' };
  const { rows } = await db.query('SELECT * FROM change_codes WHERE code = $1', [c]);
  const row = rows[0];
  if (!row) return { ok: false, error: 'Change/Credit code not found.' };
  if (!row.active) return { ok: false, error: 'This code is not active yet. We switch it on once your payment receipt is checked.' };
  if (row.used_registration_id) return { ok: false, error: 'This code has already been used.' };
  if (row.category !== 'all' && row.category !== categoryId) {
    const name = Object.keys(CATEGORIES).find(k => CATEGORIES[k].id === row.category) || row.category;
    return { ok: false, error: `This code can only be used for ${name}.` };
  }
  return { ok: true, row };
}

// Called whenever a registration becomes paid.
async function markChangeCodeUsed(pool, registrationId) {
  const { rows } = await pool.query('SELECT change_code FROM registrations WHERE id = $1', [registrationId]);
  const cc = rows[0] && rows[0].change_code;
  if (!cc || !cc.code) return;
  await pool.query(
    'UPDATE change_codes SET used_registration_id = $1, used_at = now() WHERE code = $2 AND used_registration_id IS NULL',
    [registrationId, cc.code]);
}

function firstNameToken(name) {
  return String(name || '').trim().split(/\s+/)[0].toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'DD';
}

function mapRow(r) {
  return {
    id: r.id, createdAt: r.created_at, status: r.status,
    currentCategory: r.current_category, currentAmount: Number(r.current_amount),
    newCategory: r.new_category, newAmount: Number(r.new_amount),
    name: r.name, email: r.email, mobile: r.mobile, dob: r.dob,
    receiptName: r.receipt_name, receiptType: r.receipt_type,
    entryCode: r.entry_code, entryAmount: Number(r.entry_amount),
    payAtCheckout: Number(r.pay_at_checkout),
    creditCode: r.credit_code || '', creditAmount: Number(r.credit_amount || 0),
    adminNote: r.admin_note || '', reviewedAt: r.reviewed_at
  };
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS category_changes (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'pending',
      current_category TEXT NOT NULL,
      current_amount NUMERIC NOT NULL,
      new_category TEXT NOT NULL,
      new_amount NUMERIC NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      mobile TEXT NOT NULL,
      dob TEXT,
      receipt_name TEXT,
      receipt_type TEXT,
      receipt_data BYTEA,
      entry_code TEXT UNIQUE NOT NULL,
      entry_amount NUMERIC NOT NULL,
      pay_at_checkout NUMERIC NOT NULL DEFAULT 0,
      credit_code TEXT,
      credit_amount NUMERIC,
      admin_note TEXT,
      reviewed_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS change_codes (
      code TEXT PRIMARY KEY,
      kind TEXT NOT NULL,                 -- 'entry' or 'credit'
      amount NUMERIC NOT NULL,            -- rupees, GST inclusive
      category TEXT NOT NULL,             -- 'solo' | 'double' | 'relay' | 'all'
      photo_carried BOOLEAN NOT NULL DEFAULT false,
      active BOOLEAN NOT NULL DEFAULT false,
      request_id TEXT,
      assigned_name TEXT,
      assigned_email TEXT,
      used_registration_id TEXT,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS change_code JSONB;
  `);
  console.log('✅ category_changes + change_codes tables ready.');
}

const LIST_COLUMNS = `c.id, c.created_at, c.status, c.current_category, c.current_amount, c.new_category, c.new_amount,
  c.name, c.email, c.mobile, c.dob, c.receipt_name, c.receipt_type, c.entry_code, c.entry_amount, c.pay_at_checkout,
  c.credit_code, c.credit_amount, c.admin_note, c.reviewed_at,
  (SELECT active FROM change_codes WHERE code = c.entry_code) AS entry_active,
  (SELECT used_registration_id FROM change_codes WHERE code = c.entry_code) AS entry_used,
  (SELECT used_registration_id FROM change_codes WHERE code = c.credit_code) AS credit_used`;

function register(app, { pool, requireAdmin, getMailer, emailFrom }) {

  async function sendMail(to, subject, text) {
    const mailer = getMailer();
    if (!mailer) { console.warn(`EMAIL not configured — would have emailed ${to}: ${subject}\n${text}`); return; }
    try {
      await mailer.sendMail({ from: `"Deadly Dozen India" <${emailFrom}>`, to, cc: TEAM_EMAIL, subject, text });
    } catch (err) {
      console.error('category-change email failed:', err);
    }
  }

  // ---------- Public: submit a request ----------
  app.post('/api/category-change', async (req, res) => {
    const d = req.body || {};
    const bad = msg => res.status(400).json({ error: msg });

    for (const k of ['category', 'newCategory', 'email', 'name', 'mobile', 'dob']) {
      if (!String(d[k] || '').trim()) return bad('Please fill in all the fields.');
    }
    const email = String(d.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('Please enter a valid email address.');
    if (!/^[6-9][0-9]{9}$/.test(String(d.mobile))) return bad('Please enter a valid 10-digit mobile number.');
    if (!d.confirm) return bad('Please confirm your details.');

    const [curName, curPhoto] = String(d.category).split('+');
    if (curPhoto && curPhoto !== 'Photo') return bad('Unknown category.');
    const cur = entryOf(curName, curPhoto === 'Photo');
    const nxt = entryOf(String(d.newCategory), cur && cur.photo);
    if (!cur || !nxt) return bad('Unknown category.');
    if (cur.name === nxt.name) return bad('Your new category must be different from your current one.');

    const r = d.receipt || {};
    if (!r.data) return bad('Please upload your payment receipt.');
    if (!RECEIPT_TYPES.test(r.type || '')) return bad('The receipt must be an image or a PDF.');
    const bytes = Buffer.from(String(r.data), 'base64');
    if (!bytes.length || bytes.length > MAX_RECEIPT_BYTES) return bad('The receipt must be under 5 MB.');

    const p = plan(cur, nxt);
    const name = String(d.name).trim().slice(0, 120);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Same person, same current entry, not rejected: give back the codes they already have.
      const prev = await client.query(
        `SELECT * FROM category_changes WHERE email = $1 AND current_category = $2 AND status <> 'rejected'
         ORDER BY created_at DESC LIMIT 1`, [email, cur.label]);
      if (prev.rows.length) {
        await client.query('ROLLBACK');
        const x = mapRow(prev.rows[0]);
        return res.json({ ok: true, result: {
          existing: true, newCategory: x.newCategory, entryCode: x.entryCode, entryAmount: x.entryAmount,
          payAtCheckout: x.payAtCheckout, creditCode: x.creditCode, creditAmount: x.creditAmount, photo: cur.photo } });
      }

      // Unique codes, e.g. SOLOPHOTO-PRIYA-4821 and CREDIT-PRIYA-4821
      const first = firstNameToken(name);
      const prefix = nxt.name.toUpperCase() + (nxt.photo ? 'PHOTO' : '');
      let entryCode = '', creditCode = '';
      for (let i = 0; i < 40 && !entryCode; i++) {
        const n = crypto.randomInt(1000, 10000);
        const e = `${prefix}-${first}-${n}`, c = p.creditAmount > 0 ? `CREDIT-${first}-${n}` : '';
        const clash = await client.query(
          `SELECT 1 FROM coupons WHERE UPPER(code) = $1 OR UPPER(code) = $2
           UNION SELECT 1 FROM change_codes WHERE code = $1 OR code = $2`, [e, c || e]);
        if (!clash.rows.length) { entryCode = e; creditCode = c; }
      }
      if (!entryCode) throw new Error('Could not create a unique code');

      const id = 'CC-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
      await client.query(
        `INSERT INTO category_changes (id, current_category, current_amount, new_category, new_amount, name, email, mobile, dob,
           receipt_name, receipt_type, receipt_data, entry_code, entry_amount, pay_at_checkout,
           credit_code, credit_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, cur.label, cur.total, nxt.label, nxt.total, name, email, String(d.mobile), String(d.dob),
         String(r.name || 'receipt').slice(0, 200), r.type, bytes, entryCode, p.entryAmount, p.payAtCheckout,
         creditCode || null, p.creditAmount || null]);
      await client.query(
        `INSERT INTO change_codes (code, kind, amount, category, photo_carried, request_id, assigned_name, assigned_email)
         VALUES ($1,'entry',$2,$3,$4,$5,$6,$7)`,
        [entryCode, p.entryAmount, nxt.id, cur.photo, id, name, email]);
      if (creditCode) {
        await client.query(
          `INSERT INTO change_codes (code, kind, amount, category, photo_carried, request_id, assigned_name, assigned_email)
           VALUES ($1,'credit',$2,'all',false,$3,$4,$5)`,
          [creditCode, p.creditAmount, id, name, email]);
      }

      await client.query('COMMIT');

      let text = `Hi ${name},\n\nWe have received your request to switch from ${cur.label} to ${nxt.label}.\n\n` +
        `CHANGE CODE: ${entryCode} (worth Rs ${p.entryAmount} towards ${nxt.name})\n` +
        (p.payAtCheckout > 0 ? `Enter it in the Change/Credit code box when you pay for ${nxt.name}; you pay only the remaining Rs ${p.payAtCheckout}.\n`
                             : `It covers your full ${nxt.name} entry.\n`) +
        (cur.photo ? `Your photo package carries over and is added free when you use this code.\n` : '') +
        (p.creditAmount > 0 ? `\nBALANCE CREDIT: ${creditCode} (Rs ${p.creditAmount})\nUse it for ${CREDIT_USE} within ${CREDIT_VALIDITY}.\n` : '') +
        `\nYour code will be switched on once we have checked your payment receipt. We will email you as soon as it is active.\n\n` +
        `Questions? Write to ${TEAM_EMAIL} and mention your code.\n\nDeadly Dozen India`;
      sendMail(email, `Deadly Dozen: category change request received (${entryCode})`, text);

      res.json({ ok: true, result: {
        existing: false, newCategory: nxt.label, entryCode, entryAmount: p.entryAmount,
        payAtCheckout: p.payAtCheckout, creditCode, creditAmount: p.creditAmount, photo: cur.photo } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('category-change submit failed:', err);
      res.status(500).json({ error: 'Server error saving your request. Please try again.' });
    } finally {
      client.release();
    }
  });

  // ---------- Public: check a Change/Credit code on the pay page ----------
  app.post('/api/validate-change-code', async (req, res) => {
    const { code, category } = req.body || {};
    try {
      const r = await checkChangeCode(pool, code, category);
      if (!r.ok) return res.json({ valid: false, error: r.error });
      res.json({ valid: true, code: r.row.code, kind: r.row.kind, amount: Number(r.row.amount), photoCarried: r.row.photo_carried });
    } catch (err) {
      console.error('validate-change-code failed:', err);
      res.status(500).json({ valid: false, error: 'Server error checking code.' });
    }
  });

  // ---------- Admin: list ----------
  app.get('/api/category-changes', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT ${LIST_COLUMNS} FROM category_changes c ORDER BY c.created_at DESC`);
      res.json(rows.map(r => Object.assign(mapRow(r), {
        codeActive: r.entry_active, entryUsed: !!r.entry_used, creditUsed: !!r.credit_used })));
    } catch (err) {
      console.error('list category changes failed:', err);
      res.status(500).json({ error: 'Server error loading requests.' });
    }
  });

  // ---------- Admin: view receipt (opens in a new tab: ?key=ADMIN_KEY) ----------
  app.get('/api/category-changes/:id/receipt', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT receipt_name, receipt_type, receipt_data FROM category_changes WHERE id = $1', [req.params.id]);
      if (!rows.length || !rows[0].receipt_data) return res.status(404).send('Receipt not found.');
      res.setHeader('Content-Type', rows[0].receipt_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${String(rows[0].receipt_name).replace(/"/g, '')}"`);
      res.send(rows[0].receipt_data);
    } catch (err) {
      console.error('receipt fetch failed:', err);
      res.status(500).send('Server error.');
    }
  });

  // ---------- Admin: approve -> activate coupon + email ----------
  app.post('/api/category-changes/:id/approve', requireAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM category_changes WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Request not found.' }); }
      const x = mapRow(rows[0]);
      await client.query('UPDATE change_codes SET active = true WHERE request_id = $1', [x.id]);
      await client.query(`UPDATE category_changes SET status = 'approved', reviewed_at = now(), admin_note = COALESCE($2, admin_note) WHERE id = $1`,
        [x.id, (req.body && req.body.note) || null]);
      await client.query('COMMIT');

      const photo = / \+ Photo$/.test(x.currentCategory);
      const text = `Hi ${x.name},\n\nWe have checked your payment receipt. Your coupon is now ACTIVE.\n\n` +
        `CHANGE CODE: ${x.entryCode} (Rs ${x.entryAmount})\n` +
        `Fill in your registration details for ${x.newCategory.replace(' + Photo', '')} as usual. When you reach the payment page, ` +
        `enter this code in the "Have you got a Change/Credit code?" box and tap Apply.\n` +
        (x.payAtCheckout > 0 ? `You then pay only Rs ${x.payAtCheckout}.\n` : `It covers your full entry.\n`) +
        (photo ? `Your photo package carries over and is added free.\n` : '') +
        (x.creditCode ? `\nBALANCE CREDIT: ${x.creditCode} (Rs ${x.creditAmount}) for ${CREDIT_USE}, valid ${CREDIT_VALIDITY}.\n` : '') +
        `\nQuestions? Write to ${TEAM_EMAIL}.\n\nDeadly Dozen India`;
      sendMail(x.email, `Deadly Dozen: your coupon ${x.entryCode} is now active`, text);
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('approve failed:', err);
      res.status(500).json({ error: 'Server error approving request.' });
    } finally {
      client.release();
    }
  });

  // ---------- Admin: reject -> coupon stays off + email ----------
  app.post('/api/category-changes/:id/reject', requireAdmin, async (req, res) => {
    const note = String((req.body && req.body.note) || '').slice(0, 500);
    try {
      const { rows } = await pool.query(
        `UPDATE category_changes SET status = 'rejected', reviewed_at = now(), admin_note = $2 WHERE id = $1 RETURNING *`,
        [req.params.id, note || null]);
      if (!rows.length) return res.status(404).json({ error: 'Request not found.' });
      const x = mapRow(rows[0]);
      await pool.query('UPDATE change_codes SET active = false WHERE request_id = $1', [x.id]);
      sendMail(x.email, `Deadly Dozen: about your category change request`,
        `Hi ${x.name},\n\nWe could not approve your request to switch from ${x.currentCategory} to ${x.newCategory}` +
        (note ? `:\n${note}\n` : '.\n') +
        `\nYour code ${x.entryCode} is not active. Please write to ${TEAM_EMAIL} if you have any questions.\n\nDeadly Dozen India`);
      res.json({ ok: true });
    } catch (err) {
      console.error('reject failed:', err);
      res.status(500).json({ error: 'Server error rejecting request.' });
    }
  });

  // ---------- Admin: Excel/CSV export ----------
  app.get('/api/category-changes/export.csv', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT ${LIST_COLUMNS} FROM category_changes c ORDER BY c.created_at DESC`);
      const head = ['Submitted', 'Status', 'Name', 'Email', 'Mobile', 'Date of birth', 'Current category', 'Amount paid',
        'New category', 'Change code', 'Change amount', 'Code active', 'Change code used', 'Pay at checkout', 'Credit code', 'Credit amount', 'Credit used', 'Admin note'];
      const lines = [head.join(',')].concat(rows.map(r => [
        new Date(r.created_at).toISOString(), r.status, r.name, r.email, r.mobile, r.dob, r.current_category, r.current_amount,
        r.new_category, r.entry_code, r.entry_amount, r.entry_active ? 'Yes' : 'No', r.entry_used ? 'Yes' : 'No', r.pay_at_checkout,
        r.credit_code, r.credit_amount, r.credit_code ? (r.credit_used ? 'Yes' : 'No') : '', r.admin_note
      ].map(csvEscape).join(',')));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="category-changes-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send('\ufeff' + lines.join('\n'));
    } catch (err) {
      console.error('category-change export failed:', err);
      res.status(500).json({ error: 'Server error generating CSV.' });
    }
  });
}

module.exports = { ensureSchema, register, plan, entryOf, checkChangeCode, markChangeCodeUsed, CATEGORIES };
