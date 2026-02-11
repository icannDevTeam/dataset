# 🔐 API Keys & Configuration Verification

## ✅ Firebase Configuration (For Firestore & Storage)

**Status**: ✅ **CONFIGURED**

```
FIREBASE_PROJECT_ID: facial-attendance-binus
FIREBASE_CLIENT_EMAIL: firebase-adminsdk-fbsvc@facial-attendance-binus.iam.gserviceaccount.com
FIREBASE_STORAGE_BUCKET: facial-attendance-binus.appspot.com
FIREBASE_PRIVATE_KEY_ID: 8fa52216a8de274cdc40cb79c6f7f35716b5447b
FIREBASE_PRIVATE_KEY: [✅ Loaded from .env.local]
```

**Used For**:
- Storing attendance records in `attendance_records` collection
- Storing event logs in `dashboard_logs` collection
- Storing generated reports in `generated_reports` collection
- Uploading face images to Firebase Storage

**API Endpoints Using This**:
- `/api/dashboard/attendance.js` (POST/GET)
- `/api/dashboard/logs.js` (POST/GET)
- `/api/dashboard/analytics.js` (GET)
- `/api/dashboard/claude-report.js` (POST)
- `/api/face/upload.js` (POST)

---

## ✅ Binus School API Configuration

**Status**: ✅ **CONFIGURED**

```
API_KEY: OUQyQjdEN0EtREFDQy00QkEyLTg3QTAtNUFGNDVDOUZCRTgy
Base URL: http://binusian.ws/binusschool
```

**Endpoints Used**:

### 1. **Authentication**
```
GET /auth/token
Headers: Authorization: Basic {API_KEY}
Response: { data: { token: "Bearer token..." } }
```

### 2. **Student Lookup**
```
POST /bss-student-enrollment
Headers: Authorization: Bearer {token}
Body: { IdStudent: "001234" }
Response: { studentName, gradeCode, gradeName, class }
```

### 3. **Attendance Sync** ⭐ **CRITICAL**
```
POST /bss-add-simprug-attendance-fr
Headers: Authorization: Bearer {token}
Body: {
  IdStudent: "001234",
  IdBinusian: "001234",
  ImageDesc: "Face Recognition Attendance",
  UserAction: "FR_SYSTEM"
}
```

### 4. **Photo Retrieval**
```
POST /bss-get-simprug-studentphoto-fr
Headers: Authorization: Bearer {token}
Body: { Grade, Homeroom, IdStudentList }
Response: { photoUrls, studentNames }
```

**API Endpoints Using This**:
- `/api/student/lookup.js` (Student search)
- `/api/dashboard/attendance.js` (Attendance sync on POST)

---

## 🔑 Environment Variables Checklist

| Variable | Status | Location | Used By |
|----------|--------|----------|---------|
| `FIREBASE_PROJECT_ID` | ✅ Set | `.env.local` | All Firebase APIs |
| `FIREBASE_CLIENT_EMAIL` | ✅ Set | `.env.local` | Firebase Admin SDK |
| `FIREBASE_PRIVATE_KEY` | ✅ Set | `.env.local` | Firebase Admin SDK |
| `FIREBASE_STORAGE_BUCKET` | ✅ Set | `.env.local` | Upload images |
| `API_KEY` | ✅ Set | `.env.local` | Binus Auth + Sync |
| `NODE_ENV` | ✅ Set | `.env.local` | development |
| `CLAUDE_API_KEY` | ⚠️ **TODO** | Not in `.env.local` | Report generation |

---

## ⚠️ Important: Attendance Recording Flow

When a student's face is recognized and attendance needs to be recorded:

1. **Local Firestore Storage** ✅
   ```javascript
   // Saved to: attendance_records collection
   {
     studentId: "001234",
     studentName: "Alisha Yuri Kang Chan",
     className: "10-A",
     accuracy: 0.987,
     timestamp: Date,
     status: "on_time" | "late" | "early",
     method: "face_recognition"
   }
   ```

