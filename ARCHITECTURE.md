# System Architecture Overview

## 📐 Application Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    FACIAL ATTENDANCE SYSTEM v2.0                │
└─────────────────────────────────────────────────────────────────┘

1️⃣  ENROLLMENT PAGE (/)
   ├─ Student ID lookup via Binus API
   ├─ Camera capture (3-level fallback)
   ├─ Multi-step workflow (info → capture → upload)
   └─ Images stored in Firebase Storage

2️⃣  LOGGING SYSTEM (/api/dashboard/logs)
   ├─ Captures all system events
   ├─ Stores in Firestore: dashboard_logs collection
   ├─ Event types: search, capture, failure, accuracy
   └─ Used by Dashboard & Analytics

3️⃣  ANALYTICS ENGINE (/api/dashboard/analytics)
   ├─ Queries Firestore for logs
   ├─ Calculates KPIs: searches, captures, failures, accuracy
   ├─ Supports timeframes: 24h, 7d, 30d
   └─ Returns top students & trends

4️⃣  ATTENDANCE SYSTEM (/api/dashboard/attendance)
   ├─ Records face recognition matches
   ├─ Auto-calculates status: on_time | late | early
   ├─ Syncs with Binus API
   └─ Stores in Firestore: attendance_records collection

5️⃣  REPORT GENERATION (/api/dashboard/claude-report)
   ├─ Fetches attendance data
   ├─ Sends to Claude API for analysis
   ├─ Generates natural language reports
   └─ Stores results in Firestore: generated_reports collection

6️⃣  DASHBOARD PAGE (/dashboard)
   ├─ Displays real-time analytics
   ├─ Shows KPI cards & metrics
   ├─ Filterable log tables
   └─ Generate AI reports button

7️⃣  ATTENDANCE PAGE (/attendance-records)
   ├─ Complete attendance history
   ├─ Color-coded status badges
   ├─ Multi-filter search
   └─ CSV export functionality
```

## 🔄 Data Flow

```
ENROLLMENT
   ↓
Student submits ID → Binus API lookup → Student info stored
   ↓
Camera capture → Face processing → Image to Firebase Storage
   ↓
Upload submission → Create log entry → Firestore: dashboard_logs
   ↓
Dashboard queries logs → Analytics calculated → Real-time display

ATTENDANCE TRACKING
   ↓
Face recognition match detected → Create attendance record
   ↓
Calculate status (early/on_time/late)
   ↓
Store in Firestore: attendance_records
   ↓
Sync with Binus API: /bss-add-simprug-attendance-fr
   ↓
Display in Attendance Records page

AI REPORTING
   ↓
Request report generation → Query attendance data
   ↓
Send to Claude API → Generate insights
   ↓
Store result → Display in Dashboard
```

## 🗂️ File Structure

```
web-dataset-collector/
├── pages/
│   ├── index.js                          ← Main enrollment page
│   ├── dashboard.js                      ← NEW: Analytics dashboard
│   ├── attendance-records.js             ← NEW: Attendance history
│   └── api/
│       ├── student/
│       │   ├── lookup.js                 ← Student search (Binus API)
│       │   └── metadata.js               ← Save student info
│       ├── face/
│       │   └── upload.js                 ← Face image upload
│       └── dashboard/
│           ├── logs.js                   ← NEW: Event logging
│           ├── analytics.js              ← NEW: KPI calculation
│           ├── attendance.js             ← NEW: Attendance recording
│           └── claude-report.js          ← NEW: AI report generation
├── styles/
│   ├── index.module.css                  ← Main styling (updated with nav)
│   ├── dashboard.module.css              ← NEW: Dashboard styling
│   └── attendance.module.css             ← NEW: Attendance styling
├── .env.local                            ← Firebase & API credentials
├── package.json                          ← Dependencies
├── vercel.json                           ← Vercel configuration
└── DASHBOARD_SYSTEM.md                   ← NEW: Documentation
```

## 🔌 External API Integration

### Binus School API
```
Base URL: https://api.binus.ac.id

1. Authentication
   GET /auth/token
   Response: { access_token, token_type }

2. Student Lookup
   POST /bss-student-enrollment
   Body: { IdStudent }
   Response: { studentName, gradeCode, gradeName, className }

3. Photo Retrieval
   POST /bss-get-simprug-studentphoto-fr
   Body: { Grade, Homeroom, IdStudentList }
   Response: { photoUrls[], studentNames[] }

4. Attendance Sync
   POST /bss-add-simprug-attendance-fr
   Body: { IdStudent, IdBinusian, ImageDesc, UserAction }
   Response: { success, message }
```

### Claude API (Anthropic)
```
Base URL: https://api.anthropic.com/v1

Model: claude-3-5-sonnet-20241022
Endpoint: /messages
Method: POST

Request:
{
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 1024,
  messages: [
    {
      role: "user",
      content: "attendance analysis prompt..."
    }
  ]
}

Response:
{
  content: [
    {
      type: "text",
      text: "generated report..."
    }
  ]
}
```

### Firebase Services
```
1. Firestore Database
   - Collections: dashboard_logs, attendance_records, generated_reports
   - Real-time sync capability
   - Automatic timestamps

