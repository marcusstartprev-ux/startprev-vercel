// ============================================================================
// START PREV - API VERCEL USANDO RESPONSES API (6 "AGENTES" EM UM PIPELINE)
// ============================================================================

import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// VARIÁVEIS DE AMBIENTE
// ---------------------------------------------------------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---------------------------------------------------------------------------
// CONFIGURAÇÃO SUPABASE
// ---------------------------------------------------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// FUNÇÃO: CHAMA OPENAI RESPONSES API
// ---------------------------------------------------------------------------
async function chamarStartPrevIA({ pdfText, primeiraParcela, valorPrevistoAnterior, valorRecebidoAnterior }) {
  const inputPayload = {
    pdf_text: pdfText,
    primeira_parcela: primeiraParcela,
    valor_previsto_anterior: valorPrevistoAnterior,
    valor_recebido_anterior: valorRecebidoAnterior,
  };

  console.log("🔵 Enviando à OpenAI (Responses API):", inputPayload);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o", // modelo real e suportado
      instructions: `
Você é um pipeline de 6 especialistas da Start Prev trabalhando em conjunto:

1) ANALISTA DE EXTRATO DO INSS
   - Lê o campo "pdf_text" (histórico de créditos).
   - Identifica NB, DIB, DCB, DIP, MR, parcelas (competência, período, valor bruto, desconto, líquido, status).

2) CALCULADORA DE MR E PARCELAS
   - Usa MR informado no extrato ou MR padrão (R$ 1.518,00) quando aplicável.
   - Regras (simplificadas para este contexto):
     * Mês cheio (01/XX a 30/XX ou 31/XX): valor bruto = MR integral.
     * Período parcial: valor bruto proporcional (MR/30 * dias).
     * Desconto INSS nos retroativos: 7,5% sobre o MR de cada mês.

3) CONTADOR DE PARCELAS
   - Determina todas as parcelas do benefício (pelo menos as que aparecem no extrato).
   - Marca status como "PAGO" quando já há data de pagamento; "PENDENTE" quando ainda não.
   - Soma o total líquido do INSS (todas as parcelas, inclusive 13º, quando houver).

4) ESTRATEGISTA DE COBRANÇA DE HONORÁRIOS
   - Honorário total = 30% do total líquido INSS (considerando 120 dias / 4 meses).
   - Considera valores já pagos anteriormente:
       valor_previsto_anterior = soma de honorários previstos em faturas anteriores.
       valor_recebido_anterior = soma de honorários efetivamente recebidos.
   - Define saldo_start_inicial = honorário_total - valor_recebido_anterior.
   - Estratégia padrão: frente pesada (40% / 35% / 30% / restante), respeitando:
       * Máximo 40% de cada parcela para Start.
       * Cliente deve ficar com pelo menos 60% (exceto última parcela, que pode quitar tudo).
   - Se o saldo cabe à vista em uma única parcela (cliente fica com >= 50%):
       aplicar à vista naquela parcela e zerar nas demais.

5) VALIDADOR
   - Verifica:
       * Nenhuma parcela (exceto última) ultrapassa 40% para Start Prev.
       * Cliente nunca recebe menos de 60% em cada parcela (exceto última, se for necessária para quitar).
       * Totais fecham: total_cliente + total_start = total líquido INSS.
   - Se algo não fecha, ajustar distribuição mantendo as regras o máximo possível.

6) FORMATADOR
   - A saída FINAL deve ser EXCLUSIVAMENTE um JSON válido, no formato:

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

- "linhas" = uma por parcela, na ORDEM em que a cliente recebe.
- "valor_previsto" = quanto está previsto de honorário Start naquela parcela.
- "valor_recebido" = quanto já foi efetivamente recebido de Start naquela parcela (no contexto atual).
- "saldo_start" = saldo restante de honorários Start após aquela parcela.
- "saldo_cliente" = saldo acumulado que a cliente ainda tem a receber ao final daquela parcela.
- TODOS valores monetários devem ser números (sem "R$" e usando ponto como separador decimal).
- NÃO escreva comentários, textos explicativos ou qualquer coisa fora desse JSON.
      `,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(inputPayload),
            },
          ],
        },
      ],
    }),
  });

  const rawText = await response.text();

  if (!response.ok) {
    console.error("❌ Erro HTTP da OpenAI:", response.status, rawText.slice(0, 300));
    throw new Error(`Falha ao chamar OpenAI: status ${response.status}`);
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    console.error("❌ Resposta da OpenAI não é JSON válido. Início:", rawText.slice(0, 300));
    throw e;
  }

  const outputText =
    data.output_text ||
    data.output?.[0]?.content?.[0]?.text ||
    null;

  if (!outputText) {
    console.error("❌ Não foi possível localizar output_text na resposta:", data);
    throw new Error("Resposta da OpenAI não contém output_text");
  }

  let resultadoJSON;
  try {
    resultadoJSON = JSON.parse(outputText);
  } catch (e) {
    console.error("❌ output_text não é JSON válido. output_text =", outputText);
    throw e;
  }

  return resultadoJSON;
}

// ============================================================================
// HANDLER DA ROTA /api/startprev
// ============================================================================
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido. Use POST." });
  }

  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY não configurada." });
    }

    const {
      pdfText,
      primeiraParcela,
      valorPrevistoAnterior,
      valorRecebidoAnterior,
    } = req.body || {};

    if (!pdfText) {
      return res.status(400).json({ error: "pdfText é obrigatório." });
    }

    const primeiraParcelaBool =
      primeiraParcela === true ||
      primeiraParcela === "true" ||
      primeiraParcela === "sim";

    const valorPrev = Number(valorPrevistoAnterior || 0);
    const valorRec = Number(valorRecebidoAnterior || 0);

    // 1) chama a IA
    const resultadoIA = await chamarStartPrevIA({
      pdfText,
      primeiraParcela: primeiraParcelaBool,
      valorPrevistoAnterior: valorPrev,
      valorRecebidoAnterior: valorRec,
    });

    const linhas = resultadoIA.linhas || [];
    const totais_final = resultadoIA.totais_final || null;

    // 2) salva no Supabase (snapshot) – não é crítico se falhar
    try {
      await supabase.from("calculos_start_prev").insert({
        pdf_filename: null,
        primeira_parcela: primeiraParcelaBool,
        valor_previsto_anterior: valorPrev,
        valor_recebido_anterior: valorRec,
        resultado_json: resultadoIA,
        total_cliente: totais_final?.total_cliente ?? null,
        saldo_start_final: totais_final?.total_start ?? null,
        saldo_da_cliente: totais_final?.saldo_cliente_final ?? null,
      });
    } catch (dbErr) {
      console.error("⚠️ Erro ao salvar no Supabase (ignorado):", dbErr);
    }

    // 3) responde para o front-end
    return res.status(200).json({
      ok: true,
      linhas,
      totais_final,
    });
  } catch (err) {
    console.error("❌ Erro geral no /api/startprev:", err);
    return res.status(500).json({
      ok: false,
      error: "Erro interno no processamento.",
    });
  }
}
