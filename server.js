const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
require('dns').setDefaultResultOrder('ipv4first'); // Render has no outbound IPv6 route; avoid ENETUNREACH on SMTP

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());

// ---------- Razorpay webhook (must come before express.json(), needs the RAW body for signature check) ----------
// Set this same URL + a secret in Razorpay Dashboard → Settings → Webhooks, subscribed to "payment.captured".
// This is what reliably marks a registration "paid" even if the browser-side checkout callback never fires
// (e.g. the tab was backgrounded while switching to a UPI app).
app.post('/api/razorpay-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
  if (!secret) {
    console.error('Webhook received but RAZORPAY_WEBHOOK_SECRET is not set — rejecting.');
    return res.status(500).send('Webhook secret not configured.');
  }

  const signature = req.get('x-razorpay-signature') || '';
  const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (expected !== signature) {
    console.error('Webhook signature mismatch — rejecting.');
    return res.status(400).send('Invalid signature.');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    return res.status(400).send('Invalid JSON.');
  }

  try {
    if (event.event === 'payment.captured') {
      const payment = event.payload && event.payload.payment && event.payload.payment.entity;
      if (payment && payment.order_id) {
        const { rows } = await pool.query('SELECT * FROM registrations WHERE razorpay_order_id = $1', [payment.order_id]);
        if (rows.length && rows[0].status !== 'paid') {
          const { rows: updated } = await pool.query(
            `UPDATE registrations SET status = 'paid', razorpay_payment_id = $1, paid_at = now() WHERE id = $2 RETURNING *`,
            [payment.id, rows[0].id]
          );
          console.log(`Webhook: marked ${rows[0].id} as paid (payment ${payment.id}).`);
          await sendConfirmationEmail(mapRegistrationRow(updated[0]));
        } else if (!rows.length) {
          console.warn(`Webhook: payment.captured for unknown order_id ${payment.order_id}.`);
        }
      }
    }
    res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook processing failed:', err);
    res.status(500).send('Processing error.');
  }
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Database (Render Postgres) ----------
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set. Registrations and coupons cannot be stored without it.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS registrations (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'pending_payment',
      category TEXT NOT NULL,
      category_label TEXT,
      gender_category TEXT,
      team_name TEXT,
      total_members INT,
      members JSONB NOT NULL,
      base_amount NUMERIC,
      gst_amount NUMERIC,
      total_amount NUMERIC NOT NULL,
      coupon JSONB,
      event_date TEXT,
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      razorpay_signature TEXT,
      payment_method TEXT,
      paid_at TIMESTAMPTZ,
      registration_code TEXT
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      percentage NUMERIC NOT NULL,
      categories JSONB NOT NULL,
      assigned_name TEXT,
      assigned_phone TEXT,
      assigned_email TEXT,
      max_uses INT NOT NULL,
      used_count INT NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS gyms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      phone TEXT NOT NULL,
      gym_type TEXT NOT NULL,
      gym_type_other TEXT,
      specialisation JSONB NOT NULL DEFAULT '[]',
      specialisation_other TEXT,
      deadly_dozen_association JSONB NOT NULL DEFAULT '[]',
      deadly_dozen_association_other TEXT,
      deadly_dozen_track_host JSONB NOT NULL DEFAULT '[]',
      weights JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS challenge_designs (
      id TEXT PRIMARY KEY,
      design_type TEXT NOT NULL,
      organizer_type TEXT NOT NULL,
      organizer_name TEXT NOT NULL,
      area TEXT,
      pincode TEXT,
      incharge_name TEXT,
      incharge_number TEXT,
      venue TEXT,
      area_size TEXT,
      run_distance_m NUMERIC,
      rounds INT,
      stations JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Safe to run every startup — adds the column only if it isn't already there,
  // for the case where the registrations table already existed before this field was introduced.
  await pool.query(`
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS registration_code TEXT;
    ALTER TABLE gyms ADD COLUMN IF NOT EXISTS deadly_dozen_association_other TEXT;
    ALTER TABLE gyms ADD COLUMN IF NOT EXISTS deadly_dozen_track_host JSONB NOT NULL DEFAULT '[]';
  `);

  // One-time migration of the single test registration that existed in the old
  // JSON-file storage, so nothing is lost in the switch to Postgres. Safe to
  // run on every startup — ON CONFLICT means it only inserts once, ever.
  await pool.query(`
    INSERT INTO registrations (
      id, created_at, status, category, category_label, gender_category,
      team_name, total_members, members, base_amount, gst_amount, total_amount,
      coupon, paid_at
    ) VALUES (
      'DD-1788228249048-ZHIZQ5', '2026-09-01T02:04:09.048Z', 'pending_payment',
      'solo', 'Solo — Female', 'Female', NULL, 1,
      '[{"firstName":"Shilpakala","lastName":"BA","email":"shilpapriyakala@gmail.com","contact":"09886623640","gender":"Female","dob":"1982-12-20","city":"BENGALURU","state":"Karnataka","gymClub":"independent"}]'::jsonb,
      3999, 720, 4719, NULL, NULL
    )
    ON CONFLICT (id) DO NOTHING;
  `);

  console.log('✅ Database schema ready (registrations + coupons tables).');
}

// ---------- Row → camelCase JSON mapping (keeps the same shape the frontend already expects) ----------
function mapRegistrationRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
    category: row.category,
    categoryLabel: row.category_label,
    genderCategory: row.gender_category,
    teamName: row.team_name,
    totalMembers: row.total_members,
    members: row.members,
    baseAmount: row.base_amount === null ? null : Number(row.base_amount),
    gstAmount: row.gst_amount === null ? null : Number(row.gst_amount),
    totalAmount: Number(row.total_amount),
    coupon: row.coupon,
    eventDate: row.event_date,
    razorpayOrderId: row.razorpay_order_id,
    razorpayPaymentId: row.razorpay_payment_id,
    razorpaySignature: row.razorpay_signature,
    paymentMethod: row.payment_method,
    paidAt: row.paid_at,
    registrationCode: row.registration_code
  };
}

