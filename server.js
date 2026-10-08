require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SITE_DIR = path.join(__dirname, "SITE");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("ERRO: configure SUPABASE_URL e SUPABASE_SECRET_KEY.");
    process.exit(1);
}

/* Toda chamada ao banco tem limite de 8 s: banco pausado/lento não trava o servidor. */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
        fetch: (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(8000) })
    }
});

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));
app.use(express.text({ type: "text/plain", limit: "100kb" }));
app.use(express.static(SITE_DIR, { maxAge: 0 }));

/* ============================================================
 * FLUXO (leitor único, sem box)
 *
 * RETIRADA  : pessoa escolhe o nome e o item na tela -> passa a tag do item.
 * DEVOLUÇÃO : pessoa passa a tag do item -> passa a tag pessoal.
 * Ao concluir, o evento sai com abrir:true e o ESP32 libera a fechadura.
 * ============================================================ */
const TEMPO_FLUXO_MS = 120000;           // tempo para concluir a segunda etapa
const EXIGIR_MESMO_FUNCIONARIO = true;   // só quem retirou pode devolver

let esp32 = { conectado: false, ultimoContato: null, ip: null };

const eventoOciosoBase = {
    nova: false, id: 0, uid: null, tipo: "idle", modo: "idle",
    mensagem: "Escolha retirar ou devolver.", funcionario: null,
    equipamento: null, equipamentos: [], equipamentoRecebido: null,
    equipamentoEsperado: null, abrir: false, momento: 0
};
let rfidEvent = { ...eventoOciosoBase };

let fluxo = fluxoVazio();
let cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
let ultimaLeitura = { uid: null, momento: 0 };

function fluxoVazio() {
    return { modo: "idle", funcionario: null, equipamento: null, emprestimo: null, expiraEm: 0 };
}

