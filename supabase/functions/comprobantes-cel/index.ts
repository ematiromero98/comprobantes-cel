// Auth por PIN (header x-pin vs app_config.pin_comprobantes) + service_role del
// lado servidor. DECISIÓN DE AUDITORÍA (sep-2026): el PIN se dejó A PROPÓSITO;
// migrar a Supabase Auth por persona (trazabilidad + rate-limit) quedó como mejora
// futura y se decidió NO hacerlo por ahora. Riesgo aceptado y documentado.
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-pin",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

let PIN_CACHE: string | null = null;
async function getPin(): Promise<string> {
  if (PIN_CACHE !== null) return PIN_CACHE;
  const { data } = await supabase.from("app_config").select("valor").eq("clave", "pin_comprobantes").single();
  PIN_CACHE = (data?.valor ?? "").toString();
  return PIN_CACHE;
}
async function pinOk(req: Request): Promise<boolean> {
  const pin = await getPin();
  return pin !== "" && (req.headers.get("x-pin") || "") === pin;
}

// Bucket donde el escritorio guarda los comprobantes de DDJJ (el mismo de los
// PDFs). El escritorio los abre con download_pdf(comprobante_path) desde acá.
const DDJJ_BUCKET = "pdfs";

// Nombre lindo para un certificado a partir del archivo (NRO-OP_CERT_XXX.pdf).
function nombreCert(fname: string, nro_op: string): string {
  const suf = fname.replace(nro_op + "_", "").replace(/\.pdf$/i, "");
  const map: Record<string, string> = {
    CERT_GANANCIAS: "Cert. Ganancias",
    CERT_IVA: "Cert. IVA",
    CERT_IIBB_CABA: "Cert. IIBB CABA",
    CERT_IIBB_ARBA: "Cert. IIBB ARBA",
  };
  return map[suf] || suf.replace(/_/g, " ");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname;

  try {
    // ── Órdenes de pago a proveedores (flujo original) ────────────────────
    if (req.method === "GET" && path.endsWith("/ordenes")) {
      if (!(await pinOk(req))) return json({ error: "pin" }, 401);
      const estado = (url.searchParams.get("estado") || "PENDIENTE").toUpperCase();
      if (estado !== "PENDIENTE" && estado !== "PAGADA") return json({ error: "estado" }, 400);
      const { data, error } = await supabase.rpc("ordenes_para_comprobantes", { p_estado: estado });
      if (error) return json({ error: error.message }, 500);
      return json({ ordenes: data });
    }

    // ── DDJJ de retenciones pendientes de comprobante ─────────────────────
    // Las registró como pagadas el escritorio; falta subir la foto del pago.
    if (req.method === "GET" && path.endsWith("/ddjj")) {
      if (!(await pinOk(req))) return json({ error: "pin" }, 401);
      const { data, error } = await supabase.rpc("ddjj_para_comprobantes");
      if (error) return json({ error: error.message }, 500);
      return json({ ddjj: data });
    }

    // ── Subir foto de una ORDEN (flujo original: bandeja_comprobantes) ─────
    if (req.method === "POST" && path.endsWith("/subir")) {
      if (!(await pinOk(req))) return json({ error: "pin" }, 401);
      const body = await req.json();
      const pago_id = Number(body.pago_id);
      const data = String(body.data || "");
      if (!pago_id || !data) return json({ error: "faltan datos" }, 400);
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const archivo = pago_id + "/" + crypto.randomUUID() + ".jpg";
      const up = await supabase.storage.from("comprobantes").upload(archivo, bytes, { contentType: "image/jpeg" });
      if (up.error) return json({ error: up.error.message }, 500);
      const ins = await supabase.from("bandeja_comprobantes").insert({ pago_id, archivo });
      if (ins.error) return json({ error: ins.error.message }, 500);
      return json({ ok: true });
    }

    // ── DDJJ PROPIAS (Anticipos / CM03 / IVA): pagadas + pendientes ───────
    // Son las DDJJ que el estudio paga por sí mismo (tabla ddjj_propias), no
    // las de agente de recaudación. Se listan todas con `pagada` (= ya tiene
    // comprobante), igual que /ddjj, para ver y no re-subir.
    if (req.method === "GET" && path.endsWith("/ddjj-propias")) {
      if (!(await pinOk(req))) return json({ error: "pin" }, 401);
      const { data, error } = await supabase
        .from("ddjj_propias")
        .select("id, empresa, impuesto, periodo, monto, fecha_pago, comprobante_path")
        .order("empresa", { ascending: true })
        .order("periodo", { ascending: true });
      if (error) return json({ error: error.message }, 500);
      const ddjj = (data ?? []).map((r) => ({
        pago_id: r.id, empresa: r.empresa, impuesto: r.impuesto,
        periodo: r.periodo, monto: r.monto, fecha: r.fecha_pago,
        pagada: !!r.comprobante_path, comprobante: r.comprobante_path,
      }));
      return json({ ddjj });
    }

    // ── Subir foto del pago de una DDJJ PROPIA ────────────────────────────
    // Sube al bucket de PDFs y setea ddjj_propias.comprobante_path (misma key
    // que lee "Pagos → DDJJ" del escritorio). Idempotente por comprobante NULL.
    if (req.method === "POST" && path.endsWith("/subir-ddjj-propias")) {
      if (!(await pinOk(req))) return json({ error: "pin" }, 401);
      const body = await req.json();
      const pago_id = Number(body.pago_id);
      const data = String(body.data || "");
      if (!pago_id || !data) return json({ error: "faltan datos" }, 400);

      const { data: row, error: qerr } = await supabase
        .from("ddjj_propias")
        .select("id, empresa, impuesto, periodo, comprobante_path")
        .eq("id", pago_id).single();
      if (qerr || !row) return json({ error: "DDJJ no encontrada" }, 404);
      if (row.comprobante_path) return json({ error: "ya tiene comprobante" }, 409);

      const per = String(row.periodo || "");
      const anioMes = per.length >= 6 ? per.slice(0, 4) + "-" + per.slice(4, 6) : "sin-periodo";
      const lote = "DDJJP-" + row.impuesto + "-" + row.periodo;
      const archivo = row.empresa + "/" + anioMes + "/comprobantes/" + lote + "_p" + pago_id + ".jpg";

      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const up = await supabase.storage.from(DDJJ_BUCKET).upload(archivo, bytes, { contentType: "image/jpeg", upsert: true });
      if (up.error) return json({ error: up.error.message }, 500);

      const upd = await supabase.from("ddjj_propias")
        .update({ comprobante_path: archivo })
        .eq("id", pago_id).is("comprobante_path", null);
      if (upd.error) return json({ error: upd.error.message }, 500);
      return json({ ok: true });
    }

    // ── Subir foto del pago de una DDJJ ───────────────────────────────────
    // La sube al bucket de PDFs y setea ddjj_recaudacion_pagos.comprobante_path
    // (igual que adjuntar_comprobante_ddjj del escritorio, que lee esa key).
    // Así "Pagos DDJJ" muestra el comprobante sin ningún cambio en la app.
    if (req.method === "POST" && path.endsWith("/subir-ddjj")) {
      if (!(await pinOk(req))) return json({ error: "pin" }, 401);
      const body = await req.json();
      const pago_id = Number(body.pago_id);
      const data = String(body.data || "");
      if (!pago_id || !data) return json({ error: "faltan datos" }, 400);

      const { data: row, error: qerr } = await supabase
        .from("ddjj_recaudacion_pagos")
        .select("id, empresa, regimen, periodo, quincena, comprobante_path")
        .eq("id", pago_id).single();
      if (qerr || !row) return json({ error: "DDJJ no encontrada" }, 404);
      if (row.comprobante_path) return json({ error: "ya tiene comprobante" }, 409);

      const per = String(row.periodo || "");
      const anioMes = per.length >= 6 ? per.slice(0, 4) + "-" + per.slice(4, 6) : "sin-periodo";
      const lote = "DDJJ-" + row.regimen + "-" + row.periodo + "-" + row.quincena;
      const archivo = row.empresa + "/" + anioMes + "/comprobantes/" + lote + "_p" + pago_id + ".jpg";

      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const up = await supabase.storage.from(DDJJ_BUCKET).upload(archivo, bytes, { contentType: "image/jpeg", upsert: true });
      if (up.error) return json({ error: up.error.message }, 500);

      const upd = await supabase.from("ddjj_recaudacion_pagos")
        .update({ comprobante_path: archivo })
        .eq("id", pago_id).is("comprobante_path", null);
      if (upd.error) return json({ error: upd.error.message }, 500);
      return json({ ok: true });
    }

    // ── VER documentos: URLs firmadas de todo lo guardado (solo lectura) ──
    // Órdenes → OP + certificados + comprobantes (escritorio y celular).
    // DDJJ    → el comprobante del pago (lo único que se sube).
    if (req.method === "GET" && path.endsWith("/archivos")) {
      if (!(await pinOk(req))) return json({ error: "pin" }, 401);
      const tipo = (url.searchParams.get("tipo") || "").toLowerCase();
      const archivos: Array<{ nombre: string; tipo: string; pdf: boolean; url: string }> = [];

      async function firmar(bucket: string, p: string, nombre: string, clase: string) {
        const { data, error } = await supabase.storage.from(bucket).createSignedUrl(p, 3600);
        if (error || !data?.signedUrl) return;
        archivos.push({ nombre, tipo: clase, pdf: p.toLowerCase().endsWith(".pdf"), url: data.signedUrl });
      }

      // ── DDJJ (recaudación o propias): solo el comprobante_path del pago ──
      if (tipo === "ddjj" || tipo === "ddjjp") {
        const pago_id = Number(url.searchParams.get("pago_id"));
        if (!pago_id) return json({ error: "faltan datos" }, 400);
        const tabla = tipo === "ddjjp" ? "ddjj_propias" : "ddjj_recaudacion_pagos";
        const { data: row, error } = await supabase.from(tabla)
          .select("comprobante_path").eq("id", pago_id).single();
        if (error || !row) return json({ error: "DDJJ no encontrada" }, 404);
        if (row.comprobante_path) {
          await firmar(DDJJ_BUCKET, row.comprobante_path, "Comprobante del pago", "comprobante");
        }
        return json({ archivos });
      }

      // ── Órdenes de pago: se arma por listado de Storage (sin depender de la
      //    forma exacta de la RPC). Paths deterministas EMPRESA/AAAA-MM/... ──
      if (tipo === "orden") {
        const empresa = (url.searchParams.get("empresa") || "").trim();
        const nro_op = (url.searchParams.get("nro_op") || "").trim();
        const fecha = (url.searchParams.get("fecha") || "").trim();
        const pago_id = Number(url.searchParams.get("pago_id"));
        if (!empresa || !nro_op) return json({ error: "faltan datos" }, 400);

        const meses = new Set<string>();
        const m1 = fecha.match(/(\d{4})-(\d{2})/);            // YYYY-MM-DD
        if (m1) meses.add(`${m1[1]}-${m1[2]}`);
        const m2 = fecha.match(/(\d{2})\/(\d{2})\/(\d{4})/);  // DD/MM/YYYY
        if (m2) meses.add(`${m2[3]}-${m2[2]}`);

        async function scanMes(mes: string) {
          const base = `${empresa}/${mes}`;
          const { data: files } = await supabase.storage.from("pdfs").list(base, { limit: 200 });
          for (const f of files || []) {
            const nm = f.name || "";
            if (!nm.toLowerCase().endsWith(".pdf")) continue;
            if (nm === `${nro_op}.pdf`) {
              await firmar("pdfs", `${base}/${nm}`, "Orden de pago", "op");
            } else if (nm.startsWith(`${nro_op}_CERT_`)) {
              await firmar("pdfs", `${base}/${nm}`, nombreCert(nm, nro_op), "cert");
            }
          }
          const { data: comps } = await supabase.storage.from("pdfs").list(`${base}/comprobantes`, { limit: 200 });
          let n = 0;
          for (const c of comps || []) {
            if (c.name && c.name.startsWith(`${nro_op}_p`)) {
              n++;
              await firmar("pdfs", `${base}/comprobantes/${c.name}`, "Comprobante de pago" + (n > 1 ? ` ${n}` : ""), "comprobante");
            }
          }
        }

        for (const mes of meses) await scanMes(mes);
        // Si la fecha no ayudó (formato raro / OP vieja), recorrer los meses de la empresa.
        if (!archivos.length) {
          const { data: subs } = await supabase.storage.from("pdfs").list(empresa, { limit: 200 });
          for (const s of subs || []) {
            if (s.name && /^\d{4}-\d{2}$/.test(s.name) && !meses.has(s.name)) await scanMes(s.name);
          }
        }

        // Comprobantes subidos desde el celular (bucket 'comprobantes', por pago_id).
        if (pago_id) {
          const { data: cel } = await supabase.storage.from("comprobantes").list(String(pago_id), { limit: 200 });
          let n = 0;
          for (const c of cel || []) {
            if (!c.name) continue;
            n++;
            await firmar("comprobantes", `${pago_id}/${c.name}`, "Comprobante (celular)" + (n > 1 ? ` ${n}` : ""), "comprobante");
          }
        }

        const prio: Record<string, number> = { op: 0, cert: 1, comprobante: 2 };
        archivos.sort((a, b) => (prio[a.tipo] ?? 9) - (prio[b.tipo] ?? 9));
        return json({ archivos });
      }

      return json({ error: "tipo inválido" }, 400);
    }

    return json({
      ok: true,
      info: "API comprobantes-cel: GET /ordenes?estado=PENDIENTE|PAGADA, GET /ddjj, GET /ddjj-propias, GET /archivos?tipo=orden|ddjj|ddjjp, POST /subir, POST /subir-ddjj, POST /subir-ddjj-propias (header x-pin)",
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
