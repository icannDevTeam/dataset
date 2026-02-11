# 🔗 System Integration Guide

This document explains how the web dataset collector integrates with your existing facial attendance system.

## 📊 System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    BINUS SCHOOL NETWORK                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────┐         ┌──────────────────┐          │
│  │  WEB COLLECTOR   │         │   MAIN SYSTEM    │          │
│  │  (Vercel)        │         │   (Local)        │          │
│  ├──────────────────┤         ├──────────────────┤          │
│  │ • Student form   │         │ • Face detection │          │
│  │ • Camera capture │  ────►  │ • Recognition    │          │
│  │ • Image upload   │         │ • Attendance     │          │
│  └──────────────────┘         └──────────────────┘          │
│           │                            ▲                    │
│           │                            │                    │
│           ▼                            │                    │
│  ┌─────────────────────────────────────┘                    │
│  │                                                           │
│  │  ┌──────────────────────────────────────┐               │
│  │  │   FIREBASE STORAGE                   │               │
│  │  │  (Shared Dataset)                    │               │
│  │  ├──────────────────────────────────────┤               │
│  │  │  face_dataset/                       │               │
│  │  │  ├── 1A/John Doe/                    │               │
│  │  │  │   ├── metadata.json               │               │
│  │  │  │   └── images (1-5)                │               │
│  │  │  └── 2B/Jane Smith/                  │               │
│  │  │      └── ...                         │               │
│  │  └──────────────────────────────────────┘               │
│  │                                                           │
│  │  ┌──────────────────────────────────────┐               │
│  │  │   BINUS API                          │               │
│  │  │  (Student Info Lookup)               │               │
│  │  ├──────────────────────────────────────┤               │
│  │  │  • GET student by ID                 │               │
│  │  │  • GET class info                    │               │
│  │  │  • Token authentication              │               │
│  │  └──────────────────────────────────────┘               │
│  │                                                           │
└─────────────────────────────────────────────────────────────┘
```

## 🔄 Data Flow

### 1️⃣ Face Collection Phase

```
Student (on Vercel)
    ↓
[Enter Student Info]
    ↓ (API Call)
Binus API [Lookup student name/class]
    ↓ (Response)
[Camera Capture - 3-5 images]
    ↓
[Compress & Encode]
    ↓
Firebase Storage [Save images]
    ↓
Metadata JSON [Save student info]
    ↓ (Email notification - optional)
Team Lead/Admin
```

### 2️⃣ Dataset Processing Phase

```
Firebase Storage [Downloaded locally]
    ↓
make_dataset.py [Organize & validate]
    ↓
face_dataset/
├── 1A/
│   └── Student Name/
│       ├── metadata.json
│       ├── 001.jpg
│       ├── 002.jpg
│       └── 003.jpg
```

### 3️⃣ Model Enrollment Phase

```
face_dataset/ (local)
    ↓
enroll_local.py [Generate embeddings]
    ↓
encodings.pickle [Store face vectors]
    ↓
Known faces database
```

### 4️⃣ Attendance System Phase

```
Camera (Real-time)
    ↓
main.py [Detect & recognize]
    ↓
encodings.pickle [Compare embeddings]
    ↓
attendance.json [Log attendance]
```

## 📦 Dependencies & Credentials

### What You Need

| Component | Source | How to Get |
|-----------|--------|-----------|
| **API_KEY** | Binus School | From your school account |
| **Firebase Project** | Google Cloud | Create at console.firebase.google.com |
| **Storage Bucket** | Firebase | Auto-created with project |
| **Service Account** | Firebase | Generate private key in settings |

### Credentials File Mapping

```
┌─────────────────────────────────────────────┐
│  Current System (.env)                      │
├─────────────────────────────────────────────┤
│  API_KEY=OUQyQjdE...  ────────┐             │
└─────────────────────────────────┼───────────┘
                                   │
                    ┌──────────────┘
                    ▼
┌─────────────────────────────────────────────┐
│  Web Collector (.env.local)                 │
├─────────────────────────────────────────────┤
│  API_KEY=OUQyQjdE... (same)                 │
│  FIREBASE_PROJECT_ID=...                    │
│  FIREBASE_PRIVATE_KEY=...                   │
│  FIREBASE_CLIENT_EMAIL=...                  │
│  FIREBASE_STORAGE_BUCKET=...                │
└─────────────────────────────────────────────┘
```

## 🔌 API Integration Details

### Current System (main.py)

```python
# Uses api_integrate.py for:
- get_auth_token()          # Get API token
- get_student_by_id_c2()    # Lookup student info
- write_student_report()    # Generate CSV
- generate_dashboard()      # Generate HTML
```

### Web Collector

```
POST /api/student/lookup
├─ Uses same API_KEY
├─ Calls Binus API endpoints
└─ Returns student name & class

POST /api/face/upload
├─ Firebase Storage SDK
├─ Stores organized images
└─ Public URLs for reference
```

## 📥 Downloading Images from Firebase

After students upload images, download them for local processing:

### Option 1: Firebase Console
1. Go to Firebase Console → Storage
2. Browse `face_dataset/` folder
3. Download manually

### Option 2: Python Script

Create `sync_firebase_dataset.py`:

```python
import os
import firebase_admin
from firebase_admin import credentials, storage
from dotenv import load_dotenv

