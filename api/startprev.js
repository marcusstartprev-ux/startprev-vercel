import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------
// Configuração OpenAI (workflow de 6 agentes)
// ---------------------------------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------------------------------------------------------------
// Configuração Supabase (usa SERVICE ROLE no backend, nunca no frontend)
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

// Converte "03/11/2025" -> "2025-11-03"
function brDateToIso(br) {
  if (!br) return null;
  const parts = br.split("/");
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// Converte qualquer coisa pra número decimal
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

// Lê o corpo da requisição (req) e devolve string
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
// Função serverless Vercel (Node.js) - /api/startprev
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
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Body inválido, deve ser JSON." }));
      return;
    }

    const {
      pdfText,
      valorPrevistoAnterior = 0,
      valorRecebidoAnterior = 0,
      primeiraParcela = true,
    } = body;

    if (!pdfText || typeof pdfText !== "string") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "pdfText é obrigatório e deve ser uma string com o texto do PDF.",
        })
      );
      return;
    }

    const vpAnterior = Number(valorPrevistoAnterior) || 0;
    const vrAnterior = Number(valorRecebidoAnterior) || 0;

    // -----------------------------------------------------------------
    // 1) Chamar WORKFLOW OpenAI (seus 6 agentes)
    // -----------------------------------------------------------------
    const run = await openai.workflows.runs.create({
      workflow_id: process.env.OPENAI_WORKFLOW_ID,
      input: {
        pdf_text: pdfText,
        valor_previsto_anterior: vpAnterior,
        valor_recebido_anterior: vrAnterior,
        primeira_parcela: !!primeiraParcela,
      },
    });

    let output = run.output;

    // Se vier como string, tenta converter pra JSON
    if (typeof output === "string") {
      try {
        output = JSON.parse(output);
      } catch (e) {
        console.error("Erro ao fazer JSON.parse na saída do workflow:", e);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "Saída do workflow não é um JSON válido.",
          })
        );
        return;
      }
    }

    if (!output || !output.linhas || !output.totais_final) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error:
            "Workflow não retornou estrutura esperada (linhas + totais_final).",
          raw: output,
        })
      );
      return;
    }

    const linhas = output.linhas;
    const totais = output.totais_final;

    // -----------------------------------------------------------------
    // 2) Calcular derivados para salvar em calculos_start_prev
    // -----------------------------------------------------------------
    const totalInss = toNumber(totais.total_inss);
    const totalPrevisto = toNumber(totais.total_previsto);
    const totalCliente = toNumber(totais.total_cliente);
    const totalRecebido = toNumber(totais.total_recebido);
    const saldoStartFinal = toNumber(totais.saldo_start_final);
    const saldoDaCliente = toNumber(totais.saldo_da_cliente);

    const honorarioTotal = totalPrevisto;
    const honorarioJaPago = vrAnterior;

    let saldoStartInicial = honorarioTotal - honorarioJaPago;
    if (saldoStartInicial < 0) saldoStartInicial = 0;

    if (linhas.length > 0) {
      const primeira = linhas[0];
      const saldoDepoisPrimeira = toNumber(primeira.saldo_start);
      const honorPrimeira = toNumber(primeira.valor_previsto);
      const saldoAntesPrimeira = saldoDepoisPrimeira + honorPrimeira;
      if (!Number.isNaN(saldoAntesPrimeira)) {
        saldoStartInicial = saldoAntesPrimeira;
      }
    }

    // -----------------------------------------------------------------
    // 3) Inserir em calculos_start_prev
    // -----------------------------------------------------------------
    const { data: calcInsert, error: calcError } = await supabase
      .from("calculos_start_prev")
      .insert({
        primeira_parcela: !!primeiraParcela,
        pdf_filename: null, // se quiser, preencha com nome real do arquivo
        valor_previsto_anterior: vpAnterior,
        valor_recebido_anterior: vrAnterior,
        total_inss: totalInss,
        honorario_total: honorarioTotal,
        honorario_ja_pago: honorarioJaPago,
        saldo_start_inicial: saldoStartInicial,
        saldo_start_final: saldoStartFinal,
        total_cliente: totalCliente,
        saldo_da_cliente: saldoDaCliente,
        resultado_json: output,
      })
      .select()
      .single();

    if (calcError) {
      console.error("Erro ao inserir em calculos_start_prev:", calcError);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "Erro ao salvar cálculo no banco (calculos_start_prev).",
        })
      );
      return;
    }

    const calculoId = calcInsert.id;

    // -----------------------------------------------------------------
    // 4) Inserir linhas em distribuicao_honorarios
    // -----------------------------------------------------------------
    const distRows = linhas.map((l) => {
      const ordemParcela = l.parcela ?? 0;
      const valorInss = toNumber(l.valor_inss);
      const valorCliente = toNumber(l.valor_cliente);
      const valorPrevisto = toNumber(l.valor_previsto);
      const valorRecebido = toNumber(l.valor_recebido);
      const saldoDepois = toNumber(l.saldo_start);
      const saldoAntes = saldoDepois + valorPrevisto;

      return {
        calculo_id: calculoId,
        liberacao_id: null, // se quiser, depois vinculamos pela data_inss
        ordem_parcela: ordemParcela,
        data_inss: brDateToIso(l.data_inss),
        valor_inss: valorInss,
        valor_cliente: valorCliente,
        valor_previsto: valorPrevisto,
        valor_recebido: valorRecebido,
        saldo_start_antes: saldoAntes,
        saldo_start_depois: saldoDepois,
      };
    });

    if (distRows.length > 0) {
      const { error: distError } = await supabase
        .from("distribuicao_honorarios")
        .insert(distRows);

      if (distError) {
        console.error(
          "Erro ao inserir em distribuicao_honorarios:",
          distError
        );
        // não interrompe a resposta pro front, só loga
      }
    }

    // -----------------------------------------------------------------
    // 5) Responder ao frontend com o JSON que ele espera
    // -----------------------------------------------------------------
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(output));
  } catch (err) {
    console.error("Erro geral em /api/startprev:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "Erro interno no processamento.",
        details: err.message,
      })
    );
  }
}
