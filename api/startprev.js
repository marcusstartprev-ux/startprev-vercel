import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------
// CONFIGURAÇÕES
// ---------------------------------------------------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

// ---------------------------------------------------------------------
// HELPERS
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
// PROMPT DE SISTEMA (AS REGRAS DE OURO)
// ---------------------------------------------------------------------
const SYSTEM_PROMPT = `
VOCÊ É O MOTOR DE INTELIGÊNCIA CONTÁBIL DA START PREV.
SUA MISSÃO É ANALISAR O EXTRATO DO INSS E GERAR UMA FATURA DE HONORÁRIOS SEGUINDO RIGOROSAMENTE AS REGRAS ABAIXO.

======================================================================
REGRAS DE EXTRAÇÃO E CÁLCULO
======================================================================

1) DADOS DO EXTRATO
- Extraia Nome, CPF, NB, DIB, DCB, DIP e MR (Média de Remunerações).
- Identifique cada parcela (Competência, Rubricas 101/104/206, Valor Líquido, Status, Data).

2) MR E TABELA 2025
- Base de cálculo = Rubrica 101 (MR).
- Tabela 2025:
  • Até 1.518,00: 7,5%
  • 1.518,01 a 2.793,88: 9%
  • 2.793,89 a 4.190,83: 12%
  • 4.190,84 a 8.157,41: 14%
- Identifique a faixa do MR da cliente para fins de registro.

3) AGRUPAMENTO (LIBERAÇÕES)
- O INSS paga por DATA. Agrupe parcelas com mesma data prevista em uma única LIBERAÇÃO.
- Mensal + 13º na mesma data = UMA liberação (some os líquidos).

4) CÁLCULO FINANCEIRO
- TOTAL LÍQUIDO INSS = Soma de todos os líquidos (pagos e futuros) entre DIB e DCB.
- HONORÁRIO TOTAL = 30% do Total Líquido INSS.
- SALDO A RECEBER = Honorário Total - Honorário Já Pago (informado pelo usuário).

5) CALENDÁRIO E PROJEÇÃO
- Se não houver data no PDF, projete usando o final do NB e o Calendário INSS 2025.
- Competência X paga no mês X+1.

6) ESTRATÉGIA DE COBRANÇA (TESTE DE À VISTA)
- Ordene as liberações FUTURAS da maior para a menor.
- TESTE À VISTA: (Valor Liberação - Saldo Honorários) / Valor Liberação >= 50%?
  • SIM: Cobre tudo nessa liberação. Encerre cobranças nas demais.
  • NÃO: Aplique COBRANÇA ESCALONADA.

7) COBRANÇA ESCALONADA
- 1ª liberação: máx 40% (cliente deve ficar com min 60%).
- 2ª liberação: máx 35%.
- 3ª liberação: máx 30%.
- Última liberação: Cobre o restante devido, sem limite de %.

8) OUTPUT ESPERADO (JSON)
- Gere um JSON contendo os dados estruturados para tabela E o texto completo da fatura conforme seção 10 das regras.
`;

// ---------------------------------------------------------------------
// HANDLER PRINCIPAL
// ---------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const rawBody = await readBody(req);
    const body = JSON.parse(rawBody || "{}");
    const { pdfText, valorPrevistoAnterior = 0, valorRecebidoAnterior = 0, primeiraParcela = true } = body;

    if (!pdfText) return res.status(400).json({ error: "pdfText obrigatório" });

    const vpAnterior = Number(valorPrevistoAnterior) || 0;
    const vrAnterior = Number(valorRecebidoAnterior) || 0;

    console.log("🔵 Acionando Motor de Decisão Start Prev (GPT-4o)...");

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
              dados_cliente: {
                type: "object",
                properties: {
                  nome: { type: "string" },
                  cpf: { type: "string" },
                  nb: { type: "string" },
                  mr_valor: { type: "number" },
                  mr_faixa_analise: { type: "string", description: "Texto explicando a faixa 2025" }
                },
                required: ["nome", "cpf", "nb", "mr_valor", "mr_faixa_analise"],
                additionalProperties: false
              },
              fatura_texto_completo: {
                type: "string",
                description: "O texto da FATURA DE HONORÁRIOS formatado com quebras de linha, pronto para copiar e colar, seguindo o item 10 das regras."
              },
              linhas: {
                type: "array",
                description: "Dados para a tabela visual do sistema",
                items: {
                  type: "object",
                  properties: {
                    numero_parcela: { type: "string" },
                    competencia: { type: "string" },
                    data_inss: { type: "string" },
                    status_inss: { type: "string" },
                    valor_inss_bruto: { type: "number" },
                    valor_cliente_liquido: { type: "number" },
                    valor_honorario_calculado: { type: "number", description: "Quanto será cobrado desta parcela específica segundo a estratégia" },
                    saldo_start: { type: "number" },
                    saldo_cliente: { type: "number", nullable: true }
                  },
                  required: ["numero_parcela", "competencia", "data_inss", "status_inss", "valor_inss_bruto", "valor_cliente_liquido", "valor_honorario_calculado", "saldo_start", "saldo_cliente"],
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
            required: ["dados_cliente", "fatura_texto_completo", "linhas", "totais_final"],
            additionalProperties: false
          }
        }
      }
    });

    const output = JSON.parse(completion.choices[0].message.content);

    // Salvar no Supabase (Mantém histórico e salva o texto da fatura)
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
        resultado_json: output, // Salva o JSON completo com o texto da fatura
      })
      .select()
      .single();
      
    if (calcError) console.error("Erro ao salvar BD:", calcError);

    // Salvar itens da distribuição (para gráficos futuros)
    if (!calcError && output.linhas.length > 0) {
       const distRows = output.linhas.map((l, index) => ({
          calculo_id: calcInsert.id,
          ordem_parcela: index + 1,
          data_inss: brDateToIso(l.data_inss),
          valor_inss: toNumber(l.valor_inss_bruto),
          valor_cliente: toNumber(l.valor_cliente_liquido),
          valor_previsto: toNumber(l.valor_honorario_calculado),
          saldo_start_depois: toNumber(l.saldo_start),
          saldo_start_antes: 0 // Simplificação
       }));
       await supabase.from("distribuicao_honorarios").insert(distRows);
    }

    res.status(200).json(output);

  } catch (err) {
    console.error("Erro:", err);
    res.status(500).json({ error: err.message });
  }
}
