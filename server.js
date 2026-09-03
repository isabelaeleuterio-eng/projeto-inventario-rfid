require("dotenv").config();

const express = require("express");
const path = require("path");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_DIR = path.join(__dirname, "SITE");
const SERVIDOR_PUBLICO = "https://projeto-inventario-rfid.onrender.com";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("ERRO: configure SUPABASE_URL e SUPABASE_SECRET_KEY no Render/.env.");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
    }
});

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));
app.use(express.static(SITE_DIR, { maxAge: 0 }));

let esp32 = {
    conectado: false,
    ultimoContato: null,
    ip: null
};

let rfidEvent = {
    nova: false,
    uid: null,
    tipo: null,
    modo: null,
    mensagem: "Aguardando leitura RFID.",
    momento: 0
};

/*
 * Estado do fluxo.
 * O projeto atual usa um único ESP32/leitor, então o estado global é
 * intencional para este protótipo. Na próxima fase, cada leitor poderá
 * ter seu próprio estado.
 */
let fluxo = {
    modo: "idle",
    funcionario: null,
    equipamentoSelecionado: null,
    expiraEm: 0
};

let cadastroRFID = {
    ativo: false,
    tipo: null,
    expiraEm: 0
};

function normalizarUID(uid) {
    if (uid === null || uid === undefined) return "";
    return String(uid).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function texto(valor) {
    return valor === null || valor === undefined ? "" : String(valor);
}

function agora() {
    return new Date().toISOString();
}

function publicarRFID(dados) {
    rfidEvent = {
        nova: true,
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
    fluxo = {
        modo: "idle",
        funcionario: null,
        equipamentoSelecionado: null,
        expiraEm: 0
    };
}

function expirarFluxoSeNecessario() {
    if (fluxo.expiraEm && Date.now() > fluxo.expiraEm) {
        limparFluxo();
    }
    if (cadastroRFID.expiraEm && Date.now() > cadastroRFID.expiraEm) {
        cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
    }
}

async function buscarFuncionarioPorUID(uid) {
    const r = await supabase
        .from("funcionarios")
        .select("*")
        .eq("uid_tag_pessoal", uid)
        .maybeSingle();

    if (r.error) throw r.error;
    return r.data || null;
}

async function buscarEquipamentoPorUID(uid) {
    const r = await supabase
        .from("equipamentos")
        .select("*")
        .eq("uid_tag", uid)
        .maybeSingle();

    if (r.error) throw r.error;
    return r.data || null;
}

async function verificarUIDEmQualquerCadastro(uid) {
    const funcionario = await buscarFuncionarioPorUID(uid);
    const equipamento = await buscarEquipamentoPorUID(uid);

    if (funcionario) {
        return {
            encontrado: true,
            categoria: "funcionario",
            registro: funcionario
        };
    }

    if (equipamento) {
        return {
            encontrado: true,
            categoria: "equipamento",
            registro: equipamento
        };
    }

    return {
        encontrado: false,
        categoria: null,
        registro: null
    };
}

async function listarEquipamentosDisponiveis() {
    const r = await supabase
        .from("equipamentos")
        .select("*")
        .order("nome", { ascending: true });

    if (r.error) throw r.error;

    return (r.data || []).filter(e =>
        String(e.status || "").toLowerCase() === "disponivel"
    );
}

async function listarEmprestimosAtivosDoFuncionario(funcionarioId) {
    const r = await supabase
        .from("emprestimos")
        .select("*")
        .eq("funcionario_id", funcionarioId)
        .is("data_devolucao", null)
        .order("data_retirada", { ascending: true });

    if (r.error) throw r.error;

    const emprestimos = r.data || [];
    if (!emprestimos.length) return [];

    const ids = [...new Set(emprestimos.map(x => x.equipamento_id).filter(Boolean))];

    const e = await supabase
        .from("equipamentos")
        .select("*")
        .in("id", ids);

    if (e.error) throw e.error;

    const mapa = Object.fromEntries((e.data || []).map(x => [x.id, x]));

    return emprestimos.map(x => ({
        ...x,
        equipamento: mapa[x.equipamento_id] || null
    }));
}

async function montarEmprestimos() {
    const r = await supabase
        .from("emprestimos")
        .select("*")
        .order("id", { ascending: false })
        .limit(100);

    if (r.error) throw r.error;

    const lista = r.data || [];
    const funcionarioIds = [...new Set(lista.map(x => x.funcionario_id).filter(Boolean))];
    const equipamentoIds = [...new Set(lista.map(x => x.equipamento_id).filter(Boolean))];

    const funcionariosMap = {};
    const equipamentosMap = {};

    if (funcionarioIds.length) {
        const f = await supabase.from("funcionarios").select("*").in("id", funcionarioIds);
        if (f.error) throw f.error;
        for (const item of f.data || []) funcionariosMap[item.id] = item;
    }

    if (equipamentoIds.length) {
        const e = await supabase.from("equipamentos").select("*").in("id", equipamentoIds);
        if (e.error) throw e.error;
        for (const item of e.data || []) equipamentosMap[item.id] = item;
    }

    return lista.map(item => ({
        ...item,
        funcionario: funcionariosMap[item.funcionario_id] || null,
        equipamento: equipamentosMap[item.equipamento_id] || null
    }));
}

function erroResposta(res, erro, status = 500) {
    console.error("ERRO:", erro);
    return res.status(status).json({
        sucesso: false,
        erro: erro?.message || String(erro),
        mensagem: erro?.message || "Não foi possível concluir a operação."
    });
}

/* PÁGINAS */
app.get("/", (req, res) => res.sendFile(path.join(SITE_DIR, "index.html")));
app.get("/cadastro", (req, res) => res.sendFile(path.join(SITE_DIR, "cadastro.html")));
app.get("/controle", (req, res) => res.sendFile(path.join(SITE_DIR, "controle.html")));

/* SAÚDE */
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
        mensagem: "Servidor RFID funcionando!",
        servidor: "online",
        banco: "Supabase",
        porta: PORT,
        esp32: esp32.conectado,
        horario: agora()
    });
});