const agora = () => new Date().toISOString();
const texto = (v, fallback = "") => v == null ? fallback : String(v);
const uid = (v) => texto(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
const status = (v) => texto(v).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const erroMsg = e => e?.message || String(e);

function erroResposta(res, erro, codigo = 500) {
    console.error("ERRO:", erro);
    return res.status(codigo).json({ sucesso: false, erro: erroMsg(erro), mensagem: erroMsg(erro) });
}

function publicar(d) {
    rfidEvent = {
        nova: true,
        id: Date.now(),
        uid: d.uid || null,
        tipo: d.tipo || "idle",
        modo: d.modo || fluxo.modo || "idle",
        mensagem: d.mensagem || "",
        funcionario: d.funcionario || null,
        equipamento: d.equipamento || null,
        equipamentos: d.equipamentos || [],
        equipamentoRecebido: d.equipamentoRecebido || null,
        equipamentoEsperado: d.equipamentoEsperado || null,
        abrir: d.abrir === true,
        momento: Date.now()
    };
    return rfidEvent;
}

function limparFluxo() { fluxo = fluxoVazio(); }

function expirar() {
    if (fluxo.expiraEm && Date.now() > fluxo.expiraEm) {
        const tinha = fluxo.modo !== "idle";
        limparFluxo();
        if (tinha) publicar({ tipo: "fluxo_expirado", modo: "idle", mensagem: "A operação expirou por inatividade." });
    }
    if (cadastroRFID.expiraEm && Date.now() > cadastroRFID.expiraEm) {
        cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
    }
}

const resumoFunc = f => f ? { id: f.id, nome: f.nome, matricula: f.matricula } : null;
const resumoEquip = e => e ? { id: e.id, nome: e.nome, uid_tag: e.uid_tag, descricao: e.descricao ?? null } : null;

/* ---------------- consultas ---------------- */
async function buscarFuncionarioPorUID(u) {
    const r = await supabase.from("funcionarios").select("*").eq("uid_tag_pessoal", u).eq("ativo", true).maybeSingle();
    if (r.error) throw r.error;
    return r.data || null;
}

async function buscarEquipamentoPorUID(u) {
    const r = await supabase.from("equipamentos").select("*").eq("uid_tag", u).eq("ativo", true).maybeSingle();
    if (r.error) throw r.error;
    return r.data || null;
}

async function verificarUID(u) {
    const f = await buscarFuncionarioPorUID(u);
    if (f) return { encontrado: true, categoria: "funcionario", registro: f };
    const e = await buscarEquipamentoPorUID(u);
    if (e) return { encontrado: true, categoria: "equipamento", registro: e };
    return { encontrado: false };
}

/* Empréstimo em aberto = ainda não tem data de devolução (não depende do texto do status). */
async function emprestimoAbertoDoFuncionario(id) {
    const r = await supabase.from("emprestimos").select("*")
        .eq("funcionario_id", id).is("data_devolucao", null)
        .order("id", { ascending: false }).limit(1);
    if (r.error) throw r.error;
    return r.data?.[0] || null;
}

async function emprestimoAbertoDoEquipamento(id) {
    const r = await supabase.from("emprestimos").select("*")
        .eq("equipamento_id", id).is("data_devolucao", null)
        .order("id", { ascending: false }).limit(1);
    if (r.error) throw r.error;
    return r.data?.[0] || null;
}

async function listarEquipamentos() {
    const r = await supabase.from("equipamentos").select("*").eq("ativo", true).order("id", { ascending: true });
    if (r.error) throw r.error;
    return r.data || [];
}

async function enriquecer(rows) {
    const fids = [...new Set(rows.map(x => x.funcionario_id).filter(Boolean))];
    const eids = [...new Set(rows.map(x => x.equipamento_id).filter(Boolean))];
    const fm = {}, em = {};

    if (fids.length) {
        const r = await supabase.from("funcionarios").select("*").in("id", fids);
        if (r.error) throw r.error;
        (r.data || []).forEach(x => fm[x.id] = x);
    }
    if (eids.length) {
        const r = await supabase.from("equipamentos").select("*").in("id", eids);
        if (r.error) throw r.error;
        (r.data || []).forEach(x => em[x.id] = x);
    }
    return rows.map(x => ({ ...x, funcionario: fm[x.funcionario_id] || null, equipamento: em[x.equipamento_id] || null }));
}

/* ---------------- páginas ---------------- */
app.get("/", (req, res) => res.sendFile(path.join(SITE_DIR, "index.html")));
app.get("/cadastro", (req, res) => res.sendFile(path.join(SITE_DIR, "cadastro.html")));
app.get("/controle", (req, res) => res.sendFile(path.join(SITE_DIR, "controle.html")));

/* ---------------- saúde ---------------- */
app.get("/health", (req, res) => res.json({ sucesso: true, servidor: "online", banco: "Supabase", horario: agora() }));

app.get("/health/db", async (req, res) => {
    try {
        const r = await supabase.from("equipamentos").select("id", { head: true, count: "exact" });
        if (r.error) throw r.error;
        res.json({ sucesso: true, servidor: "online", banco: "ok", horario: agora() });
    } catch (e) {
        res.status(503).json({ sucesso: false, servidor: "online", banco: "indisponivel", erro: erroMsg(e), horario: agora() });
    }
});

app.get("/teste", (req, res) => res.json({ sucesso: true, mensagem: "Servidor RFID funcionando!", banco: "Supabase", esp32, horario: agora() }));

/* Estado da tela: não consulta o banco (rápido, a tela chama a cada segundo). */
app.get("/api/status", (req, res) => {
    expirar();
    res.set("Cache-Control", "no-store");
    res.json({
        sucesso: true,
        servidor: "online",
        esp32,
        rfid: rfidEvent,
        fluxo: {
            modo: fluxo.modo,
            funcionario: resumoFunc(fluxo.funcionario),
            equipamento: resumoEquip(fluxo.equipamento)
        }
    });
});

/* ---------------- ESP32 ---------------- */
app.get("/api/esp32/status", (req, res) => {
    const t = esp32.ultimoContato ? Date.parse(esp32.ultimoContato) : 0;
    res.json({ sucesso: true, conectado: !!t && Date.now() - t < 60000, ultimoContato: esp32.ultimoContato, ip: esp32.ip });
});

app.post("/api/esp32/online", (req, res) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    esp32 = { conectado: true, ultimoContato: agora(), ip: texto(b.ip).trim() || null };
    res.json({ sucesso: true, mensagem: "ESP32 conectado ao servidor", horario: esp32.ultimoContato });
});

