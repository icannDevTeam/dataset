import Busboy from 'busboy';
import { getFirebaseStorage, getFirestoreDB, initializeFirebase } from '../../../lib/firebase-admin';

// Disable Next.js body parser — we handle multipart ourselves
export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
  maxDuration: 30,
};

// Parse multipart form data using busboy (reliable on Vercel, no temp files needed)
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    // Buffer the raw body first — Vercel may overwrite content-type header
    const bodyChunks = [];
    req.on('data', (chunk) => bodyChunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      const rawBody = Buffer.concat(bodyChunks);

      // Fix content-type if Vercel's proxy overwrote it to application/json
      let headers = { ...req.headers };
      const ct = headers['content-type'] || '';
      if (!ct.includes('multipart/form-data')) {
        const bodyStart = rawBody.toString('utf8', 0, Math.min(200, rawBody.length));
        if (bodyStart.startsWith('-')) {
          // Multipart body lines start with --<boundary>, strip only the leading --
          const boundary = bodyStart.split('\r\n')[0].substring(2);
          headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
          console.log('Fixed content-type. Extracted boundary:', boundary);
        }
      }

      const fields = {};
      const files = {};

      const busboy = Busboy({
        headers,
        limits: { fileSize: 10 * 1024 * 1024 },
      });

      busboy.on('field', (name, val) => {
        fields[name] = val;
      });

      busboy.on('file', (name, stream, info) => {
        const fileChunks = [];
        stream.on('data', (chunk) => fileChunks.push(chunk));
        stream.on('end', () => {
          const buf = Buffer.concat(fileChunks);
          files[name] = {
            buffer: buf,
            originalFilename: info.filename,
            mimetype: info.mimeType,
            size: buf.length,
          };
        });
      });

      busboy.on('finish', () => resolve({ fields, files }));
      busboy.on('error', reject);

      // Feed the buffered body to busboy
      busboy.end(rawBody);
    });
  });
}