app.get("/api/status", (req, res) => {
    expirarFluxoSeNecessario();
    res.json({
        sucesso: true,
        servidor: "online",
        banco: "Supabase",
        esp32,
        rfid: rfidEvent,
        fluxo: {
            modo: fluxo.modo,
            funcionario: fluxo.funcionario,
            equipamentoSelecionado: fluxo.equipamentoSelecionado
                ? {
                    id: fluxo.equipamentoSelecionado.id,
                    nome: fluxo.equipamentoSelecionado.nome,
                    uid_tag: fluxo.equipamentoSelecionado.uid_tag,
                    box_id: fluxo.equipamentoSelecionado.box_id
                }
                : null
        }
    });
});

/* ESP32 */
app.post("/api/esp32/online", (req, res) => {
    esp32 = {
        conectado: true,
        ultimoContato: agora(),
        ip: texto(req.body?.ip).trim() || null
    };

    res.json({
        sucesso: true,
        mensagem: "ESP32 conectado ao servidor",
        horario: esp32.ultimoContato
    });
});

app.post("/api/esp32/rfid", async (req, res) => {
    try {
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

        console.log(`RFID ${uid} | leitor=${leitor}`);

        expirarFluxoSeNecessario();

        /*
         * CADASTRO:
         * A leitura não cria nem altera estoque.
         * Primeiro verifica em AMBAS as tabelas para impedir que a mesma
         * tag seja usada como pessoa e equipamento.
         */
        if (cadastroRFID.ativo && Date.now() < cadastroRFID.expiraEm) {
            const existente = await verificarUIDEmQualquerCadastro(uid);

            if (existente.encontrado) {
                const nome = existente.registro?.nome || "registro";
                const categoria = existente.categoria === "funcionario"
                    ? "funcionário"
                    : "equipamento";

                const evento = publicarRFID({
                    uid,
                    tipo: "tag_ja_cadastrada",
                    modo: "cadastro",
                    mensagem: `Esta tag já está cadastrada como ${categoria}: ${nome}. Escolha outra tag.`,
                    equipamento: existente.categoria === "equipamento"
                        ? existente.registro
                        : null
                });

                cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };

                return res.json({ sucesso: false, ...evento });
            }

            const evento = publicarRFID({
                uid,
                tipo: "cadastro_tag",
                modo: "cadastro",
                mensagem: "Tag disponível. UID preenchido automaticamente."
            });

            cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };

            return res.json({ sucesso: true, ...evento });
        }

        /* Devolução/retirada exigem fluxo iniciado pela página. */
        if (fluxo.modo === "aguardando_equipamento") {
            const equipamento = await buscarEquipamentoPorUID(uid);

            if (!equipamento) {
                const evento = publicarRFID({
                    uid,
                    tipo: "tag_nao_cadastrada",
                    modo: fluxo.modo,
                    mensagem: "Esta tag não está cadastrada como equipamento. Passe a tag do equipamento correto."
                });
                return res.status(404).json({ sucesso: false, ...evento });
            }

            const esperado = fluxo.equipamentoSelecionado;

            if (!esperado || Number(equipamento.id) !== Number(esperado.id)) {
                const evento = publicarRFID({
                    uid,
                    tipo: "equipamento_incorreto",
                    modo: fluxo.modo,
                    mensagem: `Tag incorreta. Você selecionou "${esperado?.nome || "um equipamento"}". Passe a tag desse equipamento.`,
                    equipamentoRecebido: equipamento,
                    equipamentoEsperado: esperado
                });
                return res.status(409).json({ sucesso: false, ...evento });
            }

            if (equipamento.status !== "disponivel") {
                const evento = publicarRFID({
                    uid,
                    tipo: "equipamento_emprestado",
                    modo: fluxo.modo,
                    mensagem: "Este equipamento não está disponível para retirada.",
                    equipamento
                });
                return res.status(409).json({ sucesso: false, ...evento });
            }

            if (!fluxo.funcionario?.id) {
                limparFluxo();
                const evento = publicarRFID({
                    uid,
                    tipo: "fluxo_expirado",
                    mensagem: "O funcionário não está mais identificado. Comece novamente."
                });
                return res.status(409).json({ sucesso: false, ...evento });
            }

            const funcionarioId = fluxo.funcionario.id;
            const funcionarioNome = fluxo.funcionario.nome;

            const inserir = await supabase
                .from("emprestimos")
                .insert({
                    funcionario_id: funcionarioId,
                    equipamento_id: equipamento.id,
                    data_retirada: agora()
                })
                .select("*")
                .maybeSingle();

            if (inserir.error) throw inserir.error;

            const atualizar = await supabase
                .from("equipamentos")
                .update({ status: "emprestado" })
                .eq("id", equipamento.id)
                .eq("status", "disponivel")
                .select("*")
                .maybeSingle();

            if (atualizar.error) throw atualizar.error;

            if (!atualizar.data) {
                /*
                 * Evita deixar um empréstimo aberto caso o status tenha
                 * mudado entre a leitura e a atualização.
                 */
                if (inserir.data?.id) {
                    await supabase.from("emprestimos")
                        .delete()
                        .eq("id", inserir.data.id);
                }

                const evento = publicarRFID({
                    uid,
                    tipo: "equipamento_emprestado",
                    mensagem: "O equipamento deixou de estar disponível. Tente novamente."
                });

                limparFluxo();
                return res.status(409).json({ sucesso: false, ...evento });
            }

            const evento = publicarRFID({
                uid,
                tipo: "retirada_concluida",
                mensagem: "Retirada concluída com sucesso!",
                funcionario: funcionarioNome,
                equipamento,
                box: equipamento.box_id
            });

            limparFluxo();

            return res.json({
                sucesso: true,
                ...evento,
                emprestimo: inserir.data
            });
        }

        if (fluxo.modo === "aguardando_devolucao") {
            const equipamento = await buscarEquipamentoPorUID(uid);

            if (!equipamento) {
                const evento = publicarRFID({
                    uid,
                    tipo: "tag_nao_cadastrada",
                    modo: fluxo.modo,
                    mensagem: "Esta tag não está cadastrada como equipamento."
                });
                return res.status(404).json({ sucesso: false, ...evento });
            }

            const esperado = fluxo.equipamentoSelecionado;

            if (!esperado || Number(equipamento.id) !== Number(esperado.id)) {
                const evento = publicarRFID({
                    uid,
                    tipo: "equipamento_incorreto",
                    modo: fluxo.modo,
                    mensagem: `Tag incorreta. Você selecionou "${esperado?.nome || "um equipamento"}". Passe a tag desse equipamento.`,
                    equipamentoRecebido: equipamento,
                    equipamentoEsperado: esperado
                });
                return res.status(409).json({ sucesso: false, ...evento });
            }

            const funcionarioId = fluxo.funcionario?.id;
            if (!funcionarioId) {
                limparFluxo();
                const evento = publicarRFID({
                    uid,
                    tipo: "fluxo_expirado",
                    mensagem: "O funcionário não está mais identificado. Comece novamente."
                });
                return res.status(409).json({ sucesso: false, ...evento });
            }

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
                    mensagem: "A devolução já foi registrada. Atualize a tela e tente novamente."
                });
                limparFluxo();
                return res.status(409).json({ sucesso: false, ...evento });
            }

            const atualizar = await supabase
                .from("equipamentos")
                .update({ status: "disponivel" })
                .eq("id", equipamento.id)
                .select("*")
                .maybeSingle();

            if (atualizar.error) throw atualizar.error;

            const evento = publicarRFID({
                uid,
                tipo: "devolucao_concluida",
                mensagem: "Devolução concluída com sucesso!",
                funcionario: fluxo.funcionario.nome,
                equipamento,
                box: equipamento.box_id
            });

            limparFluxo();

            return res.json({
                sucesso: true,
                ...evento,
                emprestimo: devolver.data
            });
        }

        /*
         * Leitura fora de um fluxo iniciado pela interface.
         * Não altera estoque. Isso evita que uma tag solta retire/devolva algo.
         */
        const pessoa = await buscarFuncionarioPorUID(uid);
        const equipamento = await buscarEquipamentoPorUID(uid);

        if (pessoa) {
            const ativos = await listarEmprestimosAtivosDoFuncionario(pessoa.id);

            if (ativos.length) {
                const evento = publicarRFID({
                    uid,
                    tipo: "funcionario_identificado",
                    modo: "selecionar_devolucao",
                    mensagem: "Funcionário identificado. Selecione qual equipamento deseja devolver.",
                    funcionario: {
                        id: pessoa.id,
                        nome: pessoa.nome,
                        matricula: pessoa.matricula
                    }
                });

                return res.json({ sucesso: true, ...evento, equipamentos: ativos.map(x => x.equipamento).filter(Boolean) });
            }

            const disponiveis = await listarEquipamentosDisponiveis();

            const evento = publicarRFID({
                uid,
                tipo: "funcionario_identificado",
                modo: "selecionar_retirada",
                mensagem: "Funcionário identificado. Selecione o equipamento que deseja retirar.",
                funcionario: {
                    id: pessoa.id,
                    nome: pessoa.nome,
                    matricula: pessoa.matricula
                }
            });

            return res.json({
                sucesso: true,
                ...evento,
                equipamentos: disponiveis
            });
        }

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
            mensagem: "Tag não cadastrada. Cadastre-a antes de utilizar."
        });

        return res.status(404).json({ sucesso: false, ...evento });

    } catch (erro) {
        return erroResposta(res, erro);
    }
});

