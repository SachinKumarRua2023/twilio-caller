const express = require('express');
const twilio  = require('twilio');
const path    = require('path');
const xmlrpc  = require('xmlrpc');
const crypto  = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ── ENV ───────────────────────────────────────────────────────────────────────
const {
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,      MY_PHONE_NUMBER,
  AGENT2_PHONE,       AGENT3_PHONE,
  AGENT4_PHONE,       AGENT5_PHONE,
  ODOO_URL,           ODOO_DB,
  ODOO_USER,          ODOO_PASS
} = process.env;

const getBaseUrl = (req) =>
  process.env.BASE_URL || `https://${req.get('host')}`;

// ── AGENTS ────────────────────────────────────────────────────────────────────
const AGENTS = [
  { name: process.env.AGENT1_NAME || 'Sachin', pin: process.env.AGENT1_PIN || '1234', phone: MY_PHONE_NUMBER },
  { name: process.env.AGENT2_NAME || 'Junior1', pin: process.env.AGENT2_PIN || '2222', phone: AGENT2_PHONE  },
  { name: process.env.AGENT3_NAME || 'Junior2', pin: process.env.AGENT3_PIN || '3333', phone: AGENT3_PHONE  },
  { name: process.env.AGENT4_NAME || 'Junior3', pin: process.env.AGENT4_PIN || '4444', phone: AGENT4_PHONE  },
  { name: process.env.AGENT5_NAME || 'Junior4', pin: process.env.AGENT5_PIN || '5555', phone: AGENT5_PHONE  },
].filter(a => a.phone); // only include agents that have a phone number configured

const REQUIRED_ENV = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_NUMBER',
  'MY_PHONE_NUMBER',
];

function missingEnv() {
  return REQUIRED_ENV.filter((key) => !process.env[key]);
}

function ensureTwilioConfig(res) {
  const missing = missingEnv();
  if (!missing.length) return true;
  res.status(500).json({
    success: false,
    error: `Missing required environment variable(s): ${missing.join(', ')}`,
  });
  return false;
}

// ── IN-MEMORY STATE ───────────────────────────────────────────────────────────
const activeCalls = {};   // callSid → call info
let   incomingCall = null;

// ── STATELESS TOKEN AUTH ──────────────────────────────────────────────────────
// Token = base64url(payload).hmac — no server-side storage, survives restarts.
const TOKEN_SECRET = TWILIO_AUTH_TOKEN || 'callcenter-secret-key';

function makeToken(agent) {
  const payload = Buffer.from(JSON.stringify({ name: agent.name, phone: agent.phone }))
    .toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig     = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()); }
  catch(e) { return null; }
}

app.post('/api/agent/login', (req, res) => {
  if (!ensureTwilioConfig(res)) return;
  const { name, pin } = req.body;
  const agent = AGENTS.find(a => a.name === name && a.pin === pin);
  if (!agent) return res.status(401).json({ error: 'Invalid credentials' });
  const agentData = { name: agent.name, phone: agent.phone || MY_PHONE_NUMBER };
  res.json({ token: makeToken(agentData), agent: agentData });
});

app.post('/api/agent/logout', (req, res) => res.json({ success: true }));

app.get('/api/agents', (req, res) => res.json(AGENTS.map(a => a.name)));

function getAgent(req) {
  return verifyToken(req.headers['x-agent-token']);
}

// ── ODOO ──────────────────────────────────────────────────────────────────────
function makeOdooClients() {
  if (!ODOO_URL) return null;
  try {
    const u    = new URL(ODOO_URL);
    const opts = { host: u.hostname, port: 443 };
    return {
      common: xmlrpc.createSecureClient({ ...opts, path: '/xmlrpc/2/common' }),
      object: xmlrpc.createSecureClient({ ...opts, path: '/xmlrpc/2/object' }),
    };
  } catch(e) { return null; }
}

function rpc(client, method, params) {
  return new Promise((resolve, reject) =>
    client.methodCall(method, params, (err, val) => err ? reject(err) : resolve(val))
  );
}

async function odooUid() {
  const c = makeOdooClients();
  if (!c) return null;
  try {
    const uid = await rpc(c.common, 'authenticate', [ODOO_DB, ODOO_USER, ODOO_PASS, {}]);
    return uid ? { uid, c } : null;
  } catch(e) { return null; }
}

