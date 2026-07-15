// api/ruta-movil.js
// Hoja de ruta móvil del chofer: consulta la ruta de HOY y registra avances
// (paradas completadas/incidencias y documentos) directamente en la ruta real.
// Protegido por PIN (el mismo roster del checador). Usa la credencial
// FIREBASE_SERVICE_ACCOUNT que ya usan /api/notify y /api/alertas.

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function ensureApp() {
  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
}

// Fecha y hora de México (UTC-6, sin horario de verano)
function ahoraMX() { return new Date(Date.now() - 6 * 60 * 60 * 1000); }
function hoyMX() {
  const d = ahoraMX();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function horaMX() {
  const d = ahoraMX();
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

const DOCS_VALIDOS = ['facturas', 'albaranes', 'ordenes', 'listas', 'hoja'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    ensureApp();
    const db = getFirestore();
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { pin, accion } = body;

    // 1) Validar PIN contra el roster del checador (empleados activos)
    const rosterSnap = await db.collection('checadorConfig').doc('roster').get();
    const empleados = rosterSnap.exists ? (rosterSnap.data().empleados || []) : [];
    const emp = empleados.find(e => String(e.pin) === String(pin || '') && e.activo !== false);
    if (!emp) return res.status(401).json({ error: 'PIN incorrecto' });

    // 2) Acciones
    if (accion === 'hoy') {
      const hoy = hoyMX();
      const snap = await db.collection('rutas').where('fecha', '==', hoy).get();
      if (snap.empty) return res.status(200).json({ ruta: null, hoy });
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const ruta = docs.find(r => r.estado !== 'cerrada') || docs[0];
      return res.status(200).json({
        hoy,
        ruta: {
          id: ruta.id,
          fecha: ruta.fecha,
          estado: ruta.estado || 'planeada',
          docsEntregados: ruta.docsEntregados || {},
          paradas: (ruta.paradas || []).map(p => ({
            tipo: p.tipo, horario: p.horario || '', cliente: p.cliente || '',
            direccion: p.direccion || '', contacto: p.contacto || '',
            noPedido: p.noPedido || '', estatus: p.estatus || '', obs: p.obs || '',
            horaReal: p.horaReal || '',
          })),
        },
      });
    }

    if (accion === 'marcar') {
      const { rutaId, idx, estatus, obs } = body;
      if (!rutaId || !['ok', 'x', 'inc'].includes(estatus)) return res.status(400).json({ error: 'Datos inválidos' });
      const ref = db.collection('rutas').doc(String(rutaId));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Ruta no encontrada' });
      const ruta = snap.data();
      if (ruta.estado === 'cerrada') return res.status(409).json({ error: 'La ruta ya está cerrada' });
      const paradas = ruta.paradas || [];
      const i = Number(idx);
      if (!(i >= 0 && i < paradas.length)) return res.status(400).json({ error: 'Parada inválida' });
      paradas[i] = { ...paradas[i], estatus, horaReal: paradas[i].horaReal || horaMX() };
      if (typeof obs === 'string') paradas[i].obs = obs;
      await ref.update({ paradas, actualizadoMovil: horaMX() + ' · ' + (emp.nombre || 'chofer') });
      return res.status(200).json({ ok: true, parada: paradas[i] });
    }

    if (accion === 'doc') {
      const { rutaId, campo, valor } = body;
      if (!rutaId || !DOCS_VALIDOS.includes(campo)) return res.status(400).json({ error: 'Datos inválidos' });
      const ref = db.collection('rutas').doc(String(rutaId));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Ruta no encontrada' });
      if (snap.data().estado === 'cerrada') return res.status(409).json({ error: 'La ruta ya está cerrada' });
      await ref.update({ ['docsEntregados.' + campo]: !!valor });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (e) {
    console.error('ruta-movil error:', e);
    return res.status(500).json({ error: e.message });
  }
}