/* RFID usado pela interface */
app.get("/rfid/ultima", (req, res) => {
    expirarFluxoSeNecessario();
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
    rfidEvent = {
        nova: false,
        uid: null,
        tipo: null,
        modo: null,
        mensagem: "Aguardando nova operação.",
        momento: Date.now()
    };
    res.json({ sucesso: true, mensagem: "Operação reiniciada." });
});

/* Página de cadastro pede uma leitura temporária */
app.post("/api/rfid/cadastro/iniciar", (req, res) => {
    const tipo = req.body?.tipo === "equipamento" ? "equipamento" : "funcionario";
    cadastroRFID = {
        ativo: true,
        tipo,
        expiraEm: Date.now() + 30000
    };
    res.json({
        sucesso: true,
        tipo,
        mensagem: "Aguardando uma tag disponível.",
        expiraEm: cadastroRFID.expiraEm
    });
});

/* Seleção obrigatória de equipamento */
app.post("/api/rfid/selecionar", async (req, res) => {
    try {
        expirarFluxoSeNecessario();

        const equipamentoId = Number(req.body?.equipamento_id);
        const funcionarioId = Number(req.body?.funcionario_id);

        if (!Number.isInteger(equipamentoId) || equipamentoId <= 0) {
            return res.status(400).json({
                sucesso: false,
                erro: "Equipamento inválido."
            });
        }

        if (!fluxo.funcionario || Number(fluxo.funcionario.id) !== funcionarioId) {
            return res.status(409).json({
                sucesso: false,
                erro: "Funcionário não está mais identificado. Passe a tag novamente."
            });
        }

        const e = await supabase
            .from("equipamentos")
            .select("*")
            .eq("id", equipamentoId)
            .maybeSingle();

        if (e.error) throw e.error;

        if (!e.data) {
            return res.status(404).json({
                sucesso: false,
                erro: "Equipamento não encontrado."
            });
        }

        const ativos = await listarEmprestimosAtivosDoFuncionario(funcionarioId);

        let modo = "aguardando_equipamento";

        if (ativos.some(x => Number(x.equipamento_id) === equipamentoId)) {
            modo = "aguardando_devolucao";
        } else if (String(e.data.status).toLowerCase() !== "disponivel") {
            return res.status(409).json({
                sucesso: false,
                erro: "Este equipamento não está disponível para retirada."
            });
        }

        fluxo = {
            modo,
            funcionario: fluxo.funcionario,
            equipamentoSelecionado: e.data,
            expiraEm: Date.now() + 120000
        };

        const mensagem = modo === "aguardando_devolucao"
            ? `Devolução: passe a tag de "${e.data.nome}".`
            : `Retirada: passe a tag de "${e.data.nome}".`;

        const evento = publicarRFID({
            uid: fluxo.funcionario.uid_tag_pessoal,
            tipo: "equipamento_selecionado",
            modo,
            mensagem,
            funcionario: fluxo.funcionario,
            equipamento: e.data,
            box: e.data.box_id
        });

        res.json({
            sucesso: true,
            ...evento
        });
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
    } catch (erro) {
        erroResposta(res, erro);
    }
});

