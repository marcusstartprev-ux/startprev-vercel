// ============================================================================
// START PREV - API VERCEL (MULTI-AGENTES)
// ============================================================================
// - Recebe texto do PDF via POST do front
// - Envia para o WORKFLOW (6 agentes) do Agent Builder
// - Aguarda a conclusão via polling
// - Retorna JSON final para a página (linhas + totais_final)
// - Salva snapshot no Supabase
// ============================================================================

import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// VARIÁVEIS DE AMBIENTE
// ---------------------------------------------------------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---------------------------------------------------------------------------
// CONFIGURAÇÃO DO SUPABASE
// ---------------------------------------------------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// ---------------------------------------------------------------------------
// WORKFLOW / AGENT BUILDER (6 AGENTES)
// ---------------------------------------------------------------------------
const WORKFLOW_ID = "wf_692b2e9a94e88190807ca365f3ac6241019dd77ac57ba878";

// ============================================================================
// FUNÇÃO - INICIAR RUN DO WORKFLOW
// ============================================================================
async function iniciarWorkflow(inputObj) {
  const response = await fetch("https://api.openai.com/v1/agent_runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      agent_id: WORKFLOW_ID,
      input: inputObj
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro ao iniciar workflow:", data);
    throw new Error("Falha ao iniciar workflow");
  }

  return data.run_id;
}

// ============================================================================
// FUNÇÃO - POLLING: AGUARDAR RESULTADO DO WORKFLOW
// ============================================================================
async function aguardarResultado(run_id) {
  while (true) {
    const response = await fetch(
      `https://api.openai.com/v1/agent_runs/${run_id}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro no polling:", data);
      throw new Error("Erro ao consultar execução do workflow");
    }

    // STATUS DO WORKFLOW:
    // - waiting / running → continuar
    // - completed → pegar resultado
    // - failed → erro
    if (data.status === "completed") {
      return data.result;
    }

    if (data.status === "failed") {
      console.error("Workflow falhou:", data);
      throw new Error("Workflow retornou status FAILED");
    }

    // Aguarda 1 segundo antes do próximo polling
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// ============================================================================
// HANDLER DA ROTA /api/startprev
// ============================================================================
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido. Use POST."
    });
  }

  try {
    const {
      pdfText,
      primeiraParcela,
      valorPrevistoAnterior,
      valorRecebidoAnterior
    } = req.body || {};

    if (!pdfText) {
      return res.status(400).json({
        error: "pdfText é obrigatório."
      });
    }

    // -----------------------------------------------------------------------
    // 1️⃣ MONTA INPUT PARA OS 6 AGENTES
    // -----------------------------------------------------------------------
    const input = {
      pdf_text: pdfText,
      primeira_parcela:
        primeiraParcela === true ||
        primeiraParcela === "true" ||
        primeiraParcela === "sim",
      valor_previsto_anterior: Number(valorPrevistoAnterior || 0),
      valor_recebido_anterior: Number(valorRecebidoAnterior || 0)
    };

    console.log("🔵 Enviando ao workflow:", input);

    // -----------------------------------------------------------------------
    // 2️⃣ INICIA O WORKFLOW
    // -----------------------------------------------------------------------
    const run_id = await iniciarWorkflow(input);
    console.log("🟡 Workflow iniciado. run_id =", run_id);

    // -----------------------------------------------------------------------
    // 3️⃣ POLLING ATÉ CONCLUSÃO
    // -----------------------------------------------------------------------
    const result = await aguardarResultado(run_id);
    console.log("🟢 Workflow concluído:", result);

    // O resultado DEVE conter:
    // {
    //   linhas: [...],
    //   totais_final: {...}
    // }
    const linhas = result?.output?.linhas || result?.linhas || [];
    const totais_final =
      result?.output?.totais_final || result?.totais_final || null;

    // -----------------------------------------------------------------------
    // 4️⃣ SALVAR SNAPSHOT NO SUPABASE (OPCIONAL)
    // -----------------------------------------------------------------------
    try {
      await supabase.from("calculos_start_prev").insert({
        pdf_filename: null,
        primeira_parcela: input.primeira_parcela,
        valor_previsto_anterior: input.valor_previsto_anterior,
        valor_recebido_anterior: input.valor_recebido_anterior,
        resultado_json: result,
        total_cliente: totais_final?.total_cliente || null,
        saldo_start_final: totais_final?.total_start || null,
        saldo_da_cliente: totais_final?.saldo_cliente_final || null
      });
    } catch (dbErr) {
      console.error("Erro ao salvar no Supabase (não fatal):", dbErr);
    }

    // -----------------------------------------------------------------------
    // 5️⃣ RESPONDER PARA O FRONT-END
    // -----------------------------------------------------------------------
    return res.status(200).json({
      ok: true,
      linhas,
      totais_final
    });
  } catch (err) {
    console.error("❌ Erro geral no /api/startprev:", err);
    return res.status(500).json({
      ok: false,
      error: "Erro interno no processamento."
    });
  }
}
