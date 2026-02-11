# Quick Start Guide - Web Dataset Collector

## 30-Second Setup

### 1. Install Node.js
- Download from https://nodejs.org/
- Version 16+ recommended

### 2. Setup Credentials

```bash
# Copy example env file
cp .env.example .env.local

# Edit .env.local with:
# - API_KEY from your Binus account
# - Firebase credentials from Firebase Console
```

### 3. Run Locally

```bash
npm install
npm run dev
# Open http://localhost:3000
```

### 4. Deploy to Vercel

**Option A: Using Vercel CLI**
```bash
npm install -g vercel
vercel
```

**Option B: Via GitHub**
1. Push to GitHub
2. Connect to vercel.com
3. Add environment variables
4. Deploy!

---

## Firebase Setup (5 minutes)

1. Go to https://console.firebase.google.com
2. Create new project
3. Enable **Storage**
4. Go to **Project Settings → Service Accounts**
5. Click **Generate New Private Key**
6. Copy values to `.env.local`:

```
FIREBASE_PROJECT_ID=...
FIREBASE_PRIVATE_KEY=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_STORAGE_BUCKET=...
```

---

## How Students Use It

1. **Go to URL**: `https://your-vercel-app.vercel.app`
2. **Enter Details**: Binusian ID, name, class
3. **Allow Camera**: Browser will ask for permission
4. **Capture**: Click capture 3-5 times from different angles
5. **Upload**: Click upload and done! ✅

---

## Get Images Later

Once images are uploaded:

```python
# In parent directory, create download_dataset.py
from firebase_admin import storage

bucket = storage.bucket()
blobs = bucket.list_blobs(prefix="face_dataset/")

for blob in blobs:
    local_path = f"downloaded_{blob.name}"
    blob.download_to_filename(local_path)
```

Then use with your existing system:
```bash
python3 make_dataset.py
python3 enroll_local.py
python3 main.py
```

---

## Troubleshooting

**Camera doesn't work?**
- Use HTTPS (Vercel provides this)
- Check browser permissions
- Try Chrome/Firefox

**Images not uploading?**
- Check `.env.local` Firebase config
- Verify Firebase Storage is enabled
- Check browser console for errors

**API lookup fails?**
- Verify `API_KEY` is correct
- Check network tab in browser DevTools

---

## Need Help?

See full README.md for:
- Detailed architecture
- All API endpoints
- Security setup
- Customization options
