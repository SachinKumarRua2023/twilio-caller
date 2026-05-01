# TwilioCaller

## Project Structure (4 files only!)
```
twilio-caller/
├── server.js          ← All backend (Express + Twilio)
├── public/
│   └── index.html     ← All frontend
├── package.json
├── vercel.json
└── .gitignore
```

## Environment Variables (add these in Vercel)

| Key                  | Value                                    |
|----------------------|------------------------------------------|
| TWILIO_ACCOUNT_SID   | your_account_sid_here                    |
| TWILIO_AUTH_TOKEN    | your_auth_token_here                     |
| MY_PHONE_NUMBER      | your_indian_phone_number                 |
| TWILIO_NUMBER        | your_twilio_number                       |

## Deploy Steps

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "first commit"
```
Then on github.com:
- New repository → name it "twilio-caller" → Create
- Copy the remote URL and run:
```bash
git remote add origin https://github.com/YOUR_USERNAME/twilio-caller.git
git branch -M main
git push -u origin main
```

### Step 2 — Deploy on Vercel
1. Go to vercel.com → Sign in → New Project
2. Import your GitHub repo "twilio-caller"
3. Click "Environment Variables" → Add all 4 variables above
4. Click Deploy → Wait for green ✅
5. Copy your URL: https://twilio-caller-xxx.vercel.app

### Step 3 — Set Twilio Webhook
1. Twilio Console → Phone Numbers → +1 929 296 1896 → Configure
2. "A call comes in" → change to Webhook
3. URL → https://twilio-caller-xxx.vercel.app/api/incoming  (HTTP POST)
4. "Call status changes" → https://twilio-caller-xxx.vercel.app/api/status
5. Save ✅

## Done! Open your Vercel URL and start calling!
