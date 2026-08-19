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

    return json({
      ok: true,
      info: "API comprobantes-cel: GET /ordenes?estado=PENDIENTE|PAGADA, GET /ddjj, POST /subir, POST /subir-ddjj (header x-pin)",
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
