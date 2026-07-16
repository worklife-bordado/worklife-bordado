// api/ruta-movil.js
// Hoja de ruta móvil del chofer: consulta la ruta de HOY y registra avances
// (paradas completadas/incidencias y documentos) directamente en la ruta real.
//
// Flujo del chofer:
//   1) 'hoy'      -> ve la ruta del día (solo lectura hasta que la prepare)
//   2) 'preparar' -> captura kilometraje inicial + orden consecutivo de actividades
//   3) 'iniciar'  -> arranca la ruta (estado = "en_ruta"), a partir de aquí puede marcar
//   4) 'marcar' / 'doc' -> solo permitidos con la ruta iniciada
//
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

const DOCS_VALIDOS = ['facturas', 'albaranes', 'remisiones', 'remisionesEntrega', 'ordenes'];

// ¿La ruta ya tiene kilometraje inicial y TODAS las paradas con orden consecutivo?
function estaPreparada(ruta) {
  const paradas = ruta.paradas || [];
  const km = String(ruta.kmInicial || '').trim();
  if (!km) return false;
  if (!paradas.length) return false;
  const ordenes = paradas.map(p => Number(p.orden));
  if (ordenes.some(o => !(o >= 1 && o <= paradas.length))) return false;
  return new Set(ordenes).size === paradas.length;
}