async function findPartner(phone) {
  if (!ODOO_URL || !phone) return null;
  try {
    const auth = await odooUid();
    if (!auth) return null;
    const { uid, c } = auth;
    const clean = phone.replace(/\D/g, '').slice(-10);
    for (const field of ['mobile', 'phone']) {
      const rows = await rpc(c.object, 'execute_kw', [
        ODOO_DB, uid, ODOO_PASS, 'res.partner', 'search_read',
        [[[ field, 'like', clean ]]],
        { fields: ['id','name','mobile','phone','email'], limit: 1 },
      ]);
      if (rows.length) return rows[0];
    }
    return null;
  } catch(e) { return null; }
}

async function logCallToOdoo(info) {
  if (!ODOO_URL) return;
  try {
    const auth = await odooUid();
    if (!auth) return;
    const { uid, c } = auth;

    let partnerId = info.odooPartnerId || null;
    if (!partnerId) {
      const p = await findPartner(info.to);
      if (p) {
        partnerId = p.id;
      } else {
        // No contact found — auto-create one so the call is never lost
        partnerId = await rpc(c.object, 'execute_kw', [
          ODOO_DB, uid, ODOO_PASS, 'res.partner', 'create',
          [{ name: info.odooPartnerName || info.to, mobile: info.to }],
        ]);
      }
    }
    if (!partnerId) return;

    const dir = info.direction === 'out' ? 'Outbound' : 'Inbound';
    const rec = info.recordingUrl
      ? `<br/>🎙️ <a href="${info.recordingUrl}">Play Recording</a>` : '';
    const notes = info.notes
      ? `<br/>📝 Notes: ${info.notes}` : '';

    const body = `📞 <b>${dir} Call</b><br/>
Agent: ${info.agent}<br/>
Number: ${info.to}<br/>
Duration: ${info.duration || '0:00'}<br/>
Status: ${info.status}${rec}${notes}`;

    await rpc(c.object, 'execute_kw', [
      ODOO_DB, uid, ODOO_PASS, 'res.partner', 'message_post',
      [[partnerId]],
      { body, message_type: 'comment', subtype_xmlid: 'mail.mt_note' },
    ]);

    // also post on crm.lead if one exists
    try {
      const leads = await rpc(c.object, 'execute_kw', [
        ODOO_DB, uid, ODOO_PASS, 'crm.lead', 'search_read',
        [[['partner_id','=',partnerId],['active','=',true]]],
        { fields: ['id'], limit: 1 },
      ]);
      if (leads.length) {
        await rpc(c.object, 'execute_kw', [
          ODOO_DB, uid, ODOO_PASS, 'crm.lead', 'message_post',
          [[leads[0].id]],
          { body, message_type: 'comment', subtype_xmlid: 'mail.mt_note' },
        ]);
      }
    } catch(e) {}
  } catch(e) { console.error('Odoo log error:', e.message); }
}

