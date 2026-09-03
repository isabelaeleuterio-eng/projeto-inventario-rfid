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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));
app.use(express.text({ type: "text/plain", limit: "100kb" }));
app.use(express.static(SITE_DIR, { maxAge: 0 }));

let esp32 = { conectado: false, ultimoContato: null, ip: null };

let rfidEvent = {
    nova: false, id: 0, uid: null, tipo: "idle", modo: "idle",
    mensagem: "Passe a tag do funcionário.", funcionario: null,
    equipamento: null, equipamentos: [], equipamentoRecebido: null,
    equipamentoEsperado: null, box: null, momento: 0
};

/*
 * Estado rápido da tela.
 * A seleção de retirada também é gravada no Supabase como "Pendente RFID".
 * Assim, se o Render reiniciar entre a seleção e a leitura do objeto,
 * o ESP32 continua conseguindo concluir a operação.
 */
let fluxo = {
    modo: "idle",
    funcionario: null,
    acao: null,
    equipamentoSelecionado: null,
    expiraEm: 0
};

let cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
let ultimaLeitura = { uid: null, momento: 0 };

const agora = () => new Date().toISOString();
const texto = (v, fallback = "") => v == null ? fallback : String(v);
const uid = (v) => texto(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
const status = (v) => texto(v).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const erroMsg = e => e?.message || String(e);

function erroResposta(res, erro, codigo = 500) {
    console.error("ERRO:", erro);
    return res.status(codigo).json({
        sucesso: false,
        erro: erroMsg(erro),
        mensagem: erroMsg(erro)
    });
}

function publicar(d) {
    rfidEvent = {
        nova: true,
        id: Date.now(),
        uid: d.uid || null,
        tipo: d.tipo || "idle",
        modo: d.modo || "idle",
        mensagem: d.mensagem || "",
        funcionario: d.funcionario || null,
        equipamento: d.equipamento || null,
        equipamentos: d.equipamentos || [],
        equipamentoRecebido: d.equipamentoRecebido || null,
        equipamentoEsperado: d.equipamentoEsperado || null,
        box: d.box ?? null,
        momento: Date.now()
    };
    return rfidEvent;
}

function limparFluxo() {
    fluxo = {
        modo: "idle",
        funcionario: null,
        acao: null,
        equipamentoSelecionado: null,
        expiraEm: 0
    };
}

function expirar() {
    if (fluxo.expiraEm && Date.now() > fluxo.expiraEm) {
        limparFluxo();
    }
    if (cadastroRFID.expiraEm && Date.now() > cadastroRFID.expiraEm) {
        cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };
    }
}

async function buscarFuncionarioPorUID(u) {
    const r = await supabase.from("funcionarios").select("*").eq("uid_tag_pessoal", u).maybeSingle();
    if (r.error) throw r.error;
    return r.data || null;
}

async function buscarEquipamentoPorUID(u) {
    const r = await supabase.from("equipamentos").select("*").eq("uid_tag", u).maybeSingle();
    if (r.error) throw r.error;
    return r.data || null;
}

/* Empréstimo ATIVO: nunca considera uma seleção "Pendente RFID". */
async function ativosFuncionario(id) {
    const r = await supabase
        .from("emprestimos")
        .select("*")
        .eq("funcionario_id", id)
        .is("data_devolucao", null)
        .order("id", { ascending: false });

    if (r.error) throw r.error;

    return (r.data || []).filter(x => status(x.status) !== "pendente rfid");
}

async function ativoEquipamento(id) {
    const r = await supabase
        .from("emprestimos")
        .select("*")
        .eq("equipamento_id", id)
        .is("data_devolucao", null)
        .order("id", { ascending: false })
        .limit(20);

    if (r.error) throw r.error;

    return (r.data || []).find(x => status(x.status) !== "pendente rfid") || null;
}

async function equipamentos() {
    const r = await supabase.from("equipamentos").select("*").order("id", { ascending: true });
    if (r.error) throw r.error;
    return r.data || [];
}

async function disponiveis() {
    const all = await equipamentos();
    return all.filter(e => status(e.status) === "disponivel");
}

async function boxOcupada(box, ignorar = null) {
    if (box == null || box === "") return false;

    const r = await supabase.from("equipamentos").select("id").eq("box_id", Number(box));
    if (r.error) throw r.error;

    return (r.data || []).some(x => Number(x.id) !== Number(ignorar));
}

async function enriquecer(rows) {
    const fids = [...new Set(rows.map(x => x.funcionario_id).filter(Boolean))];
    const eids = [...new Set(rows.map(x => x.equipamento_id).filter(Boolean))];

    const fm = {};
    const em = {};

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

    return rows.map(x => ({
        ...x,
        funcionario: fm[x.funcionario_id] || null,
        equipamento: em[x.equipamento_id] || null
    }));
}

async function verificarUID(u) {
    const f = await buscarFuncionarioPorUID(u);
    if (f) return { encontrado: true, categoria: "funcionario", registro: f };

    const e = await buscarEquipamentoPorUID(u);
    if (e) return { encontrado: true, categoria: "equipamento", registro: e };

    return { encontrado: false };
}

/*
 * Recupera uma retirada que ficou aguardando a segunda leitura.
 * Só existe uma estação RFID neste projeto, portanto uma única pendência
 * é suficiente. A pendência expira após 2 minutos.
 */
