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

function paginaError(msg) {
  return `<!DOCTYPE html><html><body style="font-family:Arial;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;"><div style="background:white;padding:32px;border-radius:12px;text-align:center;max-width:380px;"><h2 style="color:#1a2a4a;">${msg}</h2></div></body></html>`;
}

module.exports = async function handler(req, res) {
  const { token } = req.query;
  const emailIngresado = req.method === 'POST' ? req.body.email : null;

  if (!token) {
    return res.status(400).send(paginaError('Link invalido'));
  }

  try {
    getApp();
    const db = getFirestore();
    const docRef = db.collection('solicitudesFirma').doc(token);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).send(paginaError('Link no encontrado'));
    }

    const data = docSnap.data();

    const ahora = new Date();
    const expira = data.expiraEn.toDate();
    if (ahora > expira) {
      return res.status(410).send(paginaError('Este link ha expirado. Solicita uno nuevo al vendedor.'));
    }

    if (data.firmado) {
      return res.status(200).send(paginaError('Esta orden ya fue firmada. Gracias.'));
    }

    if (req.method === 'GET') {
      return res.status(200).send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Autorizacion WorkLife</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .box { background: white; border-radius: 12px; padding: 32px; max-width: 380px; width: 90%; text-align: center; box-shadow: 0 2px 16px rgba(0,0,0,0.1); }
    h2 { color: #1a2a4a; margin-bottom: 8px; }
    p { color: #666; font-size: 14px; }
    input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; margin: 12px 0; box-sizing: border-box; }
    button { background: #f5a623; color: #1a2a4a; border: none; border-radius: 6px; padding: 12px 24px; font-size: 14px; font-weight: 700; cursor: pointer; width: 100%; }
    .error { color: #c0392b; font-size: 13px; margin-top: 8px; display: none; }
  </style>
</head>
<body>
  <div class="box">
    <h2>WorkLife Uniformes</h2>
    <p>Ingresa tu correo electronico para ver y firmar la orden de bordado #${data.numeroOrden}</p>
    <input id="email" type="email" placeholder="tu@correo.com"/>
    <button onclick="verificar()">Continuar</button>
    <div class="error" id="error">Email incorrecto. Verifica e intenta de nuevo.</div>
  </div>
  <script>
    async function verificar() {
      const email = document.getElementById('email').value.trim();
      if (!email) return;
      const resp = await fetch('/api/firma?token=${token}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      });
      if (resp.ok) {
        document.open();
        document.write(await resp.text());
        document.close();
      } else {
        document.getElementById('error').style.display = 'block';
      }
    }
  </script>
</body>
</html>`);
    }

    if (req.method === 'POST') {
      if (!emailIngresado || data.emailCliente !== emailIngresado.toLowerCase().trim()) {
        return res.status(403).json({ error: 'Email incorrecto' });
      }

      const htmlPdf = data.htmlPdf || '<p>PDF no disponible</p>';

      return res.status(200).send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Autorizacion WorkLife #${data.numeroOrden}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    .container { max-width: 860px; margin: 0 auto; }
    .pdf-wrapper { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; overflow: auto; }
    .firma-section { background: white; border-radius: 8px; padding: 24px; }
    h3 { color: #1a2a4a; margin-top: 0; }
    canvas { border: 2px solid #1a2a4a; border-radius: 4px; width: 100%; touch-action: none; background: white; display: block; }
    .btns { display: flex; gap: 10px; margin-top: 12px; }
    button { padding: 12px 20px; border-radius: 6px; border: none; cursor: pointer; font-size: 14px; font-weight: 700; }
    .btn-limpiar { background: #eee; color: #333; }
    .btn-firmar { background: #f5a623; color: #1a2a4a; flex: 1; }
    .mensaje { margin-top: 16px; padding: 14px; border-radius: 6px; display: none; text-align: center; font-weight: 700; }
    .exito { background: #d4edda; color: #155724; }
    .error-msg { background: #f8d7da; color: #721c24; }
  </style>
</head>
<body>
  <div class="container">
    <div class="pdf-wrapper">
      ${htmlPdf}
    </div>
    <div class="firma-section">
      <h3>Firma para autorizar</h3>
      <p style="color:#666;font-size:13px;">Dibuja tu firma con el dedo o el mouse:</p>
      <canvas id="canvas" height="180"></canvas>
      <div class="btns">
        <button class="btn-limpiar" onclick="limpiar()">Limpiar</button>
        <button class="btn-firmar" onclick="firmar()">Firmar y Autorizar</button>
      </div>
      <div id="mensaje" class="mensaje"></div>
    </div>
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

    canvas.addEventListener('mousedown', function(e) { dibujando = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
    canvas.addEventListener('mousemove', function(e) { if (!dibujando) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
    canvas.addEventListener('mouseup', function() { dibujando = false; });
    canvas.addEventListener('touchstart', function(e) { e.preventDefault(); dibujando = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }, {passive:false});
    canvas.addEventListener('touchmove', function(e) { e.preventDefault(); if (!dibujando) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); }, {passive:false});
    canvas.addEventListener('touchend', function() { dibujando = false; });

    function limpiar() { ctx.clearRect(0, 0, canvas.width, canvas.height); }

    async function firmar() {
      const firmaImg = canvas.toDataURL('image/png');
      const resp = await fetch('/api/guardarFirma', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '${token}', firma: firmaImg })
      });
      const result = await resp.json();
      const msg = document.getElementById('mensaje');
      msg.style.display = 'block';
      if (result.success) {
        msg.className = 'mensaje exito';
        msg.textContent = 'Firma registrada exitosamente. Gracias por autorizar la orden.';
        document.querySelector('.btn-firmar').disabled = true;
      } else {
        msg.className = 'mensaje error-msg';
        msg.textContent = 'Error al guardar la firma. Intenta de nuevo.';
      }
    }
  </script>
</body>
</html>`);
    }

  } catch (error) {
    console.error(error);
    return res.status(500).send(paginaError('Error del servidor'));
  }
};