function mapCouponRow(row) {
  return {
    id: row.id,
    code: row.code,
    percentage: Number(row.percentage),
    categories: row.categories,
    assignedName: row.assigned_name,
    assignedPhone: row.assigned_phone,
    assignedEmail: row.assigned_email,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    active: row.active,
    createdAt: row.created_at
  };
}

function mapGymRow(row) {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    phone: row.phone,
    gymType: row.gym_type,
    gymTypeOther: row.gym_type_other,
    specialisation: row.specialisation,
    specialisationOther: row.specialisation_other,
    deadlyDozenAssociation: row.deadly_dozen_association,
    deadlyDozenAssociationOther: row.deadly_dozen_association_other,
    deadlyDozenTrackHost: row.deadly_dozen_track_host,
    weights: row.weights,
    createdAt: row.created_at
  };
}

function mapChallengeRow(row) {
  return {
    id: row.id,
    designType: row.design_type,
    organizerType: row.organizer_type,
    organizerName: row.organizer_name,
    area: row.area,
    pincode: row.pincode,
    inchargeName: row.incharge_name,
    inchargeNumber: row.incharge_number,
    venue: row.venue,
    areaSize: row.area_size,
    runDistanceM: row.run_distance_m === null ? null : Number(row.run_distance_m),
    rounds: row.rounds,
    stations: row.stations,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ---------- Razorpay setup ----------
// Get these from https://dashboard.razorpay.com/app/keys
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

let razorpay = null;
if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
} else {
  console.warn('⚠️  RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — payment endpoints will return an error until configured.');
}

// ---------- Email setup ----------
// Gmail: use an App Password (not your normal Gmail password) — https://myaccount.google.com/apppasswords
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;

let mailTransporter = null;
if (EMAIL_USER && EMAIL_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // STARTTLS on 587 instead of implicit TLS on 465
    requireTLS: true,
    family: 4, // force IPv4 — Render has no outbound IPv6 route
    lookup: (hostname, options, callback) => {
      require('dns').lookup(hostname, { family: 4 }, callback);
    },
    connectionTimeout: 10000,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  });
} else {
  console.warn('⚠️  EMAIL_USER / EMAIL_PASS not set — confirmation emails will be skipped (logged only) until configured.');
}

