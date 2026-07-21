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
import { withApi } from '../../../lib/api-auth';

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
    const normalizedClassName = String(className || '').trim();
    const storageClassName = normalizedClassName || 'UNASSIGNED';
    const gradeCode = fields.gradeCode || '';
    const gradeName = fields.gradeName || '';
    const photoNumber = fields.photoNumber || '1';
    const totalPhotos = fields.totalPhotos || '3';
    const imageFile = files.image;

    // Build the display label for attendance (e.g. "Albert Arthur 3B")
    const displayLabel = normalizedClassName ? `${studentName} ${normalizedClassName}` : studentName;

    // F-011 fix: do not log PII (student name/class) in production logs.
    console.log(`Upload: studentId=${studentId} photo=${photoNumber}/${totalPhotos} size=${imageFile ? imageFile.size : 0}`);

    if (!studentId || !studentName || !imageFile) {
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

    // SECURITY (F-004 fix, 2026-05-13): strict allow-list regex.
    // Previous strip-list approach allowed inputs like "..admin" to collapse
    // to ".admin" and slip through (stale traversal artefacts found in the
    // bucket: `....admin/......etcpasswd/`). Now we ALLOW only the safe
    // character set; anything else is rejected outright (no silent rewrite).
    const SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,99}$/;
    const safeName = (s, label) => {
      const v = String(s || '').trim();
      if (!SAFE_RE.test(v)) {
        const err = new Error(`invalid ${label}: must match ${SAFE_RE} (got "${v.slice(0,40)}")`);
        err.statusCode = 400;
        throw err;
      }
      return v;
    };
    let safeStudentName, safeClassName, safeStudentId;
    try {
      safeStudentName = safeName(studentName, 'studentName');
      safeClassName   = safeName(storageClassName, 'className');
      safeStudentId   = safeName(studentId,   'studentId');
    } catch (e) {
      return res.status(400).json({ error: 'invalid_input', details: e.message });
    }

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
      const tenancy = require('../../../lib/tenancy');

      const storage = getFirebaseStorage();
      const bucket = storage.bucket();
      console.log('Storage bucket connected:', bucket.name);

      const rel = `${safeClassName}/${safeStudentName}/photo_${photoNumber}_${Date.now()}.jpg`;
      const fileName = `face_dataset/${rel}`;
      const tenantFileName = `${tenancy.storageFaceDatasetPrefix()}/${rel}`;
      const meta = {
        contentType: 'image/jpeg',
        metadata: {
          studentId, studentName, className: normalizedClassName || null, gradeCode, gradeName, displayLabel,
          photoNumber, totalPhotos,
          capturedAt: new Date().toISOString(),
          tenantId: tenancy.getTenantId(),
        },
      };

      if (tenancy.legacyPathsEnabled()) {
        console.log('Uploading file:', fileName);
        await bucket.file(fileName).save(imageBuffer, { metadata: meta });
      }
      try {
        await bucket.file(tenantFileName).save(imageBuffer, { metadata: meta });
        console.log(`Tenant copy: ${tenantFileName}`);
      } catch (te) {
        console.warn('Tenant storage dual-write failed (non-fatal):', te.message);
      }

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
      const tenancy = require('../../../lib/tenancy');
      const db = getFirestoreDB();
      const imageMetadata = {
        fileName: imageFile.originalFilename || `photo_${photoNumber}.jpg`,
        fileSize: imageFile.size,
        photoNumber: parseInt(photoNumber),
        totalPhotos: parseInt(totalPhotos),
        uploadedAt: new Date().toISOString(),
        storageUrl,
        uploadMethod,
        studentId, studentName, className: normalizedClassName || null, gradeCode, gradeName, displayLabel,
      };
      const studentDoc = {
        id: studentId,
        name: studentName,
        homeroom: normalizedClassName || null,
        gradeCode,
        gradeName,
        displayLabel,
        lastCaptureAt: new Date().toISOString(),
        totalImages: parseInt(photoNumber),
      };

      if (tenancy.legacyPathsEnabled()) {
        await db.collection('students').doc(studentId).collection('images').add(imageMetadata);
        await db.collection('students').doc(studentId).set(studentDoc, { merge: true });
      }
      // Tenant-scoped dual-write
      try {
        const tDoc = db.doc(`${tenancy.studentsPath()}/${studentId}`);
        await tDoc.collection('images').add({ ...imageMetadata, tenantId: tenancy.getTenantId() });
        await tDoc.set({ ...studentDoc, tenantId: tenancy.getTenantId() }, { merge: true });
      } catch (te) {
        console.warn('Tenant Firestore dual-write failed (non-fatal):', te.message);
      }

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
        className: normalizedClassName || null,
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

export default withApi(withMetrics(handler), { permission: 'enrollment.edit' });
