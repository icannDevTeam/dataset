import { db } from './firebase-admin';
import { sendEmail } from './email';

const APP_URL = process.env.APP_URL || 'https://dataset-sigma.vercel.app';

/**
 * Send completion email to the export actor.
 */
export async function sendExportCompletionEmail(actor, cardId, result) {
  if (!actor || !actor.email) {
    console.warn(`[exports-notifications] No email for actor:`, actor);
    return;
  }

  const subject = `Your ${cardId} export is ready`;
  const downloadUrl = `${APP_URL}/v2/admin/downloads/runs/${result.jobId}`;

  try {
    await sendEmail({
      to: actor.email,
      subject,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; color: #333;">
          <h2>Export Complete</h2>
          <p>Your <strong>${cardId}</strong> export has completed successfully.</p>
          <p><strong>Details:</strong></p>
          <ul>
            <li>Rows: ${result.rowCount}</li>
            <li>File: ${result.filename}</li>
            <li>Format: ${result.contentType}</li>
          </ul>
          <p>
            <a href="${downloadUrl}" style="display: inline-block; padding: 12px 24px; background-color: #0891b2; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
              Download Now
            </a>
          </p>
          <p style="color: #888; font-size: 12px; margin-top: 20px;">
            Download link expires in 1 hour. After that, visit the Downloads Hub to re-download.
          </p>
        </div>
      `,
    });

    // Mark notification sent on job doc
    await db.collection('exportJobs').doc(result.jobId).update({
      notificationSent: true,
      notificationSentAt: new Date(),
    });
  } catch (err) {
    console.error(
      `[exports-notifications] Failed to send completion email to ${actor.email}:`,
      err
    );
    // Don't throw — email failure shouldn't crash the export
  }
}

/**
 * Send failure email to the export actor.
 */
export async function sendExportFailureEmail(actor, cardId, errorMsg) {
  if (!actor || !actor.email) {
    console.warn(`[exports-notifications] No email for actor:`, actor);
    return;
  }

  const subject = `Your ${cardId} export failed`;

  try {
    await sendEmail({
      to: actor.email,
      subject,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; color: #333;">
          <h2>Export Failed</h2>
          <p>Your <strong>${cardId}</strong> export encountered an error.</p>
          <p><strong>Error:</strong></p>
          <pre style="background-color: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px;">
${escapeHtml(errorMsg)}
          </pre>
          <p>Please try again. If the problem persists, contact your administrator.</p>
          <p style="color: #888; font-size: 12px; margin-top: 20px;">
            You can retry the export from the Downloads Hub.
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.error(
      `[exports-notifications] Failed to send failure email to ${actor.email}:`,
      err
    );
    // Don't throw — email failure shouldn't prevent logging
  }
}

/**
 * Simple HTML escape utility for error messages.
 */
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return String(text).replace(/[&<>"']/g, (char) => map[char]);
}