load_dotenv()

# Initialize Firebase
cred = credentials.Certificate({
    'type': 'service_account',
    'project_id': os.getenv('FIREBASE_PROJECT_ID'),
    'private_key': os.getenv('FIREBASE_PRIVATE_KEY').replace('\\n', '\n'),
    'client_email': os.getenv('FIREBASE_CLIENT_EMAIL'),
})

firebase_admin.initialize_app(cred, {
    'storageBucket': os.getenv('FIREBASE_STORAGE_BUCKET')
})

def download_dataset():
    """Download all face images from Firebase to local face_dataset/"""
    bucket = storage.bucket()
    blobs = bucket.list_blobs(prefix='face_dataset/')
    
    downloaded = 0
    for blob in blobs:
        local_path = blob.name
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        
        print(f"⬇️  Downloading: {blob.name}")
        blob.download_to_filename(local_path)
        downloaded += 1
    
    print(f"\n✅ Downloaded {downloaded} files")

if __name__ == '__main__':
    download_dataset()
```

Usage:
```bash
python3 sync_firebase_dataset.py
```

### Option 3: Automated Sync

Add to cron (runs every hour):
```bash
0 * * * * cd /path/to/facial-attendance-v2 && python3 sync_firebase_dataset.py
```

## 🔐 Security & Access Control

### Shared Credentials (.env)

Both systems use the same `API_KEY`:

**Main System** (`/home/pandora/facial-attendance-v2/.env`):
```
API_KEY=OUQyQjdE...
```

**Web Collector** (`web-dataset-collector/.env.local`):
```
API_KEY=OUQyQjdE... (copy same value)
```

### Firebase Access

**Storage Rules** - Allow collection but organize by student:

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /face_dataset/{class}/{student}/{image} {
      // Allow all authenticated users to write
      allow create, write: if request.auth != null;
      // Allow read by authenticated users
      allow read: if request.auth != null;
      // Metadata is readable
      allow read: if resource.name.endsWith('metadata.json');
    }
    // Block direct bucket access
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

## 🎯 Complete Workflow

### Week 1: Setup
```bash
# 1. Setup Firebase project
# 2. Get credentials
# 3. Deploy web collector to Vercel
# 4. Share URL with students
```

### Week 2: Collection
```
Students capture images on Vercel
↓
Images upload to Firebase
↓
Team lead notified of progress
```

### Week 3: Processing
```bash
# Download images locally
python3 sync_firebase_dataset.py

# Organize locally
python3 make_dataset.py

# Enroll faces
python3 enroll_local.py

# Verify encodings
ls -la encodings.pickle
```

### Week 4+: Attendance
```bash
# Run attendance system
python3 main.py
```

## 🚨 Common Integration Issues

### Issue: Images not appearing locally after download

**Solution:**
```bash
# Check folder structure
find face_dataset/ -type f | head -20

# Verify permissions
ls -la face_dataset/*/
```

### Issue: API lookup returns wrong student info

**Solution:**
- Verify `API_KEY` is correct in both systems
- Check Binus API endpoint URL in `api_integrate.py`
- Test manually: `python3 main.py --lookup-id 2401234567`

### Issue: Firebase storage quota exceeded

**Solution:**
- Delete old images: Go to Firebase Console → Storage
- Implement cleanup script to archive old data
- Adjust retention policy

## 📊 Monitoring & Logs

### Web Collector Logs
- Vercel Dashboard → Deployments → Logs
- Real-time visibility of uploads
- Error tracking

### Download Logs
```bash
# See what was downloaded
grep "Downloading" sync_firebase_dataset.py.log

# Check file counts
find face_dataset/ -type f | wc -l
```

### Attendance System Logs
```bash
# View attendance records
cat data/attendance/*.json | jq '.'

# Check for recognition errors
grep "Error" facial_recognition_security.log
```

## 🔄 Backup & Recovery

### Backup Firebase to Local
```bash
# Create backup before processing
cp -r face_dataset/ face_dataset_backup_$(date +%Y%m%d)

# Or sync and backup
python3 sync_firebase_dataset.py
tar czf face_dataset_backup.tar.gz face_dataset/
```

### Firebase Automatic Backups
Enable in Firebase Console → Backups section

## 📈 Scaling Tips

### For Multiple Classes
- Students enter class automatically
- Images organized by: `face_dataset/1A/Student Name/`
- Process multiple classes simultaneously

### For Large Batches
```bash
# Process in parallel
python3 sync_firebase_dataset.py --parallel 4

# Then process locally
python3 make_dataset.py --process-all
```

### For Real-time Sync
```bash
# Run sync in background
nohup watch -n 300 'python3 sync_firebase_dataset.py' &
```

## 🎓 Next Steps

1. **Deploy web collector** (10 min)
2. **Share with students** (send URL)
3. **Monitor uploads** (Vercel dashboard)
4. **Download when complete** (Python script)
5. **Process locally** (existing pipeline)
6. **Run attendance system** (main.py)

---

**Questions?** Check individual README files:
- `web-dataset-collector/README.md` - Web app details
- `../README.md` - Main system details
