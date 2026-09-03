require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SITE_DIR = path.join(__dirname, "SITE");
const SERVIDOR_PUBLICO = "https://projeto-inventario-rfid.onrender.com";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("ERRO: SUPABASE_URL e SUPABASE_SECRET_KEY precisam estar configurados.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

let esp32 = { conectado: false, ultimoContato: null, ip: null };

let rfidEvent = {
  nova: false, id: 0, uid: null, tipo: null, modo: null,
  mensagem: "Aguardando leitura RFID.",
  funcionario: null, equipamento: null,
  equipamentoRecebido: null, equipamentoEsperado: null,
  box: null, momento: 0
};

let fluxo = {
  modo: "idle",
  funcionario: null,
  acao: null,
  equipamentoSelecionado: null,
  expiraEm: 0
};

let cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
let ultimaLeitura = { uid: null, momento: 0 };

function normalizarUID(uid) {
  return String(uid ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function texto(v) {
  return v === null || v === undefined ? "" : String(v);
}
function agora() {
  return new Date().toISOString();
}
function statusNormalizado(v) {
  return texto(v).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function erroResposta(res, erro, status = 500) {
  console.error("ERRO:", erro);
  const mensagem = erro?.message || "Não foi possível concluir a operação.";
  return res.status(status).json({ sucesso: false, erro: mensagem, mensagem });
}
function publicarRFID(dados) {
  rfidEvent = {
    nova: true,
    id: Date.now(),
    uid: dados.uid || null,
    tipo: dados.tipo || null,
    modo: dados.modo || null,
    mensagem: dados.mensagem || "",
    funcionario: dados.funcionario || null,
    equipamento: dados.equipamento || null,
    equipamentoRecebido: dados.equipamentoRecebido || null,
    equipamentoEsperado: dados.equipamentoEsperado || null,
    box: dados.box ?? null,
    momento: Date.now()
  };
  return rfidEvent;
}
function limparFluxo() {
  fluxo = { modo: "idle", funcionario: null, acao: null, equipamentoSelecionado: null, expiraEm: 0 };
}
function expirarEstados() {
  const agoraMs = Date.now();
  if (fluxo.expiraEm && agoraMs > fluxo.expiraEm) {
    limparFluxo();
    publicarRFID({ tipo: "fluxo_expirado", mensagem: "A operação expirou por falta de leitura. Passe a tag do funcionário novamente." });
  }
  if (cadastroRFID.expiraEm && agoraMs > cadastroRFID.expiraEm) {
    cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
  }
}
function resumoFuncionario(f) {
  return f ? { id: f.id, nome: f.nome, matricula: f.matricula, uid_tag_pessoal: f.uid_tag_pessoal } : null;
}
function resumoEquipamento(e) {
  return e ? { id: e.id, nome: e.nome, uid_tag: e.uid_tag, box_id: e.box_id, status: e.status } : null;
}

async function buscarFuncionarioPorUID(uid) {
  const alvo = normalizarUID(uid);
  const r = await supabase.from("funcionarios").select("*").order("id", { ascending: true });
  if (r.error) throw r.error;
  return (r.data || []).find(f => normalizarUID(f.uid_tag_pessoal) === alvo) || null;
}
async function buscarEquipamentoPorUID(uid) {
  const alvo = normalizarUID(uid);
  const r = await supabase.from("equipamentos").select("*").order("id", { ascending: true });
  if (r.error) throw r.error;
  return (r.data || []).find(e => normalizarUID(e.uid_tag) === alvo) || null;
}
async function verificarUIDEmQualquerCadastro(uid) {
  const [f, e] = await Promise.all([
    supabase.from("funcionarios").select("*").order("id", { ascending: true }),
    supabase.from("equipamentos").select("*").order("id", { ascending: true })
  ]);
  if (f.error) throw f.error;
  if (e.error) throw e.error;
  const alvo = normalizarUID(uid);
  const funcionario = (f.data || []).find(x => normalizarUID(x.uid_tag_pessoal) === alvo);
  if (funcionario) return { encontrado: true, categoria: "funcionario", registro: funcionario };
  const equipamento = (e.data || []).find(x => normalizarUID(x.uid_tag) === alvo);
  if (equipamento) return { encontrado: true, categoria: "equipamento", registro: equipamento };
  return { encontrado: false, categoria: null, registro: null };
}
async function listarEquipamentosDisponiveis() {
  const r = await supabase.from("equipamentos").select("*").order("nome", { ascending: true });
  if (r.error) throw r.error;
  return (r.data || []).filter(e => statusNormalizado(e.status) === "disponivel");
}
async function listarEmprestimosAtivosDoFuncionario(funcionarioId) {
  const r = await supabase.from("emprestimos").select("*")
    .eq("funcionario_id", funcionarioId)
    .is("data_devolucao", null)
    .order("data_retirada", { ascending: true });
  if (r.error) throw r.error;
  const lista = r.data || [];
  if (!lista.length) return [];
  const ids = [...new Set(lista.map(x => x.equipamento_id).filter(Boolean))];
  const e = await supabase.from("equipamentos").select("*").in("id", ids);
  if (e.error) throw e.error;
  const mapa = Object.fromEntries((e.data || []).map(x => [x.id, x]));
  return lista.map(x => ({ ...x, equipamento: mapa[x.equipamento_id] || null }));
}
async function montarEmprestimos() {
  const r = await supabase.from("emprestimos").select("*").order("id", { ascending: false }).limit(100);
  if (r.error) throw r.error;
  const lista = r.data || [];
  const fids = [...new Set(lista.map(x => x.funcionario_id).filter(Boolean))];
  const eids = [...new Set(lista.map(x => x.equipamento_id).filter(Boolean))];
  const fm = {}, em = {};
  if (fids.length) {
    const f = await supabase.from("funcionarios").select("*").in("id", fids);
    if (f.error) throw f.error;
    for (const x of f.data || []) fm[x.id] = x;
  }
  if (eids.length) {
    const e = await supabase.from("equipamentos").select("*").in("id", eids);
    if (e.error) throw e.error;
    for (const x of e.data || []) em[x.id] = x;
  }
  return lista.map(x => ({ ...x, funcionario: fm[x.funcionario_id] || null, equipamento: em[x.equipamento_id] || null }));
}

/* PÁGINAS */
app.get("/", (req, res) => res.sendFile(path.join(SITE_DIR, "index.html")));
app.get("/cadastro", (req, res) => res.sendFile(path.join(SITE_DIR, "cadastro.html")));
app.get("/controle", (req, res) => res.sendFile(path.join(SITE_DIR, "controle.html")));
app.use(express.static(SITE_DIR, { index: false }));

/* SAÚDE */
app.get("/health", (req, res) => res.json({ sucesso: true, servidor: "online", banco: "Supabase", horario: agora() }));
app.get("/teste", (req, res) => res.json({ sucesso: true, mensagem: "Servidor RFID funcionando!", servidor: "online", banco: "Supabase", horario: agora(), esp32: esp32.conectado }));
app.get("/api/status", (req, res) => {
  expirarEstados();
  const ultimo = esp32.ultimoContato ? new Date(esp32.ultimoContato).getTime() : 0;
  const conectado = !!ultimo && Date.now() - ultimo < 30000;
  res.set("Cache-Control", "no-store");
  res.json({
    sucesso: true, servidor: "online", banco: "Supabase",
    esp32: { ...esp32, conectado },
    rfid: rfidEvent,
    fluxo: {
      modo: fluxo.modo, acao: fluxo.acao,
      funcionario: fluxo.funcionario,
      equipamentoSelecionado: resumoEquipamento(fluxo.equipamentoSelecionado),
      expiraEm: fluxo.expiraEm || 0
    }
  });
});

/* ESP32 */
app.post("/api/esp32/online", (req, res) => {
  esp32 = { conectado: true, ultimoContato: agora(), ip: texto(req.body?.ip).trim() || null };
  res.json({ sucesso: true, mensagem: "ESP32 conectado ao servidor.", horario: esp32.ultimoContato });
});
app.get("/api/esp32/status", (req, res) => {
  const ultimo = esp32.ultimoContato ? new Date(esp32.ultimoContato).getTime() : 0;
  res.json({ sucesso: true, conectado: !!ultimo && Date.now() - ultimo < 30000, ultimoContato: esp32.ultimoContato, ip: esp32.ip, ultimoRFID: rfidEvent.nova ? rfidEvent : null });
});

/* RFID recebido pelo ESP32 */
app.post("/api/esp32/rfid", async (req, res) => {
  try {
    const uid = normalizarUID(req.body?.uid);
    const leitor = texto(req.body?.leitor).trim() || "entrada";
    if (!uid) return res.status(400).json({ sucesso: false, tipo: "erro", mensagem: "UID não informado." });

    esp32.conectado = true;
    esp32.ultimoContato = agora();
    if (req.body?.ip) esp32.ip = texto(req.body.ip).trim() || esp32.ip;

    expirarEstados();

    if (ultimaLeitura.uid === uid && Date.now() - ultimaLeitura.momento < 1500) {
      return res.json({ sucesso: true, repetida: true, uid, mensagem: "Leitura repetida ignorada." });
    }
    ultimaLeitura = { uid, momento: Date.now() };
    console.log(`RFID ${uid} | leitor=${leitor}`);

    /* Cadastro: somente lê e valida, nunca altera estoque. */
    if (cadastroRFID.ativo && Date.now() < cadastroRFID.expiraEm) {
      const existente = await verificarUIDEmQualquerCadastro(uid);
      if (existente.encontrado) {
        const categoria = existente.categoria === "funcionario" ? "funcionário" : "equipamento";
        const evento = publicarRFID({
          uid, tipo: "tag_ja_cadastrada", modo: "cadastro",
          mensagem: `Esta tag já está cadastrada como ${categoria}: ${existente.registro.nome}. Escolha outra tag.`
        });
        cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
        return res.status(409).json({ sucesso: false, ...evento });
      }
      const evento = publicarRFID({
        uid, tipo: "cadastro_tag", modo: "cadastro",
        mensagem: `Tag disponível. UID ${uid} preenchido automaticamente.`
      });
      cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
      return res.json({ sucesso: true, ...evento });
    }

    /* Se já existe uma operação em andamento, só a tag esperada pode concluir. */
    if (fluxo.modo === "aguardando_equipamento" || fluxo.modo === "aguardando_devolucao") {
      const equipamento = await buscarEquipamentoPorUID(uid);
      if (!equipamento) {
        const evento = publicarRFID({
          uid, tipo: "tag_nao_cadastrada", modo: fluxo.modo,
          mensagem: "Esta tag não está cadastrada como equipamento. Passe a tag do equipamento selecionado."
        });
        return res.status(404).json({ sucesso: false, ...evento });
      }
      const esperado = fluxo.equipamentoSelecionado;
      if (!esperado || Number(equipamento.id) !== Number(esperado.id)) {
        const evento = publicarRFID({
          uid, tipo: "equipamento_incorreto", modo: fluxo.modo,
          mensagem: `TAG INCORRETA. Você selecionou "${esperado?.nome || "outro equipamento"}". Passe a tag desse equipamento.`,
          equipamentoRecebido: resumoEquipamento(equipamento),
          equipamentoEsperado: resumoEquipamento(esperado)
        });
        return res.status(409).json({ sucesso: false, ...evento });
      }

      if (fluxo.modo === "aguardando_equipamento") {
        if (statusNormalizado(equipamento.status) !== "disponivel") {
          const evento = publicarRFID({ uid, tipo: "equipamento_emprestado", mensagem: "Este equipamento não está disponível para retirada.", equipamento });
          return res.status(409).json({ sucesso: false, ...evento });
        }
        const funcionarioId = fluxo.funcionario?.id;
        if (!funcionarioId) {
          limparFluxo();
          const evento = publicarRFID({ uid, tipo: "fluxo_expirado", mensagem: "Funcionário não identificado. Comece novamente." });
          return res.status(409).json({ sucesso: false, ...evento });
        }

        /* Segunda checagem para evitar duas retiradas concorrentes. */
        const concorrente = await supabase.from("emprestimos").select("id")
          .eq("equipamento_id", equipamento.id).is("data_devolucao", null).limit(1);
        if (concorrente.error) throw concorrente.error;
        if ((concorrente.data || []).length) {
          limparFluxo();
          const evento = publicarRFID({ uid, tipo: "equipamento_emprestado", mensagem: "Este equipamento acabou de ser retirado por outra operação." });
          return res.status(409).json({ sucesso: false, ...evento });
        }

        const inserir = await supabase.from("emprestimos").insert({
          funcionario_id: funcionarioId, equipamento_id: equipamento.id, data_retirada: agora()
        }).select("*").maybeSingle();
        if (inserir.error) throw inserir.error;

        const atualizar = await supabase.from("equipamentos").update({ status: "emprestado" })
          .eq("id", equipamento.id).eq("status", "disponivel").select("*").maybeSingle();
        if (atualizar.error) throw atualizar.error;

        if (!atualizar.data) {
          if (inserir.data?.id) await supabase.from("emprestimos").delete().eq("id", inserir.data.id);
          limparFluxo();
          const evento = publicarRFID({ uid, tipo: "equipamento_emprestado", mensagem: "O equipamento não está mais disponível. Tente novamente." });
          return res.status(409).json({ sucesso: false, ...evento });
        }

        const evento = publicarRFID({
          uid, tipo: "retirada_concluida",
          mensagem: "Retirada concluída com sucesso!",
          funcionario: fluxo.funcionario.nome, equipamento: atualizar.data, box: atualizar.data.box_id
        });
        limparFluxo();
        return res.json({ sucesso: true, ...evento, emprestimo: inserir.data });
      }

      /* DEVOLUÇÃO */
      const funcionarioId = fluxo.funcionario?.id;
      if (!funcionarioId) {
        limparFluxo();
        const evento = publicarRFID({ uid, tipo: "fluxo_expirado", mensagem: "Funcionário não identificado. Comece novamente." });
        return res.status(409).json({ sucesso: false, ...evento });
      }

      const aberto = await supabase.from("emprestimos").select("*")
        .eq("funcionario_id", funcionarioId).eq("equipamento_id", equipamento.id)
        .is("data_devolucao", null).order("id", { ascending: false }).limit(1).maybeSingle();
      if (aberto.error) throw aberto.error;
      if (!aberto.data) {
        const evento = publicarRFID({ uid, tipo: "emprestimo_nao_encontrado", mensagem: "Não existe empréstimo aberto desse equipamento para este funcionário." });
        return res.status(409).json({ sucesso: false, ...evento });
      }

      const devolver = await supabase.from("emprestimos").update({ data_devolucao: agora() })
        .eq("id", aberto.data.id).is("data_devolucao", null).select("*").maybeSingle();
      if (devolver.error) throw devolver.error;
      if (!devolver.data) {
        limparFluxo();
        const evento = publicarRFID({ uid, tipo: "operacao_conflito", mensagem: "A devolução já foi registrada. Comece novamente." });
        return res.status(409).json({ sucesso: false, ...evento });
      }

      const atualizar = await supabase.from("equipamentos").update({ status: "disponivel" })
        .eq("id", equipamento.id).select("*").maybeSingle();
      if (atualizar.error) throw atualizar.error;

      const evento = publicarRFID({
        uid, tipo: "devolucao_concluida",
        mensagem: "Devolução concluída com sucesso!",
        funcionario: fluxo.funcionario.nome, equipamento: atualizar.data, box: atualizar.data.box_id
      });
      limparFluxo();
      return res.json({ sucesso: true, ...evento, emprestimo: devolver.data });
    }

    /* Nenhuma operação ativa: uma tag de funcionário inicia o processo. */
    const pessoa = await buscarFuncionarioPorUID(uid);
    const equipamento = await buscarEquipamentoPorUID(uid);

    if (pessoa && equipamento) {
      limparFluxo();
      const evento = publicarRFID({ uid, tipo: "tag_duplicada", mensagem: "ERRO: esta tag está cadastrada como funcionário e equipamento. Corrija o cadastro antes de usar." });
      return res.status(409).json({ sucesso: false, ...evento });
    }

    if (pessoa) {
      const ativos = await listarEmprestimosAtivosDoFuncionario(pessoa.id);
      const disponiveis = await listarEquipamentosDisponiveis();
      const evento = publicarRFID({
        uid, tipo: "funcionario_identificado", modo: "selecionar_acao",
        mensagem: ativos.length
          ? "Funcionário identificado. Escolha se deseja retirar ou devolver um equipamento."
          : "Funcionário identificado. Escolha o equipamento que deseja retirar.",
        funcionario: resumoFuncionario(pessoa)
      });
      return res.json({
        sucesso: true, ...evento,
        equipamentosDisponiveis: disponiveis.map(resumoEquipamento),
        equipamentosEmprestados: ativos.map(x => resumoEquipamento(x.equipamento)).filter(Boolean)
      });
    }

    if (equipamento) {
      const evento = publicarRFID({
        uid, tipo: "equipamento_sem_funcionario",
        mensagem: "Passe primeiro a tag do funcionário. O equipamento só pode ser usado após a identificação da pessoa."
      });
      return res.status(409).json({ sucesso: false, ...evento });
    }

    const evento = publicarRFID({ uid, tipo: "tag_nao_cadastrada", mensagem: "TAG NÃO CADASTRADA. Cadastre esta tag antes de utilizar o sistema." });
    return res.status(404).json({ sucesso: false, ...evento });

  } catch (erro) {
    return erroResposta(res, erro);
  }
});

/* RFID / fluxo */
app.get("/rfid/ultima", (req, res) => {
  expirarEstados();
  res.set("Cache-Control", "no-store");
  res.json(rfidEvent);
});
app.post("/rfid/limpar", (req, res) => {
  rfidEvent.nova = false;
  res.json({ sucesso: true });
});
app.post("/api/rfid/resetar", (req, res) => {
  limparFluxo();
  cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
  rfidEvent = { nova: false, id: Date.now(), uid: null, tipo: null, modo: null, mensagem: "Aguardando nova operação.", momento: Date.now() };
  res.json({ sucesso: true, mensagem: "Operação reiniciada. Pronto para a próxima leitura." });
});
app.post("/api/rfid/cadastro/iniciar", (req, res) => {
  const tipo = req.body?.tipo === "equipamento" ? "equipamento" : "funcionario";
  cadastroRFID = { ativo: true, tipo, expiraEm: Date.now() + 30000 };
  res.json({ sucesso: true, tipo, mensagem: "Aguardando uma tag. Aproxime-a do leitor.", expiraEm: cadastroRFID.expiraEm });
});
app.post("/api/rfid/selecionar", async (req, res) => {
  try {
    expirarEstados();
    const funcionarioId = Number(req.body?.funcionario_id);
    const equipamentoId = Number(req.body?.equipamento_id);
    const acao = req.body?.acao === "devolucao" ? "devolucao" : "retirada";

    if (!Number.isInteger(funcionarioId) || funcionarioId <= 0) return res.status(400).json({ sucesso: false, erro: "Funcionário inválido." });
    if (!Number.isInteger(equipamentoId) || equipamentoId <= 0) return res.status(400).json({ sucesso: false, erro: "Equipamento inválido." });
    if (!fluxo.funcionario || Number(fluxo.funcionario.id) !== funcionarioId) return res.status(409).json({ sucesso: false, erro: "A identificação do funcionário expirou. Passe a tag novamente." });

    const e = await supabase.from("equipamentos").select("*").eq("id", equipamentoId).maybeSingle();
    if (e.error) throw e.error;
    if (!e.data) return res.status(404).json({ sucesso: false, erro: "Equipamento não encontrado." });

    const ativos = await listarEmprestimosAtivosDoFuncionario(funcionarioId);
    const possuiEmprestimo = ativos.some(x => Number(x.equipamento_id) === equipamentoId);

    if (acao === "devolucao" && !possuiEmprestimo) return res.status(409).json({ sucesso: false, erro: "Esse equipamento não está emprestado para este funcionário." });
    if (acao === "retirada" && statusNormalizado(e.data.status) !== "disponivel") return res.status(409).json({ sucesso: false, erro: "Esse equipamento não está disponível para retirada." });

    fluxo = {
      modo: acao === "devolucao" ? "aguardando_devolucao" : "aguardando_equipamento",
      funcionario: fluxo.funcionario,
      acao,
      equipamentoSelecionado: e.data,
      expiraEm: Date.now() + 120000
    };

    const evento = publicarRFID({
      uid: fluxo.funcionario.uid_tag_pessoal,
      tipo: "equipamento_selecionado",
      modo: fluxo.modo,
      mensagem: `${acao === "devolucao" ? "Devolução" : "Retirada"}: aproxime a tag de "${e.data.nome}".`,
      funcionario: fluxo.funcionario, equipamento: e.data, box: e.data.box_id
    });
    res.json({ sucesso: true, ...evento });
  } catch (erro) {
    return erroResposta(res, erro);
  }
});

/* FUNCIONÁRIOS */
app.get("/api/funcionarios", async (req, res) => {
  try {
    const r = await supabase.from("funcionarios").select("*").order("id", { ascending: true });
    if (r.error) throw r.error;
    res.json({ sucesso: true, funcionarios: r.data || [] });
  } catch (erro) { return erroResposta(res, erro); }
});
app.get("/api/funcionarios/:id", async (req, res) => {
  try {
    const r = await supabase.from("funcionarios").select("*").eq("id", req.params.id).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) return res.status(404).json({ sucesso: false, erro: "Funcionário não encontrado." });
    res.json({ sucesso: true, funcionario: r.data });
  } catch (erro) { return erroResposta(res, erro); }
});
app.post("/api/funcionarios", async (req, res) => {
  try {
    const nome = texto(req.body?.nome).trim();
    const matricula = texto(req.body?.matricula).trim();
    const uid = normalizarUID(req.body?.uid_tag_pessoal || req.body?.uid_rfid);
    if (!nome) return res.status(400).json({ sucesso: false, erro: "Informe o nome do funcionário." });
    if (!matricula) return res.status(400).json({ sucesso: false, erro: "Informe a matrícula." });
    if (!uid) return res.status(400).json({ sucesso: false, erro: "Leia a tag do funcionário antes de cadastrar." });

    const existente = await verificarUIDEmQualquerCadastro(uid);
    if (existente.encontrado) {
      const categoria = existente.categoria === "funcionario" ? "funcionário" : "equipamento";
      return res.status(409).json({ sucesso: false, tipo: "tag_ja_cadastrada", erro: `Esta tag já está cadastrada como ${categoria}: ${existente.registro.nome}.`, mensagem: `A tag ${uid} já está em uso. Não é possível reutilizá-la.` });
    }

    const m = await supabase.from("funcionarios").select("id,nome").eq("matricula", matricula).limit(1);
    if (m.error) throw m.error;
    if ((m.data || []).length) return res.status(409).json({ sucesso: false, erro: `A matrícula ${matricula} já está cadastrada para ${m.data[0].nome}.` });

    const r = await supabase.from("funcionarios").insert({ nome, matricula, uid_tag_pessoal: uid }).select("*").maybeSingle();
    if (r.error) {
      if (String(r.error.message).toLowerCase().includes("duplicate")) return res.status(409).json({ sucesso: false, erro: "Esta tag ou matrícula já está cadastrada." });
      throw r.error;
    }
    res.json({ sucesso: true, mensagem: "Funcionário cadastrado com sucesso!", funcionario: r.data });
  } catch (erro) { return erroResposta(res, erro); }
});
app.put("/api/funcionarios/:id", async (req, res) => {
  try {
    const id = Number(req.params.id), nome = texto(req.body?.nome).trim(), matricula = texto(req.body?.matricula).trim();
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ sucesso: false, erro: "ID inválido." });
    if (!nome || !matricula) return res.status(400).json({ sucesso: false, erro: "Nome e matrícula são obrigatórios." });
    const outro = await supabase.from("funcionarios").select("id,nome").eq("matricula", matricula).neq("id", id).limit(1);
    if (outro.error) throw outro.error;
    if ((outro.data || []).length) return res.status(409).json({ sucesso: false, erro: `A matrícula ${matricula} já pertence a ${outro.data[0].nome}.` });
    const r = await supabase.from("funcionarios").update({ nome, matricula }).eq("id", id).select("*").maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) return res.status(404).json({ sucesso: false, erro: "Funcionário não encontrado." });
    res.json({ sucesso: true, mensagem: "Funcionário atualizado.", funcionario: r.data });
  } catch (erro) { return erroResposta(res, erro); }
});
app.delete("/api/funcionarios/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ sucesso: false, erro: "ID inválido." });
    const ativos = await supabase.from("emprestimos").select("id").eq("funcionario_id", id).is("data_devolucao", null).limit(1);
    if (ativos.error) throw ativos.error;
    if ((ativos.data || []).length) return res.status(409).json({ sucesso: false, erro: "Não é possível excluir um funcionário com equipamento emprestado. Registre a devolução primeiro." });
    const r = await supabase.from("funcionarios").delete().eq("id", id);
    if (r.error) throw r.error;
    res.json({ sucesso: true, mensagem: "Funcionário excluído com sucesso." });
  } catch (erro) { return erroResposta(res, erro); }
});

