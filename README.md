# Facial Attendance - Web Dataset Collector

A **minimal, Vercel-ready web application** for collecting facial dataset images from multiple stations. Students can enter their details and capture face images directly from the browser, which are then uploaded to Firebase Storage.

## 🎯 Features

- ✅ **Student Self-Service**: Students enter ID, name, and class
- ✅ **Live Camera Capture**: Real-time webcam access with image preview
- ✅ **Multiple Image Capture**: Collect 3-5 images per student
- ✅ **Firebase Integration**: Secure cloud storage for face images
- ✅ **API Lookup**: Auto-populate student info from Binus API (optional)
- ✅ **Responsive Design**: Works on desktop and mobile devices
- ✅ **Vercel Ready**: Deploy with one click, no backend infrastructure needed
- ✅ **Zero Installation**: Team can use directly via URL

## 📋 Architecture

```
web-dataset-collector/
├── api/
│   └── index.js              # Express.js backend (serverless)
├── pages/
│   ├── _app.js               # Next.js app wrapper
│   ├── _document.js          # HTML document
│   └── index.js              # Main React component
├── styles/
│   └── index.module.css      # Styling
├── package.json              # Dependencies
├── next.config.js            # Next.js config
├── vercel.json               # Vercel deployment config
└── .env.example              # Environment variables template
```

## 🚀 Quick Start

### Local Development

1. **Install dependencies:**
   ```bash
   cd web-dataset-collector
   npm install
   ```

2. **Set up environment variables:**
   ```bash
   cp .env.example .env.local
   ```

3. **Add your credentials to `.env.local`:**
   ```
   API_KEY=YOUR_BINUS_API_KEY
   FIREBASE_PROJECT_ID=your-project-id
   FIREBASE_PRIVATE_KEY=your-private-key
   FIREBASE_CLIENT_EMAIL=your-email@appspot.gserviceaccount.com
   FIREBASE_STORAGE_BUCKET=your-bucket.appspot.com
   ```

4. **Run development server:**
   ```bash
   npm run dev
   ```
   Open http://localhost:3000

### 📦 Get Firebase Credentials

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Create a new project or use existing one
3. Enable **Storage** in the project
4. Go to **Project Settings** → **Service Accounts**
5. Click **Generate New Private Key**
6. Copy credentials to `.env.local`

### Get Binus API Key

Your API_KEY should be the base64 encoded string from your Binus School API:
- Format: `API_KEY=<your-base64-encoded-api-key>`

## 🌐 Deploy to Vercel

### Recommended: Standalone PickupGuard Project

Deploy this folder as its own Vercel project (same approach as the mobile app):

1. In Vercel, create a new project from this repository.
2. Set Root Directory to `web-dataset-collector`.
3. Keep framework as `Next.js`.
4. Add environment variables from `.env.example`.
5. Deploy and test these routes:
  - `/pickup/tv`
  - `/v2/pickup-admin`
  - `/api/pickup/tv/feed`

For TV devices, pairing flow works from the deployed host directly (no localhost dependency).

### Option 1: Using Vercel CLI

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
cd web-dataset-collector
vercel
```

### Option 2: Using GitHub

1. Push your repo to GitHub
2. Go to [vercel.com](https://vercel.com)
3. Click "New Project"
4. Import your GitHub repository
5. Configure environment variables in Vercel dashboard
6. Deploy!

### Option 3: Vercel Dashboard

1. Go to https://vercel.com/dashboard
2. Click "Add New..." → "Project"
3. Upload the `web-dataset-collector` folder
4. Add environment variables
5. Deploy

## ⚙️ Environment Variables (Vercel)

In your Vercel project settings, add these environment variables:

| Variable | Example | Description |
|----------|---------|-------------|
| `API_KEY` | `OUQyQjdE...` | Binus School API authentication |
| `FIREBASE_PROJECT_ID` | `binus-facial-attendance` | Firebase project ID |
| `FIREBASE_PRIVATE_KEY` | `-----BEGIN PRIVATE KEY-----...` | Firebase private key |
| `FIREBASE_CLIENT_EMAIL` | `firebase-adminsdk-xxx@appspot.gserviceaccount.com` | Firebase service account email |
| `FIREBASE_STORAGE_BUCKET` | `binus-facial-attendance.appspot.com` | Firebase storage bucket |
| `TENANT_ID` | `binus-simprug` | Tenant id for pickup collections |
| `PICKUP_TV_TOKEN` | `random-long-token` | Shared token for legacy TV URL mode |
| `SESSION_SECRET` | `random-long-secret` | Session signing secret for dashboard auth |
| `CONSENT_SIGNING_SECRET` | `random-long-secret` | Signing key for pickup onboarding tokens |

**⚠️ Important:** When copying `FIREBASE_PRIVATE_KEY`, make sure to replace all `\n` with actual newlines, or escape them properly.

## 📸 How It Works

### Step 1: Student Information
- Student enters: Binusian ID, Full Name, Class
- System (optional) looks up info from Binus API
- Metadata is saved to Firebase

### Step 2: Face Capture
- Browser requests camera permission
- Student positions themselves in good lighting
- Clicks "Capture" button to take photos
- Can capture 3-5 images from different angles
- Images preview before upload

### Step 3: Upload
- Images are compressed and uploaded to Firebase Storage
- Organized as: `face_dataset/{class}/{name}/{timestamp}.jpg`
- Metadata saved as JSON
- Confirmation displayed

## 🔗 API Endpoints

### `POST /api/student/lookup`
Lookup student information from Binus API
```json
{
  "studentId": "2401234567"
}
```

### `POST /api/face/upload`
Upload face image
```
Body: multipart/form-data
- image: File (JPEG)
- studentId: string
- studentName: string
- className: string (optional)
- position: string (e.g., "front", "left_side")
```

### `POST /api/student/metadata`
Save student metadata
```json
{
  "studentId": "2401234567",
  "studentName": "John Doe",
  "className": "1A"
}
```

### `GET /api/student/{studentId}/progress`
Get student's capture progress

### `GET /api/health`
Health check endpoint

## 📂 Storage Structure

Images are organized in Firebase Storage as:
```
face_dataset/
├── 1A/
│   ├── John Doe/
│   │   ├── metadata.json
│   │   ├── 1699534200000_front.jpg
│   │   ├── 1699534205000_left_side.jpg
│   │   └── 1699534210000_right_side.jpg
│   └── Jane Smith/
│       └── ...
└── 2B/
    └── ...