async function recuperarPendenciaRFID() {
    const r = await supabase
        .from("emprestimos")
        .select("*")
        .eq("status", "Pendente RFID")
        .is("data_devolucao", null)
        .order("id", { ascending: false })
        .limit(1);

    if (r.error) throw r.error;

    const pendente = r.data?.[0];
    if (!pendente) return null;

    const criado = pendente.data_retirada ? Date.parse(pendente.data_retirada) : 0;

    if (criado && Date.now() - criado > 120000) {
        await supabase.from("emprestimos").delete().eq("id", pendente.id);
        return null;
    }

    const f = await supabase.from("funcionarios").select("*").eq("id", pendente.funcionario_id).maybeSingle();
    if (f.error) throw f.error;

    const e = await supabase.from("equipamentos").select("*").eq("id", pendente.equipamento_id).maybeSingle();
    if (e.error) throw e.error;

    if (!f.data || !e.data) return null;

    fluxo = {
        modo: "aguardando_tag_retirada",
        funcionario: {
            id: f.data.id,
            nome: f.data.nome,
            matricula: f.data.matricula,
            uid_tag_pessoal: f.data.uid_tag_pessoal
        },
        acao: "retirada",
        equipamentoSelecionado: e.data,
        expiraEm: Date.now() + 120000
    };

    return pendente;
}

async function apagarPendenciasAntigas() {
    const r = await supabase
        .from("emprestimos")
        .select("id,data_retirada")
        .eq("status", "Pendente RFID")
        .is("data_devolucao", null);

    if (r.error) return;

    const agoraMs = Date.now();

    for (const p of r.data || []) {
        const t = p.data_retirada ? Date.parse(p.data_retirada) : 0;
        if (t && agoraMs - t > 120000) {
            await supabase.from("emprestimos").delete().eq("id", p.id);
        }
    }
}

/* Corrige automaticamente Box duplicada no cadastro. */
async function corrigirBoxesDuplicadas() {
    try {
        const r = await supabase.from("equipamentos").select("id,nome,box_id").order("id", { ascending: true });
        if (r.error) throw r.error;

        const usados = new Set();
        let proxima = 1;

        for (const e of r.data || []) {
            let b = Number(e.box_id);

            if (!Number.isInteger(b) || b < 1 || usados.has(b)) {
                while (usados.has(proxima)) proxima++;

                b = proxima;

                await supabase
                    .from("equipamentos")
                    .update({ box_id: b })
                    .eq("id", e.id);

                console.log(`Box ajustada: ${e.nome || e.id} -> Box ${b}`);
            }

            usados.add(b);
            proxima = Math.max(proxima, b + 1);
        }
    } catch (e) {
        console.error("Aviso ao verificar boxes:", e.message);
    }
}

/* PÁGINAS */
app.get("/", (req, res) => res.sendFile(path.join(SITE_DIR, "index.html")));
app.get("/cadastro", (req, res) => res.sendFile(path.join(SITE_DIR, "cadastro.html")));
app.get("/controle", (req, res) => res.sendFile(path.join(SITE_DIR, "controle.html")));

/* SAÚDE */
app.get("/health", (req, res) => res.json({
    sucesso: true,
    servidor: "online",
    banco: "Supabase",
    horario: agora()
}));

app.get("/teste", (req, res) => res.json({
    sucesso: true,
    mensagem: "Servidor RFID funcionando!",
    banco: "Supabase",
    esp32,
    horario: agora()
}));

app.get("/api/status", async (req, res) => {
    try {
        expirar();
        await recuperarPendenciaRFID();

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
    } catch (e) {
        erroResposta(res, e);
    }
});

/* ESP32 */
app.get("/api/esp32/status", (req, res) => {
    const t = esp32.ultimoContato ? Date.parse(esp32.ultimoContato) : 0;

    res.json({
        sucesso: true,
        conectado: !!t && Date.now() - t < 30000,
        ultimoContato: esp32.ultimoContato,
        ip: esp32.ip
    });
});

app.post("/api/esp32/online", (req, res) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};

    esp32 = {
        conectado: true,
        ultimoContato: agora(),
        ip: texto(b.ip).trim() || null
    };

    res.json({
        sucesso: true,
        mensagem: "ESP32 conectado ao servidor",
        horario: esp32.ultimoContato
    });
});

/*
 * ÚNICO ponto de entrada das tags.
 * Aceita uid, UID, uid_tag, tag e outros nomes usados pelos sketches.
 */
