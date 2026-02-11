# Vercel Deployment Guide

## Quick Start (2 minutes)

### Step 1: Connect to Vercel
```bash
npm i -g vercel
vercel
```
Follow the prompts. Select your GitHub repository when asked.

### Step 2: Set Environment Variables
In Vercel Dashboard → Project Settings → Environment Variables, add:

```
API_KEY=OUQyQjdEN0EtREFDQy00QkEyLTg3QTAtNUFGNDVDOUZCRTgy
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY_ID=your-key-id
FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
FIREBASE_CLIENT_EMAIL=your-email@appspot.gserviceaccount.com
FIREBASE_CLIENT_ID=your-client-id
FIREBASE_STORAGE_BUCKET=your-bucket.appspot.com
NODE_ENV=production
```

### Step 3: Deploy to Production
```bash
vercel --prod
```

---

## What Gets Deployed

✅ **Frontend**
- React UI with dark blue techy theme
- Camera capture interface
- Student lookup form
- Security metrics dashboard

✅ **API Routes** (Serverless Functions)
- `/api/student/lookup` - Get student info from Binus API
- `/api/student/metadata` - Save capture metadata
- `/api/face/upload` - Upload face images
- `/api/health` - Health check

✅ **Static Assets**
- CSS modules
- Images and icons
- JavaScript bundles

---

## What Stays Local (Python Backend)

❌ These stay on your Jetson/Server:
- `make_dataset.py` - Dataset processing
- `main.py` - Face recognition
- `enroll_local.py` - Local enrollment
- `api_integrate.py` - Backend integration
- Local file storage

---

## Auto-Deployment

Once connected, every push to `main` branch auto-deploys:

```bash
git push origin main
# Vercel automatically builds and deploys
```

---

## Architecture

```
┌──────────────────────────────────────┐
│     Vercel (Frontend + API Routes)   │
│  • Web UI (dark blue theme)          │
│  • Camera capture logic              │
│  • Serverless API endpoints          │
│  • Auto-scaling & CDN                │
│  • Free tier: 100GB bandwidth/month  │
└─────────────────┬────────────────────┘
                  │ (HTTP/REST)
                  ↓
┌──────────────────────────────────────┐
│   Your Server (Python Backend)       │
│  • Face recognition processing       │
│  • Dataset management                │
│  • Local file storage                │
│  • Database operations               │
└──────────────────────────────────────┘
```

---

## Troubleshooting

### Build Fails
```bash
# Check local build first
npm run build

# View Vercel logs
vercel logs --tail
```

### Environment Variables Not Working
- Ensure all required vars are set in Vercel Dashboard
- Redeploy after adding vars: `vercel --prod`
- Check `.env.example` for required variables

### Firebase Private Key Issues
The private key must have:
- `\n` for newlines (not actual line breaks)
- Start with `-----BEGIN PRIVATE KEY-----`
- End with `-----END PRIVATE KEY-----`

Example:
```
FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIEvQIBADA...\n-----END PRIVATE KEY-----\n
```

### Camera Not Working After Deployment
- Clear browser cache
- Try incognito/private browsing
- Check browser camera permissions
- Test on different browser

---

## Performance & Limits

| Metric | Limit | Status |
|--------|-------|--------|
| Build Time | 45 seconds | ✅ ~20 seconds |
| Serverless Timeout | 60 seconds | ✅ API calls < 30s |
| File Upload | 4.5 MB | ✅ We upload images |
| Bandwidth | 100 GB/month | ✅ Plenty for small scale |

---

## Production Checklist

- [ ] Environment variables configured in Vercel
- [ ] Firebase credentials verified
- [ ] API_KEY correct
- [ ] Local build passes: `npm run build`
- [ ] Test camera access on staging
- [ ] Test student lookup API
- [ ] Test face upload
- [ ] Git repo is private/accessible
- [ ] Monitoring enabled in Vercel Dashboard

---

## Rollback

If something breaks, revert to previous deployment:

```bash
# In Vercel Dashboard
# Deployments → Select previous version → Promote to Production
```

Or rollback Git and push:
```bash
git revert HEAD
git push origin main
```

---

## Next Steps

1. **First Deploy**: `vercel` (staging)
2. **Configure Env Vars**: Vercel Dashboard
3. **Test API Routes**: Curl or Postman
4. **Production Deploy**: `vercel --prod`
5. **Monitor**: Check Vercel Analytics dashboard

---

## Support

- Vercel Docs: https://vercel.com/docs
- Next.js Docs: https://nextjs.org/docs
- GitHub Issues: https://github.com/albertarthursub-sketch/make-dataset
