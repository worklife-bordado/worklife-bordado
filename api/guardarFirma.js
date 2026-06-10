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

module.exports = async function handler(req, res) {  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, firma } = req.body;

  if (!token || !firma) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  try {
    getApp();
    const db = getFirestore();
    const docRef = db.collection('solicitudesFirma').doc(token);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Solicitud no encontrada' });
    }

    const data = doc.data();

    // Verificar expiración
    const ahora = new Date();
    const expira = data.expiraEn.toDate();
    if (ahora > expira) {
      return res.status(410).json({ error: 'Link expirado' });
    }

    // Guardar firma
    await docRef.update({
      firma,
      firmado: true,
      fechaFirma: new Date()
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}