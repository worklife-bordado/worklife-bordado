const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function getApp() {
  if (getApps().length === 0) {
    return initializeApp({
      credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
  }
  return getApps()[0];
}

export default async function handler(req, res) {
  const { token, email } = req.query;

  if (!token || !email) {
    return res.status(400).send('<h2>Link inválido</h2>');
  }

  try {
    getApp();
    const db = getFirestore();
    const doc = await db.collection('solicitudesFirma').doc(token).get();

    if (!doc.exists) {
      return res.status(404).send('<h2>Link no encontrado</h2>');
    }

    const data = doc.data();

    // Verificar expiración
    const ahora = new Date();
    const expira = data.expiraEn.toDate();
    if (ahora > expira) {
      return res.status(410).send('<h2>Este link ha expirado. Solicita uno nuevo al vendedor.</h2>');
    }

    // Verificar email
    if (data.emailCliente.toLowerCase() !== email.toLowerCase()) {
      return res.status(403).send('<h2>Email no autorizado para ver esta orden.</h2>');
    }

    // Verificar si ya fue firmado
    if (data.firmado) {
      return res.status(200).send('<h2>Esta orden ya fue firmada. Gracias.</h2>');
    }

    // Mostrar página de firma
    res.status(200).send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Autorización de Trabajo - WorkLife</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    .container { max-width: 800px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
    h2 { color: #1a2a4a; }
    .pdf-frame { width: 100%; height: 600px; border: 1px solid #ddd; border-radius: 4px; }
    .firma-area { margin-top: 20px; }
    canvas { border: 2px solid #1a2a4a; border-radius: 4px; width: 100%; touch-action: none; }
    .btns { display: flex; gap: 10px; margin-top: 10px; }
    button { padding: 10px 20px; border-radius: 6px; border: none; cursor: pointer; font-size: 14px; font-weight: 700; }
    .btn-limpiar { background: #eee; color: #333; }
    .btn-firmar { background: #f5a623; color: #1a2a4a; flex: 1; }
    .mensaje { margin-top: 20px; padding: 15px; border-radius: 6px; display: none; }
    .exito { background: #d4edda; color: #155724; }
    .error { background: #f8d7da; color: #721c24; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Autorización de Trabajo #${data.numeroOrden}</h2>
    <p>Cliente: <strong>${data.emailCliente}</strong></p>
    <p>Por favor revisa la orden y firma abajo para autorizar.</p>
    <div class="firma-area">
      <p><strong>Firma aquí:</strong></p>
      <canvas id="canvas" height="200"></canvas>
      <div class="btns">
        <button class="btn-limpiar" onclick="limpiar()">Limpiar</button>
        <button class="btn-firmar" onclick="firmar()">✓ Firmar y Autorizar</button>
      </div>
    </div>
    <div id="mensaje" class="mensaje"></div>
  </div>
  <script>
    const canvas = document.getElementById('canvas');
    canvas.width = canvas.offsetWidth;
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#1a2a4a';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    let dibujando = false;

    function getPos(e) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
    }

    canvas.addEventListener('mousedown', e => { dibujando = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
    canvas.addEventListener('mousemove', e => { if (!dibujando) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
    canvas.addEventListener('mouseup', () => dibujando = false);
    canvas.addEventListener('touchstart', e => { e.preventDefault(); dibujando = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }, {passive:false});
    canvas.addEventListener('touchmove', e => { e.preventDefault(); if (!dibujando) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); }, {passive:false});
    canvas.addEventListener('touchend', () => dibujando = false);

    function limpiar() { ctx.clearRect(0, 0, canvas.width, canvas.height); }

    async function firmar() {
      const firmaImg = canvas.toDataURL('image/png');
      const resp = await fetch('/api/guardarFirma', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '${token}', firma: firmaImg })
      });
      const data = await resp.json();
      const msg = document.getElementById('mensaje');
      msg.style.display = 'block';
      if (data.success) {
        msg.className = 'mensaje exito';
        msg.textContent = '✓ Firma registrada exitosamente. Gracias por autorizar la orden.';
        document.querySelector('.btn-firmar').disabled = true;
      } else {
        msg.className = 'mensaje error';
        msg.textContent = 'Error al guardar la firma. Intenta de nuevo.';
      }
    }
  </script>
</body>
</html>
    `);
  } catch (error) {
    console.error(error);
    return res.status(500).send('<h2>Error del servidor</h2>');
  }
}