const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');

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

  res.json({ ok: true, status: 'paid' });
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