2. **Binus API Sync** ✅ (via `/api/dashboard/attendance.js`)
   ```javascript
   // Called automatically on POST
   const token = await getAuthToken(API_KEY);
   await axios.post(
     'http://binusian.ws/binusschool/bss-add-simprug-attendance-fr',
     {
       IdStudent: studentId,
       IdBinusian: studentId,
       ImageDesc: 'Face Recognition Attendance',
       UserAction: 'FR_SYSTEM'
     },
     { headers: { Authorization: `Bearer ${token}` } }
   );
   ```

**Flow Diagram**:
```
Face Recognition Match
    ↓
POST /api/dashboard/attendance
    ↓
    ├→ Save to Firestore (LOCAL)
    ├→ Get Binus Token (using API_KEY)
    ├→ Sync to Binus API (using token)
    └→ Return success/error
```

---

## 📋 Pre-Deployment Verification

### ✅ Completed
- [x] Firebase credentials loaded
- [x] Binus API key configured
- [x] Attendance endpoint created with auto-sync
- [x] Mock data for UI testing
- [x] All collections defined (attendance_records, dashboard_logs, generated_reports)

### ⚠️ TODO Before Production
- [ ] Add `CLAUDE_API_KEY` to `.env.local` (for report generation)
- [ ] Add `CLAUDE_API_KEY` to Vercel environment variables
- [ ] Test Binus API token generation with real API_KEY
- [ ] Test attendance sync with real Binus school system
- [ ] Configure Firebase security rules for collections
- [ ] Set up Firebase backup/snapshot strategy
- [ ] Test attendance status calculation (early/on_time/late)
- [ ] Verify face image URL format for Binus API

---

## 🚀 Deployment Instructions

### For Vercel Deployment:

1. **Set Environment Variables in Vercel Dashboard**:
   ```
   FIREBASE_PROJECT_ID = facial-attendance-binus
   FIREBASE_PRIVATE_KEY_ID = 8fa52216a8de274cdc40cb79c6f7f35716b5447b
   FIREBASE_PRIVATE_KEY = [copy from .env.local]
   FIREBASE_CLIENT_EMAIL = firebase-adminsdk-fbsvc@facial-attendance-binus.iam.gserviceaccount.com
   FIREBASE_STORAGE_BUCKET = facial-attendance-binus.appspot.com
   API_KEY = OUQyQjdEN0EtREFDQy00QkEyLTg3QTAtNUFGNDVDOUZCRTgy
   CLAUDE_API_KEY = [Get from Anthropic & add here]
   NODE_ENV = production
   ```

2. **Deploy**:
   ```bash
   vercel --prod
   ```

3. **Verify Deployment**:
   - Dashboard: `https://[your-deployment].vercel.app/dashboard`
   - Attendance: `https://[your-deployment].vercel.app/attendance-records`
   - Enrollment: `https://[your-deployment].vercel.app/`

---

## 🔍 Testing Endpoints Locally

### Test Attendance Recording
```bash
curl -X POST http://localhost:3003/api/dashboard/attendance \
  -H "Content-Type: application/json" \
  -d '{
    "studentId": "001234",
    "studentName": "Test Student",
    "className": "10-A",
    "accuracy": 0.95,
    "method": "face_recognition"
  }'
```

### Test Analytics
```bash
curl http://localhost:3003/api/dashboard/analytics?timeframe=24h
```

### Test Logs
```bash
curl http://localhost:3003/api/dashboard/logs
```

---

## 💡 Notes

- **Binus API Rate Limiting**: Each API key has rate limits. Monitor token generation calls.
- **Firebase Costs**: Monitor Firestore read/write operations. Mock data prevents unnecessary writes.
- **Claude API**: Only billable when used for report generation. Falls back to formatted report if API fails.
- **Attendance Status Logic**: 
  - Early: Before 7:00 AM
  - On Time: 7:00 - 7:15 AM
  - Late: After 7:15 AM

---

## 📞 Support

If API calls fail:

1. **Binus API Issues**: Check API_KEY validity and token expiration
2. **Firebase Issues**: Verify credentials and Firestore permissions
3. **Claude Issues**: Check CLAUDE_API_KEY and API quota
4. **Network Issues**: Verify timeouts and retry logic (all set to 10-30s)

**All error messages are logged to server console for debugging.**