2. Firebase Storage
   - Face images stored in: faces/{studentId}/{timestamp}.jpg
   - Public URLs for display

3. Authentication
   - Service account credentials
   - Admin SDK access
```

## 📊 Database Schema

### dashboard_logs Collection
```
Document ID: auto-generated
{
  logType: "search" | "capture" | "failure" | "accuracy",
  studentId: "1234567",
  studentName: "John Doe",
  className: "10-A",
  details: "Face recognition confidence: 0.95",
  accuracy: 0.95,  // 0-1 range
  timestamp: Timestamp(2024-01-15T10:30:00Z),
  createdAt: Timestamp(server-side)
}
```

### attendance_records Collection
```
Document ID: auto-generated
{
  studentId: "1234567",
  studentName: "John Doe",
  className: "10-A",
  accuracy: 0.98,  // Face recognition accuracy
  timestamp: Timestamp(2024-01-15T07:05:00Z),
  date: "2024-01-15",
  time: "07:05:00",
  status: "on_time" | "late" | "early",
  method: "face_recognition" | "manual" | "api",
  binusSync: true,
  createdAt: Timestamp(server-side)
}
```

### generated_reports Collection
```
Document ID: auto-generated
{
  type: "daily" | "weekly" | "monthly" | "class_summary",
  className: "all" | "10-A",
  date: "2024-01-15",
  statistics: {
    totalPresent: 45,
    totalLate: 8,
    totalEarly: 3,
    uniqueStudents: 45,
    averageAccuracy: 0.96,
    byClass: {
      "10-A": { present: 15, late: 2, early: 1 },
      ...
    }
  },
  reportText: "markdown formatted report...",
  createdAt: Timestamp(server-side)
}
```

## 🔐 Security Features

```
✅ Firebase Authentication
   - Service account credentials stored in .env.local
   - All data access through authenticated endpoints

✅ API Rate Limiting
   - Binus API: inherent rate limiting
   - Claude API: per-user quota

✅ Data Validation
   - Input sanitization on all endpoints
   - Type checking on Firebase writes

✅ Error Handling
   - Graceful fallbacks (Claude report generation)
   - Detailed error logging
   - User-friendly error messages

✅ CORS Protection
   - API routes only accept from same origin
   - CSRF protection via Next.js
```

## 📈 Performance Optimization

```
✅ Real-time Dashboard
   - 30-second auto-refresh interval
   - Efficient Firestore queries with indexes
   - Client-side caching where possible

✅ Image Optimization
   - Multi-level camera fallback
   - Compressed uploads
   - Firebase Storage CDN

✅ API Optimization
   - Request batching where possible
   - Timeout handling (30s for API calls)
   - Fallback responses

✅ Frontend Optimization
   - CSS Modules (scoped styles)
   - Lazy loading of pages
   - Responsive images
```

## 🚀 Deployment Checklist

- [x] All API endpoints created and tested locally
- [x] React pages built and styled
- [x] Firebase Firestore collections configured
- [x] Environment variables set in .env.local
- [x] Git commits pushed to make-dataset remote
- [ ] Claude API key added to Vercel
- [ ] Binus API credentials verified
- [ ] Vercel deployed: `vercel --prod`
- [ ] DNS/domain configured (if needed)
- [ ] Monitoring & analytics configured
- [ ] Backup strategy for Firestore

## 📱 Responsive Design

```
Desktop (1024px+)
├── Full 3-column dashboard
├── Expanded tables
└── Side-by-side metrics

Tablet (768px-1023px)
├── 2-column layout
├── Adjusted font sizes
└── Mobile-friendly navigation

Mobile (< 768px)
├── Single column
├── Stacked cards
├── Hamburger menu (if needed)
└── Touch-optimized buttons
```

## 📞 Support & Troubleshooting

### Common Issues & Solutions

**1. Firebase credentials not loading**
   - Check `.env.local` file exists
   - Verify all FIREBASE_* variables are set
   - Run: `cat .env.local | grep FIREBASE`

**2. Binus API connection issues**
   - Verify API_KEY is correct
   - Check network connectivity
   - Review API response logs

**3. Claude API not generating reports**
   - Ensure CLAUDE_API_KEY is set in Vercel
   - Check Claude API account quota
   - Review error logs for rate limiting

**4. Attendance sync failing**
   - Verify Binus API token is valid
   - Check student ID format
   - Review Binus API documentation

**5. Dashboard not loading**
   - Clear browser cache
   - Check Network tab for API errors
   - Verify Firestore collections exist

---

## 🎯 Summary

Your **facial attendance system** is now complete with:

✅ **Real-time analytics** - See all facial recognition activity
✅ **Attendance tracking** - Automatic status calculation (early/on-time/late)
✅ **AI reporting** - Claude-powered insights and summaries
✅ **Binus integration** - Automatic attendance sync
✅ **Dashboard UI** - Professional cybersecurity theme
✅ **Export capability** - CSV download of records

Ready for **production deployment** to Vercel! 🚀
