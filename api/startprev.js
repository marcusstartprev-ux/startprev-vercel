import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

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
    const cleaned = v.replace(/\s/g, "").replace(/\./g, "").replace(",", ".").replace(/[^\d.-]/g, "");
    return isNaN(Number(cleaned)) ? 0 : Number(cleaned);
  }
  return 0;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// Prompt Atualizado para extrair dados do Card
const SYSTEM_PROMPT = `
VOCÊ É O MOTOR DE DECISÃO FINANCEIRA DA START PREV.

1) DADOS DO CLIENTE (PARA O CARD):
- Extraia: Nome, CPF, NB.
- Identifique a Alíquota de Desconto INSS (7.5%, 9%, etc) baseada na MR.
- Identifique se o benefício prevê 13º salário.

2) REGRAS DE CÁLCULO (IGUAL AO EXCEL):
- Agrupe pagamentos por DATA (Liberações).
- Calcule dias proporcionais para cada competência (dias_calculados).
- ESTRATÉGIA: Aplique 40% (0.4) para liberações >= 1600 e 35% (0.35) para menores, respeitando o Teto.
- AUDITORIA: Marque 'erro_inss_pagou_menos' se o valor não bater com os dias.

3) OUTPUT JSON:
Gere JSON estrito com 'dados_cliente', 'linhas' e 'totais_final'.
`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const rawBody = await readBody(req);
    const body = JSON.parse(rawBody || "{}");
    const action = body.action || 'preview'; // Padrão é preview

    // --- MODO PREVIEW (SÓ IA) ---
    if (action === 'preview') {
      const { pdfText, valorPrevistoAnterior = 0, valorRecebidoAnterior = 0, primeiraParcela = true } = body;
      
      console.log("🔵 Modo Preview: Analisando PDF...");
      
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-2024-08-06",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify({ pdf_text: pdfText, honorario_ja_pago: valorRecebidoAnterior, primeira_vez: primeiraParcela }) }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "fatura_start_prev",
            strict: true,
            schema: {
              type: "object",
              properties: {
                fatura_texto_completo: { type: "string" },
                dados_cliente: {
                    type: "object",
                    properties: {
                        nome: { type: "string" },
                        cpf: { type: "string" },
                        nb: { type: "string" },
                        aliquota_inss_faixa: { type: "string", description: "Ex: 7.5%" },
                        tem_decimo_terceiro: { type: "boolean" }
                    },
                    required: ["nome", "cpf", "nb", "aliquota_inss_faixa", "tem_decimo_terceiro"],
                    additionalProperties: false
                },
                linhas: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      numero_parcela: { type: "string" },
                      competencia: { type: "string" },
                      data_inss: { type: "string" },
                      status_inss: { type: "string" },
                      valor_cliente_liquido: { type: "number" },
                      dias_calculados: { type: "number" },
                      aliquota_aplicada: { type: "number", description: "Frente de Calculo (0.4, 0.35...)" },
                      valor_honorario_calculado: { type: "number" },
                      saldo_start: { type: "number" },
                      erro_inss_pagou_menos: { type: "boolean" },
                      msg_alerta_inss: { type: "string" }
                    },
                    required: ["numero_parcela", "competencia", "data_inss", "status_inss", "valor_cliente_liquido", "dias_calculados", "aliquota_aplicada", "valor_honorario_calculado", "saldo_start", "erro_inss_pagou_menos"],
                    additionalProperties: false
                  }
                },
                totais_final: {
                  type: "object",
                  properties: {
                    total_liquido_cliente: { type: "number" },
                    total_honorario_total: { type: "number" },
                    total_honorario_pago: { type: "number" },
                    total_honorario_saldo: { type: "number" },
                    saldo_da_cliente: { type: "number" }
                  },
                  required: ["total_liquido_cliente", "total_honorario_total", "total_honorario_pago", "total_honorario_saldo", "saldo_da_cliente"],
                  additionalProperties: false
                }
              },
              required: ["fatura_texto_completo", "dados_cliente", "linhas", "totais_final"],
              additionalProperties: false
            }
          }
        }
      });

      return res.status(200).json(JSON.parse(completion.choices[0].message.content));
    }

    // --- MODO SAVE (GRAVA NO SUPABASE) ---
    if (action === 'save') {
      const { dados, primeiraParcela, valoresAnteriores } = body;
      console.log("💾 Modo Save: Gravando...");

      const { data: insert, error } = await supabase.from("calculos_start_prev").insert({
        primeira_parcela: !!primeiraParcela,
        valor_previsto_anterior: valoresAnteriores?.previsto || 0,
        valor_recebido_anterior: valoresAnteriores?.recebido || 0,
        total_inss: 0, // Campo legado ou calcular se precisar
        total_cliente: toNumber(dados.totais_final.total_liquido_cliente),
        honorario_total: toNumber(dados.totais_final.total_honorario_total),
        honorario_ja_pago: toNumber(dados.totais_final.total_honorario_pago),
        saldo_start_final: toNumber(dados.totais_final.total_honorario_saldo),
        saldo_da_cliente: toNumber(dados.totais_final.saldo_da_cliente),
        resultado_json: dados
      }).select().single();

      if (error) throw error;

      if (dados.linhas.length > 0) {
        const items = dados.linhas.map((l, i) => ({
           calculo_id: insert.id,
           ordem_parcela: i + 1,
           competencia: l.competencia,
           status_inss: l.status_inss,
           data_inss: brDateToIso(l.data_inss),
           valor_cliente: toNumber(l.valor_cliente_liquido),
           valor_previsto: toNumber(l.valor_honorario_calculado),
           saldo_start_depois: toNumber(l.saldo_start),
           aliquota_aplicada: toNumber(l.aliquota_aplicada),
           dias_calculados: toNumber(l.dias_calculados),
           erro_inss_pagou_menos: l.erro_inss_pagou_menos || false,
           msg_alerta_inss: l.msg_alerta_inss || ""
        }));
        await supabase.from("distribuicao_honorarios").insert(items);
      }

      return res.status(200).json({ success: true, id: insert.id });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
