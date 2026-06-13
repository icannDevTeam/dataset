import { v2 as tasks } from '@google-cloud/tasks';

const client = new tasks.CloudTasksClient();

/**
 * Enqueue an export job to Cloud Tasks for background processing.
 *
 * @param {string} jobId - The Firestore job document ID
 * @param {object} jobData - The job data (cardId, format, filters, etc.)
 * @returns {Promise<object>} Response from Cloud Tasks API
 */
export async function enqueueExportJob(jobId, jobData) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  const queueName = process.env.CLOUD_TASKS_QUEUE || 'exports';
  const region = process.env.CLOUD_TASKS_REGION || 'asia-southeast2';
  const apiKey = process.env.INTERNAL_API_KEY;

  if (!projectId || !apiKey) {
    throw new Error('Missing GOOGLE_CLOUD_PROJECT or INTERNAL_API_KEY env vars');
  }

  const queuePath = client.queuePath(projectId, region, queueName);

  // Build the worker endpoint URL
  const apiBaseUrl =
    process.env.API_BASE_URL || 'https://dataset-sigma.vercel.app';
  const workerUrl = `${apiBaseUrl}/api/downloads/_jobs/process?jobId=${jobId}`;

  const task = {
    httpRequest: {
      httpMethod: 'POST',
      url: workerUrl,
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': apiKey,
      },
      body: Buffer.from(JSON.stringify(jobData)).toString('base64'),
    },
    // Schedule immediately (can be adjusted for delayed processing)
    scheduleTime: {
      seconds: Math.floor(Date.now() / 1000),
    },
  };

  return client.createTask({ parent: queuePath, task });
}
