const $ = selector => document.querySelector(selector);
let file, busy = false, activeId, upload, cancelled = false;
const size = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
function choose(value) {
  if (busy || !value) return;
  if (!/\.mkv$/i.test(value.name) || !value.size || value.size > 20 * 1024 ** 3) {
    file = null; $('#convert-button').disabled = true;
    show('Choose an MKV file.', 0, 'Select a nonempty .mkv video up to 20 GB.');
    return;
  }
  file = value; $('#file-name').textContent = file.name; $('#file-detail').textContent = `${size(file.size)} · ready to convert`;
  $('#convert-button').disabled = false; $('#result').hidden = true;
}
$('#video-file').addEventListener('change', event => choose(event.target.files[0]));
for (const name of ['dragover', 'dragleave', 'drop']) $('#drop-zone').addEventListener(name, event => {
  event.preventDefault(); $('#drop-zone').classList.toggle('dragging', name === 'dragover' && !busy);
  if (name === 'drop') choose(event.dataTransfer.files[0]);
});
// Prevent a dropped file outside the picker from navigating away from the app.
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
function setBusy(value) {
  busy = value; $('#video-file').disabled = value; $('#mode').disabled = value;
  $('#drop-zone').classList.toggle('locked', value);
  $('#convert-button').disabled = value || !file;
  $('#convert-button').textContent = value ? 'Converting…' : 'Convert to MP4';
  $('#cancel').hidden = !value;
}
function show(status, progress, detail) {
  $('#result').hidden = false; $('#status').textContent = status;
  const percent = Math.max(0, Math.min(100, Math.round(progress || 0)));
  $('#percent').textContent = `${percent}%`; $('#progress-fill').style.width = `${percent}%`;
  $('.progress').setAttribute('aria-valuenow', percent); $('#detail').textContent = detail;
}
async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The server could not complete the request.');
  return data;
}
function transfer() {
  return new Promise((resolve, reject) => {
    upload = new XMLHttpRequest();
    upload.open('POST', `/api/convert?name=${encodeURIComponent(file.name)}&mode=${$('#mode').value}`);
    upload.setRequestHeader('Content-Type', 'application/octet-stream');
    upload.upload.onprogress = event => {
      if (event.lengthComputable) show('Preparing your file…', event.loaded / event.total * 100, 'Copying to local temporary storage. Large files may take a moment.');
    };
    upload.onload = () => {
      try { const data = JSON.parse(upload.responseText); if (upload.status !== 202) throw new Error(data.error || 'Could not prepare this file.'); resolve(data); }
      catch (error) { reject(error); }
    };
    upload.onerror = () => reject(new Error('The local server could not be reached. Reopen the app and try again.'));
    upload.onabort = () => reject(new Error('Conversion cancelled.'));
    upload.send(file);
  });
}
$('#cancel').addEventListener('click', async () => {
  cancelled = true;
  if (!activeId) { upload?.abort(); return; }
  try { await request(`/api/jobs/${activeId}`, { method: 'DELETE' }); }
  catch (error) { cancelled = false; $('#detail').textContent = `Could not cancel: ${error.message}`; }
});
$('#convert-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !file) return;
  cancelled = false; activeId = null; $('#download').hidden = true; setBusy(true);
  show('Preparing your file…', 0, 'Files stay on this Mac.');
  try {
    const data = await transfer(); activeId = data.id; upload = null;
    if (cancelled) await request(`/api/jobs/${activeId}`, { method: 'DELETE' });
    let failures = 0;
    for (;;) {
      let job;
      try { job = await request(`/api/jobs/${activeId}`); failures = 0; }
      catch (error) { if (++failures >= 5) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
      if (job.status === 'error') throw new Error(job.error);
      if (job.status === 'cancelled') { show('Conversion cancelled.', 0, 'Your original file is unchanged.'); break; }
      show(job.status === 'complete' ? 'Ready to save.' : job.status === 'converting' ? 'Converting to MP4…' : 'Checking your video…', job.progress, job.method || 'Reading video and audio tracks.');
      if (job.status === 'complete') {
        $('#detail').textContent = `${size(job.size)} · available for one hour, while the app stays open.`;
        $('#download').href = `/api/jobs/${activeId}/download`; $('#download').hidden = false; break;
      }
      await new Promise(resolve => setTimeout(resolve, 700));
    }
  } catch (error) { show(cancelled ? 'Conversion cancelled.' : 'Conversion failed.', 0, cancelled ? 'Your original file is unchanged.' : error.message); }
  finally { setBusy(false); upload = null; }
});
