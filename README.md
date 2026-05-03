# TwilioCaller

## Project Structure
```
FinalSetup/
├── server.js          ← All backend (Express + Twilio + Odoo)
├── public/
│   └── index.html     ← All frontend
├── package.json
├── vercel.json
└── .env.example
```

## Environment Variables (add in Vercel → Project → Settings → Environment Variables)

### Required
| Key                  | Example Value                            | Description                        |
|----------------------|------------------------------------------|------------------------------------|
| TWILIO_ACCOUNT_SID   | ACxxxxxxxxxxxxxxxxx                      | From Twilio Console                |
| TWILIO_AUTH_TOKEN    | xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx         | From Twilio Console                |
| TWILIO_NUMBER        | +19292961896                             | Your Twilio phone number           |
| MY_PHONE_NUMBER      | +919876543210                            | Agent 1 (senior) Indian number     |

### Agent 1 (Senior — uses MY_PHONE_NUMBER)
| Key          | Default  | Description              |
|--------------|----------|--------------------------|
| AGENT1_NAME  | Sachin   | Display name for Agent 1 |
| AGENT1_PIN   | 1234     | Login PIN for Agent 1    |

### Agent 2 (Junior)
| Key          | Default  | Description                          |
|--------------|----------|--------------------------------------|
| AGENT2_PHONE | *(empty)*| Indian number — set to enable agent  |
| AGENT2_NAME  | Junior1  | Display name                         |
| AGENT2_PIN   | 2222     | Login PIN                            |

### Agent 3 (Junior)
| Key          | Default  | Description                          |
|--------------|----------|--------------------------------------|
| AGENT3_PHONE | *(empty)*| Indian number — set to enable agent  |
| AGENT3_NAME  | Junior2  | Display name                         |
| AGENT3_PIN   | 3333     | Login PIN                            |

### Agent 4 & 5 (Optional extras)
Same pattern: `AGENT4_PHONE`, `AGENT4_NAME`, `AGENT4_PIN` and `AGENT5_PHONE`, `AGENT5_NAME`, `AGENT5_PIN`.

### Odoo CRM (optional — enables automatic call note logging)
| Key       | Description                             |
|-----------|-----------------------------------------|
| ODOO_URL  | e.g. https://yourcompany.odoo.com       |
| ODOO_DB   | Your Odoo database name                 |
| ODOO_USER | Your Odoo login email                   |
| ODOO_PASS | Your Odoo password                      |

### Other
| Key      | Description                                              |
|----------|----------------------------------------------------------|
| BASE_URL | Your Vercel URL e.g. https://twilio-caller-xxx.vercel.app |

---

## How Calls Work

1. Agent logs in with their name + PIN.
2. Agent dials a lead number in the UI.
3. **Agent's Indian phone rings first** — agent picks up.
4. Lead's phone starts ringing — when answered, both are connected.
5. After the call ends, a note is automatically saved in Odoo CRM (if configured).

---

## Deploy Steps

### Step 1 — Push to GitHub
```bash
git add .
git commit -m "setup"
git push
```

### Step 2 — Deploy on Vercel
1. Go to vercel.com → Sign in → New Project
2. Import your GitHub repo
3. Click **Environment Variables** → Add all variables from the table above
4. Click **Deploy** → Wait for green ✅
5. Copy your URL: `https://twilio-caller-xxx.vercel.app`

### Step 3 — Set Twilio Webhooks
1. Twilio Console → Phone Numbers → your number → Configure
2. **"A call comes in"** → Webhook → `https://your-url.vercel.app/api/incoming` (POST)
3. **"Call status changes"** → `https://your-url.vercel.app/api/status` (POST)
4. Save ✅

---

## Verify Odoo Notes Are Saving

Visit this URL in your browser after deployment:
```
https://your-url.vercel.app/api/odoo/test
```
It will respond with `{ "ok": true, "message": "Note saved successfully on lead ..." }` if everything is working, or an error message describing what's wrong.