/* ÚNICO ponto de entrada das tags. */
app.post("/api/esp32/rfid", async (req, res) => {
    try {
        const b = req.body && typeof req.body === "object" ? req.body : { uid: req.body };
        const u = uid(b.uid ?? b.UID ?? b.uid_tag ?? b.tag ?? b.rfid ?? b["UID da tag"]);

        if (!u) return res.status(400).json({ sucesso: false, erro: "UID não informado." });

        esp32.conectado = true;
        esp32.ultimoContato = agora();
        console.log(`RFID ${u} | modo=${fluxo.modo}`);

        expirar();

        /* Evita duplicação do mesmo cartão mantido sobre o leitor. */
        if (ultimaLeitura.uid === u && Date.now() - ultimaLeitura.momento < 1200) {
            return res.json({ sucesso: true, repetida: true, uid: u, mensagem: "Leitura repetida ignorada." });
        }
        ultimaLeitura = { uid: u, momento: Date.now() };

        /* ---------- CADASTRO DE TAGS ---------- */
        if (cadastroRFID.ativo && Date.now() < cadastroRFID.expiraEm) {
            const ex = await verificarUID(u);
            cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };

            if (ex.encontrado) {
                const ev = publicar({
                    uid: u, tipo: "tag_ja_cadastrada", modo: "cadastro",
                    mensagem: `Esta tag já está cadastrada como ${ex.categoria}: ${ex.registro.nome}.`
                });
                return res.status(409).json({ sucesso: false, ...ev });
            }

            const ev = publicar({ uid: u, tipo: "cadastro_tag", modo: "cadastro", mensagem: "Tag lida com sucesso. UID preenchido." });
            return res.json({ sucesso: true, ...ev });
        }

        /* ---------- RETIRADA: confirmar com a tag do item ---------- */
        if (fluxo.modo === "aguardando_tag_item") {
            const esperado = fluxo.equipamento;
            const funcionario = fluxo.funcionario;

            const equipamento = await buscarEquipamentoPorUID(u);

            if (!equipamento) {
                const ev = publicar({
                    uid: u, tipo: "tag_nao_cadastrada",
                    mensagem: `Esta tag não é de um equipamento. Passe a tag de "${esperado.nome}".`
                });
                return res.status(404).json({ sucesso: false, ...ev });
            }

            if (Number(equipamento.id) !== Number(esperado.id)) {
                const ev = publicar({
                    uid: u, tipo: "objeto_incorreto",
                    mensagem: `Tag incorreta. Você escolheu "${esperado.nome}". Passe a tag desse item.`,
                    funcionario: resumoFunc(funcionario),
                    equipamento: resumoEquip(esperado),
                    equipamentoRecebido: resumoEquip(equipamento),
                    equipamentoEsperado: resumoEquip(esperado)
                });
                return res.status(409).json({ sucesso: false, ...ev });
            }

            /* Revalida no banco antes de gravar. */
            if (status(equipamento.status) !== "disponivel" || await emprestimoAbertoDoEquipamento(equipamento.id)) {
                limparFluxo();
                const ev = publicar({ uid: u, tipo: "equipamento_emprestado", modo: "idle", mensagem: "Esse equipamento não está mais disponível." });
                return res.status(409).json({ sucesso: false, ...ev });
            }

            if (await emprestimoAbertoDoFuncionario(funcionario.id)) {
                limparFluxo();
                const ev = publicar({
                    uid: u, tipo: "funcionario_com_emprestimo", modo: "idle",
                    mensagem: `${funcionario.nome} precisa devolver o equipamento que está com ele antes de retirar outro.`
                });
                return res.status(409).json({ sucesso: false, ...ev });
            }

            const ins = await supabase.from("emprestimos")
                .insert([{
                    funcionario_id: Number(funcionario.id),
                    equipamento_id: Number(equipamento.id),
                    status: "Emprestado",
                    data_retirada: agora()
                }])
                .select().maybeSingle();

            if (ins.error) throw ins.error;

            const up = await supabase.from("equipamentos")
                .update({ status: "emprestado" })
                .eq("id", equipamento.id).eq("status", "disponivel")
                .select().maybeSingle();

            if (up.error || !up.data) {
                if (ins.data?.id) await supabase.from("emprestimos").delete().eq("id", ins.data.id);
                if (up.error) throw up.error;
                limparFluxo();
                const ev = publicar({ uid: u, tipo: "equipamento_emprestado", modo: "idle", mensagem: "O equipamento deixou de estar disponível. Tente novamente." });
                return res.status(409).json({ sucesso: false, ...ev });
            }

            limparFluxo();
            const ev = publicar({
                uid: u, tipo: "retirada_concluida", modo: "idle",
                mensagem: `${equipamento.nome} está EMPRESTADO para ${funcionario.nome}.`,
                funcionario: resumoFunc(funcionario),
                equipamento: resumoEquip(equipamento),
                abrir: true
            });
            return res.status(201).json({ sucesso: true, ...ev, emprestimo: ins.data });
        }

        /* ---------- DEVOLUÇÃO: confirmar com a tag pessoal ---------- */
        if (fluxo.modo === "aguardando_tag_pessoal") {
            const equipamento = fluxo.equipamento;
            const emprestimo = fluxo.emprestimo;
            const tomador = fluxo.funcionario;

            const pessoa = await buscarFuncionarioPorUID(u);

            if (!pessoa) {
                const eEquip = await buscarEquipamentoPorUID(u);
                const ev = publicar({
                    uid: u,
                    tipo: eEquip ? "tag_pessoal_esperada" : "tag_nao_cadastrada",
                    mensagem: eEquip
                        ? "Agora passe a SUA tag pessoal para confirmar a devolução."
                        : "Tag não cadastrada. Passe a sua tag pessoal.",
                    equipamento: resumoEquip(equipamento)
                });
                return res.status(eEquip ? 409 : 404).json({ sucesso: false, ...ev });
            }

            if (EXIGIR_MESMO_FUNCIONARIO && Number(pessoa.id) !== Number(emprestimo.funcionario_id)) {
                const ev = publicar({
                    uid: u, tipo: "funcionario_incorreto",
                    mensagem: `Este equipamento está com ${tomador?.nome || "outro funcionário"}. Só quem retirou pode devolver.`,
                    funcionario: resumoFunc(pessoa),
                    equipamento: resumoEquip(equipamento)
                });
                return res.status(409).json({ sucesso: false, ...ev });
            }

            const dev = await supabase.from("emprestimos")
                .update({ data_devolucao: agora(), status: "Devolvido" })
                .eq("id", emprestimo.id).is("data_devolucao", null)
                .select().maybeSingle();

            if (dev.error) throw dev.error;

            if (!dev.data) {
                limparFluxo();
                const ev = publicar({ uid: u, tipo: "operacao_conflito", modo: "idle", mensagem: "Essa devolução já foi registrada." });
                return res.status(409).json({ sucesso: false, ...ev });
            }

            const up = await supabase.from("equipamentos").update({ status: "disponivel" }).eq("id", equipamento.id);
            if (up.error) throw up.error;

            limparFluxo();
            const ev = publicar({
                uid: u, tipo: "devolucao_concluida", modo: "idle",
                mensagem: `${equipamento.nome} foi DEVOLVIDO por ${pessoa.nome}.`,
                funcionario: resumoFunc(pessoa),
                equipamento: resumoEquip(equipamento),
                abrir: true
            });
            return res.json({ sucesso: true, ...ev, emprestimo: dev.data });
        }

        /* ---------- SEM OPERAÇÃO EM ANDAMENTO ---------- */
        const ex = await verificarUID(u);

        if (!ex.encontrado) {
            const ev = publicar({ uid: u, tipo: "tag_nao_cadastrada", modo: "idle", mensagem: "Tag não cadastrada no sistema." });
            return res.status(404).json({ sucesso: false, ...ev });
        }

        if (ex.categoria === "funcionario") {
            const ev = publicar({
                uid: u, tipo: "tag_pessoal_sem_item", modo: "idle",
                mensagem: "Para devolver, passe primeiro a tag do item. Para retirar, escolha o item na tela.",
                funcionario: resumoFunc(ex.registro)
            });
            return res.status(409).json({ sucesso: false, ...ev });
        }

        /* Tag de equipamento */
        const equipamento = ex.registro;
        const aberto = await emprestimoAbertoDoEquipamento(equipamento.id);

        if (!aberto) {
            const ev = publicar({
                uid: u, tipo: "retirada_sem_selecao", modo: "idle",
                mensagem: `Para retirar "${equipamento.nome}", escolha-o primeiro na tela e depois passe a tag.`,
                equipamento: resumoEquip(equipamento)
            });
            return res.status(409).json({ sucesso: false, ...ev });
        }

        /* Item emprestado: começa a devolução. */
        const f = await supabase.from("funcionarios").select("*").eq("id", aberto.funcionario_id).maybeSingle();
        if (f.error) throw f.error;

        fluxo = {
            modo: "aguardando_tag_pessoal",
            funcionario: f.data || null,
            equipamento,
            emprestimo: aberto,
            expiraEm: Date.now() + TEMPO_FLUXO_MS
        };

        const ev = publicar({
            uid: u, tipo: "devolucao_iniciada", modo: "aguardando_tag_pessoal",
            mensagem: `Devolvendo "${equipamento.nome}". Agora passe a sua tag pessoal para confirmar.`,
            funcionario: resumoFunc(f.data),
            equipamento: resumoEquip(equipamento)
        });
        return res.json({ sucesso: true, ...ev });
    } catch (e) {
        /* Mostra o erro real do banco na tela, para não ficar "silencioso". */
        publicar({ tipo: "erro_servidor", modo: fluxo.modo, mensagem: "Não foi possível gravar no banco: " + erroMsg(e) });
        erroResposta(res, e);
    }
});