async function sendConfirmationEmail(record) {
  const members = record.members || [];
  const lead = members[0];
  const toEmail = lead && lead.email;

  if (!toEmail) {
    console.warn(`No email address found on registration ${record.id}; skipping confirmation email.`);
    return;
  }

  const amountPaid = typeof record.totalAmount === 'number' ? record.totalAmount.toLocaleString('en-IN') : 'N/A';
  const primaryName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Racer';
  const eventName = 'Deadly Dozen';
  const eventDate = record.eventDate || '28th Nov 2026';
  const eventVenue = process.env.EVENT_VENUE || 'To be announced';
  const category = record.categoryLabel || record.category;
  const txnId = record.razorpayPaymentId || 'N/A';

  const subject = `Confirmation: Your Registration for ${eventName} - ✅ ${category}`;

  const text = `Hi ${primaryName},

Thanks a lot for choosing ${eventName} for ${eventName}!

We're excited to see you at the start line 🎉 ${category}

Registration Details
Event: ${eventName}
Date: ${eventDate}
Venue: ${eventVenue}
Category: ${category}
Amount Paid: ₹${amountPaid}
Transaction ID: ${txnId}

Further details about the start wave, Venue maps and others will be conveyed to you on your registered email closer to the race date

Get ready to race

See you at the start line,
Deadly Dozen India`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif; color:#1c1c1c; max-width:560px; margin:0 auto;">
    <p>Hi ${primaryName},</p>
    <p>Thanks a lot for choosing <strong>${eventName}</strong> for ${eventName}!</p>
    <p>We're excited to see you at the start line 🎉 ${category}</p>
    <h3 style="color:#a3271f; margin-bottom:6px;">Registration Details</h3>
    <table style="border-collapse:collapse; width:100%;">
      <tr><td style="padding:4px 0;"><strong>Event:</strong></td><td>${eventName}</td></tr>
      <tr><td style="padding:4px 0;"><strong>Date:</strong></td><td>${eventDate}</td></tr>
      <tr><td style="padding:4px 0;"><strong>Venue:</strong></td><td>${eventVenue}</td></tr>
      <tr><td style="padding:4px 0;"><strong>Category:</strong></td><td>${category}</td></tr>
      <tr><td style="padding:4px 0;"><strong>Amount Paid:</strong></td><td>₹${amountPaid}</td></tr>
      <tr><td style="padding:4px 0;"><strong>Transaction ID:</strong></td><td>${txnId}</td></tr>
    </table>
    <p>Further details about the start wave, Venue maps and others will be conveyed to you on your registered email closer to the race date</p>
    <p>Get ready to race</p>
    <p>See you at the start line,<br><strong>Deadly Dozen India</strong></p>
  </div>`;

  if (!mailTransporter) {
    console.warn(`EMAIL not configured — would have sent confirmation to ${toEmail} for ${record.id}:\n${text}`);
    return;
  }

  try {
    await mailTransporter.sendMail({
      from: `"Deadly Dozen India" <${EMAIL_FROM}>`,
      to: toEmail,
      subject,
      text,
      html
    });
    console.log(`Confirmation email sent to ${toEmail} for registration ${record.id}`);
  } catch (err) {
    console.error(`Failed to send confirmation email for ${record.id}:`, err);
  }
}

// ---------- Admin protection ----------
// Set ADMIN_KEY in your environment. Without it, admin endpoints are locked (fail closed).
const ADMIN_KEY = process.env.ADMIN_KEY || '';

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(500).json({ error: 'ADMIN_KEY is not set on the server. Admin access is disabled until it is configured.' });
  }
  const provided = req.get('x-admin-key') || req.query.key || '';
  if (provided !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid or missing admin key.' });
  }
  next();
}

// Checks whether a coupon can currently be used for a given category.
// Returns { ok: true, coupon } or { ok: false, error }. `coupon` is snake_case DB row shape.
async function checkCouponUsable(client, code, category) {
  if (!code) return { ok: false, error: 'No coupon code provided.' };
  const { rows } = await client.query('SELECT * FROM coupons WHERE UPPER(code) = UPPER($1)', [code]);
  const coupon = rows[0];

  if (!coupon) return { ok: false, error: 'Coupon code not found.' };
  if (!coupon.active) return { ok: false, error: 'This coupon is no longer active.' };
  if (!coupon.categories.includes('all') && !coupon.categories.includes(category)) {
    return { ok: false, error: 'This coupon does not apply to the selected category.' };
  }
  if (coupon.used_count >= coupon.max_uses) {
    return { ok: false, error: 'This coupon has already been fully used.' };
  }
  return { ok: true, coupon };
}

// ---------- Public config (safe to expose) ----------
app.get('/api/config', (req, res) => {
  res.json({ razorpayKeyId: RAZORPAY_KEY_ID || null });
});

// ---------- Validate a coupon code (public — called as the user types it in) ----------
// Body: { code, category }. Does NOT consume a use — that only happens at /api/register.
app.post('/api/validate-coupon', async (req, res) => {
  const { code, category } = req.body || {};
  const client = await pool.connect();
  try {
    const result = await checkCouponUsable(client, code, category);
    if (!result.ok) {
      return res.status(400).json({ valid: false, error: result.error });
    }
    res.json({ valid: true, percentage: Number(result.coupon.percentage), code: result.coupon.code });
  } catch (err) {
    console.error('validate-coupon failed:', err);
    res.status(500).json({ valid: false, error: 'Server error checking coupon.' });
  } finally {
    client.release();
  }
});

// ---------- Save a registration ----------
// Called from the form once all team members (or the solo entrant) have been filled in,
// right before the payment step.
app.post('/api/register', async (req, res) => {
  const payload = req.body || {};

  if (!payload.category || typeof payload.totalAmount !== 'number' || !Array.isArray(payload.members) || !payload.members.length) {
    return res.status(400).json({ error: 'Missing required fields (category, totalAmount, members[]).' });
  }

  const registrationCode = (payload.registrationCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{11}$/.test(registrationCode)) {
    return res.status(400).json({ error: 'Registration code must be exactly 11 letters/numbers.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let appliedCoupon = null;
    if (payload.couponCode) {
      const result = await checkCouponUsable(client, payload.couponCode, payload.category);
      if (!result.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Coupon problem: ${result.error}` });
      }
      await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [result.coupon.id]);
      appliedCoupon = { code: result.coupon.code, percentage: Number(result.coupon.percentage) };
    }

    const id = 'DD-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();

    const { rows } = await client.query(
      `INSERT INTO registrations (
        id, category, category_label, gender_category, team_name, total_members,
        members, base_amount, gst_amount, total_amount, coupon, event_date, registration_code
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`,
      [
        id,
        payload.category,
        payload.categoryLabel || payload.category,
        payload.genderCategory || null,
        payload.teamName || null,
        payload.totalMembers || payload.members.length,
        JSON.stringify(payload.members),
        payload.baseAmount || null,
        payload.gstAmount || null,
        payload.totalAmount,
        appliedCoupon ? JSON.stringify(appliedCoupon) : null,
        payload.eventDate || null,
        registrationCode
      ]
    );

    await client.query('COMMIT');
    res.json({ ok: true, registrationId: id, record: mapRegistrationRow(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('register failed:', err);
    res.status(500).json({ error: 'Server error saving registration.' });
  } finally {
    client.release();
  }
});