app.post("/api/esp32/rfid", async (req, res) => {
    try {
        const b = req.body && typeof req.body === "object"
            ? req.body
            : { uid: req.body };

        const u = uid(
            b.uid ??
            b.UID ??
            b.uid_tag ??
            b.tag ??
            b.rfid ??
            b["UID da tag"]
        );

        if (!u) {
            return res.status(400).json({
                sucesso: false,
                erro: "UID não informado."
            });
        }

        esp32.conectado = true;
        esp32.ultimoContato = agora();

        console.log(`RFID ${u} | leitor=${texto(b.leitor ?? b.reader, "entrada")}`);

        expirar();
        await apagarPendenciasAntigas();

        /* Evita duplicação do mesmo cartão mantido sobre o leitor. */
        if (ultimaLeitura.uid === u && Date.now() - ultimaLeitura.momento < 1200) {
            return res.json({
                sucesso: true,
                repetida: true,
                uid: u,
                mensagem: "Leitura repetida ignorada."
            });
        }

        ultimaLeitura = { uid: u, momento: Date.now() };

        /* CADASTRO */
        if (cadastroRFID.ativo && Date.now() < cadastroRFID.expiraEm) {
            const ex = await verificarUID(u);

            if (ex.encontrado) {
                cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };

                const ev = publicar({
                    uid: u,
                    tipo: "tag_ja_cadastrada",
                    modo: "cadastro",
                    mensagem: `Esta tag já está cadastrada como ${ex.categoria}: ${ex.registro.nome}.`
                });

                return res.status(409).json({ sucesso: false, ...ev });
            }

            cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };

            const ev = publicar({
                uid: u,
                tipo: "cadastro_tag",
                modo: "cadastro",
                mensagem: "Tag lida com sucesso. UID preenchido."
            });

            return res.json({ sucesso: true, ...ev });
        }

        /*
         * Se o processo reiniciou depois da seleção, recupera a pendência
         * diretamente do Supabase antes de tentar interpretar a tag.
         */
        if (fluxo.modo === "idle") {
            await recuperarPendenciaRFID();
        }

        /* SEGUNDA TAG DA RETIRADA */
        if (fluxo.modo === "aguardando_tag_retirada") {
            const esperado = fluxo.equipamentoSelecionado;
            const funcionario = fluxo.funcionario;

            if (!esperado || !funcionario?.id) {
                limparFluxo();

                const ev = publicar({
                    uid: u,
                    tipo: "fluxo_expirado",
                    mensagem: "A operação expirou. Passe novamente a tag do funcionário."
                });

                return res.status(409).json({ sucesso: false, ...ev });
            }

            const equipamento = await buscarEquipamentoPorUID(u);

            if (!equipamento) {
                const ev = publicar({
                    uid: u,
                    tipo: "tag_nao_cadastrada",
                    modo: fluxo.modo,
                    mensagem: "Esta tag não está cadastrada como equipamento. Passe a tag correta."
                });

                return res.status(404).json({ sucesso: false, ...ev });
            }

            if (Number(equipamento.id) !== Number(esperado.id)) {
                const ev = publicar({
                    uid: u,
                    tipo: "objeto_incorreto",
                    modo: fluxo.modo,
                    mensagem: `Tag incorreta. Você selecionou "${esperado.nome}". Passe a tag desse equipamento.`,
                    funcionario,
                    equipamento: esperado,
                    equipamentoRecebido: equipamento,
                    equipamentoEsperado: esperado
                });

                return res.status(409).json({ sucesso: false, ...ev });
            }

            const atual = await supabase
                .from("equipamentos")
                .select("*")
                .eq("id", equipamento.id)
                .maybeSingle();

            if (atual.error) throw atual.error;

            if (!atual.data || status(atual.data.status) !== "disponivel") {
                const ev = publicar({
                    uid: u,
                    tipo: "equipamento_emprestado",
                    mensagem: "Esse equipamento não está mais disponível."
                });

                limparFluxo();
                return res.status(409).json({ sucesso: false, ...ev });
            }

            /* Uma Box só pode conter um objeto. */
            if (await boxOcupada(atual.data.box_id, atual.data.id)) {
                const ev = publicar({
                    uid: u,
                    tipo: "box_ocupada",
                    mensagem: `A Box ${atual.data.box_id} já possui outro objeto. Uma Box comporta apenas um objeto.`
                });

                limparFluxo();
                return res.status(409).json({ sucesso: false, ...ev });
            }

            /* Nunca permite que o funcionário tenha dois objetos. */
            const ativos = await ativosFuncionario(funcionario.id);

            if (ativos.length) {
                const outro = await supabase
                    .from("equipamentos")
                    .select("*")
                    .eq("id", ativos[0].equipamento_id)
                    .maybeSingle();

                if (outro.error) throw outro.error;

                const ev = publicar({
                    uid: u,
                    tipo: "funcionario_com_emprestimo",
                    mensagem: `Você precisa devolver "${outro.data?.nome || "o equipamento"}" antes de pegar outro objeto.`,
                    funcionario,
                    equipamento: outro.data
                });

                limparFluxo();
                return res.status(409).json({ sucesso: false, ...ev });
            }

            /*
             * Procura a pendência criada na seleção. Se existir, transforma
             * a mesma linha em empréstimo ativo. Isso evita duplicidade.
             */
            const pend = await supabase
                .from("emprestimos")
                .select("*")
                .eq("status", "Pendente RFID")
                .eq("funcionario_id", funcionario.id)
                .eq("equipamento_id", atual.data.id)
                .is("data_devolucao", null)
                .order("id", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (pend.error) throw pend.error;

            let resultadoEmprestimo;

            if (pend.data) {
                const upd = await supabase
                    .from("emprestimos")
                    .update({
                        status: "Ativo",
                        data_retirada: agora()
                    })
                    .eq("id", pend.data.id)
                    .eq("status", "Pendente RFID")
                    .select("*")
                    .maybeSingle();

                if (upd.error) throw upd.error;
                resultadoEmprestimo = upd.data;
            } else {
                const ins = await supabase
                    .from("emprestimos")
                    .insert([{
                        funcionario_id: Number(funcionario.id),
                        equipamento_id: Number(atual.data.id),
                        box: Number(atual.data.box_id),
                        status: "Ativo",
                        data_retirada: agora()
                    }])
                    .select()
                    .maybeSingle();

                if (ins.error) throw ins.error;
                resultadoEmprestimo = ins.data;
            }

            const up = await supabase
                .from("equipamentos")
                .update({ status: "emprestado" })
                .eq("id", atual.data.id)
                .eq("status", "disponivel")
                .select("*")
                .maybeSingle();

            if (up.error) throw up.error;

            if (!up.data) {
                if (resultadoEmprestimo?.id) {
                    await supabase
                        .from("emprestimos")
                        .delete()
                        .eq("id", resultadoEmprestimo.id);
                }

                const ev = publicar({
                    uid: u,
                    tipo: "equipamento_emprestado",
                    mensagem: "O equipamento deixou de estar disponível. Tente novamente."
                });

                limparFluxo();
                return res.status(409).json({ sucesso: false, ...ev });
            }

            const ev = publicar({
                uid: u,
                tipo: "retirada_concluida",
                modo: "idle",
                mensagem: `${atual.data.nome} está EMPRESTADO para ${funcionario.nome}.`,
                funcionario,
                equipamento: atual.data,
                box: atual.data.box_id
            });

            limparFluxo();

            return res.status(201).json({
                sucesso: true,
                ...ev,
                emprestimo: resultadoEmprestimo
            });
        }

        /* SEGUNDA TAG DA DEVOLUÇÃO */
        if (fluxo.modo === "aguardando_devolucao") {
            const esperado = fluxo.equipamentoSelecionado;
            const funcionario = fluxo.funcionario;

            if (!esperado || !funcionario?.id) {
                limparFluxo();

                const ev = publicar({
                    uid: u,
                    tipo: "fluxo_expirado",
                    mensagem: "A operação expirou. Passe novamente a tag do funcionário."
                });

                return res.status(409).json({ sucesso: false, ...ev });
            }

            const equipamento = await buscarEquipamentoPorUID(u);

            if (!equipamento) {
                const ev = publicar({
                    uid: u,
                    tipo: "tag_nao_cadastrada",
                    mensagem: "Esta tag não está cadastrada como equipamento."
                });

                return res.status(404).json({ sucesso: false, ...ev });
            }

            if (Number(equipamento.id) !== Number(esperado.id)) {
                const ev = publicar({
                    uid: u,
                    tipo: "objeto_incorreto",
                    mensagem: `Tag incorreta. Passe a tag de "${esperado.nome}".`,
                    funcionario,
                    equipamento: esperado,
                    equipamentoRecebido: equipamento,
                    equipamentoEsperado: esperado
                });

                return res.status(409).json({ sucesso: false, ...ev });
            }

            const ativos = await ativosFuncionario(funcionario.id);
            const ativo = ativos.find(x => Number(x.equipamento_id) === Number(equipamento.id));

            if (!ativo) {
                const ev = publicar({
                    uid: u,
                    tipo: "sem_emprestimo",
                    mensagem: "Esse equipamento não está emprestado para este funcionário."
                });

                limparFluxo();
                return res.status(409).json({ sucesso: false, ...ev });
            }

            const d = await supabase
                .from("emprestimos")
                .update({
                    data_devolucao: agora(),
                    status: "Devolvido"
                })
                .eq("id", ativo.id)
                .eq("status", "Ativo")
                .is("data_devolucao", null)
                .select()
                .maybeSingle();

            if (d.error) throw d.error;

            if (!d.data) {
                const ev = publicar({
                    uid: u,
                    tipo: "operacao_conflito",
                    mensagem: "A devolução já foi registrada."
                });

                limparFluxo();
                return res.status(409).json({ sucesso: false, ...ev });
            }

            const up = await supabase
                .from("equipamentos")
                .update({ status: "disponivel" })
                .eq("id", equipamento.id);

            if (up.error) throw up.error;

            const ev = publicar({
                uid: u,
                tipo: "devolucao_concluida",
                modo: "idle",
                mensagem: `${equipamento.nome} foi DEVOLVIDO e está disponível.`,
                funcionario,
                equipamento,
                box: equipamento.box_id
            });

            limparFluxo();

            return res.json({
                sucesso: true,
                ...ev,
                emprestimo: d.data
            });
        }

        /* TAG DO FUNCIONÁRIO */
        const funcionarioEncontrado = await buscarFuncionarioPorUID(u);

        if (funcionarioEncontrado) {
            const ativos = await ativosFuncionario(funcionarioEncontrado.id);

            const funcionario = {
                id: funcionarioEncontrado.id,
                nome: funcionarioEncontrado.nome,
                matricula: funcionarioEncontrado.matricula,
                uid_tag_pessoal: funcionarioEncontrado.uid_tag_pessoal
            };

            /*
             * Regra pedida: se já tem um objeto, a próxima passagem
             * do funcionário não permite pegar outro; obriga devolução.
             */
            if (ativos.length) {
                const eq = await supabase
                    .from("equipamentos")
                    .select("*")
                    .eq("id", ativos[0].equipamento_id)
                    .maybeSingle();

                if (eq.error) throw eq.error;

                fluxo = {
                    modo: "aguardando_devolucao",
                    funcionario,
                    acao: "devolucao",
                    equipamentoSelecionado: eq.data || null,
                    expiraEm: Date.now() + 120000
                };

                const ev = publicar({
                    uid: u,
                    tipo: "funcionario_com_emprestimo",
                    modo: "aguardando_devolucao",
                    mensagem: `Você já está com ${eq.data?.nome || "um equipamento"}. Passe a tag desse objeto para devolver antes de retirar outro.`,
                    funcionario,
                    equipamento: eq.data || null
                });

                return res.json({ sucesso: true, ...ev });
            }

            const lista = await disponiveis();

            fluxo = {
                modo: "aguardando_selecao",
                funcionario,
                acao: null,
                equipamentoSelecionado: null,
                expiraEm: Date.now() + 120000
            };

            const ev = publicar({
                uid: u,
                tipo: "funcionario_identificado",
                modo: "aguardando_selecao",
                mensagem: lista.length
                    ? "Funcionário identificado. Selecione o equipamento que deseja retirar."
                    : "Funcionário identificado, mas não há equipamentos disponíveis.",
                funcionario,
                equipamentos: lista
            });

            return res.json({
                sucesso: true,
                ...ev,
                equipamentos: lista
            });
        }

        /* TAG DE EQUIPAMENTO SEM FUNCIONÁRIO */
        const equipamento = await buscarEquipamentoPorUID(u);

        if (equipamento) {
            const ev = publicar({
                uid: u,
                tipo: "equipamento_sem_funcionario",
                mensagem: "Passe primeiro a tag do funcionário e selecione o equipamento."
            });

            return res.status(409).json({
                sucesso: false,
                ...ev
            });
        }

        const ev = publicar({
            uid: u,
            tipo: "tag_nao_cadastrada",
            mensagem: "TAG NÃO CADASTRADA. Cadastre a tag antes de utilizar."
        });

        return res.status(404).json({
            sucesso: false,
            ...ev
        });

    } catch (e) {
        return erroResposta(res, e);
    }
});