/* EQUIPAMENTOS */
app.get("/api/equipamentos", async (req, res) => {
  try {
    const r = await supabase.from("equipamentos").select("*").order("nome", { ascending: true });
    if (r.error) throw r.error;
    res.json({ sucesso: true, equipamentos: r.data || [] });
  } catch (erro) { return erroResposta(res, erro); }
});
app.get("/api/equipamentos/:id", async (req, res) => {
  try {
    const r = await supabase.from("equipamentos").select("*").eq("id", req.params.id).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) return res.status(404).json({ sucesso: false, erro: "Equipamento não encontrado." });
    res.json({ sucesso: true, equipamento: r.data });
  } catch (erro) { return erroResposta(res, erro); }
});
app.post("/api/equipamentos", async (req, res) => {
  try {
    const nome = texto(req.body?.nome).trim();
    const uid = normalizarUID(req.body?.uid_tag || req.body?.uid_rfid);
    const boxId = Number(req.body?.box_id ?? req.body?.box);
    if (!nome) return res.status(400).json({ sucesso: false, erro: "Informe o nome do equipamento." });
    if (!uid) return res.status(400).json({ sucesso: false, erro: "Leia a tag do equipamento antes de cadastrar." });
    if (!Number.isInteger(boxId) || boxId <= 0) return res.status(400).json({ sucesso: false, erro: "Informe um número de Box válido." });

    const existente = await verificarUIDEmQualquerCadastro(uid);
    if (existente.encontrado) {
      const categoria = existente.categoria === "funcionario" ? "funcionário" : "equipamento";
      return res.status(409).json({ sucesso: false, tipo: "tag_ja_cadastrada", erro: `Esta tag já está cadastrada como ${categoria}: ${existente.registro.nome}.`, mensagem: `A tag ${uid} já está em uso. Não é possível reutilizá-la.` });
    }

    const r = await supabase.from("equipamentos").insert({ nome, uid_tag: uid, box_id: boxId, status: "disponivel" }).select("*").maybeSingle();
    if (r.error) {
      if (String(r.error.message).toLowerCase().includes("duplicate")) return res.status(409).json({ sucesso: false, erro: "Esta tag já está cadastrada." });
      throw r.error;
    }
    res.json({ sucesso: true, mensagem: "Equipamento cadastrado com sucesso!", equipamento: r.data });
  } catch (erro) { return erroResposta(res, erro); }
});
app.put("/api/equipamentos/:id", async (req, res) => {
  try {
    const id = Number(req.params.id), nome = texto(req.body?.nome).trim(), boxId = Number(req.body?.box_id ?? req.body?.box);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ sucesso: false, erro: "ID inválido." });
    if (!nome) return res.status(400).json({ sucesso: false, erro: "Informe o nome." });
    if (!Number.isInteger(boxId) || boxId <= 0) return res.status(400).json({ sucesso: false, erro: "Box inválido." });
    const r = await supabase.from("equipamentos").update({ nome, box_id: boxId }).eq("id", id).select("*").maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) return res.status(404).json({ sucesso: false, erro: "Equipamento não encontrado." });
    res.json({ sucesso: true, mensagem: "Equipamento atualizado.", equipamento: r.data });
  } catch (erro) { return erroResposta(res, erro); }
});
app.delete("/api/equipamentos/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ sucesso: false, erro: "ID inválido." });
    const ativo = await supabase.from("emprestimos").select("id").eq("equipamento_id", id).is("data_devolucao", null).limit(1);
    if (ativo.error) throw ativo.error;
    if ((ativo.data || []).length) return res.status(409).json({ sucesso: false, erro: "Não é possível excluir um equipamento emprestado." });
    const historico = await supabase.from("emprestimos").select("id").eq("equipamento_id", id).limit(1);
    if (historico.error) throw historico.error;
    if ((historico.data || []).length) return res.status(409).json({ sucesso: false, erro: "Este equipamento possui histórico de empréstimos. Preserve o histórico e não o exclua." });
    const r = await supabase.from("equipamentos").delete().eq("id", id);
    if (r.error) throw r.error;
    res.json({ sucesso: true, mensagem: "Equipamento excluído com sucesso." });
  } catch (erro) { return erroResposta(res, erro); }
});

