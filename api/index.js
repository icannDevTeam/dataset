const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

// Initialize Firebase Admin
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
};

try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
  }
} catch (error) {
  console.error('Firebase initialization error:', error);
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// LOOKUP STUDENT INFO (using Binus API - C2)
// ============================================
app.post('/api/student/lookup', async (req, res) => {
  try {
    const { studentId } = req.body;
    
    if (!studentId) {
      return res.status(400).json({ error: 'studentId is required' });
    }

    const axios = require('axios');
    const apiKey = process.env.API_KEY;
    
    if (!apiKey) {
      return res.status(500).json({ error: 'API_KEY not configured' });
    }

    try {
      // Step 1: Get auth token from Binus API
      const tokenResponse = await axios.get(
        'http://binusian.ws/binusschool/auth/token',
        {
          headers: {
            'Authorization': `Basic ${apiKey}`
          },
          timeout: 10000
        }
      );

      if (!tokenResponse.data?.data?.token) {
        return res.status(401).json({ error: 'Failed to get auth token from Binus API' });
      }

      const token = tokenResponse.data.data.token;

      // Step 2: Call C2 Student Enrollment API to get student info
      const studentResponse = await axios.post(
        'http://binusian.ws/binusschool/bss-student-enrollment',
        { IdStudent: String(studentId) },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      const result = studentResponse.data;
      
      if (result?.resultCode === 200 && result?.studentDataResponse) {
        const studentData = result.studentDataResponse;
        
        // Extract fields - same as make_dataset.py logic
        const studentName = studentData.studentName || 
                           studentData.name || 
                           studentData.fullName || 
                           studentData.studentFullName ||
                           'Unknown';
        
        const homeroom = studentData.homeroom || 
                        studentData.class || 
                        studentData.className ||
                        'Unknown';

        const gradeCode = studentData.gradeCode || '';
        const gradeName = studentData.gradeName || '';

        return res.json({
          success: true,
          studentId,
          name: studentName,
          homeroom: homeroom,
          gradeCode: gradeCode,
          gradeName: gradeName,
          message: 'Student found'
        });
      } else {
        return res.status(404).json({ 
          error: 'Student not found',
          code: result?.resultCode,
          message: result?.errorMessage || 'Unknown error'
        });
      }

    } catch (apiError) {
      console.error('Binus API error:', apiError.message);
      
      // Return error details for debugging
      if (apiError.response?.data) {
        return res.status(apiError.response.status || 500).json({
          error: 'Binus API error',
          details: apiError.response.data
        });
      }
      
      return res.status(500).json({ 
        error: 'Failed to call Binus API',
        details: apiError.message 
      });
    }

  } catch (error) {
    console.error('Lookup error:', error.message);
    res.status(500).json({ error: 'Failed to lookup student', details: error.message });
  }
});

// ============================================
// UPLOAD FACE IMAGE
// ============================================
app.post('/api/face/upload', upload.single('image'), async (req, res) => {
  try {
    const { studentId, studentName, className, position } = req.body;
    
    if (!req.file || !studentId || !studentName) {
      return res.status(400).json({ 
        error: 'Missing required fields: image, studentId, studentName' 
      });
    }

    const bucket = admin.storage().bucket();
    
    // Create a unique path for the image
    const timestamp = Date.now();
    const filename = `face_dataset/${className || 'unknown'}/${studentName}/${timestamp}_${position || 'unknown'}.jpg`;
    
    const file = bucket.file(filename);
    
    // Upload to Firebase Storage
    await new Promise((resolve, reject) => {
      const writeStream = file.createWriteStream({
        metadata: {
          contentType: 'image/jpeg',
        }
      });

      writeStream.on('error', (err) => {
        console.error('Write stream error:', err);
        reject(err);
      });

      writeStream.on('finish', resolve);
      
      writeStream.end(req.file.buffer);
    });

    // Make the file publicly readable
    await file.makePublic();
    
    // Get public URL
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
    
    res.json({
      success: true,
      filename,
      url: publicUrl,
      message: 'Image uploaded successfully'
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Failed to upload image', 
      details: error.message 
    });
  }
});

// ============================================
// SAVE STUDENT METADATA
// ============================================
app.post('/api/student/metadata', async (req, res) => {
  try {
    const { studentId, studentName, className, gradeCode, gradeName } = req.body;
    
    if (!studentId || !studentName) {
      return res.status(400).json({ error: 'Missing required fields: studentId, studentName' });
    }

    const bucket = admin.storage().bucket();
    const metadataPath = `face_dataset/${className || 'unknown'}/${studentName}/metadata.json`;
    
    const metadata = {
      id: studentId,
      name: studentName,
      class: className,
      gradeCode: gradeCode || '',
      gradeName: gradeName || '',
      created_at: new Date().toISOString(),
      capture_count: 0
    };

    const file = bucket.file(metadataPath);
    
    await file.save(JSON.stringify(metadata, null, 2), {
      metadata: { contentType: 'application/json' }
    });

    await file.makePublic();
    
    res.json({
      success: true,
      message: 'Metadata saved successfully',
      path: metadataPath
    });

  } catch (error) {
    console.error('Metadata save error:', error);
    res.status(500).json({ 
      error: 'Failed to save metadata',
      details: error.message 
    });
  }
});

// ============================================
// GET STUDENT PROGRESS
// ============================================
app.get('/api/student/:studentId/progress', async (req, res) => {
  try {
    const { studentId } = req.params;
    
    if (!studentId) {
      return res.status(400).json({ error: 'studentId is required' });
    }

    // List all files for this student in Firebase
    const bucket = admin.storage().bucket();
    const [files] = await bucket.getFiles({
      prefix: `face_dataset/`
    });

    // Filter for this student (would need better filtering logic)
    const studentFiles = files.filter(f => 
      f.name.includes(studentId) || f.name.includes('metadata.json')
    );

    res.json({
      success: true,
      studentId,
      imageCount: studentFiles.length,
      files: studentFiles.map(f => ({
        name: f.name,
        size: f.metadata?.size,
        created: f.metadata?.timeCreated
      }))
    });

  } catch (error) {
    console.error('Progress check error:', error);
    res.status(500).json({ 
      error: 'Failed to check progress',
      details: error.message 
    });
  }
});

// Export for Vercel
module.exports = app;

// Start locally if not on Vercel
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}
