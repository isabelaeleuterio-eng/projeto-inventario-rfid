require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_DIR = path.join(__dirname, "SITE");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("ERRO: SUPABASE_URL e SUPABASE_SECRET_KEY precisam estar configurados.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(SITE_DIR));

/* =========================================================
   ESTADO DO SISTEMA
   Um único ESP32/leitor e uma estação de controle.
   O estado é intencionalmente global para a apresentação.
   ========================================================= */

let fluxo = {
  modo: "idle",
  acao: null,
  funcionario: null,
  equipamentoSelecionado: null,
  expiraEm: 0
};

let rfidEvent = {
  nova: false,
  id: Date.now(),
  uid: null,
  tipo: null,
  modo: null,
  mensagem: "Aguardando a tag do funcionário.",
  funcionario: null,
  equipamento: null,
  equipamentoRecebido: null,
  equipamentoEsperado: null,
  box: null,
  momento: Date.now()
};

let esp32 = {
  conectado: false,
  ultimoContato: null,
  ip: null
};

let ultimaLeituraFisica = {
  uid: null,
  momento: 0
};

let cadastroRFID = {
  ativo: false,
  tipo: null,
  expiraEm: 0
};

const TEMPO_FLUXO = 120000;
const TEMPO_CADASTRO = 30000;
const TEMPO_REPETICAO = 1500;
const TEMPO_ESP32_ONLINE = 30000;

function agora() {
  return new Date().toISOString();
}

function texto(v) {
  return v === null || v === undefined ? "" : String(v);
}

function normalizarUID(v) {
  return texto(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizarStatus(v) {
  return texto(v)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function resumoFuncionario(f) {
  if (!f) return null;
  return {
    id: f.id,
    nome: f.nome,
    matricula: f.matricula ?? null,
    uid_tag_pessoal: f.uid_tag_pessoal ?? null
  };
}

function resumoEquipamento(e) {
  if (!e) return null;
  return {
    id: e.id,
    nome: e.nome,
    uid_tag: e.uid_tag ?? null,
    box_id: e.box_id ?? null,
    status: e.status ?? null
  };
}

function publicarRFID(dados) {
  rfidEvent = {
    nova: true,
    id: Date.now(),
    uid: dados.uid ?? null,
    tipo: dados.tipo ?? null,
    modo: dados.modo ?? null,
    mensagem: dados.mensagem ?? "",
    funcionario: dados.funcionario ?? null,
    equipamento: dados.equipamento ?? null,
    equipamentoRecebido: dados.equipamentoRecebido ?? null,
    equipamentoEsperado: dados.equipamentoEsperado ?? null,
    box: dados.box ?? null,
    momento: Date.now()
  };
  return rfidEvent;
}

function limparFluxo() {
  fluxo = {
    modo: "idle",
    acao: null,
    funcionario: null,
    equipamentoSelecionado: null,
    expiraEm: 0
  };
}

function expirarEstados() {
  const agoraMs = Date.now();

  if (fluxo.expiraEm && agoraMs > fluxo.expiraEm) {
    limparFluxo();
    publicarRFID({
      tipo: "fluxo_expirado",
      mensagem: "A operação expirou. Passe novamente a tag do funcionário."
    });
    rfidEvent.nova = true;
  }

  if (cadastroRFID.expiraEm && agoraMs > cadastroRFID.expiraEm) {
    cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
  }
}

function erroResposta(res, erro, status = 500) {
  console.error("ERRO:", erro);
  return res.status(status).json({
    sucesso: false,
    erro: erro?.message || String(erro)
  });
}

async function buscarFuncionarioPorUID(uid) {
  const alvo = normalizarUID(uid);
  const r = await supabase
    .from("funcionarios")
    .select("*")
    .order("id", { ascending: true });

  if (r.error) throw r.error;

  return (r.data || []).find(
    f => normalizarUID(f.uid_tag_pessoal) === alvo
  ) || null;
}

async function buscarEquipamentoPorUID(uid) {
  const alvo = normalizarUID(uid);
  const r = await supabase
    .from("equipamentos")
    .select("*")
    .order("id", { ascending: true });

  if (r.error) throw r.error;

  return (r.data || []).find(
    e => normalizarUID(e.uid_tag) === alvo
  ) || null;
}

async function verificarUIDEmQualquerCadastro(uid) {
  const funcionario = await buscarFuncionarioPorUID(uid);
  if (funcionario) {
    return { encontrado: true, categoria: "funcionario", registro: funcionario };
  }

  const equipamento = await buscarEquipamentoPorUID(uid);
  if (equipamento) {
    return { encontrado: true, categoria: "equipamento", registro: equipamento };
  }

  return { encontrado: false, categoria: null, registro: null };
}

async function listarEquipamentos() {
  const r = await supabase
    .from("equipamentos")
    .select("*")
    .order("id", { ascending: true });

  if (r.error) throw r.error;
  return r.data || [];
}

async function listarEquipamentosDisponiveis() {
  const lista = await listarEquipamentos();
  return lista.filter(e => normalizarStatus(e.status) === "disponivel");
}

async function listarEmprestimosAtivosDoFuncionario(funcionarioId) {
  const r = await supabase
    .from("emprestimos")
    .select("*")
    .eq("funcionario_id", funcionarioId)
    .is("data_devolucao", null)
    .order("id", { ascending: false });

  if (r.error) throw r.error;

  const ativos = r.data || [];
  const ids = [...new Set(ativos.map(x => x.equipamento_id).filter(Boolean))];

  if (!ids.length) return [];

  const eq = await supabase
    .from("equipamentos")
    .select("*")
    .in("id", ids);

  if (eq.error) throw eq.error;

  const mapa = {};
  for (const e of eq.data || []) mapa[e.id] = e;

  return ativos.map(item => ({
    ...item,
    equipamento: mapa[item.equipamento_id] || null
  }));
}

async function enriquecerEmprestimos(lista) {
  const funcionariosIds = [...new Set(
    lista.map(x => x.funcionario_id).filter(v => v !== null && v !== undefined)
  )];
  const equipamentosIds = [...new Set(
    lista.map(x => x.equipamento_id).filter(v => v !== null && v !== undefined)
  )];

  const funcionarios = {};
  const equipamentos = {};

  if (funcionariosIds.length) {
    const r = await supabase
      .from("funcionarios")
      .select("*")
      .in("id", funcionariosIds);
    if (r.error) throw r.error;
    for (const f of r.data || []) funcionarios[f.id] = f;
  }

  if (equipamentosIds.length) {
    const r = await supabase
      .from("equipamentos")
      .select("*")
      .in("id", equipamentosIds);
    if (r.error) throw r.error;
    for (const e of r.data || []) equipamentos[e.id] = e;
  }

  return lista.map(item => ({
    ...item,
    funcionario: funcionarios[item.funcionario_id] || null,
    equipamento: equipamentos[item.equipamento_id] || null
  }));
}

/* =========================================================
   PÁGINAS
   ========================================================= */

app.get("/", (req, res) =>
  res.sendFile(path.join(SITE_DIR, "index.html"))
);

app.get("/cadastro", (req, res) =>
  res.sendFile(path.join(SITE_DIR, "cadastro.html"))
);

app.get("/controle", (req, res) =>
  res.sendFile(path.join(SITE_DIR, "controle.html"))
);

/* =========================================================
   STATUS / SAÚDE
   ========================================================= */

app.get("/health", (req, res) => {
  res.json({
    sucesso: true,
    servidor: "online",
    banco: "Supabase",
    horario: agora()
  });
});

app.get("/teste", (req, res) => {
  res.json({
    sucesso: true,
    mensagem: "Servidor RFID funcionando.",
    servidor: "https://projeto-inventario-rfid.onrender.com",
    banco: "Supabase",
    horario: agora()
  });
});

app.get("/api/status", (req, res) => {
  expirarEstados();
  const conectado =
    !!esp32.ultimoContato &&
    Date.now() - new Date(esp32.ultimoContato).getTime() < TEMPO_ESP32_ONLINE;

  res.json({
    sucesso: true,
    servidor: "online",
    esp32: {
      ...esp32,
      conectado
    },
    fluxo: {
      modo: fluxo.modo,
      acao: fluxo.acao,
      funcionario: resumoFuncionario(fluxo.funcionario),
      equipamentoSelecionado: resumoEquipamento(fluxo.equipamentoSelecionado),
      expiraEm: fluxo.expiraEm || null
    },
    rfid: rfidEvent
  });
});

/* =========================================================
   ESP32
   ========================================================= */

app.post("/api/esp32/online", (req, res) => {
  esp32.conectado = true;
  esp32.ultimoContato = agora();
  esp32.ip = texto(req.body?.ip).trim() || null;

  res.json({
    sucesso: true,
    mensagem: "ESP32 conectado ao servidor.",
    horario: esp32.ultimoContato
  });
});

/*
 * ESTE é o endpoint usado pelo ESP32.
 * Toda a regra de retirada/devolução fica na nuvem.
 */
app.post("/api/esp32/rfid", async (req, res) => {
  try {
    expirarEstados();

    const uid = normalizarUID(req.body?.uid);
    const leitor = texto(req.body?.leitor).trim() || "entrada";

    if (!uid) {
      return res.status(400).json({
        sucesso: false,
        erro: "UID não informado."
      });
    }

    esp32.conectado = true;
    esp32.ultimoContato = agora();
    if (req.body?.ip) esp32.ip = texto(req.body.ip);

    if (
      ultimaLeituraFisica.uid === uid &&
      Date.now() - ultimaLeituraFisica.momento < TEMPO_REPETICAO
    ) {
      return res.json({
        sucesso: true,
        repetida: true,
        uid,
        mensagem: "Leitura repetida ignorada."
      });
    }

    ultimaLeituraFisica = {
      uid,
      momento: Date.now()
    };

    console.log(`[RFID] ${uid} | leitor=${leitor}`);

    /* Cadastro: leitura apenas preenche UID. */
    if (cadastroRFID.ativo && Date.now() < cadastroRFID.expiraEm) {
      const existente = await verificarUIDEmQualquerCadastro(uid);

      if (existente.encontrado) {
        const tipo =
          existente.categoria === "funcionario"
            ? "funcionário"
            : "equipamento";

        const evento = publicarRFID({
          uid,
          tipo: "tag_ja_cadastrada",
          modo: "cadastro",
          mensagem: `Esta tag já está cadastrada como ${tipo}: ${existente.registro.nome}.`
        });

        cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
        return res.status(409).json({ sucesso: false, ...evento });
      }

      const evento = publicarRFID({
        uid,
        tipo: "cadastro_tag",
        modo: "cadastro",
        mensagem: "Tag lida com sucesso. UID preenchido automaticamente."
      });

      cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
      return res.json({ sucesso: true, ...evento });
    }

    /*
     * Se existe seleção feita pela interface, a próxima tag de equipamento
     * precisa ser exatamente a tag selecionada.
     */
    if (
      fluxo.modo === "aguardando_equipamento" ||
      fluxo.modo === "aguardando_devolucao"
    ) {
      const equipamento = await buscarEquipamentoPorUID(uid);

      if (!equipamento) {
        const evento = publicarRFID({
          uid,
          tipo: "tag_nao_cadastrada",
          modo: fluxo.modo,
          mensagem: "Esta tag não está cadastrada como equipamento. Passe a tag do equipamento selecionado."
        });
        return res.status(404).json({ sucesso: false, ...evento });
      }

      const esperado = fluxo.equipamentoSelecionado;

      if (!esperado || Number(equipamento.id) !== Number(esperado.id)) {
        const evento = publicarRFID({
          uid,
          tipo: "equipamento_incorreto",
          modo: fluxo.modo,
          mensagem: `TAG INCORRETA. Você selecionou "${esperado?.nome || "outro equipamento"}". Passe a tag desse equipamento.`,
          funcionario: fluxo.funcionario,
          equipamentoRecebido: resumoEquipamento(equipamento),
          equipamentoEsperado: resumoEquipamento(esperado)
        });
        return res.status(409).json({ sucesso: false, ...evento });
      }

      const funcionarioId = fluxo.funcionario?.id;

      if (!funcionarioId) {
        limparFluxo();
        const evento = publicarRFID({
          uid,
          tipo: "fluxo_expirado",
          mensagem: "A identificação do funcionário expirou. Comece novamente."
        });
        return res.status(409).json({ sucesso: false, ...evento });
      }

      /* -------------------- RETIRADA -------------------- */
      if (fluxo.modo === "aguardando_equipamento") {
        if (normalizarStatus(equipamento.status) !== "disponivel") {
          const evento = publicarRFID({
            uid,
            tipo: "equipamento_emprestado",
            mensagem: "Este equipamento não está disponível para retirada.",
            equipamento: resumoEquipamento(equipamento)
          });
          return res.status(409).json({ sucesso: false, ...evento });
        }

        const concorrente = await supabase
          .from("emprestimos")
          .select("id")
          .eq("equipamento_id", equipamento.id)
          .is("data_devolucao", null)
          .limit(1);

        if (concorrente.error) throw concorrente.error;

        if ((concorrente.data || []).length) {
          const evento = publicarRFID({
            uid,
            tipo: "equipamento_emprestado",
            mensagem: "Este equipamento acabou de ser emprestado. Atualize a tela."
          });
          return res.status(409).json({ sucesso: false, ...evento });
        }

        const inserir = await supabase
          .from("emprestimos")
          .insert({
            funcionario_id: funcionarioId,
            equipamento_id: equipamento.id,
            data_retirada: agora()
          })
          .select("*")
          .single();

        if (inserir.error) throw inserir.error;

        const atualizar = await supabase
          .from("equipamentos")
          .update({ status: "emprestado" })
          .eq("id", equipamento.id)
          .select("*")
          .single();

        if (atualizar.error) throw atualizar.error;

        const nomeFuncionario = fluxo.funcionario.nome;
        const evento = publicarRFID({
          uid,
          tipo: "retirada_concluida",
          modo: "concluido",
          mensagem: "Retirada concluída com sucesso!",
          funcionario: fluxo.funcionario,
          equipamento: atualizar.data,
          box: atualizar.data?.box_id
        });

        limparFluxo();

        return res.json({
          sucesso: true,
          ...evento,
          emprestimo: inserir.data
        });
      }

      /* -------------------- DEVOLUÇÃO -------------------- */
      const aberto = await supabase
        .from("emprestimos")
        .select("*")
        .eq("funcionario_id", funcionarioId)
        .eq("equipamento_id", equipamento.id)
        .is("data_devolucao", null)
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (aberto.error) throw aberto.error;

      if (!aberto.data) {
        const evento = publicarRFID({
          uid,
          tipo: "emprestimo_nao_encontrado",
          mensagem: "Não existe empréstimo aberto desse equipamento para este funcionário."
        });
        return res.status(409).json({ sucesso: false, ...evento });
      }

      const devolver = await supabase
        .from("emprestimos")
        .update({ data_devolucao: agora() })
        .eq("id", aberto.data.id)
        .is("data_devolucao", null)
        .select("*")
        .maybeSingle();

      if (devolver.error) throw devolver.error;

      if (!devolver.data) {
        const evento = publicarRFID({
          uid,
          tipo: "operacao_conflito",
          mensagem: "A devolução já foi registrada. Atualize a tela."
        });
        limparFluxo();
        return res.status(409).json({ sucesso: false, ...evento });
      }

      const liberar = await supabase
        .from("equipamentos")
        .update({ status: "disponivel" })
        .eq("id", equipamento.id)
        .select("*")
        .single();

      if (liberar.error) throw liberar.error;

      const evento = publicarRFID({
        uid,
        tipo: "devolucao_concluida",
        modo: "concluido",
        mensagem: "Devolução concluída com sucesso!",
        funcionario: fluxo.funcionario,
        equipamento: liberar.data,
        box: liberar.data?.box_id
      });

      limparFluxo();

      return res.json({
        sucesso: true,
        ...evento,
        emprestimo: devolver.data
      });
    }

    /*
     * Sem seleção de equipamento, uma tag de pessoa apenas identifica.
     * Uma tag de equipamento solta nunca altera o estoque.
     */
    const funcionario = await buscarFuncionarioPorUID(uid);

    if (funcionario) {
      const evento = publicarRFID({
        uid,
        tipo: "funcionario_identificado",
        modo: "selecionar_acao",
        mensagem: "Funcionário identificado. Escolha Retirar ou Devolver.",
        funcionario: resumoFuncionario(funcionario)
      });

      return res.json({ sucesso: true, ...evento });
    }

    const equipamento = await buscarEquipamentoPorUID(uid);

    if (equipamento) {
      const evento = publicarRFID({
        uid,
        tipo: "equipamento_sem_funcionario",
        mensagem: "Passe primeiro a tag do funcionário."
      });
      return res.status(409).json({ sucesso: false, ...evento });
    }

    const evento = publicarRFID({
      uid,
      tipo: "tag_nao_cadastrada",
      mensagem: "TAG NÃO CADASTRADA. Cadastre esta tag antes de utilizar."
    });

    return res.status(404).json({ sucesso: false, ...evento });
  } catch (erro) {
    return erroResposta(res, erro);
  }
});

/* =========================================================
   RFID / interface
   ========================================================= */

app.get("/rfid/ultima", (req, res) => {
  expirarEstados();
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.json(rfidEvent);
});

app.post("/rfid/limpar", (req, res) => {
  rfidEvent.nova = false;
  res.json({ sucesso: true });
});

app.post("/api/rfid/resetar", (req, res) => {
  limparFluxo();
  cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
  rfidEvent = {
    nova: false,
    id: Date.now(),
    uid: null,
    tipo: null,
    modo: null,
    mensagem: "Aguardando a tag do funcionário.",
    funcionario: null,
    equipamento: null,
    equipamentoRecebido: null,
    equipamentoEsperado: null,
    box: null,
    momento: Date.now()
  };
  res.json({
    sucesso: true,
    mensagem: "Operação reiniciada."
  });
});

app.post("/api/rfid/cadastro/iniciar", (req, res) => {
  const tipo =
    req.body?.tipo === "equipamento"
      ? "equipamento"
      : "funcionario";

  cadastroRFID = {
    ativo: true,
    tipo,
    expiraEm: Date.now() + TEMPO_CADASTRO
  };

  res.json({
    sucesso: true,
    tipo,
    mensagem: "Aguardando a tag.",
    expiraEm: cadastroRFID.expiraEm
  });
});

/*
 * A interface chama esta rota depois de:
 * 1) identificar funcionário;
 * 2) escolher RETIRAR/DEVOLVER;
 * 3) escolher equipamento.
 */
app.post("/api/rfid/selecionar", async (req, res) => {
  try {
    expirarEstados();

    const funcionarioId = Number(req.body?.funcionario_id);
    const equipamentoId = Number(req.body?.equipamento_id);
    const acao =
      req.body?.acao === "devolucao"
        ? "devolucao"
        : "retirada";

    if (!Number.isInteger(funcionarioId) || funcionarioId <= 0) {
      return res.status(400).json({
        sucesso: false,
        erro: "Funcionário inválido."
      });
    }

    if (!Number.isInteger(equipamentoId) || equipamentoId <= 0) {
      return res.status(400).json({
        sucesso: false,
        erro: "Equipamento inválido."
      });
    }

    if (
      !fluxo.funcionario ||
      Number(fluxo.funcionario.id) !== funcionarioId
    ) {
      return res.status(409).json({
        sucesso: false,
        erro: "A identificação do funcionário expirou. Passe a tag novamente."
      });
    }

    const equipamentoBusca = await supabase
      .from("equipamentos")
      .select("*")
      .eq("id", equipamentoId)
      .maybeSingle();

    if (equipamentoBusca.error) throw equipamentoBusca.error;

    const equipamento = equipamentoBusca.data;

    if (!equipamento) {
      return res.status(404).json({
        sucesso: false,
        erro: "Equipamento não encontrado."
      });
    }

    const ativos =
      await listarEmprestimosAtivosDoFuncionario(funcionarioId);

    const possuiEmprestimo =
      ativos.some(
        x => Number(x.equipamento_id) === equipamentoId
      );

    if (acao === "retirada") {
      if (normalizarStatus(equipamento.status) !== "disponivel") {
        return res.status(409).json({
          sucesso: false,
          erro: "Esse equipamento não está disponível para retirada."
        });
      }

      if (possuiEmprestimo) {
        return res.status(409).json({
          sucesso: false,
          erro: "Esse equipamento já está com este funcionário."
        });
      }
    }

    if (acao === "devolucao" && !possuiEmprestimo) {
      return res.status(409).json({
        sucesso: false,
        erro: "Esse equipamento não está emprestado para este funcionário."
      });
    }

    fluxo = {
      modo:
        acao === "devolucao"
          ? "aguardando_devolucao"
          : "aguardando_equipamento",
      acao,
      funcionario: resumoFuncionario(fluxo.funcionario),
      equipamentoSelecionado: equipamento,
      expiraEm: Date.now() + TEMPO_FLUXO
    };

    const evento = publicarRFID({
      uid: fluxo.funcionario.uid_tag_pessoal,
      tipo: "equipamento_selecionado",
      modo: fluxo.modo,
      mensagem:
        acao === "devolucao"
          ? `Devolução: passe a tag de "${equipamento.nome}".`
          : `Retirada: passe a tag de "${equipamento.nome}".`,
      funcionario: fluxo.funcionario,
      equipamento,
      box: equipamento.box_id
    });

    return res.json({
      sucesso: true,
      ...evento
    });
  } catch (erro) {
    return erroResposta(res, erro);
  }
});

/* =========================================================
   FUNCIONÁRIOS
   ========================================================= */

app.get("/api/funcionarios", async (req, res) => {
  try {
    const r = await supabase
      .from("funcionarios")
      .select("*")
      .order("id", { ascending: true });

    if (r.error) throw r.error;

    res.json({
      sucesso: true,
      funcionarios: r.data || []
    });
  } catch (erro) {
    return erroResposta(res, erro);
  }
});

app.post("/api/funcionarios", async (req, res) => {
  try {
    const nome = texto(req.body?.nome).trim();
    const matricula = texto(req.body?.matricula).trim();
    const uid = normalizarUID(
      req.body?.uid_tag_pessoal || req.body?.uid_rfid
    );

    if (!nome)
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o nome do funcionário."
      });

    if (!matricula)
      return res.status(400).json({
        sucesso: false,
        erro: "Informe a matrícula."
      });

    if (!uid)
      return res.status(400).json({
        sucesso: false,
        erro: "Leia a tag do funcionário antes de cadastrar."
      });

    const existente = await verificarUIDEmQualquerCadastro(uid);

    if (existente.encontrado) {
      const tipo =
        existente.categoria === "funcionario"
          ? "funcionário"
          : "equipamento";

      return res.status(409).json({
        sucesso: false,
        erro: `Esta tag já está cadastrada como ${tipo}: ${existente.registro.nome}.`
      });
    }

    const matriculaExistente = await supabase
      .from("funcionarios")
      .select("id,nome")
      .eq("matricula", matricula)
      .limit(1);

    if (matriculaExistente.error)
      throw matriculaExistente.error;

    if ((matriculaExistente.data || []).length) {
      return res.status(409).json({
        sucesso: false,
        erro: `A matrícula ${matricula} já está cadastrada.`
      });
    }

    const r = await supabase
      .from("funcionarios")
      .insert({
        nome,
        matricula,
        uid_tag_pessoal: uid
      })
      .select("*")
      .single();

    if (r.error) throw r.error;

    res.status(201).json({
      sucesso: true,
      mensagem: "Funcionário cadastrado com sucesso.",
      funcionario: r.data
    });
  } catch (erro) {
    return erroResposta(res, erro, 400);
  }
});

app.delete("/api/funcionarios/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    const ativos = await listarEmprestimosAtivosDoFuncionario(id);
    if (ativos.length) {
      return res.status(409).json({
        sucesso: false,
        erro: "Não é possível excluir um funcionário com equipamento emprestado."
      });
    }

    const r = await supabase
      .from("funcionarios")
      .delete()
      .eq("id", id);

    if (r.error) throw r.error;

    res.json({
      sucesso: true,
      mensagem: "Funcionário excluído."
    });
  } catch (erro) {
    return erroResposta(res, erro, 400);
  }
});

