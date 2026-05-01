const express = require('express');
const twilio = require('twilio');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const myPhone    = process.env.MY_PHONE_NUMBER;   // your Indian number
const twilioNum  = process.env.TWILIO_NUMBER;     // +19292961896

// In-memory call state (resets on restart — fine for demo)
let incomingCall = null;

// ── 1. Make outbound call ─────────────────────────────────────────────────────
app.post('/api/call', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing "to" number' });

  try {
    const client = twilio(accountSid, authToken);
    const call = await client.calls.create({
      to,
      from: twilioNum,
      statusCallback: `${req.protocol}://${req.get('host')}/api/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated','ringing','answered','completed'],
      twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Connecting your call, please wait.</Say>
  <Dial callerId="${twilioNum}" timeout="30">
    <Number>${myPhone}</Number>
  </Dial>
</Response>`
    });
    res.json({ success: true, callSid: call.sid, status: call.status });
  } catch (err) {
    console.error('Call error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 2. Hang up a call ─────────────────────────────────────────────────────────
app.post('/api/hangup', async (req, res) => {
  const { callSid } = req.body;
  if (!callSid) return res.status(400).json({ error: 'Missing callSid' });
  try {
    const client = twilio(accountSid, authToken);
    await client.calls(callSid).update({ status: 'completed' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 3. Incoming call webhook (Twilio calls this) ──────────────────────────────
app.post('/api/incoming', (req, res) => {
  const from    = req.body.From    || 'Unknown';
  const callSid = req.body.CallSid || '';

  // Save for frontend polling
  incomingCall = { from, sid: callSid, time: Date.now() };

  // Forward to your Indian phone
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Please wait, connecting your call.</Say>
  <Dial callerId="${twilioNum}" timeout="30"
        action="/api/dial-done" method="POST">
    <Number statusCallbackEvent="initiated ringing answered completed"
            statusCallback="/api/status">${myPhone}</Number>
  </Dial>
</Response>`;

  res.setHeader('Content-Type', 'text/xml');
  res.send(twiml);
});

// ── 4. After dial completes ───────────────────────────────────────────────────
app.post('/api/dial-done', (req, res) => {
  incomingCall = null;
  res.setHeader('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

// ── 5. Call status updates (Twilio posts here) + frontend polls GET ───────────
app.post('/api/status', (req, res) => {
  const { CallStatus, From, CallSid } = req.body;
  if (['ringing','initiated'].includes(CallStatus) && From) {
    incomingCall = { from: From, sid: CallSid, time: Date.now() };
  } else if (['completed','busy','failed','no-answer','canceled'].includes(CallStatus)) {
    incomingCall = null;
  }
  res.sendStatus(200);
});

app.get('/api/status', (req, res) => {
  // Clear stale calls older than 30s
  if (incomingCall && Date.now() - incomingCall.time > 30000) incomingCall = null;
  res.json({ incomingCall });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
