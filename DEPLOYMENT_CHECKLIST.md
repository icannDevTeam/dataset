# 📋 Deployment Checklist

Complete checklist for deploying the facial attendance web dataset collector.

## ✅ Pre-Deployment

- [ ] Node.js v16+ installed locally
- [ ] Firebase project created at console.firebase.google.com
- [ ] Firebase Storage enabled
- [ ] Service account private key generated
- [ ] Binus API credentials (API_KEY) available
- [ ] GitHub account setup (for GitHub integration with Vercel)
- [ ] Vercel account created at vercel.com

## ✅ Local Setup

- [ ] Clone/download repository
- [ ] Copy `.env.example` to `.env.local`
- [ ] Fill in all environment variables:
  - [ ] `API_KEY` from Binus School
  - [ ] `FIREBASE_PROJECT_ID`
  - [ ] `FIREBASE_PRIVATE_KEY`
  - [ ] `FIREBASE_CLIENT_EMAIL`
  - [ ] `FIREBASE_STORAGE_BUCKET`
- [ ] Run `npm install`
- [ ] Run `npm run dev`
- [ ] Test at http://localhost:3000
  - [ ] Form submission works
  - [ ] Camera access is requested
  - [ ] Images can be captured
  - [ ] Upload completes successfully

## ✅ Firebase Configuration

- [ ] Storage bucket created
- [ ] Storage rules configured (see INTEGRATION.md)
- [ ] Tested Firebase upload locally

### Storage Rules
```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /face_dataset/{allPaths=**} {
      allow read, write;
    }
  }
}
```

## ✅ Vercel Deployment

### Option 1: CLI Deployment
- [ ] Install Vercel CLI: `npm install -g vercel`
- [ ] Run `vercel` in project root
- [ ] Add environment variables in prompts
- [ ] Deployment completes successfully

### Option 2: GitHub Integration
- [ ] Push code to GitHub
- [ ] Go to vercel.com/new
- [ ] Import GitHub repository
- [ ] Add environment variables:
  - [ ] API_KEY
  - [ ] FIREBASE_PROJECT_ID
  - [ ] FIREBASE_PRIVATE_KEY
  - [ ] FIREBASE_CLIENT_EMAIL
  - [ ] FIREBASE_STORAGE_BUCKET
- [ ] Click "Deploy"
- [ ] Deployment succeeds

## ✅ Post-Deployment Testing

- [ ] Access Vercel URL
- [ ] Form works on desktop
- [ ] Form works on mobile
- [ ] Camera permission request appears
- [ ] Image capture works
- [ ] Upload completes
- [ ] Images appear in Firebase Storage
- [ ] Student metadata saved correctly

## ✅ Documentation

- [ ] Send deployment link to students
- [ ] Create usage instructions
- [ ] Test with 1-2 students first
- [ ] Troubleshoot any issues
- [ ] Document any custom changes

## ✅ Team Communication

- [ ] Send link to all teachers/coordinators
- [ ] Brief on how to use
- [ ] Test with small group (1 class)
- [ ] Gather feedback
- [ ] Make adjustments if needed

## ✅ Data Management

- [ ] Verify images downloading correctly from Firebase
- [ ] Test `sync_firebase_dataset.py` script
- [ ] Process downloaded images with `make_dataset.py`
- [ ] Enroll faces with `enroll_local.py`
- [ ] Test recognition with `main.py`

## ✅ Monitoring

- [ ] Check Vercel logs regularly
- [ ] Monitor Firebase Storage usage
- [ ] Track upload success rates
- [ ] Document any errors
- [ ] Have backup of downloaded images

## 🔄 Weekly Checklist

Every Sunday (or your maintenance day):
- [ ] Check Vercel logs for errors
- [ ] Download latest images from Firebase
- [ ] Backup images locally
- [ ] Check Firebase Storage quota
- [ ] Review deployment performance
- [ ] Update team on progress

## ❌ Troubleshooting Checklist

If something breaks:
- [ ] Check Vercel logs
- [ ] Check Firebase console
- [ ] Verify environment variables
- [ ] Test locally first
- [ ] Check browser console for errors
- [ ] Verify API_KEY is correct
- [ ] Clear browser cache and try again

## 📱 Browser Compatibility

Test on:
- [ ] Chrome (Desktop)
- [ ] Firefox (Desktop)
- [ ] Safari (Desktop)
- [ ] Chrome (Mobile)
- [ ] Safari (iOS)

## 🔐 Security Checklist

- [ ] Environment variables not committed to Git
- [ ] `.env.local` added to `.gitignore`
- [ ] Private keys not exposed in logs
- [ ] HTTPS enabled (Vercel provides this)
- [ ] Firebase rules restrict public access
- [ ] Only authenticated uploads allowed

## 📊 Success Metrics

- [ ] 90%+ of students capture images successfully
- [ ] Average upload time < 30 seconds
- [ ] < 1% upload failure rate
- [ ] Images organized correctly in Firebase
- [ ] Recognition accuracy meets requirements

## 📝 Notes & Custom Changes

Document any customizations made:
- [ ] Modified form fields? List them:
- [ ] Changed colors/styling? Describe:
- [ ] Added validators? Explain:
- [ ] Custom API integration? Document:

---

**Status**: Ready for deployment ✅ / On Hold ⏸️ / Issues Found ❌

**Last Updated**: ________________

**Deployed By**: ________________

**Live URL**: ________________
