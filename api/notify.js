const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

let app;

function getApp() {
  if (!app) {
    app = initializeApp({
      credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
  }
  return app;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, titulo, cuerpo } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token requerido' });
  }

  try {
    getApp();
    const messaging = getMessaging();
    await messaging.send({
      token,
      notification: {
        title: titulo || 'WorkLife Bordado',
        body: cuerpo || 'Tu orden ha cambiado de etapa'
      }
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error enviando notificación:', error);
    return res.status(500).json({ error: error.message });
  }
}