app.get("/api/funcionarios/:id", async (req, res) => {
    try {
        const r = await supabase.from("funcionarios").select("*").eq("id", req.params.id).maybeSingle();
        if (r.error) throw r.error;
        if (!r.data) return res.status(404).json({ sucesso: false, erro: "Funcionário não encontrado." });
        res.json({ sucesso: true, funcionario: r.data });
    } catch (erro) {
        erroResposta(res, erro);
    }
});

app.post("/api/funcionarios", async (req, res) => {
    try {
        const nome = texto(req.body?.nome).trim();
        const matricula = texto(req.body?.matricula).trim();
        const uid = normalizarUID(req.body?.uid_tag_pessoal || req.body?.uid_rfid);

        if (!nome) return res.status(400).json({ sucesso: false, erro: "Informe o nome do funcionário." });
        if (!matricula) return res.status(400).json({ sucesso: false, erro: "Informe a matrícula." });
        if (!uid) return res.status(400).json({ sucesso: false, erro: "Leia a tag do funcionário antes de salvar." });

        const existente = await verificarUIDEmQualquerCadastro(uid);

        if (existente.encontrado) {
            const tipo = existente.categoria === "funcionario" ? "funcionário" : "equipamento";
            return res.status(409).json({
                sucesso: false,
                tipo: "tag_ja_cadastrada",
                erro: `Esta tag já está cadastrada como ${tipo}: ${existente.registro.nome}.`,
                mensagem: `A tag ${uid} já está cadastrada. Não é possível reutilizá-la.`
            });
        }

        const matriculaExistente = await supabase
            .from("funcionarios")
            .select("id,nome")
            .eq("matricula", matricula)
            .maybeSingle();

        if (matriculaExistente.error) throw matriculaExistente.error;

        if (matriculaExistente.data) {
            return res.status(409).json({
                sucesso: false,
                erro: `A matrícula ${matricula} já está cadastrada para ${matriculaExistente.data.nome}.`
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
            .maybeSingle();

        if (r.error) {
            if (String(r.error.message).toLowerCase().includes("duplicate")) {
                return res.status(409).json({ sucesso: false, erro: "Esta tag ou matrícula já está cadastrada." });
            }
            throw r.error;
        }

        res.json({ sucesso: true, mensagem: "Funcionário cadastrado com sucesso!", funcionario: r.data });
    } catch (erro) {
        erroResposta(res, erro);
    }
});

app.put("/api/funcionarios/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        const nome = texto(req.body?.nome).trim();
        const matricula = texto(req.body?.matricula).trim();

        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ sucesso: false, erro: "ID inválido." });
        if (!nome || !matricula) return res.status(400).json({ sucesso: false, erro: "Nome e matrícula são obrigatórios." });

        const r = await supabase.from("funcionarios").update({ nome, matricula }).eq("id", id).select("*").maybeSingle();
        if (r.error) throw r.error;
        if (!r.data) return res.status(404).json({ sucesso: false, erro: "Funcionário não encontrado." });

        res.json({ sucesso: true, mensagem: "Funcionário atualizado.", funcionario: r.data });
    } catch (erro) {
        erroResposta(res, erro);
    }
});