/* Último evento (a página de cadastro lê o UID por aqui). */
app.get("/rfid/ultima", (req, res) => {
    expirar();
    res.set("Cache-Control", "no-store,no-cache,must-revalidate,proxy-revalidate");
    res.json(rfidEvent);
});

app.post("/rfid/limpar", (req, res) => res.json({ sucesso: true }));

app.post("/api/rfid/resetar", (req, res) => {
    limparFluxo();
    cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
    rfidEvent = { ...eventoOciosoBase, id: Date.now(), momento: Date.now() };
    res.json({ sucesso: true, mensagem: "Operação reiniciada." });
});

app.post("/api/rfid/cadastro/iniciar", (req, res) => {
    cadastroRFID = {
        ativo: true,
        tipo: req.body?.tipo === "equipamento" ? "equipamento" : "funcionario",
        expiraEm: Date.now() + 30000
    };
    res.json({ sucesso: true, mensagem: "Aguardando uma tag.", tipo: cadastroRFID.tipo });
});

/* RETIRADA, passo da tela: pessoa + item escolhidos. Falta confirmar com a tag do item. */
app.post("/api/rfid/selecionar", async (req, res) => {
    try {
        const fid = Number(req.body?.funcionario_id);
        const eid = Number(req.body?.equipamento_id);

        if (!Number.isInteger(fid) || !Number.isInteger(eid)) {
            return res.status(400).json({ sucesso: false, erro: "Escolha o funcionário e o equipamento." });
        }

        if (fluxo.modo !== "idle") {
            return res.status(409).json({ sucesso: false, tipo: "operacao_conflito", erro: "Já existe uma operação em andamento. Aguarde ou toque em Cancelar." });
        }

        const f = await supabase.from("funcionarios").select("*").eq("id", fid).eq("ativo", true).maybeSingle();
        if (f.error) throw f.error;
        if (!f.data) return res.status(404).json({ sucesso: false, erro: "Funcionário não encontrado." });

        const e = await supabase.from("equipamentos").select("*").eq("id", eid).eq("ativo", true).maybeSingle();
        if (e.error) throw e.error;
        if (!e.data) return res.status(404).json({ sucesso: false, erro: "Equipamento não encontrado." });

        if (status(e.data.status) !== "disponivel" || await emprestimoAbertoDoEquipamento(eid)) {
            return res.status(409).json({ sucesso: false, tipo: "equipamento_emprestado", erro: "Este equipamento não está disponível." });
        }

        if (await emprestimoAbertoDoFuncionario(fid)) {
            return res.status(409).json({
                sucesso: false, tipo: "funcionario_com_emprestimo",
                erro: `${f.data.nome} já está com um equipamento. Devolva antes de retirar outro (passe a tag do item no leitor).`
            });
        }

        fluxo = { modo: "aguardando_tag_item", funcionario: f.data, equipamento: e.data, emprestimo: null, expiraEm: Date.now() + TEMPO_FLUXO_MS };

        const ev = publicar({
            tipo: "equipamento_selecionado", modo: "aguardando_tag_item",
            mensagem: `Passe a tag de "${e.data.nome}" no leitor para confirmar.`,
            funcionario: resumoFunc(f.data),
            equipamento: resumoEquip(e.data)
        });

        res.json({ sucesso: true, ...ev });
    } catch (err) {
        erroResposta(res, err);
    }
});

