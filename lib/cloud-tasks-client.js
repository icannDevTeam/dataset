let client = null;

function getClient() {
  if (client) return client;

  let tasksModule;
  try {
    tasksModule = require('@google-cloud/tasks');
  } catch (err) {
    const error = new Error('Missing @google-cloud/tasks dependency');
    error.cause = err;
    throw error;
  }

  client = new tasksModule.v2.CloudTasksClient();
  return client;
}

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

  const tasksClient = getClient();
  const queuePath = tasksClient.queuePath(projectId, region, queueName);

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

  return tasksClient.createTask({ parent: queuePath, task });
}
