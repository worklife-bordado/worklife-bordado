// api/checada.js
// Registro de jornada (entrada / comida / salida) para el kiosco Y el celular.
//
// La secuencia del día se hace cumplir AQUÍ, en un solo lugar, porque los dos
// clientes escriben por este endpoint. Si la regla viviera en cada pantalla,
// las dos versiones se separarían con el tiempo.
//
// Reglas (lineal, sin retorno, un registro de cada tipo por día):
//   entrada  →  comida_inicio  →  comida_fin  →  salida
//   · No hay entrada después de una salida el mismo día.
//   · La comida se puede omitir, pero no invertir.
//   · La hora SIEMPRE la asigna el servidor (es lo que el empleado aceptó).
//
// Escribe en la MISMA colección que el kiosco: `checadas`, agregando `origen`.

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

function ensureApp() {
  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
}

const TIPOS = ['entrada', 'comida_inicio', 'comida_fin', 'salida'];
const LBL = { entrada: 'Entrada', comida_inicio: 'Inicio de comida', comida_fin: 'Fin de comida', salida: 'Salida' };

// México = UTC-6 sin horario de verano
function ahoraMX() { return new Date(Date.now() - 6 * 60 * 60 * 1000); }
function hoyMX() {
  const d = ahoraMX();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
// Rango del día de hoy en México, expresado en UTC real (00:00 MX = 06:00 UTC)
function rangoHoyMX() {
  const d = ahoraMX();
  const ini = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 6, 0, 0));
  return { ini, fin: new Date(ini.getTime() + 24 * 60 * 60 * 1000) };
}
function horaDe(date) {
  const d = new Date(date.getTime() - 6 * 60 * 60 * 1000);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

// Qué puede checar ahora, según lo que ya lleva hoy. El orden importa:
// el primero es el paso más probable (el botón principal).
function permitidos(hechos) {
  const tiene = t => hechos.has(t);
  if (!hechos.size) return ['entrada'];
  if (tiene('salida')) return [];              // jornada cerrada: ya no hay nada más hoy
  if (!tiene('entrada')) return [];            // sin entrada no hay nada que continuar
  const out = [];
  if (!tiene('comida_inicio')) out.push('comida_inicio');
  else if (!tiene('comida_fin')) out.push('comida_fin');
  out.push('salida');
  return out;
}

async function leerDia(db, empleadoId) {
  const { ini, fin } = rangoHoyMX();
  // Filtro solo por rango de fecha (índice automático) y el empleado en memoria:
  // son un puñado de documentos por día y así no hace falta índice compuesto.
  const snap = await db.collection('checadas').where('ts', '>=', ini).where('ts', '<=', fin).get();
  const regs = [];
  snap.forEach(d => {
    const c = d.data();
    if (c.empleadoId !== empleadoId || !c.ts || !c.ts.toDate) return;
    regs.push({ tipo: c.tipo, origen: c.origen || 'kiosco', ts: c.ts.toDate() });
  });
  regs.sort((a, b) => a.ts - b.ts);
  return regs;
}

function armarEstado(emp, acepto, regs) {
  const hechos = new Set(regs.map(r => r.tipo));
  return {
    emp: { id: emp.id, nombre: emp.nombre || '' },
    acepto,
    hoy: hoyMX(),
    registros: regs.map(r => ({ tipo: r.tipo, lbl: LBL[r.tipo] || r.tipo, hora: horaDe(r.ts), origen: r.origen })),
    permitidos: acepto ? permitidos(hechos) : [],
    cerrada: hechos.has('salida'),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    ensureApp();
    const db = getFirestore();
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { pin, accion } = body;

    // PIN contra el roster del checador (mismo padrón para kiosco y celular)
    const rosterSnap = await db.collection('checadorConfig').doc('roster').get();
    const empleados = rosterSnap.exists ? (rosterSnap.data().empleados || []) : [];
    const emp = empleados.find(e => String(e.pin) === String(pin || '') && e.activo !== false);
    if (!emp) return res.status(401).json({ error: 'PIN incorrecto' });

    const aceptoDoc = await db.collection('checadorAcept').doc(String(emp.id)).get();
    const acepto = aceptoDoc.exists;

    if (accion === 'estado') {
      const regs = await leerDia(db, emp.id);
      return res.status(200).json(armarEstado(emp, acepto, regs));
    }

    // Aceptación del texto de registro de jornada (mismo doc que usa el kiosco)
    if (accion === 'aceptar') {
      const { texto } = body;
      if (!acepto) {
        await db.collection('checadorAcept').doc(String(emp.id)).set({
          empleadoId: emp.id, nombre: emp.nombre || '', texto: String(texto || ''), ts: FieldValue.serverTimestamp(),
        });
      }
      const regs = await leerDia(db, emp.id);
      return res.status(200).json({ ok: true, estado: armarEstado(emp, true, regs) });
    }

    if (accion === 'checar') {
      const { tipo, origen } = body;
      if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de checada inválido' });
      if (!acepto) return res.status(409).json({ error: 'Primero debes aceptar el registro de jornada' });

      const regs = await leerDia(db, emp.id);
      const hechos = new Set(regs.map(r => r.tipo));

      if (!permitidos(hechos).includes(tipo)) {
        let motivo = 'Esa checada no corresponde en este momento';
        if (hechos.has(tipo)) motivo = 'Ya registraste ' + (LBL[tipo] || tipo).toLowerCase() + ' hoy';
        else if (hechos.has('salida')) motivo = 'Tu jornada de hoy ya está cerrada';
        else if (!hechos.has('entrada')) motivo = 'Primero tienes que registrar tu entrada';
        else if (tipo === 'comida_fin') motivo = 'Primero registra el inicio de tu comida';
        return res.status(409).json({ error: motivo });
      }

      const doc = {
        empleadoId: emp.id,
        nombre: emp.nombre || '',
        tipo,
        ts: FieldValue.serverTimestamp(),                     // la hora la pone el servidor, nunca el equipo
        origen: origen === 'movil' ? 'movil' : 'kiosco',
      };
      // Salida con la comida abierta: se registra, pero queda marcada para Krisia.
      // Bloquearla dejaría el día sin salida, que es peor que una bandera.
      if (tipo === 'salida' && hechos.has('comida_inicio') && !hechos.has('comida_fin')) {
        doc.anomalia = 'comida_sin_cierre';
      }

      const ref = await db.collection('checadas').add(doc);
      const creado = await ref.get();
      const ts = creado.data().ts;
      const hora = ts && ts.toDate ? horaDe(ts.toDate()) : horaDe(new Date());

      // Si registró ENTRADA y aún no hay ruta cargada para hoy, avisar a quienes
      // cargan rutas (admin + seguimiento). Fuego y olvido: un fallo aquí jamás
      // debe estorbar la checada. Como solo hay una entrada por día, no se duplica.
      if (tipo === 'entrada') {
        try {
          const rutasHoy = await db.collection('rutas').where('fecha', '==', hoyMX()).limit(1).get();
          if (rutasHoy.empty) {
            const usuariosSnap = await db.collection('config').doc('usuarios').get();
            const roles = usuariosSnap.exists ? (usuariosSnap.data().roles || {}) : {};
            const destinos = Object.entries(roles)
              .filter(([, rol]) => rol === 'admin' || rol === 'seguimiento')
              .map(([email]) => email);
            await Promise.all(destinos.map(para => db.collection('notificaciones').add({
              para,
              titulo: '🚚 Entrada registrada sin ruta cargada',
              cuerpo: (emp.nombre || 'El chofer') + ' registró su entrada a las ' + hora + ' y todavía no hay ruta para hoy (' + hoyMX() + ').',
              tipo: 'ruta',
              ordenId: '',
              leida: false,
              fecha: FieldValue.serverTimestamp(),
            })));
          }
        } catch (eNotif) { console.error('aviso sin ruta:', eNotif); }
      }

      const regs2 = await leerDia(db, emp.id);
      return res.status(200).json({
        ok: true,
        mensaje: (LBL[tipo] || tipo) + ' registrada · ' + hora,
        anomalia: doc.anomalia || null,
        estado: armarEstado(emp, true, regs2),
      });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (e) {
    console.error('checada error:', e);
    return res.status(500).json({ error: e.message });
  }
}