/* ---------------- FUNCIONÁRIOS ---------------- */
app.get("/api/funcionarios", async (req, res) => {
    try {
        const r = await supabase.from("funcionarios").select("*").eq("ativo", true).order("nome", { ascending: true });
        if (r.error) throw r.error;
        res.json({ sucesso: true, funcionarios: r.data || [] });
    } catch (e) { erroResposta(res, e); }
});

app.get("/funcionarios", async (req, res) => {
    try {
        const r = await supabase.from("funcionarios").select("*").eq("ativo", true).order("id", { ascending: true });
        res.json(r.data || []);
    } catch (e) { erroResposta(res, e); }
});

app.post("/api/funcionarios", async (req, res) => {
    try {
        const nome = texto(req.body?.nome).trim();
        const matricula = texto(req.body?.matricula).trim();
        const u = uid(req.body?.uid_tag_pessoal ?? req.body?.uid_rfid);

        if (!nome || !matricula || !u) {
            return res.status(400).json({ sucesso: false, erro: "Nome, matrícula e UID são obrigatórios." });
        }

        if ((await verificarUID(u)).encontrado) {
            return res.status(409).json({ sucesso: false, erro: "Esta tag já está cadastrada." });
        }

        const r = await supabase.from("funcionarios")
            .insert([{ nome, matricula, setor: texto(req.body?.setor).trim() || null, uid_tag_pessoal: u }])
            .select().single();
        if (r.error) throw r.error;

        res.status(201).json({ sucesso: true, funcionario: r.data, mensagem: "Funcionário cadastrado." });
    } catch (e) { erroResposta(res, e, 400); }
});