/* =========================================================
   EQUIPAMENTOS
   ========================================================= */

app.get("/api/equipamentos", async (req, res) => {
  try {
    const equipamentos = await listarEquipamentos();
    res.json({
      sucesso: true,
      equipamentos
    });
  } catch (erro) {
    return erroResposta(res, erro);
  }
});

app.post("/api/equipamentos", async (req, res) => {
  try {
    const nome = texto(req.body?.nome).trim();
    const uid = normalizarUID(
      req.body?.uid_tag || req.body?.uid_rfid
    );
    const box = Number(req.body?.box_id ?? req.body?.box ?? 1);

    if (!nome)
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o nome do equipamento."
      });

    if (!uid)
      return res.status(400).json({
        sucesso: false,
        erro: "Leia a tag do equipamento antes de cadastrar."
      });

    if (!Number.isInteger(box) || box < 1)
      return res.status(400).json({
        sucesso: false,
        erro: "Informe um Box válido."
      });

    const existente = await verificarUIDEmQualquerCadastro(uid);

    if (existente.encontrado) {
      const tipo =
        existente.categoria === "funcionario"
          ? "funcionário"
          : "equipamento";

      return res.status(409).json({
        sucesso: false,
        erro: `Esta tag já está cadastrada como ${tipo}: ${existente.registro.nome}.`
      });
    }

    const r = await supabase
      .from("equipamentos")
      .insert({
        nome,
        uid_tag: uid,
        box_id: box,
        status: "disponivel"
      })
      .select("*")
      .single();

    if (r.error) throw r.error;

    res.status(201).json({
      sucesso: true,
      mensagem: "Equipamento cadastrado com sucesso.",
      equipamento: r.data
    });
  } catch (erro) {
    return erroResposta(res, erro, 400);
  }
});

