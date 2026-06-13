import { db, auth } from '../../lib/firebase-admin';
import { runJob } from '../../lib/download-runner';
import {
  sendExportCompletionEmail,
  sendExportFailureEmail,
} from '../../lib/exports-notifications';

/**
 * POST /api/downloads/_jobs/process
 *
 * Worker endpoint for processing export jobs asynchronously.
 * Called by Cloud Tasks after a job is enqueued.
 *
 * Request headers:
 *   X-Internal-Key: Secret API key to verify Cloud Tasks
 *   X-CloudTasks-TaskName: Set by Cloud Tasks (optional verification)
 *
 * Query params:
 *   jobId: The Firestore job document ID
 */
export default async function handler(req, res) {
  // Only POST allowed
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify request is from Cloud Tasks
  if (!isCloudTasksRequest(req)) {
    console.warn(
      '[process] Unauthorized request missing X-Internal-Key or X-CloudTasks-TaskName'
    );
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { jobId } = req.query;
  if (!jobId || typeof jobId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid jobId' });
  }

  try {
    // Fetch job document from Firestore
    const jobRef = db.collection('exportJobs').doc(jobId);
    const jobDoc = await jobRef.get();

    if (!jobDoc.exists) {
      console.warn(`[process] Job not found: ${jobId}`);
      return res.status(404).json({ error: 'Job not found' });
    }

    const jobData = jobDoc.data();
    const { tenantId, actor, cardId, format, from, to, filters } = jobData;

    // Mark job as 'running'
    const now = new Date();
    await jobRef.update({
      status: 'running',
      startedAt: now,
    });

    console.log(`[process] Starting export job ${jobId} for ${cardId}`);

    // Execute the export
    const result = await runJob({
      jobId,
      cardId,
      format,
      from,
      to,
      filters,
      actor,
      tenantId,
      redact: false, // Can be made configurable later
    });

    // Update job with success
    const completedAt = new Date();
    await jobRef.update({
      status: 'completed',
      completedAt,
      rowCount: result.rowCount,
      filename: result.filename,
      storagePath: result.storagePath,
      contentType: result.contentType,
      durationMs: result.durationMs,
      sha256: result.sha256,
      verifyToken: result.verifyToken,
      redactionsApplied: result.redactionsApplied,
    });

    console.log(
      `[process] Completed export job ${jobId}: ${result.rowCount} rows, ${result.filename}`
    );

    // Send completion email to actor
    await sendExportCompletionEmail(actor, cardId, {
      jobId,
      rowCount: result.rowCount,
      filename: result.filename,
      contentType: result.contentType,
    });

    // Return 200 to acknowledge successful processing
    res.status(200).json({ ok: true, jobId, result });
  } catch (err) {
    console.error(`[process] Export job failed: ${jobId}`, err);

    try {
      // Update job as failed (no retries, just fail)
      const failedAt = new Date();
      const jobRef = db.collection('exportJobs').doc(jobId);
      const jobDoc = await jobRef.get();

      if (jobDoc.exists) {
        const { actor, cardId } = jobDoc.data();
        await jobRef.update({
          status: 'failed',
          failedAt,
          lastError: err.message,
        });

        // Send failure email to actor
        await sendExportFailureEmail(actor, cardId, err.message);
      }
    } catch (updateErr) {
      console.error(
        `[process] Failed to update job status or send email: ${jobId}`,
        updateErr
      );
    }

    // Return 500 so Cloud Tasks knows the task failed
    // (But since we configured max retries = 1, this will be the final attempt)
    res.status(500).json({ error: err.message, permanent: true });
  }
}

/**
 * Verify that the request came from Cloud Tasks.
 * Checks for:
 *   1. X-Internal-Key header matching INTERNAL_API_KEY
 *   2. X-CloudTasks-TaskName header (set by Cloud Tasks)
 */
function isCloudTasksRequest(req) {
  const internalKey = req.headers['x-internal-key'];
  const taskName = req.headers['x-cloudtasks-taskname'];

  const expectedKey = process.env.INTERNAL_API_KEY;
  if (!expectedKey) {
    console.warn('[process] INTERNAL_API_KEY not configured');
    return false;
  }

  // Both headers should be present and match
  return internalKey === expectedKey && !!taskName;
}