// ---------- Create a Razorpay order ----------
// amountInRupees comes from the form's already-computed Total payable.
app.post('/api/create-order', async (req, res) => {
  if (!razorpay) {
    return res.status(500).json({ error: 'Razorpay is not configured on the server. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.' });
  }

  const { registrationId, amountInRupees } = req.body || {};
  if (!registrationId || !amountInRupees) {
    return res.status(400).json({ error: 'registrationId and amountInRupees are required.' });
  }

  const amountInPaise = Math.round(amountInRupees * 100);
  if (amountInPaise < 100) {
    return res.status(400).json({ error: 'Amount must be at least ₹1 (100 paise).' });
  }

  try {
    const { rows } = await pool.query('SELECT id FROM registrations WHERE id = $1', [registrationId]);
    if (!rows.length) return res.status(404).json({ error: 'Registration not found.' });

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: registrationId,
      notes: { registrationId, origin: 'deadly-dozen' }
    });

    await pool.query('UPDATE registrations SET razorpay_order_id = $1 WHERE id = $2', [order.id, registrationId]);

    res.json({ ok: true, order, keyId: RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('Razorpay order creation failed:', err);
    const statusCode = err && (err.statusCode === 401 || (err.error && err.error.code === 'BAD_REQUEST_ERROR' && /key/i.test(err.error.description || '')))
      ? 401
      : 500;
    const message = statusCode === 401
      ? 'Razorpay authentication failed. Check RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.'
      : 'Failed to create Razorpay order.';
    res.status(statusCode).json({ error: message });
  }
});