app.delete("/api/funcionarios/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ sucesso: false, erro: "ID inválido." });

        const ativos = await supabase.from("emprestimos").select("id").eq("funcionario_id", id).is("data_devolucao", null).limit(1);
        if (ativos.error) throw ativos.error;

        if ((ativos.data || []).length) {
            return res.status(409).json({ sucesso: false, erro: "Não é possível excluir um funcionário com equipamento emprestado. Registre a devolução primeiro." });
        }

        const r = await supabase.from("funcionarios").delete().eq("id", id);
        if (r.error) throw r.error;

        res.json({ sucesso: true, mensagem: "Funcionário excluído com sucesso." });
    } catch (erro) {
        erroResposta(res, erro);
    }
});

/* EQUIPAMENTOS */
app.get("/api/equipamentos", async (req, res) => {
    try {
        const r = await supabase.from("equipamentos").select("*").order("nome", { ascending: true });
        if (r.error) throw r.error;
        res.json({ sucesso: true, equipamentos: r.data || [] });
    } catch (erro) {
        erroResposta(res, erro);
    }
});

app.get("/api/equipamentos/:id", async (req, res) => {
    try {
        const r = await supabase.from("equipamentos").select("*").eq("id", req.params.id).maybeSingle();
        if (r.error) throw r.error;
        if (!r.data) return res.status(404).json({ sucesso: false, erro: "Equipamento não encontrado." });
        res.json({ sucesso: true, equipamento: r.data });
    } catch (erro) {
        erroResposta(res, erro);
    }
});

