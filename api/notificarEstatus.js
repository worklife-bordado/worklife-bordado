// api/notificarEstatus.js
// Envía un correo al CLIENTE cada vez que su pedido cambia de estatus.
//
// Lo llama la app (App.js → notificarClienteCambioEtapa) con { ordenId, etapa }.
// Esta función vuelve a leer la orden en Firestore (fuente de verdad) para obtener
// el correo del cliente, su nombre, el número de pedido y el token de seguimiento.
// Así nunca se manda a una dirección arbitraria: solo al correo guardado en la orden.
//
// Variables de entorno requeridas en Vercel:
//   RESEND_API_KEY          -> clave de Resend (secreta)
//   FIREBASE_SERVICE_ACCOUNT -> JSON de la cuenta de servicio de Firebase (misma que usan
//                               las demás funciones, p. ej. guardarFirma.js)
// Opcional:
//   RESEND_REPLY_TO         -> correo al que llegan las respuestas del cliente
//                               (p. ej. gerencia@worklife.com.mx). Si no se define,
//                               el correo sale sin "responder a".

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

// Etapa interna -> mensaje que ve el cliente.
// Solo estas 4 etapas generan correo; cualquier otra (espera, retrabajo, cancelada) se ignora.
const ETAPAS = {
  nueva: {
    titulo: "Recibimos tu pedido",
    encabezado: "¡Pedido recibido!",
    mensaje: "Tu pedido quedó registrado y entrará a producción muy pronto. Te avisaremos en cada paso.",
    color: "#5c8fe0",
  },
  bordado: {
    titulo: "Tu pedido ya está en producción",
    encabezado: "En producción",
    mensaje: "¡Manos a la obra! Tu pedido ya entró a producción y nuestro equipo está trabajando en él.",
    color: "#f5a623",
  },
  calidad: {
    titulo: "Tu pedido está en control de calidad",
    encabezado: "Control de calidad",
    mensaje: "Tu pedido está en la revisión final de calidad. Ya casi está listo para entregarse.",
    color: "#f5a623",
  },
  entregada: {
    titulo: "Tu pedido fue entregado",
    encabezado: "¡Entregado!",
    mensaje: "Tu pedido fue entregado. Muchas gracias por tu preferencia; fue un gusto trabajar contigo.",
    color: "#4caf7d",
  },
};

function emailValido(c) {
  return typeof c === "string" && /^\S+@\S+\.\S+$/.test(c.trim());
}

function plantillaHTML({ encabezado, mensaje, color, cliente, numero, link }) {
  const saludo = cliente ? `Hola ${cliente}:` : "Hola:";
  const botonSeguimiento = link
    ? `<tr><td style="padding:8px 0 4px;">
         <a href="${link}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 24px;border-radius:10px;">
           Ver el estatus de mi pedido
         </a>
       </td></tr>
       <tr><td style="color:#8b90a7;font-size:12px;padding-top:6px;">O copia este enlace: ${link}</td></tr>`
    : "";
  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2f3f7;font-family:Segoe UI,Arial,Helvetica,sans-serif;color:#1a1d27;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.06);">
        <tr><td style="background:#1a1d27;padding:20px 28px;">
          <span style="color:#ffffff;font-size:18px;font-weight:800;letter-spacing:.5px;">WORK-LIFE</span>
          <span style="color:#f5a623;font-size:18px;font-weight:800;"> Uniformes</span>
        </td></tr>
        <tr><td style="height:5px;background:${color};"></td></tr>
        <tr><td style="padding:28px 28px 8px;">
          <div style="display:inline-block;background:${color}22;color:${color};font-size:13px;font-weight:700;padding:6px 14px;border-radius:20px;">${encabezado}</div>
          <h1 style="font-size:21px;margin:16px 0 6px;color:#1a1d27;">Pedido #${numero || "—"}</h1>
          <p style="font-size:15px;line-height:1.55;color:#3a3f4f;margin:14px 0 4px;">${saludo}</p>
          <p style="font-size:15px;line-height:1.55;color:#3a3f4f;margin:4px 0 20px;">${mensaje}</p>
        </td></tr>
        <tr><td style="padding:0 28px 26px;">
          <table role="presentation" cellpadding="0" cellspacing="0">${botonSeguimiento}</table>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #eceef3;color:#8b90a7;font-size:12px;line-height:1.5;">
          Este es un aviso automático de WORK-LIFE Uniformes. Por favor no es necesario responder a este correo.
        </td></tr>
      </table>
      <div style="color:#aab0be;font-size:11px;padding:16px 0 0;">WORK-LIFE Uniformes · San Luis Potosí, México</div>
    </td></tr>
  </table>
</body></html>`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }
  try {
    // El body puede llegar como objeto (Vercel lo parsea) o como string.
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const { ordenId, etapa } = body || {};

    const info = ETAPAS[etapa];
    if (!info) return res.status(200).json({ skipped: "etapa no notificable" });
    if (!ordenId) return res.status(400).json({ error: "falta ordenId" });

    const snap = await db.collection("ordenes").doc(String(ordenId)).get();
    if (!snap.exists) return res.status(200).json({ skipped: "orden no encontrada" });
    const o = snap.data() || {};

    if (o.clienteSinCorreo) return res.status(200).json({ skipped: "cliente marcado sin correo" });
    const correo = (o.correoCliente || "").trim();
    if (!emailValido(correo)) return res.status(200).json({ skipped: "sin correo válido" });

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "RESEND_API_KEY no configurada" });

    const numero = o.numero || "";
    const cliente = (o.cliente || "").trim();
    const token = o.seguimientoToken || "";
    const link = token ? `https://worklife-bordado.vercel.app/?seguimiento=${token}` : "";

    const html = plantillaHTML({
      encabezado: info.encabezado,
      mensaje: info.mensaje,
      color: info.color,
      cliente,
      numero,
      link,
    });

    const payload = {
      from: "WORK-LIFE Uniformes <avisos@notificaciones.worklife.com.mx>",
      to: [correo],
      subject: `Pedido #${numero || "—"}: ${info.titulo}`,
      html,
    };
    if (emailValido(process.env.RESEND_REPLY_TO)) {
      payload.reply_to = process.env.RESEND_REPLY_TO.trim();
    }

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.log("Resend error:", r.status, data);
      return res.status(502).json({ error: "No se pudo enviar el correo", detalle: data });
    }
    return res.status(200).json({ ok: true, id: data.id, to: correo });
  } catch (e) {
    console.log("notificarEstatus error:", e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