app.get("/rfid/ultima", async (req, res) => {
    try {
        expirar();
        await recuperarPendenciaRFID();

        res.set("Cache-Control", "no-store,no-cache,must-revalidate,proxy-revalidate");
        res.json(rfidEvent);
    } catch (e) {
        erroResposta(res, e);
    }
});

/*
 * NÃO apaga mais o evento globalmente.
 * A tela controla o que já viu pelo id. Isso evita que Dashboard,
 * Cadastro ou outra aba "roube" a leitura antes da página de Controle.
 */
app.post("/rfid/limpar", (req, res) => {
    res.json({ sucesso: true });
});

app.post("/api/rfid/resetar", async (req, res) => {
    try {
        const p = await supabase
            .from("emprestimos")
            .select("id")
            .eq("status", "Pendente RFID")
            .is("data_devolucao", null);

        if (!p.error) {
            for (const x of p.data || []) {
                await supabase.from("emprestimos").delete().eq("id", x.id);
            }
        }

        limparFluxo();

        cadastroRFID = { ativo: false, tipo: null, expiraEm: 0 };

        rfidEvent = {
            nova: false,
            id: Date.now(),
            uid: null,
            tipo: "idle",
            modo: "idle",
            mensagem: "Passe a tag do funcionário.",
            funcionario: null,
            equipamento: null,
            equipamentos: [],
            equipamentoRecebido: null,
            equipamentoEsperado: null,
            box: null,
            momento: Date.now()
        };

        res.json({
            sucesso: true,
            mensagem: "Operação reiniciada."
        });
    } catch (e) {
        erroResposta(res, e);
    }
});