app.post("/api/equipamentos", async (req, res) => {
    try {
        const nome = texto(req.body?.nome).trim();
        const uid = normalizarUID(req.body?.uid_tag || req.body?.uid_rfid);
        const boxId = Number(req.body?.box_id ?? req.body?.box);

        if (!nome) return res.status(400).json({ sucesso: false, erro: "Informe o nome do equipamento." });
        if (!uid) return res.status(400).json({ sucesso: false, erro: "Leia a tag do equipamento antes de salvar." });
        if (!Number.isInteger(boxId) || boxId <= 0) return res.status(400).json({ sucesso: false, erro: "Informe um número de Box válido." });

        const existente = await verificarUIDEmQualquerCadastro(uid);

        if (existente.encontrado) {
            const tipo = existente.categoria === "funcionario" ? "funcionário" : "equipamento";
            return res.status(409).json({
                sucesso: false,
                tipo: "tag_ja_cadastrada",
                erro: `Esta tag já está cadastrada como ${tipo}: ${existente.registro.nome}.`,
                mensagem: `A tag ${uid} já está cadastrada. Não é possível reutilizá-la.`
            });
        }

        const r = await supabase
            .from("equipamentos")
            .insert({
                nome,
                uid_tag: uid,
                box_id: boxId,
                status: "disponivel"
            })
            .select("*")
            .maybeSingle();

        if (r.error) {
            if (String(r.error.message).toLowerCase().includes("duplicate")) {
                return res.status(409).json({ sucesso: false, erro: "Esta tag já está cadastrada." });
            }
            throw r.error;
        }

        res.json({ sucesso: true, mensagem: "Equipamento cadastrado com sucesso!", equipamento: r.data });
    } catch (erro) {
        erroResposta(res, erro);
    }
});

