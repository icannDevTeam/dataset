// pages/api/dashboard/claude-report.js
// Claude AI integration for generating attendance reports and summaries

import admin from 'firebase-admin';
import axios from 'axios';

const initializeFirebase = () => {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
  }
  return admin.firestore();
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    reportType = 'daily', // 'daily', 'weekly', 'monthly', 'class_summary'
    className = null,
    date = new Date().toISOString().split('T')[0],
  } = req.body;

  if (!process.env.CLAUDE_API_KEY) {
    return res.status(400).json({
      error: 'Claude API key not configured',
    });
  }

  try {
    const db = initializeFirebase();

    // Fetch attendance data based on report type
    let query = db.collection('attendance_records');
    let startDate, endDate;

    switch (reportType) {
      case 'daily':
        startDate = new Date(date);
        endDate = new Date(date);
        endDate.setDate(endDate.getDate() + 1);
        query = query.where('date', '==', date);
        break;
      case 'weekly':
        startDate = new Date(date);
        startDate.setDate(startDate.getDate() - 7);
        endDate = new Date(date);
        query = query
          .where('timestamp', '>=', startDate)
          .where('timestamp', '<=', endDate);
        break;
      case 'monthly':
        startDate = new Date(date);
        startDate.setDate(1);
        endDate = new Date(date);
        endDate.setMonth(endDate.getMonth() + 1);
        endDate.setDate(0);
        query = query
          .where('timestamp', '>=', startDate)
          .where('timestamp', '<=', endDate);
        break;
      case 'class_summary':
        if (!className) {
          return res.status(400).json({
            error: 'className required for class_summary report',
          });
        }
        query = query.where('className', '==', className);
        break;
    }

    const snapshot = await query.get();
    const records = snapshot.docs.map(doc => doc.data());

    // Calculate summary statistics
    const stats = calculateStatistics(records, reportType);

    // Generate report using Claude
    const report = await generateClaudeReport(reportType, stats, records);

    // Save report to Firestore
    const reportRef = await db.collection('generated_reports').add({
      type: reportType,
      className: className || 'all',
      date,
      statistics: stats,
      reportText: report,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      reportId: reportRef.id,
      reportType,
      statistics: stats,
      report,
    });
  } catch (error) {
    console.error('Report generation error:', error);
    return res.status(500).json({
      error: 'Failed to generate report',
      details: error.message,
    });
  }
}

function calculateStatistics(records, reportType) {
  const stats = {
    totalPresent: 0,
    totalLate: 0,
    totalEarly: 0,
    totalAbsent: 0,
    averageAccuracy: 0,
    uniqueStudents: new Set(),
    byClass: {},
    byStatus: {
      on_time: 0,
      late: 0,
      early: 0,
    },
  };

  let accuracySum = 0;
  let accuracyCount = 0;

  records.forEach(record => {
    stats.uniqueStudents.add(record.studentId);

    if (record.status === 'late') {
      stats.totalLate++;
      stats.byStatus.late++;
    } else if (record.status === 'early') {
      stats.totalEarly++;
      stats.byStatus.early++;
    } else {
      stats.totalPresent++;
      stats.byStatus.on_time++;
    }

    if (record.accuracy) {
      accuracySum += record.accuracy;
      accuracyCount++;
    }

    if (!stats.byClass[record.className]) {
      stats.byClass[record.className] = {
        present: 0,
        late: 0,
        early: 0,
      };
    }

    if (record.status === 'late') {
      stats.byClass[record.className].late++;
    } else if (record.status === 'early') {
      stats.byClass[record.className].early++;
    } else {
      stats.byClass[record.className].present++;
    }
  });

  stats.uniqueStudents = stats.uniqueStudents.size;
  stats.averageAccuracy =
    accuracyCount > 0
      ? (accuracySum / accuracyCount).toFixed(2)
      : 0;

  return stats;
}

async function generateClaudeReport(reportType, stats, records) {
  const prompt = buildPrompt(reportType, stats, records);

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        timeout: 30000,
      }
    );

    const content = response.data.content[0];
    if (content.type === 'text') {
      return content.text;
    }

    return 'Report generated successfully';
  } catch (error) {
    console.error('Claude API error:', error.message);
    // Fallback to basic report if Claude fails
    return generateFallbackReport(reportType, stats);
  }
}

function buildPrompt(reportType, stats, records) {
  let prompt = `Generate a professional attendance report for facial recognition system.\n\n`;
  prompt += `Report Type: ${reportType}\n`;
  prompt += `Total Unique Students: ${stats.uniqueStudents}\n`;
  prompt += `Present (On-Time): ${stats.byStatus.on_time}\n`;
  prompt += `Late Arrivals: ${stats.byStatus.late}\n`;
  prompt += `Early Arrivals: ${stats.byStatus.early}\n`;
  prompt += `Average Recognition Accuracy: ${stats.averageAccuracy}%\n\n`;

  if (Object.keys(stats.byClass).length > 0) {
    prompt += `By Class:\n`;
    Object.entries(stats.byClass).forEach(([className, classStats]) => {
      prompt += `- ${className}: ${classStats.present} on-time, ${classStats.late} late, ${classStats.early} early\n`;
    });
  }

  prompt += `\nPlease provide:
1. Executive summary of attendance
2. Key insights and trends
3. Classes or students needing attention
4. Recommendations for improvement

Keep the report concise but informative.`;

  return prompt;
}

function generateFallbackReport(reportType, stats) {
  let report = `# Attendance Report - ${reportType.toUpperCase()}\n\n`;
  report += `## Summary\n`;
  report += `- Total Students Present: ${stats.uniqueStudents}\n`;
  report += `- On-Time Arrivals: ${stats.byStatus.on_time}\n`;
  report += `- Late Arrivals: ${stats.byStatus.late}\n`;
  report += `- Early Arrivals: ${stats.byStatus.early}\n`;
  report += `- Average Recognition Accuracy: ${stats.averageAccuracy}%\n\n`;
  report += `## Class Breakdown\n`;

  Object.entries(stats.byClass).forEach(([className, classStats]) => {
    report += `**${className}**\n`;
    report += `- Present: ${classStats.present}\n`;
    report += `- Late: ${classStats.late}\n`;
    report += `- Early: ${classStats.early}\n\n`;
  });

  return report;
}