// ── OUTBOUND CALL ─────────────────────────────────────────────────────────────
app.post('/api/call', async (req, res) => {
  if (!ensureTwilioConfig(res)) return;
  const agent = getAgent(req);
  if (!agent) return res.status(401).json({ error: 'Not logged in' });

  const { to, odooPartnerId, odooPartnerName } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing "to"' });

  const agentPhone = agent.phone || MY_PHONE_NUMBER;
  const base       = getBaseUrl(req);

  // Encode call metadata into callback URLs so Vercel serverless instances
  // can log the call even if activeCalls is empty (no shared memory between requests).
  const meta     = new URLSearchParams({
    agent: agent.name,
    to,
    dir: 'out',
    ...(odooPartnerId   ? { pid:   String(odooPartnerId)   } : {}),
    ...(odooPartnerName ? { pname: odooPartnerName         } : {}),
  }).toString();
  // Inside TwiML (XML), & must be &amp; — otherwise Twilio rejects the XML and says "application error"
  const metaXml  = meta.replace(/&/g, '&amp;');

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    // Agent's phone rings first. When answered, lead's phone starts ringing.
    const call = await client.calls.create({
      to:   agentPhone,
      from: TWILIO_NUMBER,
      statusCallback:      `${base}/api/status?${meta}`,
      statusCallbackMethod:'POST',
      statusCallbackEvent: ['initiated','ringing','answered','completed'],
      twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${TWILIO_NUMBER}"
        answerOnBridge="true"
        record="record-from-ringing"
        recordingStatusCallback="${base}/api/recording?${metaXml}"
        recordingStatusCallbackMethod="POST"
        action="${base}/api/dial-done"
        method="POST"
        timeout="30">
    <Number>${to}</Number>
  </Dial>
</Response>`,
    });

    activeCalls[call.sid] = {
      callSid: call.sid,
      agent:   agent.name,
      agentPhone,
      to,
      direction:       'out',
      startTime:       Date.now(),
      status:          'initiated',
      recordingUrl:    null,
      notes:           '',
      odooPartnerId:   odooPartnerId   || null,
      odooPartnerName: odooPartnerName || null,
    };

    res.json({ success: true, callSid: call.sid, status: call.status });
  } catch(err) {
    console.error('Call error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── HANGUP ────────────────────────────────────────────────────────────────────
app.post('/api/hangup', async (req, res) => {
  if (!ensureTwilioConfig(res)) return;
  const { callSid } = req.body;
  if (!callSid) return res.status(400).json({ error: 'Missing callSid' });
  try {
    await twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
      .calls(callSid).update({ status: 'completed' });
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── CALL NOTES ────────────────────────────────────────────────────────────────
app.post('/api/call/notes', (req, res) => {
  const { callSid, notes } = req.body;
  if (callSid && activeCalls[callSid]) activeCalls[callSid].notes = notes;
  res.json({ success: true });
});

// ── INBOUND WEBHOOK ───────────────────────────────────────────────────────────
app.post('/api/incoming', (req, res) => {
  const missing = missingEnv();
  if (missing.length) {
    res.setHeader('Content-Type', 'text/xml');
    res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Call routing is not configured. Missing ${missing.join(', ')}.</Say>
</Response>`);
    return;
  }

  const from    = req.body.From    || 'Unknown';
  const callSid = req.body.CallSid || '';
  const base    = getBaseUrl(req);

  incomingCall = { from, sid: callSid, time: Date.now() };
  activeCalls[callSid] = {
    callSid, agent: 'Incoming', agentPhone: MY_PHONE_NUMBER,
    to: from, direction: 'in', startTime: Date.now(),
    status: 'ringing', recordingUrl: null, notes: '',
    odooPartnerId: null, odooPartnerName: null,
  };

  const inMeta = new URLSearchParams({ agent: 'Incoming', to: from, dir: 'in' }).toString();

  res.setHeader('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Please wait while we connect you.</Say>
  <Dial callerId="${TWILIO_NUMBER}"
        answerOnBridge="true"
        record="record-from-ringing"
        recordingStatusCallback="${base}/api/recording?${inMeta}"
        recordingStatusCallbackMethod="POST"
        action="${base}/api/dial-done"
        method="POST"
        timeout="30">
    <Number statusCallbackEvent="initiated ringing answered completed"
            statusCallback="${base}/api/status?${inMeta}"
            statusCallbackMethod="POST">${MY_PHONE_NUMBER}</Number>
  </Dial>
</Response>`);
});

// ── DIAL DONE ─────────────────────────────────────────────────────────────────
app.post('/api/dial-done', (req, res) => {
  incomingCall = null;
  res.setHeader('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

// ── RECORDING WEBHOOK ─────────────────────────────────────────────────────────
app.post('/api/recording', async (req, res) => {
  const { CallSid, RecordingUrl } = req.body;
  if (!CallSid || !RecordingUrl) return res.sendStatus(200);

  const mp3 = RecordingUrl + '.mp3';

  if (activeCalls[CallSid]) {
    activeCalls[CallSid].recordingUrl = mp3;
  } else {
    // Serverless: activeCalls is empty — log recording note directly to Odoo
    const q = req.query;
    const phone = q.to || '';
    try {
      const auth = await odooUid();
      if (auth) {
        const { uid, c } = auth;
        let partnerId = q.pid ? parseInt(q.pid) : null;
        if (!partnerId) {
          const p = await findPartner(phone);
          if (p) partnerId = p.id;
        }
        if (partnerId) {
          const body = `🎙️ <b>Call Recording</b><br/>Agent: ${q.agent || 'Unknown'}<br/>Number: ${phone}<br/><a href="${mp3}">Play Recording</a>`;
          await rpc(c.object, 'execute_kw', [
            ODOO_DB, uid, ODOO_PASS, 'res.partner', 'message_post',
            [[partnerId]],
            { body, message_type: 'comment', subtype_xmlid: 'mail.mt_note' },
          ]);
        }
      }
    } catch(e) { console.error('Recording Odoo log error:', e.message); }
  }
  res.sendStatus(200);
});

// ── STATUS WEBHOOK (Twilio POST) + FRONTEND POLL (GET) ───────────────────────
app.post('/api/status', async (req, res) => {
  const { CallStatus, From, CallSid, CallDuration } = req.body;
  const q = req.query; // agent, to, dir, pid, pname — encoded when call was created

  if (['ringing','initiated'].includes(CallStatus) && From && !activeCalls[CallSid]) {
    incomingCall = { from: From, sid: CallSid, time: Date.now() };
  }

  if (['completed','busy','failed','no-answer','canceled'].includes(CallStatus)) {
    if (incomingCall && incomingCall.sid === CallSid) incomingCall = null;

    const secs = parseInt(CallDuration || 0);
    const duration = `${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}`;

    // Use in-memory info if available; otherwise reconstruct from URL query params.
    // The query-param fallback is essential on Vercel (serverless — no shared memory).
    const info = activeCalls[CallSid] || {
      callSid:         CallSid,
      agent:           q.agent || (From === TWILIO_NUMBER ? 'Unknown Agent' : 'Inbound'),
      to:              q.to   || From || '',
      direction:       q.dir  || 'out',
      recordingUrl:    null,
      notes:           '',
      odooPartnerId:   q.pid   ? parseInt(q.pid)  : null,
      odooPartnerName: q.pname || null,
    };

    info.duration = duration;
    info.status   = CallStatus;
    await logCallToOdoo(info);
    setTimeout(() => delete activeCalls[CallSid], 60000);
  }
  res.sendStatus(200);
});

app.get('/api/status', (req, res) => {
  if (incomingCall && Date.now() - incomingCall.time > 30000) incomingCall = null;
  res.json({ incomingCall });
});

// ── ODOO CONTACT SEARCH ───────────────────────────────────────────────────────
app.get('/api/odoo/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2 || !ODOO_URL) return res.json([]);
  try {
    const auth = await odooUid();
    if (!auth) return res.json([]);
    const { uid, c } = auth;
    const rows = await rpc(c.object, 'execute_kw', [
      ODOO_DB, uid, ODOO_PASS, 'res.partner', 'search_read',
      [[['|','|',['name','ilike',q],['mobile','ilike',q],['phone','ilike',q]]]],
      { fields: ['id','name','mobile','phone','email'], limit: 10 },
    ]);
    res.json(rows);
  } catch(e) { res.json([]); }
});

app.get('/api/odoo/contact', async (req, res) => {
  const partner = await findPartner(req.query.phone || '');
  res.json(partner);
});

// ── ODOO CONNECTIVITY TEST ────────────────────────────────────────────────────
app.get('/api/odoo/test', async (req, res) => {
  if (!ODOO_URL) return res.json({ ok: false, error: 'ODOO_URL not configured' });
  try {
    const auth = await odooUid();
    if (!auth) return res.json({ ok: false, error: 'Authentication failed — check ODOO_DB, ODOO_USER, ODOO_PASS' });
    const { uid, c } = auth;

    // post a test note to the first lead found, or report no leads
    const leads = await rpc(c.object, 'execute_kw', [
      ODOO_DB, uid, ODOO_PASS, 'crm.lead', 'search_read',
      [[['active', '=', true]]],
      { fields: ['id', 'name'], limit: 1 },
    ]);

    if (!leads.length) {
      return res.json({ ok: true, uid, message: 'Connected to Odoo ✓ — no active CRM leads found to test note posting' });
    }

    const lead = leads[0];
    await rpc(c.object, 'execute_kw', [
      ODOO_DB, uid, ODOO_PASS, 'crm.lead', 'message_post',
      [[lead.id]],
      { body: '🔧 Test note from call agent — Odoo note saving is working ✓', message_type: 'comment', subtype_xmlid: 'mail.mt_note' },
    ]);

    res.json({ ok: true, uid, message: `Note saved successfully on lead "${lead.name}" (id: ${lead.id}) ✓` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── SMS ───────────────────────────────────────────────────────────────────────
app.post('/api/sms', async (req, res) => {
  if (!ensureTwilioConfig(res)) return;
  const agent = getAgent(req);
  if (!agent) return res.status(401).json({ error: 'Not logged in' });

  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Missing to/message' });

  try {
    await twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
      .messages.create({ to, from: TWILIO_NUMBER, body: message });

    // log to Odoo partner chatter
    try {
      const auth = await odooUid();
      if (auth) {
        const { uid, c } = auth;
        const partner = await findPartner(to);
        if (partner) {
          await rpc(c.object, 'execute_kw', [
            ODOO_DB, uid, ODOO_PASS, 'res.partner', 'message_post',
            [[partner.id]],
            {
              body: `💬 SMS sent by ${agent.name}: ${message}`,
              message_type: 'comment',
              subtype_xmlid: 'mail.mt_note',
            },
          ]);
        }
      }
    } catch(e) {}

    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── MANAGER ───────────────────────────────────────────────────────────────────
app.get('/api/manager/calls', (req, res) => res.json(activeCalls));

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
