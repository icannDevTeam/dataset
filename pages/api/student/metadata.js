import { getFirestoreDB, initializeFirebase } from '../../../lib/firebase-admin';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Initialize Firebase
    initializeFirebase();

    const { studentId, studentName, className, gradeCode, gradeName } = req.body;

    if (!studentId || !studentName || !className) {
      return res.status(400).json({ 
        error: 'Missing required fields: studentId, studentName, className' 
      });
    }

    const metadata = {
      id: studentId,
      name: studentName,
      homeroom: className,
      gradeCode: gradeCode || 'Unknown',
      gradeName: gradeName || 'Unknown',
      updated_at: new Date().toISOString(),
      // Display label for attendance: e.g. "Albert 3B"
      displayLabel: `${studentName} ${className}`,
    };

    // Save to Firestore
    try {
      const db = getFirestoreDB();
      await db.collection('students').doc(studentId).set(metadata, { merge: true });
      console.log('✓ Metadata saved to Firestore:', studentId);
    } catch (fbError) {
      console.warn('Firestore save failed:', fbError.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Metadata saved',
      metadata
    });

  } catch (error) {
    console.error('Error saving metadata:', error);
    return res.status(500).json({ 
      error: 'Failed to save metadata',
      message: error.message 
    });
  }
}