app.put("/api/equipamentos/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        const nome = texto(req.body?.nome).trim();
        const boxId = Number(req.body?.box_id ?? req.body?.box);

        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ sucesso: false, erro: "ID inválido." });
        if (!nome) return res.status(400).json({ sucesso: false, erro: "Informe o nome." });
        if (!Number.isInteger(boxId) || boxId <= 0) return res.status(400).json({ sucesso: false, erro: "Box inválido." });

        const r = await supabase.from("equipamentos").update({ nome, box_id: boxId }).eq("id", id).select("*").maybeSingle();
        if (r.error) throw r.error;
        if (!r.data) return res.status(404).json({ sucesso: false, erro: "Equipamento não encontrado." });

        res.json({ sucesso: true, mensagem: "Equipamento atualizado.", equipamento: r.data });
    } catch (erro) {
        erroResposta(res, erro);
    }
});

app.delete("/api/equipamentos/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ sucesso: false, erro: "ID inválido." });

        const ativo = await supabase.from("emprestimos").select("id").eq("equipamento_id", id).is("data_devolucao", null).limit(1);
        if (ativo.error) throw ativo.error;

        if ((ativo.data || []).length) {
            return res.status(409).json({ sucesso: false, erro: "Não é possível excluir um equipamento emprestado." });
        }

        const historico = await supabase.from("emprestimos").select("id").eq("equipamento_id", id).limit(1);
        if (historico.error) throw historico.error;

        if ((historico.data || []).length) {
            return res.status(409).json({ sucesso: false, erro: "Este equipamento possui histórico de empréstimos. Preserve o histórico e não o exclua." });
        }

        const r = await supabase.from("equipamentos").delete().eq("id", id);
        if (r.error) throw r.error;

        res.json({ sucesso: true, mensagem: "Equipamento excluído com sucesso." });
    } catch (erro) {
        erroResposta(res, erro);
    }
});

