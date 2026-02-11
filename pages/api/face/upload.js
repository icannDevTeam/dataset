import formidable from 'formidable';
import fs from 'fs';
import os from 'os';
import { getFirebaseStorage, getFirestoreDB, initializeFirebase } from '../../../lib/firebase-admin';

// Disable Next.js body parser — formidable will handle it
export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
  maxDuration: 30,
};

// Helper: collect raw request body as a Buffer (Vercel sometimes pre-consumes the stream)
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Helper: parse multipart boundary from Content-Type
function getBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType || '');
  return match ? (match[1] || match[2]) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Initialize Firebase
    initializeFirebase();

    console.log('\n=== UPLOAD REQUEST START ===');
    console.log('Content-Type:', req.headers['content-type']);
    
    // Parse form data with formidable — force multipart plugin only
    const tmpDir = os.tmpdir();
    const form = formidable({
      uploadDir: tmpDir,
      keepExtensions: true,
      maxFileSize: 10 * 1024 * 1024,
      multiples: false,
      // Force multipart parser only — prevents JSON parser from activating
      enabledPlugins: ['multipart'],
    });

    const [fields, files] = await form.parse(req);

    console.log('Form parsed. Fields:', Object.keys(fields), 'Files:', Object.keys(files));

    const getField = (name) => {
      const val = fields[name];
      return Array.isArray(val) ? val[0] : val;
    };

    const studentId = getField('studentId');
    const studentName = getField('studentName');
    const className = getField('className');
    const gradeCode = getField('gradeCode') || '';
    const gradeName = getField('gradeName') || '';
    const photoNumber = getField('photoNumber') || '1';
    const totalPhotos = getField('totalPhotos') || '3';
    const imageFile = Array.isArray(files.image) ? files.image[0] : files.image;

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

    console.log(`Processing photo ${photoNumber}/${totalPhotos} for ${displayLabel}`);

    // Read image file
    const imageBuffer = fs.readFileSync(imageFile.filepath);
    console.log(`Image buffer read: ${imageBuffer.length} bytes`);

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
      const fileName = `face_dataset/${className}/${studentName}/photo_${photoNumber}_${Date.now()}.jpg`;
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

    // Clean up temp file
    try {
      fs.unlinkSync(imageFile.filepath);
    } catch (e) { /* ignore */ }

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
      error: 'Upload failed',
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 5)
    });
  }
}