/* "Excluir" = desativar (o histórico continua apontando para a pessoa). */
app.delete("/api/funcionarios/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (await emprestimoAbertoDoFuncionario(id)) {
            return res.status(409).json({ sucesso: false, erro: "Não é possível excluir: este funcionário está com um equipamento emprestado. Registre a devolução antes." });
        }

        const r = await supabase.from("funcionarios").update({ ativo: false }).eq("id", id).select().maybeSingle();
        if (r.error) throw r.error;
        if (!r.data) return res.status(404).json({ sucesso: false, erro: "Funcionário não encontrado." });

        res.json({ sucesso: true, mensagem: "Funcionário excluído. O histórico dele continua registrado." });
    } catch (e) { erroResposta(res, e, 400); }
});

/* ---------------- EQUIPAMENTOS ---------------- */
app.get("/api/equipamentos", async (req, res) => {
    try {
        res.json({ sucesso: true, equipamentos: await listarEquipamentos() });
    } catch (e) { erroResposta(res, e); }
});

app.get("/api/equipamentos/disponiveis", async (req, res) => {
    try {
        const todos = await listarEquipamentos();
        res.json({ sucesso: true, equipamentos: todos.filter(x => status(x.status) === "disponivel") });
    } catch (e) { erroResposta(res, e); }
});