// ---------- Verify payment signature after Razorpay Checkout success ----------
app.post('/api/verify-payment', async (req, res) => {
  const { registrationId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

  if (!registrationId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing required fields (registrationId, razorpay_order_id, razorpay_payment_id, razorpay_signature).' });
  }
  if (!RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ error: 'Server missing RAZORPAY_KEY_SECRET.' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(razorpay_order_id + '|' + razorpay_payment_id)
    .digest('hex');

  const isValid = expectedSignature === razorpay_signature;
  const newStatus = isValid ? 'paid' : 'payment_verification_failed';

  try {
    const { rows } = await pool.query(
      `UPDATE registrations
       SET status = $1, razorpay_payment_id = $2, razorpay_signature = $3, paid_at = $4
       WHERE id = $5
       RETURNING *`,
      [newStatus, razorpay_payment_id, razorpay_signature, isValid ? new Date().toISOString() : null, registrationId]
    );
    const record = rows[0] ? mapRegistrationRow(rows[0]) : null;

    if (!isValid) {
      return res.status(400).json({ ok: false, error: 'Signature verification failed.' });
    }

    if (record) {
      await sendConfirmationEmail(record);
    }

    res.json({ ok: true, status: 'paid' });
  } catch (err) {
    console.error('verify-payment failed:', err);
    res.status(500).json({ error: 'Server error verifying payment.' });
  }
});

// ---------- Send a test confirmation email (admin only) ----------
// Lets you verify email delivery/formatting without needing a completed payment.
// Body: { "toEmail": "you@example.com" } — everything else is filled with sample data.
app.post('/api/test-confirmation-email', requireAdmin, async (req, res) => {
  const { toEmail } = req.body || {};
  if (!toEmail) {
    return res.status(400).json({ error: 'toEmail is required.' });
  }

  const fakeRecord = {
    id: 'DD-TEST-' + Date.now(),
    category: 'solo',
    categoryLabel: 'Solo (TEST)',
    teamName: null,
    totalAmount: 1,
    eventDate: '28/11/2026, 8:00 AM (IST)',
    razorpayPaymentId: 'pay_TESTSAMPLE123',
    members: [{ firstName: 'Test', lastName: 'Runner', email: toEmail }]
  };

  try {
    await sendConfirmationEmail(fakeRecord);
    res.json({ ok: true, message: `Test email sent to ${toEmail} (check server logs if it doesn't arrive).` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send test email: ' + err.message });
  }
});

// ---------- List all registrations (admin only) ----------
app.get('/api/registrations', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM registrations ORDER BY created_at DESC');
    res.json(rows.map(mapRegistrationRow));
  } catch (err) {
    console.error('list registrations failed:', err);
    res.status(500).json({ error: 'Server error loading registrations.' });
  }
});

// ---------- Get minimal public details for the standalone payment page ----------
// No admin key required — the registration ID itself (long, random) acts as the access
// token, same pattern as most payment-link systems. Only exposes what's needed to pay:
// no email, phone, DOB, address, etc.
app.get('/api/registrations/:id/pay-details', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM registrations WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Registration not found.' });

    const r = mapRegistrationRow(rows[0]);
    const lead = (r.members || [])[0] || {};

    res.json({
      id: r.id,
      status: r.status,
      categoryLabel: r.categoryLabel,
      teamName: r.teamName,
      totalMembers: r.totalMembers,
      baseAmount: r.baseAmount,
      gstAmount: r.gstAmount,
      totalAmount: r.totalAmount,
      leadName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || null
    });
  } catch (err) {
    console.error('pay-details failed:', err);
    res.status(500).json({ error: 'Server error loading registration.' });
  }
});

// ---------- Export all registrations as CSV (admin only) ----------
// This MUST be registered before '/api/registrations/:id' — otherwise Express
// matches "export.csv" as the :id parameter and this route is never reached.
function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

app.get('/api/registrations/export.csv', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM registrations ORDER BY created_at DESC');
    const list = rows.map(mapRegistrationRow);

    const headers = [
      'Registration ID', 'Status', 'Registration Code', 'Category', 'Gender', 'Team Name',
      'Lead First Name', 'Lead Last Name', 'Lead Email', 'Lead Contact',
      'Members Count', 'Base Amount', 'GST Amount', 'Total Amount',
      'Coupon Code', 'Coupon %', 'Event Date', 'Registered At', 'Paid At', 'Razorpay Payment ID'
    ];

    const lines = [headers.map(csvEscape).join(',')];

    list.forEach(r => {
      const lead = (r.members || [])[0] || {};
      lines.push([
        r.id, r.status, r.registrationCode, r.categoryLabel || r.category, r.genderCategory, r.teamName,
        lead.firstName, lead.lastName, lead.email, lead.contact,
        r.totalMembers, r.baseAmount, r.gstAmount, r.totalAmount,
        r.coupon ? r.coupon.code : '', r.coupon ? r.coupon.percentage : '',
        r.eventDate, r.createdAt, r.paidAt, r.razorpayPaymentId
      ].map(csvEscape).join(','));
    });

    const csv = lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="deadly-dozen-registrations-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('CSV export failed:', err);
    res.status(500).json({ error: 'Server error generating CSV.' });
  }
});

