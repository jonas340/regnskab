// Modtager et bilag (billede eller PDF), gemmer det privat og lader Claude aflæse
// leverandør, dato, beløb og moms. Resultatet lander som "Til godkendelse" i appen.
//
// To måder at kalde den på:
//   1) Fra appen:  Authorization: Bearer <brugerens login-token>
//   2) Fra iOS-genvej:  x-upload-token: <INGEST_TOKEN>
//
// Hemmeligheder (supabase secrets set …): ANTHROPIC_API_KEY, INGEST_TOKEN, OWNER_USER_ID
// Valgfrit: ANTHROPIC_MODEL, ALLOWED_ORIGIN

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CATEGORIES = [
  "Noder & instrumenter",
  "Kørsel & transport",
  "Rejse & overnatning",
  "Markedsføring",
  "Kontor & IT",
  "Telefon & internet",
  "Forsikring & kontingent",
  "Repræsentation",
  "Underleverandører",
  "Andet",
];

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-upload-token, x-filename, x-note, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toBase64(u8: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

// Find filtypen ud fra indholdet – Genveje sender ofte forkert Content-Type.
function sniff(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === "%PDF") return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 3) === "GIF") return "image/gif";
  if (ascii(4, 8) === "ftyp" && /heic|heif|mif1|hevc/.test(ascii(8, 12))) return "image/heic";
  return null;
}

const EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Brug POST" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // ── 1. Hvem er det? ──
  const owner = Deno.env.get("OWNER_USER_ID");
  let userId: string | null = null;

  const upload = req.headers.get("x-upload-token");
  const expected = Deno.env.get("INGEST_TOKEN");
  if (upload && expected && safeEqual(upload, expected)) {
    userId = owner ?? null;
  } else {
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) {
      const { data } = await admin.auth.getUser(auth.slice(7));
      if (data?.user && (!owner || data.user.id === owner)) userId = data.user.id;
    }
  }
  if (!userId) return json({ error: "Ikke autoriseret" }, 401);

  // ── 2. Læs filen ──
  let bytes: Uint8Array;
  let fileName = "bilag";
  let note = "";
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const f = form.get("file");
      if (!(f instanceof File)) return json({ error: "Mangler feltet 'file'" }, 400);
      bytes = new Uint8Array(await f.arrayBuffer());
      fileName = f.name || fileName;
      note = String(form.get("note") ?? "");
    } else {
      bytes = new Uint8Array(await req.arrayBuffer());
      fileName = decodeURIComponent(req.headers.get("x-filename") ?? fileName);
      note = decodeURIComponent(req.headers.get("x-note") ?? "");
    }
  } catch {
    return json({ error: "Kunne ikke læse upload" }, 400);
  }
  if (!bytes.length) return json({ error: "Filen er tom" }, 400);

  const mime = sniff(bytes);
  if (mime === "image/heic") {
    return json({ error: "HEIC-billeder understøttes ikke. Konvertér til JPEG først." }, 415);
  }
  if (!mime || !EXT[mime]) return json({ error: "Kun JPEG, PNG, WebP og PDF kan bruges" }, 415);
  if (mime === "application/pdf" && bytes.length > 20 * 1024 * 1024) {
    return json({ error: "PDF'en er over 20 MB" }, 413);
  }
  if (mime !== "application/pdf" && bytes.length > 5 * 1024 * 1024) {
    return json({ error: "Billedet er over 5 MB. Gør det mindre og prøv igen." }, 413);
  }

  // ── 3. Gem filen og opret en række ──
  const id = crypto.randomUUID();
  const path = `${userId}/${id}.${EXT[mime]}`;
  const up = await admin.storage.from("receipts").upload(path, bytes, { contentType: mime });
  if (up.error) return json({ error: "Kunne ikke gemme filen: " + up.error.message }, 500);

  const ins = await admin.from("receipts").insert({
    id,
    user_id: userId,
    status: "pending",
    file_path: path,
    file_name: fileName.slice(0, 200),
    mime,
    note: note.slice(0, 500),
  });
  if (ins.error) {
    await admin.storage.from("receipts").remove([path]);
    return json({ error: "Kunne ikke oprette bilag: " + ins.error.message }, 500);
  }

  // ── 4. Lad Claude aflæse bilaget ──
  let extracted = false;
  let result: Record<string, unknown> = {};
  try {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) throw new Error("ANTHROPIC_API_KEY mangler");

    const data = toBase64(bytes);
    const fileBlock = mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: mime, data } }
      : { type: "image", source: { type: "base64", media_type: mime, data } };

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5",
        max_tokens: 1024,
        tools: [{
          name: "gem_bilag",
          description: "Gem de aflæste oplysninger fra bilaget.",
          input_schema: {
            type: "object",
            properties: {
              vendor: { type: "string", description: "Leverandørens navn, fx 'Coop' eller 'DSB'" },
              date: { type: "string", description: "Bilagets dato som YYYY-MM-DD" },
              total: { type: "number", description: "Samlet beløb inkl. moms, som tal med punktum" },
              vat_amount: { type: "number", description: "Momsbeløb hvis det fremgår, ellers 0" },
              currency: { type: "string", description: "ISO-valutakode, fx DKK eller EUR" },
              category: { type: "string", enum: CATEGORIES },
              summary: { type: "string", description: "Hvad købet var, højst otte ord, på dansk" },
            },
          },
        }],
        tool_choice: { type: "tool", name: "gem_bilag" },
        messages: [{
          role: "user",
          content: [
            fileBlock,
            {
              type: "text",
              text:
                "Dette er et bilag til en lille dansk virksomhed (musiker/koncertarrangør). " +
                "Aflæs det og kald værktøjet. Udelad felter, der ikke fremgår tydeligt. Gæt ikke. " +
                (note ? `Brugerens note: ${note}` : ""),
            },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error(`Claude svarede ${res.status}`);
    const body = await res.json();
    const tool = (body.content ?? []).find((c: { type: string }) => c.type === "tool_use");
    if (!tool) throw new Error("Intet svar fra aflæsning");
    const x = tool.input as Record<string, unknown>;

    const currency = typeof x.currency === "string" ? x.currency.toUpperCase() : "DKK";
    const total = typeof x.total === "number" ? x.total : null;
    const update: Record<string, unknown> = {
      vendor: typeof x.vendor === "string" ? x.vendor.slice(0, 120) : "",
      receipt_date: isDate(x.date) ? x.date : null,
      vat_amount: typeof x.vat_amount === "number" ? x.vat_amount : 0,
      currency,
      category: CATEGORIES.includes(x.category as string) ? x.category : "",
    };
    if (currency === "DKK") update.total = total;
    else update.orig_total = total;
    if (!note && typeof x.summary === "string") update.note = x.summary.slice(0, 200);

    const upd = await admin.from("receipts").update(update).eq("id", id);
    if (upd.error) throw new Error(upd.error.message);
    extracted = true;
    result = update;
  } catch (e) {
    await admin.from("receipts").update({ extract_error: String((e as Error).message).slice(0, 300) }).eq("id", id);
  }

  return json({ ok: true, id, extracted, ...result });
});
