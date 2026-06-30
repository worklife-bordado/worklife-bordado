// api/alertas.js
// Tarea programada (Vercel Cron): manda un resumen push de vencimientos.
// Se dispara 8 AM y 1 PM (hora MX), de lunes a viernes — ver vercel.json.
// Reutiliza la credencial FIREBASE_SERVICE_ACCOUNT que ya usa /api/notify.

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

function ensureApp() {
  if (!getApps().length) {
    initializeApp({
      credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
  }
}

// Roles (igual que en la app)
const ROLES = {
  'gerencia@worklife.com.mx': 'admin',
  'worklife.ventas@gmail.com': 'ventas',
  'puntosdeventagon@gmail.com': 'ventas',
  'uniformesgon@gmail.com': 'ventas',
  'compras.uniformesgon@gmail.com': 'seguimiento',
};

const ETAPAS_ACTIVAS = ['nueva', 'bordado', 'calidad', 'retrabajo'];

// ¿Cuenta para indicadores? Solo órdenes ya liberadas a producción (igual que la app).
// - liberada === true  -> cuenta
// - liberada === false -> NO cuenta (aunque la hayan movido de etapa)
// - sin el campo (órdenes viejas) -> cuenta solo si ya salió de "nueva"
function cuentaParaIndicadores(o) {
  if (!o) return false;
  if (o.liberada === true) return true;
  if (o.liberada === false) return false;
  return o.etapa !== 'nueva';
}

export default async function handler(req, res) {
  // Seguridad: si hay CRON_SECRET, exige el header que Vercel envía automáticamente.
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'No autorizado' });
    }
  }

  try {
    ensureApp();
    const db = getFirestore();
    const messaging = getMessaging();

    // 1) Órdenes
    const ordenesSnap = await db.collection('ordenes').get();
    const ordenes = ordenesSnap.docs.map((d) => d.data());
    const activas = ordenes.filter((o) => ETAPAS_ACTIVAS.includes(o.etapa) && cuentaParaIndicadores(o));

    // 2) "Hoy" en hora de México (UTC-6, sin horario de verano)
    const mx = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const hoy = Date.UTC(mx.getUTCFullYear(), mx.getUTCMonth(), mx.getUTCDate());
    const dias = (s) => {
      if (!s) return null;
      const p = String(s).split('-').map(Number);
      return Math.round((Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1) - hoy) / 86400000);
    };

    // 3) Tokens FCM agrupados por correo
    const tokensSnap = await db.collection('fcmTokens').get();
    const tokensPorEmail = {};
    tokensSnap.docs.forEach((d) => {
      const { email, token } = d.data();
      if (email && token) {
        if (!tokensPorEmail[email]) tokensPorEmail[email] = [];
        tokensPorEmail[email].push(token);
      }
    });

    const resultados = [];

    // 4) Por cada usuario (según ROLES), arma su resumen, escribe la notificación
    //    dentro de la app y manda push si tiene dispositivos. Silencio si nada urgente.
    for (const email of Object.keys(ROLES)) {
      const rol = ROLES[email];
      const esPriv = rol === 'admin' || rol === 'seguimiento';

      const suyas = esPriv ? activas : activas.filter((o) => o.creadoPor === email);
      const conFecha = suyas.filter((o) => o.fechaRequerida);
      const vencidas = conFecha.filter((o) => dias(o.fechaRequerida) < 0).length;
      const vencenHoy = conFecha.filter((o) => dias(o.fechaRequerida) === 0).length;
      const sinAsignar = esPriv
        ? suyas.filter((o) => !(o.bordador || '').trim()).length
        : 0;

      const partes = [];
      if (vencidas > 0) partes.push(`🔴 ${vencidas} atrasada${vencidas === 1 ? '' : 's'}`);
      if (vencenHoy > 0) partes.push(`🟠 ${vencenHoy} vence${vencenHoy === 1 ? '' : 'n'} hoy`);
      if (sinAsignar > 0) partes.push(`⚠️ ${sinAsignar} sin bordador`);

      if (partes.length === 0) {
        resultados.push({ email, enviado: false, motivo: 'sin pendientes' });
        continue; // silencio
      }

      const titulo = esPriv ? 'WORK-LIFE · Resumen del día' : 'WORK-LIFE · Tus órdenes';
      const cuerpo = partes.join(' · ');

      // 4a) Notificación DENTRO de la app (campanita). Reemplaza el resumen anterior
      //     no leído para que solo quede el más reciente y no se acumule.
      try {
        const previos = await db.collection('notificaciones').where('para', '==', email).get();
        const aBorrar = previos.docs.filter((d) => {
          const x = d.data();
          return x.tipo === 'resumen' && x.leida === false;
        });
        await Promise.all(aBorrar.map((d) => d.ref.delete()));
        await db.collection('notificaciones').add({
          para: email, titulo, cuerpo, tipo: 'resumen', leida: false, fecha: FieldValue.serverTimestamp(),
        });
      } catch (e) {
        resultados.push({ email, notif: false, motivo: e.message });
      }

      // 4b) Push a sus dispositivos (si tiene)
      const tokens = tokensPorEmail[email] || [];
      if (tokens.length === 0) {
        resultados.push({ email, enviado: false, motivo: 'sin tokens (solo in-app)' });
        continue;
      }
      try {
        const resp = await messaging.sendEachForMulticast({
          tokens,
          notification: { title: titulo, body: cuerpo },
        });
        resultados.push({ email, enviado: true, ok: resp.successCount, fallo: resp.failureCount });
      } catch (e) {
        resultados.push({ email, enviado: false, motivo: e.message });
      }
    }

    return res.status(200).json({ ok: true, ts: new Date().toISOString(), resultados });
  } catch (error) {
    console.error('Error en alertas:', error);
    return res.status(500).json({ error: error.message });
  }
}