// ---------- Get one registration (admin only) ----------
app.get('/api/registrations/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM registrations WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(mapRegistrationRow(rows[0]));
  } catch (err) {
    console.error('get registration failed:', err);
    res.status(500).json({ error: 'Server error loading registration.' });
  }
});

// ---------- Status + category summary counts (admin only) ----------
app.get('/api/registrations-summary', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM registrations');
    const list = rows.map(mapRegistrationRow);
    const summary = {
      total: list.length,
      paid: 0,
      pending_payment: 0,
      payment_verification_failed: 0,
      byCategory: { solo: 0, double: 0, relay: 0 },
      participantsByCategory: { solo: 0, double: 0, relay: 0 }
    };
    list.forEach(r => {
      if (summary[r.status] !== undefined) summary[r.status]++;
      if (summary.byCategory[r.category] !== undefined) {
        summary.byCategory[r.category]++;
        summary.participantsByCategory[r.category] += (r.totalMembers || (r.members || []).length || 0);
      }
    });
    res.json(summary);
  } catch (err) {
    console.error('summary failed:', err);
    res.status(500).json({ error: 'Server error computing summary.' });
  }
});

// ---------- Manually mark a registration as paid (admin only) ----------
// For reconciling cases where Razorpay shows a captured payment but our DB still says
// pending — e.g. the browser-side checkout callback never fired.
// Body (optional): { razorpayPaymentId: "pay_..." }
app.post('/api/registrations/:id/mark-paid', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM registrations WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    if (rows[0].status === 'paid') return res.json({ ok: true, alreadyPaid: true, record: mapRegistrationRow(rows[0]) });

    const paymentId = (req.body && req.body.razorpayPaymentId) || rows[0].razorpay_payment_id || null;
    const { rows: updated } = await pool.query(
      `UPDATE registrations SET status = 'paid', razorpay_payment_id = COALESCE($1, razorpay_payment_id), paid_at = now() WHERE id = $2 RETURNING *`,
      [paymentId, req.params.id]
    );
    const record = mapRegistrationRow(updated[0]);
    await sendConfirmationEmail(record);
    res.json({ ok: true, record });
  } catch (err) {
    console.error('mark-paid failed:', err);
    res.status(500).json({ error: 'Server error marking as paid.' });
  }
});

// ---------- Delete one registration (admin only) ----------
app.delete('/api/registrations/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM registrations WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted: rows[0].id });
  } catch (err) {
    console.error('delete registration failed:', err);
    res.status(500).json({ error: 'Server error deleting registration.' });
  }
});

// ---------- Bulk delete registrations (admin only) ----------
app.post('/api/registrations/bulk-delete', requireAdmin, async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'ids must be a non-empty array.' });
  }
  try {
    const { rowCount } = await pool.query('DELETE FROM registrations WHERE id = ANY($1)', [ids]);
    res.json({ ok: true, deletedCount: rowCount });
  } catch (err) {
    console.error('bulk delete failed:', err);
    res.status(500).json({ error: 'Server error deleting registrations.' });
  }
});

// ---------- List all coupons (admin only) ----------
app.get('/api/coupons', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json(rows.map(mapCouponRow));
  } catch (err) {
    console.error('list coupons failed:', err);
    res.status(500).json({ error: 'Server error loading coupons.' });
  }
});

// ---------- Export all coupons as CSV (admin only) ----------
app.get('/api/coupons/export.csv', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    const list = rows.map(mapCouponRow);

    const headers = ['Code', 'Percentage', 'Categories', 'Assigned Name', 'Assigned Phone', 'Assigned Email', 'Max Uses', 'Used Count', 'Active', 'Created At'];
    const lines = [headers.map(csvEscape).join(',')];
    list.forEach(c => {
      lines.push([
        c.code, c.percentage, (c.categories || []).join('; '), c.assignedName, c.assignedPhone, c.assignedEmail,
        c.maxUses, c.usedCount, c.active, c.createdAt
      ].map(csvEscape).join(','));
    });

    const csv = lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="deadly-dozen-coupons-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('coupons CSV export failed:', err);
    res.status(500).json({ error: 'Server error generating CSV.' });
  }
});

