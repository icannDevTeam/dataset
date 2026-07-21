/**
 * lib/client-image.js — browser-only image compression helper.
 *
 * Hikvision face terminals (DS-K1T341 family) silently cap face pictures at
 * 200 KB and reject anything larger with a misleading
 * `badJsonFormat "faceURL"` error. Root-caused 2026-07-21: across 288
 * approved chaperones, every successful device enrolment had a photo
 * ≤ 195 KB and every faceURL failure was 201–298 KB.
 *
 * This helper re-encodes any image (File, Blob or data-URL) to a JPEG
 * data-URL that fits under `maxBytes`, first by capping the longest side at
 * `maxDim`, then by stepping quality down, then by shrinking dimensions.
 * Pure canvas — no dependencies. Use it in EVERY code path that uploads a
 * chaperone face photo.
 */

function approxDataUrlBytes(dataUrl) {
  const i = dataUrl.indexOf(',');
  return Math.floor((dataUrl.length - i - 1) * 3 / 4);
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('not a valid image'));
    if (typeof source === 'string') {
      img.src = source; // data-URL
    } else {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('cannot read file'));
      fr.onload = () => { img.src = fr.result; };
      fr.readAsDataURL(source); // File | Blob
    }
  });
}

/**
 * Compress an image to a JPEG data-URL of at most `maxBytes`.
 *
 * @param {File|Blob|string} source  image file, blob, or data-URL
 * @param {object} [opts]
 * @param {number} [opts.maxDim=1024]           longest side in px
 * @param {number} [opts.maxBytes=194560]       target size (default 190 KB)
 * @returns {Promise<string>} JPEG data-URL guaranteed ≤ maxBytes (best effort)
 */
export async function compressImageToJpegDataUrl(source, { maxDim = 1024, maxBytes = 190 * 1024 } = {}) {
  const img = await loadImage(source);
  if (!img.width || !img.height) throw new Error('image has no dimensions');

  let scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  let best = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);

    for (const q of [0.85, 0.75, 0.65, 0.55]) {
      const dataUrl = canvas.toDataURL('image/jpeg', q);
      const bytes = approxDataUrlBytes(dataUrl);
      if (!best || bytes < approxDataUrlBytes(best)) best = dataUrl;
      if (bytes <= maxBytes) return dataUrl;
    }
    scale *= 0.75; // still too big — shrink and try again
  }
  // Last resort: return the smallest thing we produced (upload endpoint
  // still enforces its own hard cap).
  return best;
}
