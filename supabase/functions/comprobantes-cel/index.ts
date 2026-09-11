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
function sufijoCert(fname: string, nro_op: string): string {
  return fname.replace(nro_op + "_", "").replace(/\.pdf$/i, "");
}
function nombreCert(fname: string, nro_op: string): string {
  const suf = sufijoCert(fname, nro_op);
  const map: Record<string, string> = {
    CERT_GANANCIAS: "Cert. Ganancias",
    CERT_IVA: "Cert. IVA",
    CERT_IIBB_CABA: "Cert. IIBB CABA",
    CERT_IIBB_ARBA: "Cert. IIBB ARBA",
  };
  return map[suf] || suf.replace(/_/g, " ");
}
// Clave de retención a la que pertenece el certificado (para enlazarlo en la ficha).
function claveCert(fname: string, nro_op: string): string {
  const map: Record<string, string> = {
    CERT_GANANCIAS: "ganancias",
    CERT_IVA: "iva",
    CERT_IIBB_CABA: "iibb_caba",
    CERT_IIBB_ARBA: "iibb_arba",
  };
  return map[sufijoCert(fname, nro_op)] || "";
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
      // deno-lint-ignore no-explicit-any
      const archivos: Array<Record<string, any>> = [];
      const firmados = new Set<string>();   // bucket/path ya firmados (evita duplicados)

      async function firmar(bucket: string, p: string, nombre: string, clase: string, extra: Record<string, unknown> = {}) {
        const key = bucket + "/" + p;
        if (firmados.has(key)) return;
        const { data, error } = await supabase.storage.from(bucket).createSignedUrl(p, 3600);
        if (error || !data?.signedUrl) return;
        firmados.add(key);
        archivos.push({ nombre, tipo: clase, pdf: p.toLowerCase().endsWith(".pdf"), url: data.signedUrl, ...extra });
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

      // ── Órdenes de pago: FICHA (datos de la OP, facturas, retenciones, pagos)
      //    + archivos firmados. La OP y los certificados viven en Storage con
      //    paths deterministas EMPRESA/AAAA-MM/NRO-OP[_CERT_X].pdf; el comprobante
      //    del pago que adjunta el escritorio está en op_pagos.comprobante_path y
      //    las fotos del celular en el bucket 'comprobantes' por pago_id. ──
      if (tipo === "orden") {
        const empresa = (url.searchParams.get("empresa") || "").trim();
        const nro_op = (url.searchParams.get("nro_op") || "").trim();
        const fecha = (url.searchParams.get("fecha") || "").trim();
        const pago_id = Number(url.searchParams.get("pago_id"));
        if (!empresa || !nro_op) return json({ error: "faltan datos" }, 400);

        // ── Ficha desde la base (pagos + facturas + op_pagos + ret_iibb) ──
        // deno-lint-ignore no-explicit-any
        let ficha: Record<string, any> | null = null;
        // deno-lint-ignore no-explicit-any
        let opsPagos: any[] = [];
        if (pago_id) {
          const { data: p } = await supabase.from("pagos")
            .select("id, nro_op, fecha, empresa, proveedor, cuit, tipo, categoria, estado, mes_retencion, " +
                    "total_factura, total_subtotal, total_iva, total_a_pagar, " +
                    "ret_ganancias, ret_iibb_caba, ret_iibb_arba, ret_iva, " +
                    "cert_ganancias, cert_caba, cert_arba, cert_iva")
            .eq("id", pago_id).maybeSingle();
          if (p) {
            const [fcs, ops, iibb] = await Promise.all([
              supabase.from("facturas")
                .select("id, pto_venta, nro_fc, fecha, subtotal, iva, perc_iibb, perc_iva, no_gravado, otros_conceptos, total, orden")
                .eq("pago_id", pago_id).order("orden", { ascending: true }).order("id", { ascending: true }),
              supabase.from("op_pagos")
                .select("id, fecha, importe, medio, banco, referencia, estado, comprobante_path, comprobante_nombre")
                .eq("pago_id", pago_id).eq("estado", "ACTIVO").order("fecha", { ascending: true }).order("id", { ascending: true }),
              supabase.from("ret_iibb").select("jurisdiccion, alicuota").eq("nro_op", p.nro_op).eq("estado", "ACTIVA"),
            ]);
            opsPagos = ops.data ?? [];
            const alic: Record<string, number | null> = {};
            for (const r of iibb.data ?? []) alic[String(r.jurisdiccion || "").toUpperCase()] = r.alicuota;

            // deno-lint-ignore no-explicit-any
            const retenciones: any[] = [];
            const addRet = (key: string, nombre: string, monto: unknown, cert: unknown, alicuota: number | null) => {
              if (Number(monto) > 0) retenciones.push({ key, nombre, monto: Number(monto), nro_certificado: cert ?? null, alicuota });
            };
            addRet("ganancias", "Ret. Ganancias", p.ret_ganancias, p.cert_ganancias, null);
            addRet("iibb_caba", "Ret. IIBB CABA", p.ret_iibb_caba, p.cert_caba, alic["CABA"] ?? null);
            addRet("iibb_arba", "Ret. IIBB ARBA", p.ret_iibb_arba, p.cert_arba, alic["ARBA"] ?? null);
            addRet("iva", "Ret. IVA", p.ret_iva, p.cert_iva, null);

            ficha = {
              pago_id: p.id, nro_op: p.nro_op, fecha: p.fecha, empresa: p.empresa, proveedor: p.proveedor,
              cuit: p.cuit, tipo: p.tipo, categoria: p.categoria, estado: p.estado, mes_retencion: p.mes_retencion,
              total_factura: Number(p.total_factura ?? 0), total_subtotal: Number(p.total_subtotal ?? 0),
              total_iva: Number(p.total_iva ?? 0), total_a_pagar: Number(p.total_a_pagar ?? 0),
              total_retenciones: retenciones.reduce((a, r) => a + r.monto, 0),
              facturas: (fcs.data ?? []).map((f) => ({
                id: f.id, pto_venta: f.pto_venta, nro_fc: f.nro_fc, fecha: f.fecha,
                subtotal: Number(f.subtotal ?? 0), iva: Number(f.iva ?? 0), total: Number(f.total ?? 0),
              })),
              retenciones,
              pagos: opsPagos.map((o) => ({
                id: o.id, fecha: o.fecha, importe: Number(o.importe ?? 0), medio: o.medio, banco: o.banco,
                referencia: o.referencia, comprobante: !!o.comprobante_path, comprobante_nombre: o.comprobante_nombre,
              })),
            };
          }
        }

        // ── OP + certificados en Storage (por mes de la fecha; si no, todos) ──
        const meses = new Set<string>();
        const m1 = fecha.match(/(\d{4})-(\d{2})/);            // YYYY-MM-DD
        if (m1) meses.add(`${m1[1]}-${m1[2]}`);
        const m2 = fecha.match(/(\d{2})\/(\d{2})\/(\d{4})/);  // DD/MM/YYYY
        if (m2) meses.add(`${m2[3]}-${m2[2]}`);
        if (ficha?.fecha) { const m3 = String(ficha.fecha).match(/(\d{4})-(\d{2})/); if (m3) meses.add(`${m3[1]}-${m3[2]}`); }

        let hallados = 0;   // OP/certificados encontrados en Storage
        async function scanMes(mes: string) {
          const base = `${empresa}/${mes}`;
          // search = filtro "contiene" del lado del servidor: evita el tope de
          // listado en carpetas con cientos de PDFs.
          const { data: files } = await supabase.storage.from("pdfs").list(base, { limit: 1000, search: nro_op });
          for (const f of files || []) {
            const nm = f.name || "";
            if (!nm.toLowerCase().endsWith(".pdf")) continue;
            if (nm === `${nro_op}.pdf`) {
              hallados++;
              await firmar("pdfs", `${base}/${nm}`, "Orden de pago", "op");
            } else if (nm.startsWith(`${nro_op}_CERT_`)) {
              hallados++;
              await firmar("pdfs", `${base}/${nm}`, nombreCert(nm, nro_op), "cert", { ret: claveCert(nm, nro_op) });
            }
          }
          // Comprobantes viejos del escritorio (antes de op_pagos.comprobante_path).
          const { data: comps } = await supabase.storage.from("pdfs").list(`${base}/comprobantes`, { limit: 1000, search: nro_op + "_p" });
          for (const c of comps || []) {
            if (c.name && c.name.startsWith(`${nro_op}_p`)) {
              await firmar("pdfs", `${base}/comprobantes/${c.name}`, "Comprobante de pago", "comprobante");
            }
          }
        }

        // Comprobantes del escritorio: primero por la base (path exacto + nombre original).
        for (const o of opsPagos) {
          if (o.comprobante_path) {
            await firmar("pdfs", String(o.comprobante_path), String(o.comprobante_nombre || "Comprobante de pago"), "comprobante", { op_pago_id: o.id });
          }
        }

        for (const mes of meses) await scanMes(mes);
        // Si la fecha no ayudó (formato raro / OP vieja), recorrer los meses de la empresa.
        if (!hallados) {
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
            await firmar("comprobantes", `${pago_id}/${c.name}`, "Comprobante (celular)" + (n > 1 ? ` ${n}` : ""), "comprobante", { celular: true });
          }
        }

        const prio: Record<string, number> = { op: 0, cert: 1, comprobante: 2 };
        archivos.sort((a, b) => (prio[a.tipo] ?? 9) - (prio[b.tipo] ?? 9));
        return json({ archivos, ficha });
      }

      return json({ error: "tipo inválido" }, 400);
    }

    return json({
      ok: true,
      info: "API comprobantes-cel: GET /ordenes?estado=PENDIENTE|PAGADA, GET /ddjj, GET /ddjj-propias, GET /archivos?tipo=orden|ddjj|ddjjp (orden: + ficha), POST /subir, POST /subir-ddjj, POST /subir-ddjj-propias (header x-pin)",
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