app.post("/api/rfid/cadastro/iniciar", (req, res) => {
    cadastroRFID = {
        ativo: true,
        tipo: req.body?.tipo === "equipamento" ? "equipamento" : "funcionario",
        expiraEm: Date.now() + 30000
    };

    res.json({
        sucesso: true,
        mensagem: "Aguardando uma tag.",
        tipo: cadastroRFID.tipo
    });
});

/*
 * Seleção:
 * - retirada: cria uma linha Pendente RFID no banco;
 * - devolução: apenas arma o fluxo, pois o empréstimo já existe.
 */
app.post("/api/rfid/selecionar", async (req, res) => {
    try {
        expirar();

        const funcionarioId = Number(req.body?.funcionario_id);
        const equipamentoId = Number(req.body?.equipamento_id);
        const acao = req.body?.acao === "devolucao" ? "devolucao" : "retirada";

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

        if (!fluxo.funcionario || Number(fluxo.funcionario.id) !== funcionarioId) {
            await recuperarPendenciaRFID();

            if (!fluxo.funcionario || Number(fluxo.funcionario.id) !== funcionarioId) {
                return res.status(409).json({
                    sucesso: false,
                    erro: "A identificação do funcionário expirou. Passe a tag novamente."
                });
            }
        }

        const e = await supabase
            .from("equipamentos")
            .select("*")
            .eq("id", equipamentoId)
            .maybeSingle();

        if (e.error) throw e.error;
        if (!e.data) return res.status(404).json({
            sucesso: false,
            erro: "Equipamento não encontrado."
        });

        const ativos = await ativosFuncionario(funcionarioId);
        const possuiEste = ativos.some(x => Number(x.equipamento_id) === equipamentoId);

        if (acao === "retirada") {
            if (ativos.length) {
                const outro = await supabase
                    .from("equipamentos")
                    .select("*")
                    .eq("id", ativos[0].equipamento_id)
                    .maybeSingle();

                const nomeOutro = outro.data?.nome || "o equipamento";

                return res.status(409).json({
                    sucesso: false,
                    tipo: "funcionario_com_emprestimo",
                    erro: `Você precisa devolver "${nomeOutro}" antes de pegar outro objeto.`
                });
            }

            if (status(e.data.status) !== "disponivel") {
                return res.status(409).json({
                    sucesso: false,
                    tipo: "equipamento_emprestado",
                    erro: "Esse equipamento não está disponível."
                });
            }

            if (await boxOcupada(e.data.box_id, e.data.id)) {
                return res.status(409).json({
                    sucesso: false,
                    tipo: "box_ocupada",
                    erro: `A Box ${e.data.box_id} já possui outro objeto. Uma Box comporta apenas um objeto.`
                });
            }

            /* Só uma pendência de retirada por vez. */
            const antigas = await supabase
                .from("emprestimos")
                .select("id")
                .eq("status", "Pendente RFID")
                .is("data_devolucao", null);

            if (antigas.error) throw antigas.error;

            for (const p of antigas.data || []) {
                await supabase.from("emprestimos").delete().eq("id", p.id);
            }

            const pendente = await supabase
                .from("emprestimos")
                .insert([{
                    funcionario_id: funcionarioId,
                    equipamento_id: equipamentoId,
                    box: Number(e.data.box_id),
                    status: "Pendente RFID",
                    data_retirada: agora()
                }])
                .select("*")
                .maybeSingle();

            if (pendente.error) throw pendente.error;
        } else {
            if (!possuiEste) {
                return res.status(409).json({
                    sucesso: false,
                    erro: "Esse equipamento não está emprestado para este funcionário."
                });
            }
        }

        fluxo = {
            modo: acao === "devolucao"
                ? "aguardando_devolucao"
                : "aguardando_tag_retirada",
            funcionario: fluxo.funcionario,
            acao,
            equipamentoSelecionado: e.data,
            expiraEm: Date.now() + 120000
        };

        const ev = publicar({
            uid: fluxo.funcionario.uid_tag_pessoal,
            tipo: "equipamento_selecionado",
            modo: fluxo.modo,
            mensagem: `Agora passe a tag física de "${e.data.nome}".`,
            funcionario: fluxo.funcionario,
            equipamento: e.data,
            box: e.data.box_id
        });

        return res.json({
            sucesso: true,
            ...ev
        });

    } catch (e) {
        return erroResposta(res, e, 400);
    }
});