function serializarRuta(ruta) {
  return {
    id: ruta.id,
    fecha: ruta.fecha,
    estado: ruta.estado || 'planeada',
    kmInicial: ruta.kmInicial || '',
    horaSalida: ruta.horaSalida || '',
    responsable: ruta.responsable || '',
    preparada: estaPreparada(ruta),
    incidencias: ruta.incidencias || '',
    docsEntregados: ruta.docsEntregados || {},
    paradas: (ruta.paradas || []).map((p, i) => ({
      idx: i,
      orden: Number(p.orden) || 0,
      tipo: p.tipo, horario: p.horario || '', cliente: p.cliente || '',
      direccion: p.direccion || '', contacto: p.contacto || '',
      noPedido: p.noPedido || '', estatus: p.estatus || '', obs: p.obs || '',
      horaReal: p.horaReal || '',
    })),
  };
}

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

    const firma = () => horaMX() + ' · ' + (emp.nombre || 'chofer');

    // Helper: carga la ruta por id y valida que exista / no esté cerrada
    const cargarRuta = async (rutaId, permitirCerrada) => {
      const ref = db.collection('rutas').doc(String(rutaId));
      const snap = await ref.get();
      if (!snap.exists) return { error: { code: 404, msg: 'Ruta no encontrada' } };
      const ruta = { id: snap.id, ...snap.data() };
      if (!permitirCerrada && ruta.estado === 'cerrada') {
        return { error: { code: 409, msg: 'La ruta ya está cerrada' } };
      }
      return { ref, ruta };
    };

    // 2) Acciones
    if (accion === 'hoy') {
      const hoy = hoyMX();
      const snap = await db.collection('rutas').where('fecha', '==', hoy).get();
      if (snap.empty) return res.status(200).json({ ruta: null, hoy });
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const ruta = docs.find(r => r.estado !== 'cerrada') || docs[0];
      return res.status(200).json({ hoy, ruta: serializarRuta(ruta) });
    }

    // 2.a) Preparación: kilometraje inicial + orden consecutivo de actividades
    if (accion === 'preparar') {
      const { rutaId, kmInicial, orden } = body;
      if (!rutaId) return res.status(400).json({ error: 'Datos inválidos' });

      const km = String(kmInicial == null ? '' : kmInicial).trim();
      if (!/^\d{1,8}$/.test(km) || Number(km) <= 0) {
        return res.status(400).json({ error: 'Captura un kilometraje inicial válido' });
      }

      const { ref, ruta, error } = await cargarRuta(rutaId);
      if (error) return res.status(error.code).json({ error: error.msg });
      if (ruta.estado === 'en_ruta') return res.status(409).json({ error: 'La ruta ya fue iniciada' });

      const paradas = ruta.paradas || [];
      if (!paradas.length) return res.status(400).json({ error: 'La ruta de hoy no tiene actividades' });

      // orden = arreglo con los índices de las paradas en el orden de ejecución
      if (!Array.isArray(orden) || orden.length !== paradas.length) {
        return res.status(400).json({ error: 'Debes asignar el orden a todas las actividades' });
      }
      const idxs = orden.map(Number);
      if (idxs.some(i => !(i >= 0 && i < paradas.length)) || new Set(idxs).size !== paradas.length) {
        return res.status(400).json({ error: 'Orden inválido' });
      }

      const nuevas = paradas.map(p => ({ ...p }));
      idxs.forEach((idxParada, posicion) => { nuevas[idxParada].orden = posicion + 1; });

      await ref.update({
        paradas: nuevas,
        kmInicial: km,
        preparadaMovil: firma(),
        actualizadoMovil: firma(),
      });

      const actualizada = { ...ruta, paradas: nuevas, kmInicial: km };
      return res.status(200).json({ ok: true, ruta: serializarRuta(actualizada) });
    }

    // 2.b) Iniciar ruta: solo si ya quedó preparada
    if (accion === 'iniciar') {
      const { rutaId } = body;
      if (!rutaId) return res.status(400).json({ error: 'Datos inválidos' });

      const { ref, ruta, error } = await cargarRuta(rutaId);
      if (error) return res.status(error.code).json({ error: error.msg });
      if (ruta.estado === 'en_ruta') {
        return res.status(200).json({ ok: true, ruta: serializarRuta(ruta) });
      }
      if (!estaPreparada(ruta)) {
        return res.status(409).json({ error: 'Primero captura el kilometraje inicial y el orden de las actividades' });
      }

      const horaSalida = ruta.horaSalida || horaMX();
      await ref.update({
        estado: 'en_ruta',
        horaSalida,
        iniciadaMovil: firma(),
        actualizadoMovil: firma(),
      });

      const actualizada = { ...ruta, estado: 'en_ruta', horaSalida };
      return res.status(200).json({ ok: true, ruta: serializarRuta(actualizada) });
    }

    // 2.b2) Recolocar actividades: para las que Krisia agregue DESPUÉS de iniciar.
    // Recibe la secuencia completa de índices ya ordenados; las que no vengan en la
    // lista quedan sin orden (siguen apareciendo como "nuevas" para el chofer).
    if (accion === 'reordenar') {
      const { rutaId, orden } = body;
      if (!rutaId || !Array.isArray(orden)) return res.status(400).json({ error: 'Datos inválidos' });

      const { ref, ruta, error } = await cargarRuta(rutaId);
      if (error) return res.status(error.code).json({ error: error.msg });
      if (ruta.estado !== 'en_ruta') return res.status(409).json({ error: 'La ruta no está iniciada' });

      const paradas = (ruta.paradas || []).map(p => ({ ...p }));
      const idxs = orden.map(Number);
      if (idxs.some(i => !(i >= 0 && i < paradas.length)) || new Set(idxs).size !== idxs.length) {
        return res.status(400).json({ error: 'La ruta cambió. Actualiza e inténtalo de nuevo.' });
      }

      paradas.forEach(p => { p.orden = 0; });
      idxs.forEach((idxParada, pos) => { paradas[idxParada].orden = pos + 1; });

      await ref.update({ paradas, actualizadoMovil: firma() });
      return res.status(200).json({ ok: true, ruta: serializarRuta({ ...ruta, paradas }) });
    }

    // 2.c) Marcar parada — requiere ruta iniciada
    if (accion === 'marcar') {
      const { rutaId, idx, estatus, obs } = body;
      if (!rutaId || !['ok', 'x', 'inc'].includes(estatus)) return res.status(400).json({ error: 'Datos inválidos' });

      // Una incidencia sale del cálculo de cumplimiento: sin motivo escrito no se registra.
      if (estatus === 'inc' && !(typeof obs === 'string' && obs.trim())) {
        return res.status(400).json({ error: 'Para marcar incidencia debes escribir el motivo' });
      }

      const { ref, ruta, error } = await cargarRuta(rutaId);
      if (error) return res.status(error.code).json({ error: error.msg });
      if (ruta.estado !== 'en_ruta') {
        return res.status(409).json({ error: 'Primero debes iniciar la ruta' });
      }

      const paradas = (ruta.paradas || []).map(p => ({ ...p }));
      const i = Number(idx);
      if (!(i >= 0 && i < paradas.length)) return res.status(400).json({ error: 'Parada inválida' });

      paradas[i] = { ...paradas[i], estatus, horaReal: paradas[i].horaReal || horaMX() };
      if (typeof obs === 'string') paradas[i].obs = obs;

      await ref.update({ paradas, actualizadoMovil: firma() });
      return res.status(200).json({ ok: true, parada: paradas[i] });
    }

    // 2.c2) Observación de una parada (sin cambiar el estatus) — requiere ruta iniciada
    if (accion === 'obs') {
      const { rutaId, idx, obs } = body;
      if (!rutaId || typeof obs !== 'string') return res.status(400).json({ error: 'Datos inválidos' });

      const { ref, ruta, error } = await cargarRuta(rutaId);
      if (error) return res.status(error.code).json({ error: error.msg });
      if (ruta.estado !== 'en_ruta') return res.status(409).json({ error: 'Primero debes iniciar la ruta' });

      const paradas = (ruta.paradas || []).map(p => ({ ...p }));
      const i = Number(idx);
      if (!(i >= 0 && i < paradas.length)) return res.status(400).json({ error: 'Parada inválida' });

      const texto = obs.slice(0, 500).trim();
      // No se puede dejar sin motivo una parada marcada como incidencia.
      if (paradas[i].estatus === 'inc' && !texto) {
        return res.status(400).json({ error: 'La incidencia necesita un motivo' });
      }

      paradas[i].obs = texto;
      await ref.update({ paradas, actualizadoMovil: firma() });
      return res.status(200).json({ ok: true, parada: paradas[i] });
    }

    // 2.c3) Incidencias del día (campo libre de la ruta, sale en el PDF de cierre)
    if (accion === 'incidencias') {
      const { rutaId, texto } = body;
      if (!rutaId || typeof texto !== 'string') return res.status(400).json({ error: 'Datos inválidos' });

      const { ref, ruta, error } = await cargarRuta(rutaId);
      if (error) return res.status(error.code).json({ error: error.msg });
      if (ruta.estado !== 'en_ruta') return res.status(409).json({ error: 'Primero debes iniciar la ruta' });

      await ref.update({ incidencias: texto.slice(0, 2000), actualizadoMovil: firma() });
      return res.status(200).json({ ok: true });
    }

    // 2.d) Documentos — requiere ruta iniciada
    if (accion === 'doc') {
      const { rutaId, campo, valor } = body;
      if (!rutaId || !DOCS_VALIDOS.includes(campo)) return res.status(400).json({ error: 'Datos inválidos' });

      const { ref, ruta, error } = await cargarRuta(rutaId);
      if (error) return res.status(error.code).json({ error: error.msg });
      if (ruta.estado !== 'en_ruta') {
        return res.status(409).json({ error: 'Primero debes iniciar la ruta' });
      }

      await ref.update({ ['docsEntregados.' + campo]: !!valor, actualizadoMovil: firma() });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (e) {
    console.error('ruta-movil error:', e);
    return res.status(500).json({ error: e.message });
  }
}
