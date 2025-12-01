import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// CONFIGURAÇÕES
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

// HELPERS
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

// ---------------------------------------------------------------------
// PROMPT COM AS NOVAS REGRAS DE ESCALONAMENTO E TETO
// ---------------------------------------------------------------------
const SYSTEM_PROMPT = `
VOCÊ É O MOTOR DE DECISÃO FINANCEIRA DA START PREV.

======================================================================
REGRAS DE CÁLCULO E AUDITORIA
======================================================================

1) CONCEITOS BÁSICOS
- Base de Cálculo: Rubrica 101 (MR).
- Honorário Total Contratual: 30% sobre o TOTAL LÍQUIDO recebido pelo cliente (soma de todas as parcelas).
- Saldo a Receber: Honorário Total - Honorários já pagos anteriormente.

2) AGRUPAMENTO (LIBERAÇÕES)
- O INSS paga por DATA. Agrupe parcelas com a MESMA data em uma única LIBERAÇÃO.
- Ex: Mensal + 13º na mesma data = UMA liberação com valor somado.

3) ESTRATÉGIA DE COBRANÇA (ESCALONAMENTO POR VALOR)
Para cada liberação FUTURA (pendente), aplique a seguinte lógica SEQUENCIAL:

   PASSO A: Definir a Alíquota Base
   - Se o valor líquido da liberação for >= R$ 1.600,00: Base = 40%.
   - Se o valor líquido da liberação for < R$ 1.600,00: Base = 35%.

   PASSO B: Calcular a Retenção Potencial
   - Retenção = Valor Liberação * Base.

   PASSO C: Aplicar a TRAVA DO TETO (CRUCIAL)
   - Compare a 'Retenção' com o 'Saldo a Receber' restante.
   - SE Retenção > Saldo a Receber:
     -> A cobrança deve ser EXATAMENTE igual ao Saldo a Receber. (A alíquota efetiva será menor que a base).
     -> O Saldo a Receber para as próximas parcelas vira ZERO.
   - SE Retenção <= Saldo a Receber:
     -> Mantenha a Retenção calculada.
     -> Subtraia esse valor do Saldo a Receber para a próxima iteração.

4) AUDITORIA DE VALOR (ALERTA VERMELHO)
- Para cada parcela, faça a "Prova Real":
  • Valor Esperado = (MR / 30) * Dias do Período (DIP até fim do mês ou DCB).
  • Se o Valor Líquido do PDF for significativamente MENOR que o Valor Esperado (diferença > R$ 10,00), marque a flag 'erro_inss_pagou_menos' como TRUE.
  • Exceção: Desconsidere 13º salário nessa prova real de dias.

5) OUTPUT JSON
Gere um JSON estrito para alimentar o frontend.
`;

// HANDLER
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const rawBody = await readBody(req);
    const body = JSON.parse(rawBody || "{}");
    const { pdfText, valorPrevistoAnterior = 0, valorRecebidoAnterior = 0, primeiraParcela = true } = body;

    if (!pdfText) return res.status(400).json({ error: "pdfText obrigatório" });

    const vpAnterior = Number(valorPrevistoAnterior) || 0;
    const vrAnterior = Number(valorRecebidoAnterior) || 0;

    console.log("🔵 Acionando Motor Start Prev (GPT-4o) - Regra Escalonada + Teto...");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-2024-08-06",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { 
          role: "user", 
          content: JSON.stringify({ 
            pdf_text: pdfText, 
            honorario_ja_pago_informado: vrAnterior,
            contexto: primeiraParcela ? "Primeira análise" : "Análise recorrente"
          }) 
        }
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
              linhas: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    numero_parcela: { type: "string" },
                    competencia: { type: "string" },
                    data_inss: { type: "string" },
                    status_inss: { type: "string" },
                    valor_inss_bruto: { type: "number" },
                    valor_cliente_liquido: { type: "number" },
                    
                    // NOVOS CAMPOS PARA AUDITORIA
                    dias_calculados: { type: "number", description: "Quantos dias a IA calculou para o periodo" },
                    erro_inss_pagou_menos: { type: "boolean", description: "True se o valor recebido for menor que o devido proporcional" },
                    msg_alerta_inss: { type: "string", description: "Explicação curta se houver erro (ex: 'Pagou 20 dias mas devia 30')" },
                    
                    // CAMPOS DA ESTRATÉGIA
                    aliquota_aplicada: { type: "number", description: "Percentual usado (ex: 0.4 ou 0.35 ou menor)" },
                    valor_honorario_calculado: { type: "number" },
                    
                    saldo_start: { type: "number" },
                    saldo_cliente: { type: "number", nullable: true }
                  },
                  required: ["numero_parcela", "competencia", "data_inss", "status_inss", "valor_inss_bruto", "valor_cliente_liquido", "dias_calculados", "erro_inss_pagou_menos", "aliquota_aplicada", "valor_honorario_calculado", "saldo_start", "saldo_cliente"],
                  additionalProperties: false
                }
              },
              totais_final: {
                type: "object",
                properties: {
                  total_bruto: { type: "number" },
                  total_liquido_cliente: { type: "number" },
                  total_honorario_total: { type: "number" },
                  total_honorario_pago: { type: "number" },
                  total_honorario_saldo: { type: "number" },
                  saldo_start_final: { type: "number" },
                  saldo_da_cliente: { type: "number" }
                },
                required: ["total_bruto", "total_liquido_cliente", "total_honorario_total", "total_honorario_pago", "total_honorario_saldo", "saldo_start_final", "saldo_da_cliente"],
                additionalProperties: false
              }
            },
            required: ["fatura_texto_completo", "linhas", "totais_final"],
            additionalProperties: false
          }
        }
      }
    });

    const output = JSON.parse(completion.choices[0].message.content);

    // Salvar no Supabase
    const { data: calcInsert, error: calcError } = await supabase
      .from("calculos_start_prev")
      .insert({
        primeira_parcela: !!primeiraParcela,
        valor_previsto_anterior: vpAnterior,
        valor_recebido_anterior: vrAnterior,
        total_inss: toNumber(output.totais_final.total_bruto),
        honorario_total: toNumber(output.totais_final.total_honorario_total),
        honorario_ja_pago: toNumber(output.totais_final.total_honorario_pago),
        saldo_start_inicial: 0,
        saldo_start_final: toNumber(output.totais_final.total_honorario_saldo),
        total_cliente: toNumber(output.totais_final.total_liquido_cliente),
        saldo_da_cliente: toNumber(output.totais_final.saldo_da_cliente),
        resultado_json: output,
      })
      .select()
      .single();
      
    if (calcError) console.error("Erro BD:", calcError);

    // Salvar distribuição
    if (!calcError && output.linhas.length > 0) {
       const distRows = output.linhas.map((l, index) => ({
          calculo_id: calcInsert.id,
          ordem_parcela: index + 1,
          data_inss: brDateToIso(l.data_inss),
          valor_inss: toNumber(l.valor_inss_bruto),
          valor_cliente: toNumber(l.valor_cliente_liquido),
          valor_previsto: toNumber(l.valor_honorario_calculado),
          saldo_start_depois: toNumber(l.saldo_start),
          saldo_start_antes: 0 
       }));
       await supabase.from("distribuicao_honorarios").insert(distRows);
    }

    res.status(200).json(output);

  } catch (err) {
    console.error("Erro:", err);
    res.status(500).json({ error: err.message });
  }
}