app.delete("/api/equipamentos/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    const ativos = await supabase
      .from("emprestimos")
      .select("id")
      .eq("equipamento_id", id)
      .is("data_devolucao", null)
      .limit(1);

    if (ativos.error) throw ativos.error;

    if ((ativos.data || []).length) {
      return res.status(409).json({
        sucesso: false,
        erro: "Não é possível excluir um equipamento emprestado."
      });
    }

    const r = await supabase
      .from("equipamentos")
      .delete()
      .eq("id", id);

    if (r.error) throw r.error;

    res.json({
      sucesso: true,
      mensagem: "Equipamento excluído."
    });
  } catch (erro) {
    return erroResposta(res, erro, 400);
  }
});

/* =========================================================
   EMPRÉSTIMOS / HISTÓRICO
   ========================================================= */

app.get("/api/emprestimos", async (req, res) => {
  try {
    const r = await supabase
      .from("emprestimos")
      .select("*")
      .order("id", { ascending: false });

    if (r.error) throw r.error;

    const resultado = await enriquecerEmprestimos(r.data || []);

    res.json({
      sucesso: true,
      emprestimos: resultado
    });
  } catch (erro) {
    return erroResposta(res, erro);
  }
});

app.post("/api/emprestimos", async (req, res) => {
  try {
    const funcionarioId = Number(req.body?.funcionario_id);
    const equipamentoId = Number(req.body?.equipamento_id);

    if (!funcionarioId || !equipamentoId) {
      return res.status(400).json({
        sucesso: false,
        erro: "Funcionário e equipamento são obrigatórios."
      });
    }

    const equipamento = await supabase
      .from("equipamentos")
      .select("*")
      .eq("id", equipamentoId)
      .maybeSingle();

    if (equipamento.error) throw equipamento.error;
    if (!equipamento.data) {
      return res.status(404).json({
        sucesso: false,
        erro: "Equipamento não encontrado."
      });
    }

    if (normalizarStatus(equipamento.data.status) !== "disponivel") {
      return res.status(409).json({
        sucesso: false,
        erro: "Equipamento não está disponível."
      });
    }

    const inserido = await supabase
      .from("emprestimos")
      .insert({
        funcionario_id: funcionarioId,
        equipamento_id: equipamentoId,
        data_retirada: agora()
      })
      .select("*")
      .single();

    if (inserido.error) throw inserido.error;

    const atualizado = await supabase
      .from("equipamentos")
      .update({ status: "emprestado" })
      .eq("id", equipamentoId);

    if (atualizado.error) throw atualizado.error;

    res.status(201).json({
      sucesso: true,
      mensagem: "Empréstimo registrado.",
      emprestimo: inserido.data
    });
  } catch (erro) {
    return erroResposta(res, erro, 400);
  }
});