/* EMPRÉSTIMOS */
app.get("/api/emprestimos", async (req, res) => {
    try {
        res.json({ sucesso: true, emprestimos: await montarEmprestimos() });
    } catch (erro) {
        erroResposta(res, erro);
    }
});

app.get("/api/ultimos-emprestimos", async (req, res) => {
    try {
        const lista = await montarEmprestimos();
        res.json({ sucesso: true, emprestimos: lista.slice(0, 10) });
    } catch (erro) {
        erroResposta(res, erro);
    }
});

app.post("/api/emprestimos", async (req, res) => {
    try {
        const funcionarioId = Number(req.body?.funcionario_id);
        const equipamentoId = Number(req.body?.equipamento_id);

        if (!Number.isInteger(funcionarioId) || funcionarioId <= 0) return res.status(400).json({ sucesso: false, erro: "Funcionário inválido." });
        if (!Number.isInteger(equipamentoId) || equipamentoId <= 0) return res.status(400).json({ sucesso: false, erro: "Equipamento inválido." });

        const funcionario = await supabase.from("funcionarios").select("*").eq("id", funcionarioId).maybeSingle();
        if (funcionario.error) throw funcionario.error;
        if (!funcionario.data) return res.status(404).json({ sucesso: false, erro: "Funcionário não encontrado." });

        const equipamento = await supabase.from("equipamentos").select("*").eq("id", equipamentoId).maybeSingle();
        if (equipamento.error) throw equipamento.error;
        if (!equipamento.data) return res.status(404).json({ sucesso: false, erro: "Equipamento não encontrado." });

        if (equipamento.data.status !== "disponivel") return res.status(409).json({ sucesso: false, erro: "Equipamento não disponível." });

        const r = await supabase.from("emprestimos").insert({
            funcionario_id: funcionarioId,
            equipamento_id: equipamentoId,
            data_retirada: agora()
        }).select("*").maybeSingle();

        if (r.error) throw r.error;

        const u = await supabase.from("equipamentos").update({ status: "emprestado" }).eq("id", equipamentoId).eq("status", "disponivel");
        if (u.error) throw u.error;

        res.json({ sucesso: true, mensagem: "Retirada registrada.", emprestimo: r.data });
    } catch (erro) {
        erroResposta(res, erro);
    }
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
    } catch (erro) {
        erroResposta(res, erro);
    }
});

/* DASHBOARD */
app.get("/api/dashboard", async (req, res) => {
    try {
        const [f, e, emprestimos] = await Promise.all([
            supabase.from("funcionarios").select("id", { count: "exact", head: true }),
            supabase.from("equipamentos").select("id,status"),
            supabase.from("emprestimos").select("id", { count: "exact", head: true }).is("data_devolucao", null)
        ]);

        if (f.error) throw f.error;
        if (e.error) throw e.error;
        if (emprestimos.error) throw emprestimos.error;

        const equipamentos = e.data || [];
        const disponiveis = equipamentos.filter(x => String(x.status).toLowerCase() === "disponivel").length;
        const emprestados = equipamentos.filter(x => String(x.status).toLowerCase() === "emprestado").length;

        res.json({
            sucesso: true,
            funcionarios: f.count || 0,
            equipamentos: equipamentos.length,
            disponiveis,
            emprestimos: emprestimos.count || 0,
            emprestados
        });
    } catch (erro) {
        erroResposta(res, erro);
    }
});

/* ROTA NÃO ENCONTRADA */
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

app.listen(PORT, "0.0.0.0", () => {
    console.log("======================================");
    console.log(" INVENTÁRIO RFID - NUVEM");
    console.log("======================================");
    console.log(`Servidor: ${SERVIDOR_PUBLICO}`);
    console.log("Banco: Supabase");
    console.log("Aguardando ESP32...");
});