```

## 🔒 Security Considerations

1. **Firebase Security Rules**: Set up proper rules for your storage bucket
2. **API Authentication**: Validate API_KEY in production
3. **Rate Limiting**: Consider adding rate limiting for uploads
4. **CORS**: Configure CORS for your domain
5. **HTTPS**: Vercel provides free HTTPS by default

### Example Firebase Storage Rules

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /face_dataset/{allPaths=**} {
      // Allow read for authenticated users
      allow read: if request.auth != null;
      // Allow write for authenticated users
      allow write: if request.auth != null;
    }
  }
}
```

## 🎨 Customization

### Change Colors
Edit `styles/index.module.css`:
- Primary gradient: `#667eea` to `#764ba2`
- Accent colors for buttons, alerts, etc.

### Modify Form Fields
Edit `pages/index.js` in the `InfoStep` component:
```jsx
<div className={styles.form_group}>
  <label>Custom Field *</label>
  <input type="text" value={field} onChange={...} />
</div>
```

### Change Image Count
Edit line in `CaptureStep`:
```javascript
const TARGET_IMAGES = 5; // Change this
```

## 🐛 Troubleshooting

### Camera Permission Denied
- Check browser permissions (Settings → Privacy)
- Use HTTPS (required for camera access)
- Try a different browser

### Firebase Upload Fails
- Verify Firebase credentials in `.env`
- Check Firebase Storage is enabled
- Verify storage bucket has public write access

### API Lookup Not Working
- Ensure `API_KEY` is correct
- Check network tab for API errors
- Verify Binus API endpoint is reachable

### Images Not Showing
- Check Firebase Storage path structure
- Verify bucket permissions
- Check CORS settings

## 📊 Monitoring

Monitor uploads in:
1. **Firebase Console**: Storage → Browser
2. **Vercel Logs**: Dashboard → Deployments → Logs
3. **Network Tab**: Browser DevTools

## 📝 Next Steps After Collection

After students collect images using this app:

1. **Download from Firebase**: Use Firebase Admin SDK to batch download
2. **Process with main.py**: Use your existing `make_dataset.py` logic
3. **Enroll faces**: Run `enroll_local.py` to create encodings
4. **Use in attendance system**: Run `main.py` for attendance tracking

## 🔄 Batch Download Script

Create `download_dataset.py` in parent directory:

```python
from firebase_admin import storage
import os

def download_all_faces(local_dir="face_dataset_web"):
    bucket = storage.bucket()
    blobs = bucket.list_blobs(prefix="face_dataset/")
    
    for blob in blobs:
        # Create local path
        local_path = os.path.join(local_dir, blob.name)
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        
        # Download file
        blob.download_to_filename(local_path)
        print(f"Downloaded: {blob.name}")

if __name__ == "__main__":
    download_all_faces()
```

## 📞 Support

For issues or questions:
1. Check troubleshooting section
2. Review API error messages in browser console
3. Check Firebase Console for storage errors
4. Review Vercel deployment logs

## 📄 License

Same as parent project

## 🎓 Credits

Built for Binus School AI Club - Facial Attendance System