/* FUNCIONÁRIOS */
app.get("/api/funcionarios", async (req, res) => {
    try {
        const r = await supabase.from("funcionarios").select("*").order("id", { ascending: true });
        if (r.error) throw r.error;

        res.json({
            sucesso: true,
            funcionarios: r.data || []
        });
    } catch (e) {
        erroResposta(res, e);
    }
});

app.get("/funcionarios", async (req, res) => {
    try {
        const r = await supabase.from("funcionarios").select("*").order("id", { ascending: true });
        res.json(r.data || []);
    } catch (e) {
        erroResposta(res, e);
    }
});

app.post("/api/funcionarios", async (req, res) => {
    try {
        const nome = texto(req.body?.nome).trim();
        const matricula = texto(req.body?.matricula).trim();
        const u = uid(req.body?.uid_tag_pessoal ?? req.body?.uid_rfid);

        if (!nome || !matricula || !u) {
            return res.status(400).json({
                sucesso: false,
                erro: "Nome, matrícula e UID são obrigatórios."
            });
        }

        const ex = await verificarUID(u);

        if (ex.encontrado) {
            return res.status(409).json({
                sucesso: false,
                erro: "Esta tag já está cadastrada."
            });
        }

        const r = await supabase
            .from("funcionarios")
            .insert([{
                nome,
                matricula,
                setor: texto(req.body?.setor).trim() || null,
                uid_tag_pessoal: u
            }])
            .select()
            .single();

        if (r.error) throw r.error;

        res.status(201).json({
            sucesso: true,
            funcionario: r.data,
            mensagem: "Funcionário cadastrado."
        });
    } catch (e) {
        erroResposta(res, e, 400);
    }
});

app.delete("/api/funcionarios/:id", async (req, res) => {
    try {
        const a = await ativosFuncionario(Number(req.params.id));

        if (a.length) {
            return res.status(409).json({
                sucesso: false,
                erro: "Não é possível excluir um funcionário com equipamento emprestado."
            });
        }

        const r = await supabase.from("funcionarios").delete().eq("id", req.params.id);
        if (r.error) throw r.error;

        res.json({
            sucesso: true,
            mensagem: "Funcionário excluído."
        });
    } catch (e) {
        erroResposta(res, e, 400);
    }
});