// ---------- Create a coupon (admin only) ----------
// Body: { code, percentage, categories: ['solo','double','relay'] or ['all'],
//         assignedName, assignedPhone, assignedEmail, maxUses }
app.post('/api/coupons', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const code = (body.code || '').trim().toUpperCase();
  const percentage = Number(body.percentage);
  const categories = Array.isArray(body.categories) ? body.categories : [];
  const maxUses = Number(body.maxUses);

  if (!code) return res.status(400).json({ error: 'A coupon code is required.' });
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
    return res.status(400).json({ error: 'Percentage must be a number between 1 and 100.' });
  }
  if (!categories.length) {
    return res.status(400).json({ error: 'Select at least one category (or "all").' });
  }
  if (!Number.isFinite(maxUses) || maxUses <= 0) {
    return res.status(400).json({ error: 'How many uses to assign must be a number greater than 0.' });
  }

  const id = 'CPN-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

  try {
    const { rows } = await pool.query(
      `INSERT INTO coupons (id, code, percentage, categories, assigned_name, assigned_phone, assigned_email, max_uses)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [id, code, percentage, JSON.stringify(categories), body.assignedName || '', body.assignedPhone || '', body.assignedEmail || '', maxUses]
    );
    res.json({ ok: true, coupon: mapCouponRow(rows[0]) });
  } catch (err) {
    if (err.code === '23505') { // unique_violation on code
      return res.status(400).json({ error: `Coupon code "${code}" already exists.` });
    }
    console.error('create coupon failed:', err);
    res.status(500).json({ error: 'Server error creating coupon.' });
  }
});

// ---------- Toggle a coupon active/inactive (admin only) ----------
app.patch('/api/coupons/:id', requireAdmin, async (req, res) => {
  if (typeof req.body.active !== 'boolean') {
    return res.status(400).json({ error: 'Body must include a boolean "active" field.' });
  }
  try {
    const { rows } = await pool.query(
      'UPDATE coupons SET active = $1 WHERE id = $2 RETURNING *',
      [req.body.active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Coupon not found.' });
    res.json({ ok: true, coupon: mapCouponRow(rows[0]) });
  } catch (err) {
    console.error('toggle coupon failed:', err);
    res.status(500).json({ error: 'Server error updating coupon.' });
  }
});

// ---------- Delete a coupon (admin only) ----------
app.delete('/api/coupons/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM coupons WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Coupon not found.' });
    res.json({ ok: true, deleted: rows[0].id });
  } catch (err) {
    console.error('delete coupon failed:', err);
    res.status(500).json({ error: 'Server error deleting coupon.' });
  }
});

// ---------- Submit a gym information form (public) ----------
// Body: { name, address, phone, gymType, gymTypeOther, specialisation: [], specialisationOther,
//         deadlyDozenAssociation: [], weights: [{ equipment, weightKg, quantity, notes }] }
app.post('/api/gyms', async (req, res) => {
  const body = req.body || {};
  const name = (body.name || '').trim();
  const address = (body.address || '').trim();
  const phone = (body.phone || '').trim();
  const gymType = (body.gymType || '').trim();

  if (!name || !address) {
    return res.status(400).json({ error: 'Gym name and address are required.' });
  }
  if (!/^[0-9]{10}$/.test(phone)) {
    return res.status(400).json({ error: 'Phone number must be exactly 10 digits.' });
  }
  if (!gymType) {
    return res.status(400).json({ error: 'Please select a gym type.' });
  }

  const specialisation = Array.isArray(body.specialisation) ? body.specialisation : [];
  const deadlyDozenAssociation = Array.isArray(body.deadlyDozenAssociation) ? body.deadlyDozenAssociation : [];
  const deadlyDozenTrackHost = Array.isArray(body.deadlyDozenTrackHost) ? body.deadlyDozenTrackHost : [];
  const weights = Array.isArray(body.weights) ? body.weights : [];

  const id = 'GYM-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

  try {
    const { rows } = await pool.query(
      `INSERT INTO gyms (
        id, name, address, phone, gym_type, gym_type_other,
        specialisation, specialisation_other, deadly_dozen_association, deadly_dozen_association_other,
        deadly_dozen_track_host, weights
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *`,
      [
        id, name, address, phone, gymType, body.gymTypeOther || null,
        JSON.stringify(specialisation), body.specialisationOther || null,
        JSON.stringify(deadlyDozenAssociation), body.deadlyDozenAssociationOther || null,
        JSON.stringify(deadlyDozenTrackHost), JSON.stringify(weights)
      ]
    );
    res.json({ ok: true, gymId: id, record: mapGymRow(rows[0]) });
  } catch (err) {
    console.error('gym submission failed:', err);
    res.status(500).json({ error: 'Server error saving gym information.' });
  }
});

// ---------- List all gym submissions (admin only) ----------
app.get('/api/gyms', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM gyms ORDER BY created_at DESC');
    res.json(rows.map(mapGymRow));
  } catch (err) {
    console.error('list gyms failed:', err);
    res.status(500).json({ error: 'Server error loading gyms.' });
  }
});

// ---------- Delete a gym submission (admin only) ----------
app.delete('/api/gyms/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM gyms WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Gym not found.' });
    res.json({ ok: true, deleted: rows[0].id });
  } catch (err) {
    console.error('delete gym failed:', err);
    res.status(500).json({ error: 'Server error deleting gym.' });
  }
});

// ---------- Challenge Designs (Simulation / Mini Challenge) — admin only ----------

function validateChallengeBody(body) {
  if (!body.designType) return 'Please select a design type (Simulation or Mini Challenge).';
  if (!body.organizerType) return 'Please select who this is for (Gym, DD, or Run Club).';
  if (!(body.organizerName || '').trim()) return 'Organizer name is required.';
  return null;
}

// ---------- Create a challenge design ----------
app.post('/api/challenge-designs', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const err = validateChallengeBody(body);
  if (err) return res.status(400).json({ error: err });

  const id = 'CHL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const stations = Array.isArray(body.stations) ? body.stations : [];

  try {
    const { rows } = await pool.query(
      `INSERT INTO challenge_designs (
        id, design_type, organizer_type, organizer_name, area, pincode,
        incharge_name, incharge_number, venue, area_size, run_distance_m, rounds, stations
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`,
      [
        id, body.designType, body.organizerType, body.organizerName.trim(),
        body.area || null, body.pincode || null, body.inchargeName || null, body.inchargeNumber || null,
        body.venue || null, body.areaSize || null, body.runDistanceM || null, body.rounds || null,
        JSON.stringify(stations)
      ]
    );
    res.json({ ok: true, id, record: mapChallengeRow(rows[0]) });
  } catch (err) {
    console.error('create challenge design failed:', err);
    res.status(500).json({ error: 'Server error saving challenge design.' });
  }
});

// ---------- List all challenge designs ----------
app.get('/api/challenge-designs', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM challenge_designs ORDER BY created_at DESC');
    res.json(rows.map(mapChallengeRow));
  } catch (err) {
    console.error('list challenge designs failed:', err);
    res.status(500).json({ error: 'Server error loading challenge designs.' });
  }
});

// ---------- Get one challenge design ----------
app.get('/api/challenge-designs/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM challenge_designs WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json(mapChallengeRow(rows[0]));
  } catch (err) {
    console.error('get challenge design failed:', err);
    res.status(500).json({ error: 'Server error loading challenge design.' });
  }
});

// ---------- Update a challenge design ----------
app.put('/api/challenge-designs/:id', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const err = validateChallengeBody(body);
  if (err) return res.status(400).json({ error: err });

  const stations = Array.isArray(body.stations) ? body.stations : [];

  try {
    const { rows } = await pool.query(
      `UPDATE challenge_designs SET
        design_type = $1, organizer_type = $2, organizer_name = $3, area = $4, pincode = $5,
        incharge_name = $6, incharge_number = $7, venue = $8, area_size = $9,
        run_distance_m = $10, rounds = $11, stations = $12, updated_at = now()
      WHERE id = $13
      RETURNING *`,
      [
        body.designType, body.organizerType, body.organizerName.trim(),
        body.area || null, body.pincode || null, body.inchargeName || null, body.inchargeNumber || null,
        body.venue || null, body.areaSize || null, body.runDistanceM || null, body.rounds || null,
        JSON.stringify(stations), req.params.id
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true, record: mapChallengeRow(rows[0]) });
  } catch (err) {
    console.error('update challenge design failed:', err);
    res.status(500).json({ error: 'Server error updating challenge design.' });
  }
});

// ---------- Delete a challenge design ----------
app.delete('/api/challenge-designs/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM challenge_designs WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true, deleted: rows[0].id });
  } catch (err) {
    console.error('delete challenge design failed:', err);
    res.status(500).json({ error: 'Server error deleting challenge design.' });
  }
});

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Deadly Dozen Registration backend running on http://localhost:${PORT}`);
      console.log('Storage: Render Postgres (deadly-dozen-db)');
    });
  })
  .catch(err => {
    console.error('❌ Failed to set up database schema — server not started:', err);
    process.exit(1);
  });