import { withMetrics } from '../../../lib/metrics';

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Initialize Firebase
    initializeFirebase();

    console.log('\n=== UPLOAD REQUEST START ===');
    console.log('Content-Type:', req.headers['content-type']);
    
    // Parse multipart form data with busboy
    const { fields, files } = await parseMultipart(req);

    console.log('Form parsed. Fields:', Object.keys(fields), 'Files:', Object.keys(files));

    const studentId = fields.studentId;
    const studentName = fields.studentName;
    const className = fields.className;
    const gradeCode = fields.gradeCode || '';
    const gradeName = fields.gradeName || '';
    const photoNumber = fields.photoNumber || '1';
    const totalPhotos = fields.totalPhotos || '3';
    const imageFile = files.image;

    // Build the display label for attendance (e.g. "Albert Arthur 3B")
    const displayLabel = `${studentName} ${className}`;

    console.log(`Student: ${studentName}, ID: ${studentId}, Class: ${className}, Photo: ${photoNumber}/${totalPhotos}`);
    console.log(`Display Label: ${displayLabel}`);
    console.log(`Image file:`, imageFile ? `${imageFile.originalFilename} (${imageFile.size} bytes)` : 'MISSING');

    if (!studentId || !studentName || !className || !imageFile) {
      console.error('Missing required fields:', { studentId, studentName, className, hasImage: !!imageFile });
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: { studentId, studentName, className, hasImage: !!imageFile }
      });
    }

    // Validate MIME type — only accept actual image files
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedMimes.includes(imageFile.mimetype)) {
      return res.status(400).json({
        error: 'Invalid file type',
        details: `Only JPEG, PNG, and WebP images are accepted. Got: ${imageFile.mimetype}`
      });
    }

    // Validate magic bytes (file signature) to prevent MIME spoofing
    const header = imageFile.buffer.slice(0, 4);
    const isJPEG = header[0] === 0xFF && header[1] === 0xD8;
    const isPNG  = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47;
    const isWEBP = header.length >= 4 && imageFile.buffer.slice(8, 12).toString() === 'WEBP';
    if (!isJPEG && !isPNG && !isWEBP) {
      return res.status(400).json({
        error: 'Invalid image file',
        details: 'File content does not match a valid image format'
      });
    }

    // Sanitize path components to prevent directory traversal
    const safeName = (s) => {
      let clean = String(s).replace(/[^a-zA-Z0-9 _.-]/g, '');  // strip dangerous chars
      clean = clean.replace(/\.{2,}/g, '.');  // collapse ".." sequences to single dot
      clean = clean.replace(/^[.\s]+/, '');    // strip leading dots/spaces
      clean = clean.replace(/[.\s]+$/, '');    // strip trailing dots/spaces
      clean = clean.substring(0, 100);
      return clean || 'unknown';               // never return empty string
    };
    const safeStudentName = safeName(studentName);
    const safeClassName = safeName(className);
    const safeStudentId = safeName(studentId);

    console.log(`Processing photo ${photoNumber}/${totalPhotos} for ${displayLabel}`);

    // Image buffer is already in memory from busboy
    const imageBuffer = imageFile.buffer;
    console.log(`Image buffer: ${imageBuffer.length} bytes`);

    // Upload to Firebase Storage
    let uploadSuccess = false;
    let storageUrl = null;
    let uploadMethod = null;
    
    try {
      console.log('\n--- Uploading to Firebase Storage ---');
      
      const storage = getFirebaseStorage();
      const bucket = storage.bucket();
      console.log('Storage bucket connected:', bucket.name);
      
      // Path: face_dataset/{ClassName}/{StudentName}/photo_{number}_{timestamp}.jpg
      const fileName = `face_dataset/${safeClassName}/${safeStudentName}/photo_${photoNumber}_${Date.now()}.jpg`;
      console.log('Uploading file:', fileName);
      
      const file = bucket.file(fileName);
      await file.save(imageBuffer, {
        metadata: {
          contentType: 'image/jpeg',
          metadata: {
            studentId,
            studentName,
            className,
            gradeCode,
            gradeName,
            displayLabel,
            photoNumber,
            totalPhotos,
            capturedAt: new Date().toISOString()
          }
        }
      });

      storageUrl = `gs://${process.env.FIREBASE_STORAGE_BUCKET}/${fileName}`;
      uploadSuccess = true;
      uploadMethod = 'Firebase Storage';
      console.log(`Firebase upload successful: ${fileName}`);
    } catch (fbError) {
      console.error(`Firebase Storage error: ${fbError.message}`);
      console.error('Full error:', JSON.stringify(fbError, Object.getOwnPropertyNames(fbError), 2));
      // No local fallback on Vercel (read-only filesystem)
    }

    // Save image metadata to Firestore under the student document
    try {
      const db = getFirestoreDB();
      const imageMetadata = {
        fileName: imageFile.originalFilename || `photo_${photoNumber}.jpg`,
        fileSize: imageFile.size,
        photoNumber: parseInt(photoNumber),
        totalPhotos: parseInt(totalPhotos),
        uploadedAt: new Date().toISOString(),
        storageUrl,
        uploadMethod,
        // Full student context saved with each image
        studentId,
        studentName,
        className,
        gradeCode,
        gradeName,
        displayLabel, // "Albert Arthur 3B" - used for attendance display
      };

      await db.collection('students').doc(studentId).collection('images').add(imageMetadata);
      
      // Also update the student document with latest capture info
      await db.collection('students').doc(studentId).set({
        id: studentId,
        name: studentName,
        homeroom: className,
        gradeCode,
        gradeName,
        displayLabel,
        lastCaptureAt: new Date().toISOString(),
        totalImages: parseInt(photoNumber),
      }, { merge: true });

      console.log(`Firestore metadata saved for ${displayLabel}`);
    } catch (fsError) {
      console.log(`Firestore unavailable: ${fsError.message}`);
    }

    console.log('Upload complete\n');
    
    if (!uploadSuccess) {
      return res.status(500).json({ 
        error: 'Upload failed - no storage available'
      });
    }

    return res.status(200).json({
      success: true,
      message: `Photo ${photoNumber}/${totalPhotos} uploaded for ${displayLabel}`,
      uploadMethod,
      data: {
        studentId,
        studentName,
        className,
        gradeCode,
        gradeName,
        displayLabel,
        photoNumber,
        totalPhotos,
        size: imageFile.size,
        storageUrl
      }
    });

  } catch (error) {
    console.error('Upload error:', error);
    console.error('Error stack:', error.stack);
    return res.status(500).json({ 
      error: 'Upload failed'
    });
  }
}

export default withMetrics(handler);