app.put("/api/emprestimos/:id/devolver", async (req, res) => {
  try {
    const id = Number(req.params.id);

    const busca = await supabase
      .from("emprestimos")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (busca.error) throw busca.error;

    if (!busca.data) {
      return res.status(404).json({
        sucesso: false,
        erro: "Empréstimo não encontrado."
      });
    }

    if (busca.data.data_devolucao) {
      return res.status(409).json({
        sucesso: false,
        erro: "Esse empréstimo já foi devolvido."
      });
    }

    const atualizado = await supabase
      .from("emprestimos")
      .update({ data_devolucao: agora() })
      .eq("id", id)
      .is("data_devolucao", null)
      .select("*")
      .single();

    if (atualizado.error) throw atualizado.error;

    const liberar = await supabase
      .from("equipamentos")
      .update({ status: "disponivel" })
      .eq("id", busca.data.equipamento_id);

    if (liberar.error) throw liberar.error;

    res.json({
      sucesso: true,
      mensagem: "Equipamento devolvido.",
      emprestimo: atualizado.data
    });
  } catch (erro) {
    return erroResposta(res, erro, 400);
  }
});

/* =========================================================
   DASHBOARD
   ========================================================= */

app.get("/api/dashboard", async (req, res) => {
  try {
    const f = await supabase
      .from("funcionarios")
      .select("id", { count: "exact", head: true });

    if (f.error) throw f.error;

    const equipamentos = await listarEquipamentos();

    const disponiveis = equipamentos.filter(
      e => normalizarStatus(e.status) === "disponivel"
    ).length;

    const emprestados = equipamentos.filter(
      e => normalizarStatus(e.status) === "emprestado"
    ).length;

    const emp = await supabase
      .from("emprestimos")
      .select("id,data_devolucao");

    if (emp.error) throw emp.error;

    const ativos = (emp.data || []).filter(
      e => !e.data_devolucao
    ).length;

    res.json({
      sucesso: true,
      funcionarios: f.count || 0,
      equipamentos: equipamentos.length,
      disponiveis,
      emprestados,
      emprestimos: ativos
    });
  } catch (erro) {
    return erroResposta(res, erro);
  }
});

/* =========================================================
   404 / ERRO
   ========================================================= */

app.use((req, res) => {
  res.status(404).json({
    sucesso: false,
    erro: "Rota não encontrada.",
    rota: req.originalUrl
  });
});

app.use((erro, req, res, next) => {
  console.error("ERRO GERAL:", erro);
  res.status(500).json({
    sucesso: false,
    erro: "Erro interno do servidor."
  });
});

app.listen(PORT, () => {
  console.log("======================================");
  console.log(" INVENTÁRIO RFID - NUVEM");
  console.log("======================================");
  console.log(`Porta: ${PORT}`);
  console.log("Banco: Supabase");
  console.log("Aguardando ESP32...");
});