/* EMPRÉSTIMOS */
app.get("/api/emprestimos", async (req, res) => {
  try { res.json({ sucesso: true, emprestimos: await montarEmprestimos() }); }
  catch (erro) { return erroResposta(res, erro); }
});
app.get("/api/ultimos-emprestimos", async (req, res) => {
  try { res.json({ sucesso: true, emprestimos: (await montarEmprestimos()).slice(0, 10) }); }
  catch (erro) { return erroResposta(res, erro); }
});
app.post("/api/emprestimos", async (req, res) => {
  try {
    const funcionarioId = Number(req.body?.funcionario_id), equipamentoId = Number(req.body?.equipamento_id);
    if (!Number.isInteger(funcionarioId) || funcionarioId <= 0) return res.status(400).json({ sucesso: false, erro: "Funcionário inválido." });
    if (!Number.isInteger(equipamentoId) || equipamentoId <= 0) return res.status(400).json({ sucesso: false, erro: "Equipamento inválido." });
    const f = await supabase.from("funcionarios").select("*").eq("id", funcionarioId).maybeSingle();
    if (f.error) throw f.error;
    const e = await supabase.from("equipamentos").select("*").eq("id", equipamentoId).maybeSingle();
    if (e.error) throw e.error;
    if (!f.data) return res.status(404).json({ sucesso: false, erro: "Funcionário não encontrado." });
    if (!e.data) return res.status(404).json({ sucesso: false, erro: "Equipamento não encontrado." });
    if (statusNormalizado(e.data.status) !== "disponivel") return res.status(409).json({ sucesso: false, erro: "Equipamento não disponível." });
    const r = await supabase.from("emprestimos").insert({ funcionario_id: funcionarioId, equipamento_id: equipamentoId, data_retirada: agora() }).select("*").maybeSingle();
    if (r.error) throw r.error;
    const u = await supabase.from("equipamentos").update({ status: "emprestado" }).eq("id", equipamentoId).eq("status", "disponivel").select("*").maybeSingle();
    if (u.error) throw u.error;
    if (!u.data) {
      if (r.data?.id) await supabase.from("emprestimos").delete().eq("id", r.data.id);
      return res.status(409).json({ sucesso: false, erro: "Equipamento não está mais disponível." });
    }
    res.json({ sucesso: true, mensagem: "Retirada registrada.", emprestimo: r.data });
  } catch (erro) { return erroResposta(res, erro); }
});
app.post("/api/emprestimos/:id/devolver", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ sucesso: false, erro: "Empréstimo inválido." });
    const aberto = await supabase.from("emprestimos").select("*").eq("id", id).is("data_devolucao", null).maybeSingle();
    if (aberto.error) throw aberto.error;
    if (!aberto.data) return res.status(404).json({ sucesso: false, erro: "Empréstimo ativo não encontrado." });
    const d = await supabase.from("emprestimos").update({ data_devolucao: agora() }).eq("id", id).is("data_devolucao", null).select("*").maybeSingle();
    if (d.error) throw d.error;
    if (!d.data) return res.status(409).json({ sucesso: false, erro: "A devolução já foi registrada." });
    const u = await supabase.from("equipamentos").update({ status: "disponivel" }).eq("id", aberto.data.equipamento_id);
    if (u.error) throw u.error;
    res.json({ sucesso: true, mensagem: "Devolução registrada.", emprestimo: d.data });
  } catch (erro) { return erroResposta(res, erro); }
});