/* EQUIPAMENTOS */
app.get("/api/equipamentos", async (req, res) => {
    try {
        const r = await supabase.from("equipamentos").select("*").order("id", { ascending: true });
        if (r.error) throw r.error;

        res.json({
            sucesso: true,
            equipamentos: r.data || []
        });
    } catch (e) {
        erroResposta(res, e);
    }
});

app.get("/equipamentos", async (req, res) => {
    try {
        const r = await supabase.from("equipamentos").select("*").order("id", { ascending: true });
        res.json(r.data || []);
    } catch (e) {
        erroResposta(res, e);
    }
});

app.get("/api/equipamentos/:id", async (req, res) => {
    try {
        const r = await supabase.from("equipamentos").select("*").eq("id", req.params.id).maybeSingle();
        if (r.error) throw r.error;

        if (!r.data) {
            return res.status(404).json({
                sucesso: false,
                erro: "Equipamento não encontrado."
            });
        }

        res.json({
            sucesso: true,
            equipamento: r.data
        });
    } catch (e) {
        erroResposta(res, e);
    }
});

app.post("/api/equipamentos", async (req, res) => {
    try {
        const nome = texto(req.body?.nome).trim();
        const u = uid(req.body?.uid_rfid ?? req.body?.uid_tag);
        const box = Number(req.body?.box ?? req.body?.box_id);

        if (!nome || !u || !Number.isInteger(box) || box < 1) {
            return res.status(400).json({
                sucesso: false,
                erro: "Nome, UID e Box válida são obrigatórios."
            });
        }

        const ex = await verificarUID(u);

        if (ex.encontrado) {
            return res.status(409).json({
                sucesso: false,
                erro: "Esta tag já está cadastrada."
            });
        }

        if (await boxOcupada(box)) {
            return res.status(409).json({
                sucesso: false,
                tipo: "box_ocupada",
                erro: `A Box ${box} já possui outro objeto. Uma Box comporta apenas um objeto.`
            });
        }

        const r = await supabase
            .from("equipamentos")
            .insert([{
                nome,
                descricao: texto(req.body?.descricao).trim() || null,
                uid_tag: u,
                box_id: box,
                status: "disponivel"
            }])
            .select()
            .single();

        if (r.error) throw r.error;

        res.status(201).json({
            sucesso: true,
            equipamento: r.data,
            mensagem: "Equipamento cadastrado."
        });
    } catch (e) {
        erroResposta(res, e, 400);
    }
});

app.put("/api/equipamentos/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        const dados = {};

        if (req.body.nome !== undefined) dados.nome = texto(req.body.nome).trim();
        if (req.body.descricao !== undefined) dados.descricao = req.body.descricao;

        if (req.body.uid_rfid !== undefined || req.body.uid_tag !== undefined) {
            dados.uid_tag = uid(req.body.uid_rfid ?? req.body.uid_tag);
        }

        if (req.body.box !== undefined || req.body.box_id !== undefined) {
            const b = Number(req.body.box ?? req.body.box_id);

            if (!Number.isInteger(b) || b < 1) {
                return res.status(400).json({
                    sucesso: false,
                    erro: "Box inválida."
                });
            }

            if (await boxOcupada(b, id)) {
                return res.status(409).json({
                    sucesso: false,
                    erro: `A Box ${b} já possui outro objeto.`
                });
            }

            dados.box_id = b;
        }

        if (req.body.status !== undefined) {
            dados.status = status(req.body.status) === "disponivel"
                ? "disponivel"
                : "emprestado";
        }

        const r = await supabase
            .from("equipamentos")
            .update(dados)
            .eq("id", id)
            .select()
            .single();

        if (r.error) throw r.error;

        res.json({
            sucesso: true,
            equipamento: r.data,
            mensagem: "Equipamento atualizado."
        });
    } catch (e) {
        erroResposta(res, e, 400);
    }
});

app.delete("/api/equipamentos/:id", async (req, res) => {
    try {
        const a = await ativoEquipamento(Number(req.params.id));

        if (a) {
            return res.status(409).json({
                sucesso: false,
                erro: "Não é possível excluir um equipamento emprestado."
            });
        }

        const r = await supabase.from("equipamentos").delete().eq("id", req.params.id);
        if (r.error) throw r.error;

        res.json({
            sucesso: true,
            mensagem: "Equipamento excluído."
        });
    } catch (e) {
        erroResposta(res, e, 400);
    }
});

/* EMPRÉSTIMOS */
app.get("/api/emprestimos", async (req, res) => {
    try {
        const r = await supabase
            .from("emprestimos")
            .select("*")
            .order("id", { ascending: false });

        if (r.error) throw r.error;

        res.json({
            sucesso: true,
            emprestimos: await enriquecer(r.data || [])
        });
    } catch (e) {
        erroResposta(res, e);
    }
});

app.get("/emprestimos", async (req, res) => {
    try {
        const r = await supabase
            .from("emprestimos")
            .select("*")
            .order("id", { ascending: false });

        if (r.error) throw r.error;

        const rows = await enriquecer(r.data || []);

        res.json(rows.map(x => ({
            ...x,
            funcionario: x.funcionario?.nome || "-",
            matricula: x.funcionario?.matricula || "-",
            equipamento: x.equipamento?.nome || "-",
            box_id: x.equipamento?.box_id ?? x.box ?? "-"
        })));
    } catch (e) {
        erroResposta(res, e);
    }
});

