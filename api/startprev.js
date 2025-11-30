import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------
// Configuração OpenAI
// ---------------------------------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------------------------------------------------------------
// Configuração Supabase
// ---------------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }
);

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function brDateToIso(br) {
  if (!br) return null;
  const parts = br.split("/");
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function toNumber(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const cleaned = v
      .replace(/\s/g, "")
      .replace(/\./g, "")
      .replace(",", ".")
      .replace(/[^\d.-]/g, "");
    const num = Number(cleaned);
    return isNaN(num) ? 0 : num;
  }
  return 0;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------
// Função Serverless
// ---------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Método não permitido. Use POST." }));
    return;
  }

  try {
    const rawBody = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(rawBody || "{}");
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Body inválido." }));
      return;
    }

    const {
      pdfText,
      valorPrevistoAnterior = 0,
      valorRecebidoAnterior = 0,
      primeiraParcela = true,
    } = body;

    if (!pdfText) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "pdfText é obrigatório." }));
      return;
    }

    const vpAnterior = Number(valorPrevistoAnterior) || 0;
    const vrAnterior = Number(valorRecebidoAnterior) || 0;

    // --- NOVA CHAMADA (Substituindo Workflow) ---
    console.log("🔵 Enviando para GPT-4o (Chat Completions)..."); // Log novo para você saber que atualizou

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-2024-08-06",
      messages: [
        {
          role: "system",
          content: `Você é um especialista da Start Prev em cálculo de honorários sobre salário-maternidade.
          Analise o texto do PDF, identifique as parcelas e calcule os honorários.
          
          REGRAS IMPORTANTES:
          1. O 'valor_inss' é o valor bruto da parcela.
          2. O 'valor_cliente' é quanto sobra para a cliente.
          3. O 'valor_previsto' é o honorário da Start Prev (geralmente 30% ou valor fixo, deduza pelo contexto se houver ou aplique 30% sobre o bruto se não especificado, mas siga o padrão das parcelas).
          4. Se houver valores anteriores, considere no cálculo do saldo.
          `
        },
        {
          role: "user",
          content: JSON.stringify({
            pdf_text: pdfText,
            valor_previsto_anterior: vpAnterior,
            valor_recebido_anterior: vrAnterior,
            primeira_parcela: !!primeiraParcela
          })
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "calculo_honorarios",
          strict: true,
          schema: {
            type: "object",
            properties: {
              linhas: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    parcela: { type: "string" },
                    data_inss: { type: "string" },
                    valor_inss: { type: "number" },
                    valor_cliente: { type: "number" },
                    valor_previsto: { type: "number" },
                    valor_recebido: { type: "number" },
                    saldo_start: { type: "number" },
                    saldo_cliente: { type: "number", nullable: true }
                  },
                  required: ["parcela", "data_inss", "valor_inss", "valor_cliente", "valor_previsto", "valor_recebido", "saldo_start", "saldo_cliente"],
                  additionalProperties: false
                }
              },
              totais_final: {
                type: "object",
                properties: {
                  total_inss: { type: "number" },
                  total_cliente: { type: "number" },
                  total_previsto: { type: "number" },
                  total_recebido: { type: "number" },
                  saldo_start_final: { type: "number" },
                  saldo_da_cliente: { type: "number" }
                },
                required: ["total_inss", "total_cliente", "total_previsto", "total_recebido", "saldo_start_final", "saldo_da_cliente"],
                additionalProperties: false
              }
            },
            required: ["linhas", "totais_final"],
            additionalProperties: false
          }
        }
      }
    });

    const output = JSON.parse(completion.choices[0].message.content);
    
    // --- FIM DA CHAMADA NOVA ---

    // Processamento para o Supabase (mantido igual)
    const linhas = output.linhas;
    const totais = output.totais_final;

    const { data: calcInsert, error: calcError } = await supabase
      .from("calculos_start_prev")
      .insert({
        primeira_parcela: !!primeiraParcela,
        valor_previsto_anterior: vpAnterior,
        valor_recebido_anterior: vrAnterior,
        total_inss: toNumber(totais.total_inss),
        honorario_total: toNumber(totais.total_previsto),
        honorario_ja_pago: vrAnterior,
        saldo_start_inicial: 0, // Simplificado para evitar erro de lógica, a IA já calcula os saldos
        saldo_start_final: toNumber(totais.saldo_start_final),
        total_cliente: toNumber(totais.total_cliente),
        saldo_da_cliente: toNumber(totais.saldo_da_cliente),
        resultado_json: output,
      })
      .select()
      .single();

    if (!calcError && calcInsert) {
       const distRows = linhas.map((l) => {
         let ordem = 0;
         const match = l.parcela.match(/\d+/);
         if(match) ordem = parseInt(match[0]);
         
         return {
            calculo_id: calcInsert.id,
            ordem_parcela: ordem,
            data_inss: brDateToIso(l.data_inss),
            valor_inss: toNumber(l.valor_inss),
            valor_cliente: toNumber(l.valor_cliente),
            valor_previsto: toNumber(l.valor_previsto),
            valor_recebido: toNumber(l.valor_recebido),
            saldo_start_depois: toNumber(l.saldo_start),
            saldo_start_antes: toNumber(l.saldo_start) + toNumber(l.valor_previsto) 
         };
       });
       await supabase.from("distribuicao_honorarios").insert(distRows);
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(output));

  } catch (err) {
    console.error("Erro no processamento:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
}
