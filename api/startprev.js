import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// -----------------------------------------------------------------------------
// Configuração OpenAI
// -----------------------------------------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -----------------------------------------------------------------------------
// Configuração Supabase (usa SERVICE ROLE no backend, nunca no frontend)
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// Função auxiliar: chama o modelo gpt-5.1 via Responses API
// -----------------------------------------------------------------------------
async function chamarIAStartPrev({
  pdfText,
  primeiraParcela,
  valorPrevistoAnterior,
  valorRecebidoAnterior,
}) {
  // Normaliza booleano
  const primeiraParcelaBool =
    primeiraParcela === true ||
    primeiraParcela === "true" ||
    primeiraParcela === "sim" ||
    primeiraParcela === "Sim";

  const response = await openai.responses.create({
    model: "gpt-5.1",
    reasoning: { effort: "medium" },

    // ⚠️ Aqui é onde entram as REGRAS DO PROMPT MESTRE.
    // Coloque/resuma aqui todas as suas instruções detalhadas
    // (regras de MR, 30%, 40%, datas, etc).
    instructions: `
Você é um especialista da Start Prev em cálculo de honorários sobre benefício do INSS
(geralmente salário-maternidade). Sua tarefa é:

1) Ler o texto extraído do PDF de Histórico de Créditos do INSS.
2) Calcular todas as parcelas, honorários e saldos conforme as regras internas da Start Prev.
3) Devolver APENAS um JSON válido, seguindo o schema abaixo, SEM nenhum texto adicional.

Schema de saída:

{
  "linhas": [
    {
      "parcela": "Parcela 1",
      "data_inss": "03/11/2025",
      "valor_inss": 1405.00,
      "valor_cliente": 913.25,
      "valor_previsto": 491.75,
      "valor_recebido": 491.75,
      "saldo_start": 1880.05,
      "saldo_cliente": 0.00
    }
  ],
  "totais_final": {
    "total_cliente": 3313.79,
    "total_start": 3678.56,
    "saldo_cliente_final": 4592.21
  }
}

Regras:
- NUNCA escreva nada fora do JSON.
- NUNCA inclua comentários.
- Todos os valores monetários devem ser números, com ponto como separador decimal.
- "linhas" é a lista de parcelas, na ordem cronológica em que a cliente recebe.
- "totais_final" resume os totais de cliente e Start Prev ao final de todas as parcelas.

Use também como contexto:
- primeira_parcela: indica se esta é a primeira parcela recebida (booleano).
- valor_previsto_anterior e valor_recebido_anterior: somatórios de faturas anteriores, se existirem.
`,

    // Passa os dados estruturados como input do usuário
    input: [
      {
        role: "user",
        content: JSON.stringify({
          pdf_text: pdfText,
          primeira_parcela: primeiraParcelaBool,
          valor_previsto_anterior: valorPrevistoAnterior,
          valor_recebido_anterior: valorRecebidoAnterior,
        }),
      },
    ],

    // Exigir JSON seguindo o schema
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "StartPrevResultado",
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
                  saldo_cliente: { type: "number" },
                },
                required: [
                  "parcela",
                  "data_inss",
                  "valor_inss",
                  "valor_cliente",
                  "valor_previsto",
                  "valor_recebido",
                  "saldo_start",
                  "saldo_cliente",
                ],
                additionalProperties: true,
              },
            },
            totais_final: {
              type: "object",
              properties: {
                total_cliente: { type: "number" },
                total_start: { type: "number" },
                saldo_cliente_final: { type: "number" },
              },
              additionalProperties: true,
            },
          },
          required: ["linhas"],
          additionalProperties: true,
        },
      },
    },
  });

  // A Responses API retorna a saída em response.output[0].content[0].text
  const content = response.output?.[0]?.content?.[0];
  const jsonText = content?.text;

  if (!jsonText) {
    throw new Error("Não foi possível extrair texto JSON da resposta da IA.");
  }

  const parsed = JSON.parse(jsonText);
  return parsed;
}

// -----------------------------------------------------------------------------
// Função principal da rota /api/startprev
// -----------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido. Use POST." });
  }

  try {
    const {
      pdfText,
      primeiraParcela,
      valorPrevistoAnterior,
      valorRecebidoAnterior,
    } = req.body || {};

    if (!pdfText || typeof pdfText !== "string") {
      return res
        .status(400)
        .json({ error: "Campo 'pdfText' é obrigatório e deve ser texto." });
    }

    const valorPrevisto =
      typeof valorPrevistoAnterior === "number"
        ? valorPrevistoAnterior
        : Number(
            String(valorPrevistoAnterior || "0").replace(".", "").replace(",", ".")
          ) || 0;

    const valorRecebido =
      typeof valorRecebidoAnterior === "number"
        ? valorRecebidoAnterior
        : Number(
            String(valorRecebidoAnterior || "0").replace(".", "").replace(",", ".")
          ) || 0;

    // 1) Chama a IA pra calcular linhas e totais
    const resultadoIA = await chamarIAStartPrev({
      pdfText,
      primeiraParcela,
      valorPrevistoAnterior: valorPrevisto,
      valorRecebidoAnterior: valorRecebido,
    });

    const linhas = resultadoIA.linhas || [];
    const totais_final = resultadoIA.totais_final || null;

    // 2) (Opcional) salva um "snapshot" do cálculo no Supabase
    try {
      await supabase.from("calculos_start_prev").insert({
        // cliente_id: null, // se tiver um ID de cliente, passe aqui
        pdf_filename: null,
        primeira_parcela:
          primeiraParcela === true ||
          primeiraParcela === "true" ||
          primeiraParcela === "sim" ||
          primeiraParcela === "Sim",
        valor_previsto_anterior: valorPrevisto,
        valor_recebido_anterior: valorRecebido,
        total_inss: null,
        honorario_total: null,
        honorario_ja_pago: null,
        saldo_start_inicial: null,
        saldo_start_final: totais_final?.total_start ?? null,
        total_cliente: totais_final?.total_cliente ?? null,
        saldo_da_cliente: totais_final?.saldo_cliente_final ?? null,
        resultado_json: resultadoIA,
      });
    } catch (dbErr) {
      console.error("Erro ao salvar cálculo no Supabase (não fatal):", dbErr);
      // Não interrompe a resposta para o front.
    }

    // 3) Responde para o frontend exatamente o que a página espera
    return res.status(200).json({
      ok: true,
      linhas,
      totais_final,
    });
  } catch (err) {
    console.error("Erro geral em /api/startprev:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Erro interno no processamento." });
  }
}
