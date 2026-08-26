const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const nodemailer = require('nodemailer');
require('dns').setDefaultResultOrder('ipv4first'); // Render has no outbound IPv6 route; avoid ENETUNREACH on SMTP

const app = express();
const PORT = process.env.PORT || 4000;
const DATA_FILE = path.join(__dirname, 'data', 'registrations.json');

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

function buildMemberSummaryText(member, index, total) {
  const fullName = `${(member.firstName || '')} ${(member.lastName || '')}`.trim() || 'Not specified';
  const label = total > 1 ? `Member ${index + 1}` : 'Entrant';
  const lines = [
    `  ${label}: ${fullName}`,
    `  Email: ${member.email || 'Not specified'}`,
    `  Contact: ${member.contact || 'Not specified'}`,
    `  City / State: ${[member.city, member.state].filter(Boolean).join(', ') || 'Not specified'}`,
    `  Gym/Club: ${member.gymClub || 'Not specified'}`
  ];
  return lines.join('\n');
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
  const eventDate = record.eventDate || 'To be confirmed';
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

Your spot is confirmed. You'll receive details about kit collection, race timings, and reporting time closer to the event.

In the meantime, keep training and get ready to run!

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
    <p>Your spot is confirmed. You'll receive details about kit collection, race timings, and reporting time closer to the event.</p>
    <p>In the meantime, keep training and get ready to run!</p>
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

// ---------- Simple JSON-file storage ----------
function readRegistrations() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to read registrations.json:', e);
    return [];
  }
}

function writeRegistrations(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
}

// ---------- Public config (safe to expose) ----------
app.get('/api/config', (req, res) => {
  res.json({ razorpayKeyId: RAZORPAY_KEY_ID || null });
});

// ---------- Save a registration ----------
// Called from the form once all team members (or the solo entrant) have been filled in,
// right before the payment step.
app.post('/api/register', (req, res) => {
  const payload = req.body || {};

  if (!payload.category || typeof payload.totalAmount !== 'number' || !Array.isArray(payload.members) || !payload.members.length) {
    return res.status(400).json({ error: 'Missing required fields (category, totalAmount, members[]).' });
  }

  const registrations = readRegistrations();
  const id = 'DD-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();

  const record = {
    id,
    createdAt: new Date().toISOString(),
    status: 'pending_payment',
    category: payload.category,
    categoryLabel: payload.categoryLabel || payload.category,
    teamName: payload.teamName || null,
    totalMembers: payload.totalMembers || payload.members.length,
    members: payload.members,
    baseAmount: payload.baseAmount || null,
    gstAmount: payload.gstAmount || null,
    totalAmount: payload.totalAmount,
    paidAt: null
  };

  registrations.push(record);
  writeRegistrations(registrations);

  res.json({ ok: true, registrationId: id, record });
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

  const registrations = readRegistrations();
  const record = registrations.find(r => r.id === registrationId);
  if (!record) return res.status(404).json({ error: 'Registration not found.' });

  try {
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: registrationId,
      notes: { registrationId, origin: 'deadly-dozen' }
    });

    record.razorpayOrderId = order.id;
    writeRegistrations(registrations);

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

  const registrations = readRegistrations();
  const record = registrations.find(r => r.id === registrationId);

  if (record) {
    record.status = isValid ? 'paid' : 'payment_verification_failed';
    record.razorpayPaymentId = razorpay_payment_id;
    record.razorpaySignature = razorpay_signature;
    record.paidAt = isValid ? new Date().toISOString() : null;
    writeRegistrations(registrations);
  }

  if (!isValid) {
    return res.status(400).json({ ok: false, error: 'Signature verification failed.' });
  }

  if (record) {
    await sendConfirmationEmail(record);
  }

  res.json({ ok: true, status: 'paid' });
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
app.get('/api/registrations', requireAdmin, (req, res) => {
  res.json(readRegistrations());
});

// ---------- Get one registration (admin only) ----------
app.get('/api/registrations/:id', requireAdmin, (req, res) => {
  const list = readRegistrations();
  const record = list.find(r => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json(record);
});

// ---------- Status + category summary counts (admin only) ----------
app.get('/api/registrations-summary', requireAdmin, (req, res) => {
  const list = readRegistrations();
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
});

// ---------- Delete one registration (admin only) ----------
app.delete('/api/registrations/:id', requireAdmin, (req, res) => {
  const list = readRegistrations();
  const idx = list.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const [removed] = list.splice(idx, 1);
  writeRegistrations(list);
  res.json({ ok: true, deleted: removed.id });
});

// ---------- Bulk delete registrations (admin only) ----------
app.post('/api/registrations/bulk-delete', requireAdmin, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'ids must be a non-empty array.' });
  }

  const list = readRegistrations();
  const idSet = new Set(ids);
  const remaining = list.filter(r => !idSet.has(r.id));
  const deletedCount = list.length - remaining.length;

  writeRegistrations(remaining);
  res.json({ ok: true, deletedCount });
});

app.listen(PORT, () => {
  console.log(`Deadly Dozen Registration backend running on http://localhost:${PORT}`);
  console.log(`Registration data is stored in: ${DATA_FILE}`);
});