app.get("/equipamentos", async (req, res) => {
    try { res.json(await listarEquipamentos()); } catch (e) { erroResposta(res, e); }
});

app.get("/api/equipamentos/:id", async (req, res) => {
    try {
        const r = await supabase.from("equipamentos").select("*").eq("id", req.params.id).maybeSingle();
        if (r.error) throw r.error;
        if (!r.data) return res.status(404).json({ sucesso: false, erro: "Equipamento não encontrado." });
        res.json({ sucesso: true, equipamento: r.data });
    } catch (e) { erroResposta(res, e); }
});

app.post("/api/equipamentos", async (req, res) => {
    try {
        const nome = texto(req.body?.nome).trim();
        const u = uid(req.body?.uid_rfid ?? req.body?.uid_tag);

        if (!nome || !u) {
            return res.status(400).json({ sucesso: false, erro: "Nome e UID são obrigatórios." });
        }

        if ((await verificarUID(u)).encontrado) {
            return res.status(409).json({ sucesso: false, erro: "Esta tag já está cadastrada." });
        }

        const r = await supabase.from("equipamentos")
            .insert([{ nome, descricao: texto(req.body?.descricao).trim() || null, uid_tag: u, status: "disponivel" }])
            .select().single();
        if (r.error) throw r.error;

        res.status(201).json({ sucesso: true, equipamento: r.data, mensagem: "Equipamento cadastrado." });
    } catch (e) { erroResposta(res, e, 400); }
});

app.put("/api/equipamentos/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        const dados = {};

        if (req.body.nome !== undefined) dados.nome = texto(req.body.nome).trim();
        if (req.body.descricao !== undefined) dados.descricao = req.body.descricao;
        if (req.body.uid_rfid !== undefined || req.body.uid_tag !== undefined) dados.uid_tag = uid(req.body.uid_rfid ?? req.body.uid_tag);

        const r = await supabase.from("equipamentos").update(dados).eq("id", id).select().single();
        if (r.error) throw r.error;

        res.json({ sucesso: true, equipamento: r.data, mensagem: "Equipamento atualizado." });
    } catch (e) { erroResposta(res, e, 400); }
});

app.delete("/api/equipamentos/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (await emprestimoAbertoDoEquipamento(id)) {
            return res.status(409).json({ sucesso: false, erro: "Não é possível excluir: este equipamento está emprestado agora. Registre a devolução antes." });
        }

        const r = await supabase.from("equipamentos").update({ ativo: false }).eq("id", id).select().maybeSingle();
        if (r.error) throw r.error;
        if (!r.data) return res.status(404).json({ sucesso: false, erro: "Equipamento não encontrado." });

        res.json({ sucesso: true, mensagem: "Equipamento excluído. O histórico dele continua registrado." });
    } catch (e) { erroResposta(res, e, 400); }
});

/* ---------------- EMPRÉSTIMOS ---------------- */
app.get("/api/emprestimos", async (req, res) => {
    try {
        const r = await supabase.from("emprestimos").select("*").order("id", { ascending: false });
        if (r.error) throw r.error;
        res.json({ sucesso: true, emprestimos: await enriquecer(r.data || []) });
    } catch (e) { erroResposta(res, e); }
});

