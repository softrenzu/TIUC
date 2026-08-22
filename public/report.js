document.addEventListener('DOMContentLoaded', () => {
  // File input button handlers
  document.getElementById('file-btn-src').addEventListener('click', () => {
    document.getElementById('file-src').click();
  });

  document.getElementById('file-btn-tgt').addEventListener('click', () => {
    document.getElementById('file-tgt').click();
  });

  // Camera button handlers (basic implementation)
  document.getElementById('camera-btn-src').addEventListener('click', () => {
    const input = document.getElementById('file-src');
    input.click();
  });

  document.getElementById('camera-btn-tgt').addEventListener('click', () => {
    const input = document.getElementById('file-tgt');
    input.click();
  });
});