/* DASHBOARD */
app.get("/api/dashboard", async (req, res) => {
  try {
    const [f, e, ativos] = await Promise.all([
      supabase.from("funcionarios").select("id", { count: "exact", head: true }),
      supabase.from("equipamentos").select("id,status"),
      supabase.from("emprestimos").select("id", { count: "exact", head: true }).is("data_devolucao", null)
    ]);
    if (f.error) throw f.error;
    if (e.error) throw e.error;
    if (ativos.error) throw ativos.error;
    const equipamentos = e.data || [];
    const disponiveis = equipamentos.filter(x => statusNormalizado(x.status) === "disponivel").length;
    const emprestados = equipamentos.filter(x => statusNormalizado(x.status) === "emprestado").length;
    res.json({ sucesso: true, funcionarios: f.count || 0, equipamentos: equipamentos.length, disponiveis, emprestimos: ativos.count || 0, emprestados });
  } catch (erro) { return erroResposta(res, erro); }
});

/* ROTA NÃO ENCONTRADA / ERRO */
app.use((req, res) => res.status(404).json({ sucesso: false, erro: "Rota não encontrada.", rota: req.originalUrl }));
app.use((erro, req, res, next) => {
  console.error("ERRO GERAL:", erro);
  res.status(500).json({ sucesso: false, erro: "Erro interno do servidor." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("======================================");
  console.log(" INVENTÁRIO RFID - NUVEM");
  console.log("======================================");
  console.log(`Servidor: ${SERVIDOR_PUBLICO}`);
  console.log("Banco: Supabase");
  console.log("Aguardando ESP32...");
});