app.get("/api/ultimos-emprestimos", async (req, res) => {
    try {
        const r = await supabase
            .from("emprestimos")
            .select("*")
            .order("id", { ascending: false })
            .limit(10);

        if (r.error) throw r.error;

        res.json({
            sucesso: true,
            emprestimos: await enriquecer(r.data || [])
        });
    } catch (e) {
        erroResposta(res, e);
    }
});

/* Mantido para compatibilidade com a tela antiga. */
app.post("/api/emprestimos", async (req, res) => {
    try {
        const funcionarioId = Number(req.body?.funcionario_id);
        const equipamentoId = Number(req.body?.equipamento_id);

        if (!Number.isInteger(funcionarioId) || !Number.isInteger(equipamentoId)) {
            return res.status(400).json({
                sucesso: false,
                erro: "Funcionário e equipamento são obrigatórios."
            });
        }

        const ativos = await ativosFuncionario(funcionarioId);

        if (ativos.length) {
            return res.status(409).json({
                sucesso: false,
                erro: "Este funcionário já possui um equipamento. Devolva-o antes de retirar outro."
            });
        }

        const e = await supabase
            .from("equipamentos")
            .select("*")
            .eq("id", equipamentoId)
            .maybeSingle();

        if (e.error) throw e.error;
        if (!e.data) return res.status(404).json({
            sucesso: false,
            erro: "Equipamento não encontrado."
        });

        if (status(e.data.status) !== "disponivel") {
            return res.status(409).json({
                sucesso: false,
                erro: "Equipamento não disponível."
            });
        }

        if (await boxOcupada(e.data.box_id, e.data.id)) {
            return res.status(409).json({
                sucesso: false,
                erro: `A Box ${e.data.box_id} já possui outro objeto.`
            });
        }

        const r = await supabase
            .from("emprestimos")
            .insert([{
                funcionario_id: funcionarioId,
                equipamento_id: equipamentoId,
                box: Number(e.data.box_id),
                status: "Ativo",
                data_retirada: agora()
            }])
            .select()
            .maybeSingle();

        if (r.error) throw r.error;

        const u = await supabase
            .from("equipamentos")
            .update({ status: "emprestado" })
            .eq("id", equipamentoId)
            .eq("status", "disponivel");

        if (u.error) throw u.error;

        res.status(201).json({
            sucesso: true,
            mensagem: "Empréstimo registrado.",
            emprestimo: r.data
        });
    } catch (e) {
        erroResposta(res, e, 400);
    }
});

app.put("/api/emprestimos/:id/devolver", async (req, res) => {
    try {
        const id = Number(req.params.id);

        const aberto = await supabase
            .from("emprestimos")
            .select("*")
            .eq("id", id)
            .eq("status", "Ativo")
            .is("data_devolucao", null)
            .maybeSingle();

        if (aberto.error) throw aberto.error;

        if (!aberto.data) {
            return res.status(404).json({
                sucesso: false,
                erro: "Empréstimo ativo não encontrado."
            });
        }

        const d = await supabase
            .from("emprestimos")
            .update({
                data_devolucao: agora(),
                status: "Devolvido"
            })
            .eq("id", id)
            .eq("status", "Ativo")
            .is("data_devolucao", null)
            .select()
            .maybeSingle();

        if (d.error) throw d.error;

        if (!d.data) {
            return res.status(409).json({
                sucesso: false,
                erro: "A devolução já foi registrada."
            });
        }

        const u = await supabase
            .from("equipamentos")
            .update({ status: "disponivel" })
            .eq("id", aberto.data.equipamento_id);

        if (u.error) throw u.error;

        res.json({
            sucesso: true,
            mensagem: "Equipamento devolvido.",
            emprestimo: d.data
        });
    } catch (e) {
        erroResposta(res, e, 400);
    }
});

/* DASHBOARD */
app.get("/api/dashboard", async (req, res) => {
    try {
        const [f, e, ativos] = await Promise.all([
            supabase.from("funcionarios").select("id", { count: "exact", head: true }),
            supabase.from("equipamentos").select("id,status,box_id"),
            supabase.from("emprestimos").select("id").eq("status", "Ativo").is("data_devolucao", null)
        ]);

        if (f.error) throw f.error;
        if (e.error) throw e.error;
        if (ativos.error) throw ativos.error;

        const eq = e.data || [];

        res.json({
            sucesso: true,
            funcionarios: f.count || 0,
            equipamentos: eq.length,
            disponiveis: eq.filter(x => status(x.status) === "disponivel").length,
            emprestimos: (ativos.data || []).length,
            emprestados: (ativos.data || []).length
        });
    } catch (e) {
        erroResposta(res, e);
    }
});

/* 404 / erro */
app.use((req, res) => res.status(404).json({
    sucesso: false,
    erro: "Rota não encontrada.",
    rota: req.originalUrl
}));

app.use((err, req, res, next) => {
    console.error("ERRO GERAL:", err);
    res.status(500).json({
        sucesso: false,
        erro: "Erro interno do servidor."
    });
});

(async () => {
    await corrigirBoxesDuplicadas();
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`INVENTÁRIO RFID - NUVEM | porta ${PORT} | aguardando ESP32...`);
    });
})().catch(e => {
    console.error(e);
    process.exit(1);
});