app.get("/emprestimos", async (req, res) => {
    try {
        const r = await supabase.from("emprestimos").select("*").order("id", { ascending: false });
        if (r.error) throw r.error;
        const rows = await enriquecer(r.data || []);
        res.json(rows.map(x => ({
            ...x,
            funcionario: x.funcionario?.nome || "-",
            matricula: x.funcionario?.matricula || "-",
            equipamento: x.equipamento?.nome || "-"
        })));
    } catch (e) { erroResposta(res, e); }
});

app.get("/api/ultimos-emprestimos", async (req, res) => {
    try {
        const r = await supabase.from("emprestimos").select("*").order("id", { ascending: false }).limit(10);
        if (r.error) throw r.error;
        res.json({ sucesso: true, emprestimos: await enriquecer(r.data || []) });
    } catch (e) { erroResposta(res, e); }
});

/* Devolução manual pelo painel (caso alguém esqueça de devolver pelo leitor). */
app.put("/api/emprestimos/:id/devolver", async (req, res) => {
    try {
        const id = Number(req.params.id);

        const d = await supabase.from("emprestimos")
            .update({ data_devolucao: agora(), status: "Devolvido" })
            .eq("id", id).is("data_devolucao", null)
            .select().maybeSingle();
        if (d.error) throw d.error;
        if (!d.data) return res.status(404).json({ sucesso: false, erro: "Empréstimo em aberto não encontrado." });

        const u = await supabase.from("equipamentos").update({ status: "disponivel" }).eq("id", d.data.equipamento_id);
        if (u.error) throw u.error;

        res.json({ sucesso: true, mensagem: "Equipamento devolvido.", emprestimo: d.data });
    } catch (e) { erroResposta(res, e, 400); }
});

/* Só apaga movimentações já devolvidas. */
app.delete("/api/emprestimos/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);

        const atual = await supabase.from("emprestimos").select("*").eq("id", id).maybeSingle();
        if (atual.error) throw atual.error;
        if (!atual.data) return res.status(404).json({ sucesso: false, erro: "Movimentação não encontrada." });

        if (!atual.data.data_devolucao) {
            return res.status(409).json({ sucesso: false, erro: "Só é possível apagar movimentações já devolvidas. Esta ainda está em andamento." });
        }

        const r = await supabase.from("emprestimos").delete().eq("id", id);
        if (r.error) throw r.error;

        res.json({ sucesso: true, mensagem: "Movimentação apagada do histórico." });
    } catch (e) { erroResposta(res, e, 400); }
});

/* ---------------- DASHBOARD ---------------- */
app.get("/api/dashboard", async (req, res) => {
    try {
        const [f, e, abertos] = await Promise.all([
            supabase.from("funcionarios").select("id", { count: "exact", head: true }).eq("ativo", true),
            supabase.from("equipamentos").select("id,status").eq("ativo", true),
            supabase.from("emprestimos").select("id").is("data_devolucao", null)
        ]);

        if (f.error) throw f.error;
        if (e.error) throw e.error;
        if (abertos.error) throw abertos.error;

        const eq = e.data || [];
        const n = (abertos.data || []).length;

        res.json({
            sucesso: true,
            funcionarios: f.count || 0,
            equipamentos: eq.length,
            disponiveis: eq.filter(x => status(x.status) === "disponivel").length,
            emprestimos: n,
            emprestados: n
        });
    } catch (e) { erroResposta(res, e); }
});

/* ---------------- 404 / erro ---------------- */
app.use((req, res) => res.status(404).json({ sucesso: false, erro: "Rota não encontrada.", rota: req.originalUrl }));

app.use((err, req, res, next) => {
    console.error("ERRO GERAL:", err);
    res.status(500).json({ sucesso: false, erro: "Erro interno do servidor." });
});

/* Sobe primeiro; nada de mexer no banco antes de abrir a porta. */
const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`INVENTÁRIO RFID - NUVEM | porta ${PORT} | aguardando ESP32...`);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

process.on("unhandledRejection", e => console.error("unhandledRejection:", e));
process.on("uncaughtException", e => console.error("uncaughtException:", e));
