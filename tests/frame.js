document.getElementById('fs').onclick = () => document.getElementById('target').requestFullscreen().catch(e => { document.getElementById('message').textContent = e.message; });
document.getElementById('leave').onclick = () => document.exitFullscreen();
