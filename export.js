// Standalone export page. The popup cannot reliably download large runs: a
// base64 data: URL of thousands of rows exceeds what chrome.downloads accepts,
// and a popup-owned blob: URL dies when the popup closes. This tab stays open,
// owns the blob, and works for any size.
import { csvFilename, recordsToCsv } from './lib/csv.js';

const $ = (id) => document.getElementById(id);

let blobUrl = null;
let filename = 'google_maps_export.csv';

function download() {
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

async function main() {
  const { extractorRun } = await chrome.storage.local.get('extractorRun');
  const records = extractorRun?.records || [];
  if (!records.length) {
    $('status').textContent = 'No collected places found. Run an extraction first.';
    return;
  }
  filename = csvFilename(extractorRun.config);
  const csv = recordsToCsv(records);
  blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  $('status').textContent = `${records.length.toLocaleString()} places · ${(csv.length / 1024 / 1024).toFixed(1)} MB. Your download should start now. Results stay saved in the extension until you clear them.`;
  $('download').hidden = false;
  $('download').addEventListener('click', download);
  download();
}

main().catch((error) => {
  $('status').textContent = 'Export failed.';
  $('error').textContent = error.message;
});
