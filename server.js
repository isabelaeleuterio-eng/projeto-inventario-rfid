require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const PORT = Number(process.env.PORT || 3000);

const SITE_DIR = path.join(__dirname, "SITE");


// ============================================================
// SUPABASE
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {

    console.error(
        "ERRO: configure SUPABASE_URL e SUPABASE_SECRET_KEY no arquivo .env"
    );

    process.exit(1);
}


const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_KEY,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
        }
    }
);


// ============================================================
// CONFIGURAÇÃO EXPRESS
// ============================================================

app.set("trust proxy", 1);

app.use(cors());

app.use(
    express.json({
        limit: "100kb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "100kb"
    })
);

app.use(
    express.text({
        type: "text/plain",
        limit: "100kb"
    })
);

app.use(
    express.static(
        SITE_DIR,
        {
            maxAge: 0
        }
    )
);


// ============================================================
// ESTADO DO ESP32
// ============================================================

let esp32 = {

    conectado: false,

    ultimoContato: null,

    ip: null

};


// ============================================================
// ÚNICA CAIXA DO SISTEMA
// ============================================================
//
// Não existe Box 1, Box 2 etc.
//
// O sistema possui uma única caixa.
//
// A trava física será implementada depois.
//
// ============================================================


let comandoESP32 = {

    id: 0,

    tipo: "nenhum",

    criadoEm: 0,

    lido: true,

    parametros: {}

};


// ============================================================
// EVENTO RFID ATUAL
// ============================================================

let rfidEvent = {

    nova: false,

    id: 0,

    uid: null,

    tipo: "idle",

    modo: "idle",

    mensagem: "Passe a tag do funcionário.",

    funcionario: null,

    equipamento: null,

    equipamentos: [],

    equipamentoRecebido: null,

    equipamentoEsperado: null,

    acaoTrava: null,

    momento: 0

};


// ============================================================
// FLUXO ATUAL
// ============================================================
//
// RETIRADA:
//
// funcionario
//      ↓
// escolha equipamento
//      ↓
// tag equipamento
//      ↓
// caixa liberada
//      ↓
// retirada
//
//
//
// DEVOLUÇÃO:
//
// funcionario
//      ↓
// equipamento emprestado
//      ↓
// tag equipamento
//      ↓
// caixa liberada
//      ↓
// colocar equipamento
//      ↓
// fechar caixa
//      ↓
// tag funcionário novamente
//      ↓
// devolvido
//
// ============================================================

let fluxo = {

    modo: "idle",

    funcionario: null,

    acao: null,

    equipamentoSelecionado: null,

    emprestimoId: null,

    expiraEm: 0

};


// ============================================================
// CADASTRO DE RFID
// ============================================================

let cadastroRFID = {

    ativo: false,

    tipo: null,

    expiraEm: 0

};


// ============================================================
// ÚLTIMA LEITURA
// ============================================================

let ultimaLeitura = {

    uid: null,

    momento: 0

};


// ============================================================
// FUNÇÕES BÁSICAS
// ============================================================

function agora() {

    return new Date().toISOString();

}


function texto(valor, fallback = "") {

    if (valor === null || valor === undefined) {

        return fallback;

    }

    return String(valor);

}


function normalizarUID(valor) {

    return texto(valor)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");

}


function normalizarStatus(valor) {

    return texto(valor)
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

}


function erroMensagem(erro) {

    return erro?.message || String(erro);

}


function responderErro(res, erro, codigo = 500) {

    console.error("ERRO:", erro);

    return res.status(codigo).json({

        sucesso: false,

        erro: erroMensagem(erro),

        mensagem: erroMensagem(erro)

    });

}


// ============================================================
// OBJETOS PÚBLICOS
// ============================================================

function funcionarioPublico(funcionario) {

    if (!funcionario) {

        return null;

    }

    return {

        id: funcionario.id,

        nome: funcionario.nome,

        matricula: funcionario.matricula,

        uid_tag_pessoal: funcionario.uid_tag_pessoal,

        setor: funcionario.setor ?? null

    };

}


function equipamentoPublico(equipamento) {

    if (!equipamento) {

        return null;

    }

    return {

        id: equipamento.id,

        nome: equipamento.nome,

        descricao: equipamento.descricao ?? null,

        uid_tag: equipamento.uid_tag,

        status: equipamento.status,

        ativo: equipamento.ativo

    };

}


// ============================================================
// PUBLICAR EVENTO RFID
// ============================================================

function publicarEvento(dados = {}) {

    rfidEvent = {

        nova: true,

        id: Date.now(),

        uid: dados.uid || null,

        tipo: dados.tipo || "idle",

        modo: dados.modo || "idle",

        mensagem: dados.mensagem || "",

        funcionario: dados.funcionario || null,

        equipamento: dados.equipamento || null,

        equipamentos: dados.equipamentos || [],

        equipamentoRecebido:
            dados.equipamentoRecebido || null,

        equipamentoEsperado:
            dados.equipamentoEsperado || null,

        acaoTrava:
            dados.acaoTrava || null,

        momento: Date.now()

    };

    return rfidEvent;

}


// ============================================================
// LIMPAR FLUXO
// ============================================================

function limparFluxo() {

    fluxo = {

        modo: "idle",

        funcionario: null,

        acao: null,

        equipamentoSelecionado: null,

        emprestimoId: null,

        expiraEm: 0

    };

}


// ============================================================
// EXPIRAÇÃO
// ============================================================

function verificarExpiracao() {

    if (
        fluxo.expiraEm &&
        Date.now() > fluxo.expiraEm
    ) {

        limparFluxo();

        publicarEvento({

            tipo: "fluxo_expirado",

            modo: "idle",

            mensagem:
                "A operação expirou. Passe novamente a tag do funcionário."

        });

    }


    if (
        cadastroRFID.expiraEm &&
        Date.now() > cadastroRFID.expiraEm
    ) {

        cadastroRFID = {

            ativo: false,

            tipo: null,

            expiraEm: 0

        };

    }

}


// ============================================================
// SOLICITAR ABERTURA DA CAIXA
// ============================================================
//
// IMPORTANTE:
//
// Ainda não controla fisicamente a trava.
//
// Apenas cria o comando que futuramente será recebido
// pelo ESP32.
//
// Os 5000 ms NÃO significam:
//
// "depois de 5 segundos a trava deve subir".
//
// Isso será tratado posteriormente.
//
// ============================================================

function solicitarAbertura(motivo, equipamento = null) {

    comandoESP32 = {

        id: Date.now(),

        tipo: "liberar_caixa",

        criadoEm: Date.now(),

        lido: false,

        parametros: {

            motivo: motivo,

            equipamento_id:
                equipamento?.id ?? null,

            tempo_liberacao_ms: 5000

        }

    };

    return comandoESP32;

}


// ============================================================
// BUSCAR FUNCIONÁRIO
// ============================================================

async function buscarFuncionarioPorUID(uid) {

    const resultado = await supabase

        .from("funcionarios")

        .select("*")

        .eq("uid_tag_pessoal", uid)

        .eq("ativo", true)

        .maybeSingle();


    if (resultado.error) {

        throw resultado.error;

    }


    return resultado.data || null;

}


// ============================================================
// BUSCAR EQUIPAMENTO
// ============================================================

async function buscarEquipamentoPorUID(uid) {

    const resultado = await supabase

        .from("equipamentos")

        .select("*")

        .eq("uid_tag", uid)

        .eq("ativo", true)

        .maybeSingle();


    if (resultado.error) {

        throw resultado.error;

    }


    return resultado.data || null;

}


// ============================================================
// EMPRÉSTIMOS ATIVOS DO FUNCIONÁRIO
// ============================================================

async function emprestimosAtivosFuncionario(funcionarioId) {

    const resultado = await supabase

        .from("emprestimos")

        .select("*")

        .eq(
            "funcionario_id",
            funcionarioId
        )

        .eq(
            "status",
            "emprestado"
        )

        .is(
            "data_devolucao",
            null
        )

        .order(
            "id",
            {
                ascending: false
            }
        );


    if (resultado.error) {

        throw resultado.error;

    }


    return resultado.data || [];

}


// ============================================================
// EMPRÉSTIMO ATIVO DO EQUIPAMENTO
// ============================================================

async function emprestimoAtivoEquipamento(equipamentoId) {

    const resultado = await supabase

        .from("emprestimos")

        .select("*")

        .eq(
            "equipamento_id",
            equipamentoId
        )

        .eq(
            "status",
            "emprestado"
        )

        .is(
            "data_devolucao",
            null
        )

        .order(
            "id",
            {
                ascending: false
            }
        )

        .limit(1);


    if (resultado.error) {

        throw resultado.error;

    }


    return resultado.data?.[0] || null;

}


// ============================================================
// EQUIPAMENTOS
// ============================================================

async function buscarEquipamentos() {

    const resultado = await supabase

        .from("equipamentos")

        .select("*")

        .eq(
            "ativo",
            true
        )

        .order(
            "id",
            {
                ascending: true
            }
        );


    if (resultado.error) {

        throw resultado.error;

    }


    return resultado.data || [];

}


// ============================================================
// EQUIPAMENTOS DISPONÍVEIS
// ============================================================

async function buscarEquipamentosDisponiveis() {

    const equipamentos =
        await buscarEquipamentos();


    return equipamentos.filter(

        equipamento =>

            normalizarStatus(
                equipamento.status
            ) === "disponivel"

    );

}


// ============================================================
// VERIFICAR UID
// ============================================================

async function verificarUID(uid) {

    const funcionario =
        await buscarFuncionarioPorUID(uid);


    if (funcionario) {

        return {

            encontrado: true,

            categoria: "funcionario",

            registro: funcionario

        };

    }


    const equipamento =
        await buscarEquipamentoPorUID(uid);


    if (equipamento) {

        return {

            encontrado: true,

            categoria: "equipamento",

            registro: equipamento

        };

    }


    return {

        encontrado: false

    };

}


// ============================================================
// REGISTRAR OPERAÇÃO
// ============================================================

async function registrarOperacao(
    etapa,
    dados = {}
) {

    if (!fluxo.funcionario?.id) {

        return null;

    }


    const registro = {

        funcionario_id:
            Number(fluxo.funcionario.id),

        equipamento_id:
            fluxo.equipamentoSelecionado?.id
                ? Number(
                    fluxo.equipamentoSelecionado.id
                )
                : null,

        tipo:
            fluxo.acao === "devolucao"
                ? "devolucao"
                : "retirada",

        etapa: etapa,

        mensagem:
            dados.mensagem || null,

        uid_ultima_leitura:
            dados.uid || null,

        atualizada_em:
            agora(),

        expira_em:
            fluxo.expiraEm
                ? new Date(
                    fluxo.expiraEm
                ).toISOString()
                : null

    };


    const resultado = await supabase

        .from("operacoes_rfid")

        .insert([registro])

        .select("*")

        .maybeSingle();


    if (resultado.error) {

        console.warn(
            "Não foi possível registrar operacao_rfid:",
            resultado.error.message
        );

        return null;

    }


    return resultado.data;

}


// ============================================================
// FINALIZAR OPERAÇÃO
// ============================================================

async function finalizarOperacao(
    mensagem
) {

    if (!fluxo.funcionario?.id) {

        return;

    }


    const resultado = await supabase

        .from("operacoes_rfid")

        .update({

            etapa: "concluida",

            mensagem: mensagem || null,

            atualizada_em: agora(),

            finalizada_em: agora()

        })

        .eq(
            "funcionario_id",
            Number(
                fluxo.funcionario.id
            )
        )

        .is(
            "finalizada_em",
            null
        );


    if (resultado.error) {

        console.warn(
            "Erro ao finalizar operação:",
            resultado.error.message
        );

    }

}


// ============================================================
// ROTAS PRINCIPAIS
// ============================================================

app.get(
    "/",
    (req, res) => {

        res.sendFile(
            path.join(
                SITE_DIR,
                "index.html"
            )
        );

    }
);


app.get(
    "/cadastro",
    (req, res) => {

        res.sendFile(
            path.join(
                SITE_DIR,
                "cadastro.html"
            )
        );

    }
);


app.get(
    "/controle",
    (req, res) => {

        res.sendFile(
            path.join(
                SITE_DIR,
                "controle.html"
            )
        );

    }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
    "/health",
    (req, res) => {

        res.json({

            sucesso: true,

            servidor: true,

            banco: true,

            timestamp: agora()

        });

    }
);


// ============================================================
// STATUS
// ============================================================

app.get(
    "/api/status",
    async (req, res) => {

        try {

            const resultado =
                await supabase
                    .from("funcionarios")
                    .select("id")
                    .limit(1);


            if (resultado.error) {

                throw resultado.error;

            }


            res.json({

                sucesso: true,

                servidor: true,

                banco: true,

                esp32: esp32,

                fluxo: fluxo,

                comandoESP32: comandoESP32,

                rfid: rfidEvent

            });

        } catch (erro) {

            responderErro(
                res,
                erro
            );

        }

    }
);


// ============================================================
// STATUS ESP32
// ============================================================

app.get(
    "/api/esp32/status",
    (req, res) => {

        res.json({

            sucesso: true,

            ...esp32

        });

    }
);


// ============================================================
// ESP32 ONLINE
// ============================================================

app.post(
    "/api/esp32/online",
    (req, res) => {

        esp32.conectado = true;

        esp32.ultimoContato = agora();

        esp32.ip =
            req.ip ||
            req.body?.ip ||
            null;


        res.json({

            sucesso: true,

            mensagem:
                "ESP32 conectado.",

            comando:
                comandoESP32

        });

    }
);


// ============================================================
// ESP32 BUSCA COMANDO
// ============================================================

app.get(
    "/api/esp32/comando",
    (req, res) => {

        esp32.conectado = true;

        esp32.ultimoContato = agora();


        const comando = {
            ...comandoESP32
        };


        if (
            !comando.lido &&
            comando.id
        ) {

            comandoESP32.lido = true;

        }


        res.json({

            sucesso: true,

            comando: comando

        });

    }
);


// ============================================================
// ESP32 CONFIRMA COMANDO
// ============================================================

app.post(
    "/api/esp32/comando/confirmar",
    (req, res) => {

        esp32.conectado = true;

        esp32.ultimoContato = agora();


        const id =
            Number(
                req.body?.id
            );


        if (
            id &&
            id === Number(
                comandoESP32.id
            )
        ) {

            comandoESP32.lido = true;

        }


        res.json({

            sucesso: true,

            mensagem:
                "Comando recebido.",

            comando:
                comandoESP32

        });

    }
);
// ============================================================
// ESP32 ENVIA LEITURA RFID
// ============================================================
//
// O ESP32 envia:
//
// {
//     "uid": "93053514"
// }
//
// ou:
//
// {
//     "uid": "5308E8B1B50001"
// }
//
// O servidor decide se a leitura é:
//
// FUNCIONÁRIO
// ou
// EQUIPAMENTO
//
// ============================================================

app.post(
    "/api/esp32/rfid",
    async (req, res) => {

        try {

            esp32.conectado = true;

            esp32.ultimoContato = agora();


            let uid = req.body?.uid;


            // ------------------------------------------------
            // ACEITAR TAMBÉM "tag" E "rfid"
            // ------------------------------------------------

            if (!uid) {

                uid = req.body?.tag;

            }

            if (!uid) {

                uid = req.body?.rfid;

            }


            uid = normalizarUID(uid);


            if (!uid) {

                return res.status(400).json({

                    sucesso: false,

                    erro:
                        "UID da tag não informado."

                });

            }


            // ------------------------------------------------
            // EVITAR LEITURA DUPLICADA MUITO RÁPIDA
            // ------------------------------------------------

            const agoraMs = Date.now();


            if (
                ultimaLeitura.uid === uid &&
                agoraMs - ultimaLeitura.momento < 1500
            ) {

                return res.json({

                    sucesso: true,

                    duplicada: true,

                    mensagem:
                        "Leitura duplicada ignorada.",

                    fluxo: fluxo,

                    rfid: rfidEvent

                });

            }


            ultimaLeitura = {

                uid: uid,

                momento: agoraMs

            };


            // ------------------------------------------------
            // VERIFICAR EXPIRAÇÃO
            // ------------------------------------------------

            verificarExpiracao();


            // ------------------------------------------------
            // MODO CADASTRO
            // ------------------------------------------------

            if (cadastroRFID.ativo) {

                return await processarCadastroRFID(
                    uid,
                    res
                );

            }


            // ------------------------------------------------
            // DESCOBRIR SE É FUNCIONÁRIO OU EQUIPAMENTO
            // ------------------------------------------------

            const encontrado =
                await verificarUID(uid);


            // =================================================
            // TAG NÃO CADASTRADA
            // =================================================

            if (!encontrado.encontrado) {

                publicarEvento({

                    uid: uid,

                    tipo: "tag_desconhecida",

                    modo: fluxo.modo,

                    mensagem:
                        "Tag não cadastrada."

                });


                return res.json({

                    sucesso: false,

                    encontrado: false,

                    uid: uid,

                    mensagem:
                        "Tag não cadastrada.",

                    fluxo: fluxo,

                    rfid: rfidEvent

                });

            }


            // =================================================
            // TAG DE FUNCIONÁRIO
            // =================================================

            if (
                encontrado.categoria ===
                "funcionario"
            ) {

                return await processarTagFuncionario(
                    uid,
                    encontrado.registro,
                    res
                );

            }


            // =================================================
            // TAG DE EQUIPAMENTO
            // =================================================

            if (
                encontrado.categoria ===
                "equipamento"
            ) {

                return await processarTagEquipamento(
                    uid,
                    encontrado.registro,
                    res
                );

            }


            return res.json({

                sucesso: false,

                mensagem:
                    "Tipo de tag não reconhecido."

            });


        } catch (erro) {

            return responderErro(
                res,
                erro
            );

        }

    }
);


// ============================================================
// PROCESSAR TAG DO FUNCIONÁRIO
// ============================================================

async function processarTagFuncionario(
    uid,
    funcionario,
    res
) {

    // --------------------------------------------------------
    // FUNCIONÁRIO INATIVO
    // --------------------------------------------------------

    if (!funcionario.ativo) {

        publicarEvento({

            uid: uid,

            tipo: "funcionario_inativo",

            modo: "erro",

            mensagem:
                "Funcionário inativo."

        });


        return res.json({

            sucesso: false,

            mensagem:
                "Funcionário inativo."

        });

    }


    // ========================================================
    // CASO 1
    // NÃO EXISTE FLUXO
    //
    // É O INÍCIO DA OPERAÇÃO
    // ========================================================

    if (
        fluxo.modo === "idle"
    ) {

        const ativos =
            await emprestimosAtivosFuncionario(
                funcionario.id
            );


        // ----------------------------------------------------
        // FUNCIONÁRIO POSSUI EQUIPAMENTO
        //
        // Portanto deve fazer devolução.
        // ----------------------------------------------------

        if (ativos.length > 0) {

            const primeiro =
                ativos[0];


            const equipamento =
                await buscarEquipamentoPorId(
                    primeiro.equipamento_id
                );


            fluxo = {

                modo: "devolucao",

                funcionario: funcionario,

                acao: "devolucao",

                equipamentoSelecionado:
                    equipamento,

                emprestimoId:
                    primeiro.id,

                expiraEm:
                    Date.now() +
                    120000

            };


            await registrarOperacao(

                "aguardando_tag_equipamento_devolucao",

                {

                    uid: uid,

                    mensagem:
                        "Aguardando tag do equipamento para devolução."

                }

            );


            publicarEvento({

                uid: uid,

                tipo: "funcionario_identificado",

                modo: "devolucao",

                funcionario:
                    funcionarioPublico(
                        funcionario
                    ),

                equipamento:
                    equipamentoPublico(
                        equipamento
                    ),

                mensagem:
                    `Olá, ${funcionario.nome}. Você possui o equipamento "${equipamento?.nome || "equipamento"}" para devolver. Passe a tag do equipamento.`

            });


            return res.json({

                sucesso: true,

                modo: "devolucao",

                funcionario:
                    funcionarioPublico(
                        funcionario
                    ),

                equipamento:
                    equipamentoPublico(
                        equipamento
                    ),

                mensagem:
                    "Passe a tag do equipamento para confirmar a devolução.",

                rfid: rfidEvent

            });

        }


        // ----------------------------------------------------
        // FUNCIONÁRIO NÃO POSSUI EQUIPAMENTO
        //
        // Pode iniciar retirada.
        // ----------------------------------------------------

        const disponiveis =
            await buscarEquipamentosDisponiveis();


        fluxo = {

            modo: "retirada",

            funcionario: funcionario,

            acao: "retirada",

            equipamentoSelecionado: null,

            emprestimoId: null,

            expiraEm:
                Date.now() +
                120000

        };


        await registrarOperacao(

            "aguardando_escolha",

            {

                uid: uid,

                mensagem:
                    "Funcionário identificado. Aguardando escolha do equipamento."

            }

        );


        publicarEvento({

            uid: uid,

            tipo: "funcionario_identificado",

            modo: "retirada",

            funcionario:
                funcionarioPublico(
                    funcionario
                ),

            equipamentos:
                disponiveis.map(
                    equipamentoPublico
                ),

            mensagem:
                `Olá, ${funcionario.nome}. Escolha um equipamento disponível.`

        });


        return res.json({

            sucesso: true,

            modo: "retirada",

            funcionario:
                funcionarioPublico(
                    funcionario
                ),

            equipamentos:
                disponiveis.map(
                    equipamentoPublico
                ),

            mensagem:
                "Escolha um equipamento.",

            rfid: rfidEvent

        });

    }


    // ========================================================
    // CASO 2
    // DEVOLUÇÃO AGUARDANDO TAG FUNCIONÁRIO FINAL
    // ========================================================

    if (
        fluxo.modo ===
        "devolucao_aguardando_confirmacao"
    ) {

        if (
            Number(
                fluxo.funcionario.id
            ) !==
            Number(
                funcionario.id
            )
        ) {

            return res.json({

                sucesso: false,

                mensagem:
                    "Esta devolução pertence a outro funcionário."

            });

        }


        // ----------------------------------------------------
        // AQUI SIM A DEVOLUÇÃO É FINALIZADA
        // ----------------------------------------------------

        const resultado =
            await finalizarDevolucao();


        if (!resultado.sucesso) {

            return res.json(
                resultado
            );

        }


        await finalizarOperacao(
            "Devolução confirmada pelo funcionário."
        );


        publicarEvento({

            uid: uid,

            tipo: "devolucao_concluida",

            modo: "concluida",

            funcionario:
                funcionarioPublico(
                    funcionario
                ),

            equipamento:
                equipamentoPublico(
                    fluxo.equipamentoSelecionado
                ),

            mensagem:
                "Devolução concluída com sucesso."

        });


        limparFluxo();


        return res.json({

            sucesso: true,

            modo: "concluida",

            mensagem:
                "Devolução concluída com sucesso.",

            funcionario:
                funcionarioPublico(
                    funcionario
                ),

            equipamento:
                equipamentoPublico(
                    resultado.equipamento
                )

        });

    }


    // ========================================================
    // CASO 3
    // QUALQUER OUTRA SITUAÇÃO
    // ========================================================

    publicarEvento({

        uid: uid,

        tipo: "tag_funcionario",

        modo: fluxo.modo,

        funcionario:
            funcionarioPublico(
                funcionario
            ),

        mensagem:
            "Funcionário identificado."

    });


    return res.json({

        sucesso: true,

        funcionario:
            funcionarioPublico(
                funcionario
            ),

        fluxo: fluxo,

        mensagem:
            "Funcionário identificado."

    });

}


// ============================================================
// PROCESSAR TAG DO EQUIPAMENTO
// ============================================================

async function processarTagEquipamento(
    uid,
    equipamento,
    res
) {

    // ========================================================
    // NÃO EXISTE OPERAÇÃO
    // ========================================================

    if (
        fluxo.modo === "idle"
    ) {

        publicarEvento({

            uid: uid,

            tipo: "equipamento_sem_fluxo",

            modo: "erro",

            equipamento:
                equipamentoPublico(
                    equipamento
                ),

            mensagem:
                "Primeiro passe a tag do funcionário."

        });


        return res.json({

            sucesso: false,

            mensagem:
                "Primeiro passe a tag do funcionário."

        });

    }


    // ========================================================
    // RETIRADA
    // ========================================================

    if (
        fluxo.modo === "retirada"
    ) {

        // ----------------------------------------------------
        // EQUIPAMENTO PRECISA ESTAR DISPONÍVEL
        // ----------------------------------------------------

        if (
            normalizarStatus(
                equipamento.status
            ) !== "disponivel"
        ) {

            return res.json({

                sucesso: false,

                mensagem:
                    "Esse equipamento não está disponível."

            });

        }


        // ----------------------------------------------------
        // SE A PESSOA ESCOLHEU UM EQUIPAMENTO
        // CONFIRMAR SE A TAG É A MESMA
        // ----------------------------------------------------

        if (
            fluxo.equipamentoSelecionado &&
            Number(
                fluxo.equipamentoSelecionado.id
            ) !==
            Number(
                equipamento.id
            )
        ) {

            publicarEvento({

                uid: uid,

                tipo: "equipamento_incorreto",

                modo: "retirada",

                funcionario:
                    funcionarioPublico(
                        fluxo.funcionario
                    ),

                equipamento:
                    equipamentoPublico(
                        equipamento
                    ),

                equipamentoEsperado:
                    equipamentoPublico(
                        fluxo.equipamentoSelecionado
                    ),

                mensagem:
                    `Tag incorreta. O equipamento escolhido foi "${fluxo.equipamentoSelecionado.nome}".`

            });


            return res.json({

                sucesso: false,

                mensagem:
                    `Tag incorreta. O equipamento escolhido foi "${fluxo.equipamentoSelecionado.nome}".`,

                equipamentoEsperado:
                    equipamentoPublico(
                        fluxo.equipamentoSelecionado
                    )

            });

        }


        // ----------------------------------------------------
        // GUARDAR EQUIPAMENTO
        // ----------------------------------------------------

        fluxo.equipamentoSelecionado =
            equipamento;


        fluxo.expiraEm =
            Date.now() +
            120000;


        // ----------------------------------------------------
        // VERIFICAR NOVAMENTE SE NÃO EXISTE
        // OUTRO EMPRÉSTIMO ATIVO
        // ----------------------------------------------------

        const ativo =
            await emprestimoAtivoEquipamento(
                equipamento.id
            );


        if (ativo) {

            return res.json({

                sucesso: false,

                mensagem:
                    "Esse equipamento já possui um empréstimo ativo."

            });

        }


        // ----------------------------------------------------
        // SOLICITAR ABERTURA DA CAIXA
        // ----------------------------------------------------

        solicitarAbertura(
            "retirada",
            equipamento
        );


        await registrarOperacao(

            "caixa_aberta",

            {

                uid: uid,

                mensagem:
                    "Equipamento confirmado. Caixa liberada para retirada."

            }

        );


        publicarEvento({

            uid: uid,

            tipo: "equipamento_confirmado",

            modo: "retirada",

            funcionario:
                funcionarioPublico(
                    fluxo.funcionario
                ),

            equipamento:
                equipamentoPublico(
                    equipamento
                ),

            acaoTrava:
                "liberar_caixa",

            mensagem:
                `Equipamento "${equipamento.nome}" confirmado. Caixa liberada. Retire o equipamento.`

        });


        return res.json({

            sucesso: true,

            modo: "retirada",

            equipamento:
                equipamentoPublico(
                    equipamento
                ),

            acao:
                "liberar_caixa",

            comando:
                comandoESP32,

            mensagem:
                "Caixa liberada. Retire o equipamento."

        });

    }


    // ========================================================
    // DEVOLUÇÃO
    // ========================================================

    if (
        fluxo.modo === "devolucao"
    ) {

        const esperado =
            fluxo.equipamentoSelecionado;


        // ----------------------------------------------------
        // CONFIRMAR TAG
        // ----------------------------------------------------

        if (
            !esperado ||
            Number(
                esperado.id
            ) !==
            Number(
                equipamento.id
            )
        ) {

            publicarEvento({

                uid: uid,

                tipo: "equipamento_incorreto",

                modo: "devolucao",

                equipamento:
                    equipamentoPublico(
                        equipamento
                    ),

                equipamentoEsperado:
                    equipamentoPublico(
                        esperado
                    ),

                mensagem:
                    "Essa não é a tag do equipamento que deve ser devolvido."

            });


            return res.json({

                sucesso: false,

                mensagem:
                    "Essa não é a tag do equipamento que deve ser devolvido.",

                equipamentoEsperado:
                    equipamentoPublico(
                        esperado
                    )

            });

        }


        // ----------------------------------------------------
        // CONFIRMAR EMPRÉSTIMO
        // ----------------------------------------------------

        const emprestimo =
            await emprestimoAtivoEquipamento(
                equipamento.id
            );


        if (!emprestimo) {

            return res.json({

                sucesso: false,

                mensagem:
                    "Não existe empréstimo ativo para esse equipamento."

            });

        }


        if (
            Number(
                emprestimo.funcionario_id
            ) !==
            Number(
                fluxo.funcionario.id
            )
        ) {

            return res.json({

                sucesso: false,

                mensagem:
                    "Esse equipamento não está emprestado para este funcionário."

            });

        }


        // ----------------------------------------------------
        // ABRIR CAIXA
        // ----------------------------------------------------

        fluxo.modo =
            "devolucao_aguardando_confirmacao";


        fluxo.emprestimoId =
            emprestimo.id;


        fluxo.expiraEm =
            Date.now() +
            120000;


        solicitarAbertura(
            "devolucao",
            equipamento
        );


        await registrarOperacao(

            "aguardando_confirmacao_funcionario",

            {

                uid: uid,

                mensagem:
                    "Equipamento confirmado. Coloque-o na caixa e passe novamente a tag do funcionário."

            }

        );


        publicarEvento({

            uid: uid,

            tipo: "equipamento_devolucao_confirmado",

            modo:
                "devolucao_aguardando_confirmacao",

            funcionario:
                funcionarioPublico(
                    fluxo.funcionario
                ),

            equipamento:
                equipamentoPublico(
                    equipamento
                ),

            acaoTrava:
                "liberar_caixa",

            mensagem:
                "Equipamento confirmado. Caixa liberada. Coloque o equipamento dentro, feche a caixa e passe novamente sua tag."

        });


        return res.json({

            sucesso: true,

            modo:
                "devolucao_aguardando_confirmacao",

            equipamento:
                equipamentoPublico(
                    equipamento
                ),

            acao:
                "liberar_caixa",

            comando:
                comandoESP32,

            mensagem:
                "Caixa liberada. Coloque o equipamento dentro e passe novamente sua tag."

        });

    }


    return res.json({

        sucesso: false,

        mensagem:
            "Fluxo RFID inválido."

    });

}


// ============================================================
// BUSCAR EQUIPAMENTO PELO ID
// ============================================================

async function buscarEquipamentoPorId(
    id
) {

    if (!id) {

        return null;

    }


    const resultado =
        await supabase

            .from("equipamentos")

            .select("*")

            .eq(
                "id",
                id
            )

            .maybeSingle();


    if (resultado.error) {

        throw resultado.error;

    }


    return resultado.data || null;

}


// ============================================================
// FINALIZAR DEVOLUÇÃO
// ============================================================

async function finalizarDevolucao() {

    if (
        !fluxo.emprestimoId ||
        !fluxo.equipamentoSelecionado
    ) {

        return {

            sucesso: false,

            mensagem:
                "Não existe uma devolução pendente."

        };

    }


    // --------------------------------------------------------
    // ATUALIZAR EMPRÉSTIMO
    // --------------------------------------------------------

    const emprestimo =
        await supabase

            .from("emprestimos")

            .update({

                status: "devolvido",

                data_devolucao: agora()

            })

            .eq(
                "id",
                fluxo.emprestimoId
            )

            .eq(
                "status",
                "emprestado"
            )

            .select("*")

            .maybeSingle();


    if (emprestimo.error) {

        throw emprestimo.error;

    }


    if (!emprestimo.data) {

        return {

            sucesso: false,

            mensagem:
                "O empréstimo não pôde ser finalizado."

        };

    }


    // --------------------------------------------------------
    // EQUIPAMENTO DISPONÍVEL
    // --------------------------------------------------------

    const equipamento =
        await supabase

            .from("equipamentos")

            .update({

                status: "disponivel"

            })

            .eq(
                "id",
                fluxo.equipamentoSelecionado.id
            )

            .select("*")

            .maybeSingle();


    if (equipamento.error) {

        throw equipamento.error;

    }


    return {

        sucesso: true,

        equipamento:
            equipamento.data

    };

}


// ============================================================
// ESCOLHER EQUIPAMENTO PARA RETIRADA
// ============================================================

app.post(
    "/api/retirada/escolher",
    async (req, res) => {

        try {

            const equipamentoId =
                Number(
                    req.body?.equipamento_id
                );


            if (!equipamentoId) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "equipamento_id é obrigatório."

                });

            }


            if (
                fluxo.modo !==
                "retirada"
            ) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "Não existe uma retirada em andamento."

                });

            }


            const equipamento =
                await buscarEquipamentoPorId(
                    equipamentoId
                );


            if (!equipamento) {

                return res.status(404).json({

                    sucesso: false,

                    mensagem:
                        "Equipamento não encontrado."

                });

            }


            if (
                normalizarStatus(
                    equipamento.status
                ) !== "disponivel"
            ) {

                return res.status(409).json({

                    sucesso: false,

                    mensagem:
                        "Equipamento não está disponível."

                });

            }


            fluxo.equipamentoSelecionado =
                equipamento;


            fluxo.expiraEm =
                Date.now() +
                120000;


            await registrarOperacao(

                "aguardando_tag_equipamento_retirada",

                {

                    mensagem:
                        "Equipamento escolhido. Aguardando tag."

                }

            );


            publicarEvento({

                tipo: "equipamento_escolhido",

                modo: "retirada",

                funcionario:
                    funcionarioPublico(
                        fluxo.funcionario
                    ),

                equipamento:
                    equipamentoPublico(
                        equipamento
                    ),

                mensagem:
                    `Equipamento "${equipamento.nome}" escolhido. Passe a tag do equipamento.`

            });


            return res.json({

                sucesso: true,

                equipamento:
                    equipamentoPublico(
                        equipamento
                    ),

                mensagem:
                    "Passe a tag do equipamento."

            });


        } catch (erro) {

            return responderErro(
                res,
                erro
            );

        }

    }
);


// ============================================================
// ESTADO DO FLUXO
// ============================================================

app.get(
    "/api/rfid/estado",
    (req, res) => {

        verificarExpiracao();


        res.json({

            sucesso: true,

            fluxo: {

                modo:
                    fluxo.modo,

                funcionario:
                    funcionarioPublico(
                        fluxo.funcionario
                    ),

                acao:
                    fluxo.acao,

                equipamentoSelecionado:
                    equipamentoPublico(
                        fluxo.equipamentoSelecionado
                    ),

                emprestimoId:
                    fluxo.emprestimoId,

                expiraEm:
                    fluxo.expiraEm

            },

            rfid: rfidEvent,

            comandoESP32: comandoESP32

        });

    }
);


// ============================================================
// ÚLTIMO EVENTO RFID
// ============================================================

app.get(
    "/api/rfid/evento",
    (req, res) => {

        res.json({

            sucesso: true,

            evento: rfidEvent

        });

    }
);


// ============================================================
// MARCAR EVENTO COMO LIDO
// ============================================================

app.post(
    "/api/rfid/evento/ler",
    (req, res) => {

        rfidEvent.nova = false;


        res.json({

            sucesso: true

        });

    }
);
// ============================================================
// CADASTRO RFID
// ============================================================

// ============================================================
// PROCESSAR TAG DO CADASTRO RFID
// ============================================================
//
// A leitura da tag NÃO cadastra automaticamente.
//
// O servidor:
// 1. recebe o UID;
// 2. informa ao site qual tag foi lida;
// 3. encerra o modo de leitura.
//
// O cadastro definitivo será feito depois pelo formulário.
//
// ============================================================

async function processarCadastroRFID(uid, res) {

    if (!cadastroRFID.ativo) {

        return res.json({

            sucesso: false,

            mensagem:
                "Cadastro RFID não está ativo."

        });

    }


    try {

        const tipo =
            cadastroRFID.tipo;


        // ----------------------------------------------------
        // VERIFICAR TIPO DE CADASTRO
        // ----------------------------------------------------

        if (
            tipo !== "funcionario" &&
            tipo !== "equipamento"
        ) {

            cadastroRFID = {

                ativo: false,

                tipo: null,

                expiraEm: 0

            };


            return res.status(400).json({

                sucesso: false,

                mensagem:
                    "Tipo de cadastro RFID inválido."

            });

        }


        // ----------------------------------------------------
        // PUBLICAR TAG CAPTURADA
        // ----------------------------------------------------

        publicarEvento({

            uid: uid,

            tipo:
                tipo === "funcionario"
                    ? "cadastro_tag_funcionario"
                    : "cadastro_tag_equipamento",

            modo: "cadastro",

            mensagem:
                tipo === "funcionario"
                    ? "Tag do funcionário capturada."
                    : "Tag do equipamento capturada."

        });


        // ----------------------------------------------------
        // ENCERRAR MODO DE LEITURA
        // ----------------------------------------------------

        cadastroRFID = {

            ativo: false,

            tipo: null,

            expiraEm: 0

        };


        // ----------------------------------------------------
        // RESPONDER AO ESP32
        // ----------------------------------------------------

        return res.json({

            sucesso: true,

            tipo: tipo,

            uid: uid,

            mensagem:
                "Tag capturada com sucesso.",

            rfid: rfidEvent

        });


    } catch (erro) {

        return responderErro(

            res,

            erro,

            400

        );

    }

}

// ============================================================
// INICIAR CADASTRO DE FUNCIONÁRIO
// ============================================================

app.post(
    "/api/rfid/cadastro/funcionario",
    (req, res) => {

        cadastroRFID = {

            ativo: true,

            tipo: "funcionario",

            expiraEm:
                Date.now() + 120000

        };


        publicarEvento({

            tipo: "cadastro_funcionario",

            modo: "cadastro",

            mensagem:
                "Passe a tag do novo funcionário."

        });


        res.json({

            sucesso: true,

            mensagem:
                "Passe a tag do novo funcionário."

        });

    }
);


// ============================================================
// INICIAR CADASTRO DE EQUIPAMENTO
// ============================================================

app.post(
    "/api/rfid/cadastro/equipamento",
    (req, res) => {

        cadastroRFID = {

            ativo: true,

            tipo: "equipamento",

            expiraEm:
                Date.now() + 120000

        };


        publicarEvento({

            tipo: "cadastro_equipamento",

            modo: "cadastro",

            mensagem:
                "Passe a tag do novo equipamento."

        });


        res.json({

            sucesso: true,

            mensagem:
                "Passe a tag do novo equipamento."

        });

    }
);


// ============================================================
// CANCELAR CADASTRO RFID
// ============================================================

app.post(
    "/api/rfid/cadastro/cancelar",
    (req, res) => {

        cadastroRFID = {

            ativo: false,

            tipo: null,

            expiraEm: 0

        };


        res.json({

            sucesso: true,

            mensagem:
                "Cadastro RFID cancelado."

        });

    }
);


// ============================================================
// LISTAR FUNCIONÁRIOS
// ============================================================

app.get(
    "/api/funcionarios",
    async (req, res) => {

        try {

            const resultado = await supabase

                .from("funcionarios")

                .select("*")

                .order(
                    "id",
                    {
                        ascending: true
                    }
                );


            if (resultado.error) {

                throw resultado.error;

            }


            res.json({

                sucesso: true,

                funcionarios:
                    resultado.data || []

            });


        } catch (erro) {

            responderErro(
                res,
                erro
            );

        }

    }
);


// ============================================================
// LISTAR EQUIPAMENTOS
// ============================================================

app.get(
    "/api/equipamentos",
    async (req, res) => {

        try {

            const resultado = await supabase

                .from("equipamentos")

                .select("*")

                .order(
                    "id",
                    {
                        ascending: true
                    }
                );


            if (resultado.error) {

                throw resultado.error;

            }


            res.json({

                sucesso: true,

                equipamentos:
                    resultado.data || []

            });


        } catch (erro) {

            responderErro(
                res,
                erro
            );

        }

    }
);


// ============================================================
// BUSCAR EQUIPAMENTO PELO ID
// ============================================================

app.get(
    "/api/equipamentos/:id",
    async (req, res) => {

        try {

            const id =
                Number(
                    req.params.id
                );


            if (!Number.isInteger(id)) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "ID inválido."

                });

            }


            const equipamento =
                await buscarEquipamentoPorId(
                    id
                );


            if (!equipamento) {

                return res.status(404).json({

                    sucesso: false,

                    mensagem:
                        "Equipamento não encontrado."

                });

            }


            res.json({

                sucesso: true,

                equipamento:
                    equipamentoPublico(
                        equipamento
                    )

            });


        } catch (erro) {

            responderErro(
                res,
                erro
            );

        }

    }
);


// ============================================================
// CADASTRAR FUNCIONÁRIO MANUALMENTE
// ============================================================

app.post(
    "/api/funcionarios",
    async (req, res) => {

        try {

            const nome =
                texto(
                    req.body?.nome
                ).trim();


            const matricula =
                texto(
                    req.body?.matricula
                ).trim();


            const uidTag =
                normalizarUID(
                    req.body?.uid_tag_pessoal
                    ??
                    req.body?.uid_rfid
                    ??
                    req.body?.uid
                );


            if (!nome) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "Nome é obrigatório."

                });

            }


            if (!matricula) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "Matrícula é obrigatória."

                });

            }


            if (!uidTag) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "UID da tag é obrigatório."

                });

            }


            const resultado =
                await supabase

                    .from("funcionarios")

                    .insert([{

                        nome: nome,

                        matricula: matricula,

                        uid_tag_pessoal: uidTag,

                        setor:
                            texto(
                                req.body?.setor
                            ).trim() || null,

                        ativo: true

                    }])

                    .select()

                    .single();


            if (resultado.error) {

                throw resultado.error;

            }


            res.status(201).json({

                sucesso: true,

                funcionario:
                    funcionarioPublico(
                        resultado.data
                    ),

                mensagem:
                    "Funcionário cadastrado."

            });


        } catch (erro) {

            responderErro(
                res,
                erro,
                400
            );

        }

    }
);


// ============================================================
// DESATIVAR FUNCIONÁRIO
// ============================================================

app.delete(
    "/api/funcionarios/:id",
    async (req, res) => {

        try {

            const id =
                Number(
                    req.params.id
                );


            const ativos =
                await emprestimosAtivosFuncionario(
                    id
                );


            if (ativos.length > 0) {

                return res.status(409).json({

                    sucesso: false,

                    mensagem:
                        "Não é possível desativar este funcionário enquanto ele estiver com equipamento emprestado."

                });

            }


            const resultado =
                await supabase

                    .from("funcionarios")

                    .update({

                        ativo: false

                    })

                    .eq(
                        "id",
                        id
                    )

                    .select()

                    .maybeSingle();


            if (resultado.error) {

                throw resultado.error;

            }


            if (!resultado.data) {

                return res.status(404).json({

                    sucesso: false,

                    mensagem:
                        "Funcionário não encontrado."

                });

            }


            res.json({

                sucesso: true,

                mensagem:
                    "Funcionário desativado."

            });


        } catch (erro) {

            responderErro(
                res,
                erro,
                400
            );

        }

    }
);


// ============================================================
// CADASTRAR EQUIPAMENTO MANUALMENTE
// ============================================================

app.post(
    "/api/equipamentos",
    async (req, res) => {

        try {

            const nome =
                texto(
                    req.body?.nome
                ).trim();


            const descricao =
                texto(
                    req.body?.descricao
                ).trim();


            const uidTag =
                normalizarUID(
                    req.body?.uid_tag
                    ??
                    req.body?.uid_rfid
                    ??
                    req.body?.uid
                );


            if (!nome) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "Nome é obrigatório."

                });

            }


            if (!uidTag) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "UID da tag é obrigatório."

                });

            }


            const resultado =
                await supabase

                    .from("equipamentos")

                    .insert([{

                        nome: nome,

                        descricao:
                            descricao || null,

                        uid_tag: uidTag,

                        status: "disponivel",

                        ativo: true

                    }])

                    .select()

                    .single();


            if (resultado.error) {

                throw resultado.error;

            }


            res.status(201).json({

                sucesso: true,

                equipamento:
                    equipamentoPublico(
                        resultado.data
                    ),

                mensagem:
                    "Equipamento cadastrado."

            });


        } catch (erro) {

            responderErro(
                res,
                erro,
                400
            );

        }

    }
);


// ============================================================
// ALTERAR EQUIPAMENTO
// ============================================================

app.put(
    "/api/equipamentos/:id",
    async (req, res) => {

        try {

            const id =
                Number(
                    req.params.id
                );


            const dados = {};


            if (
                req.body?.nome !== undefined
            ) {

                dados.nome =
                    texto(
                        req.body.nome
                    ).trim();

            }


            if (
                req.body?.descricao !== undefined
            ) {

                dados.descricao =
                    texto(
                        req.body.descricao
                    ).trim() || null;

            }


            if (
                req.body?.uid_tag !== undefined ||
                req.body?.uid_rfid !== undefined
            ) {

                dados.uid_tag =
                    normalizarUID(
                        req.body.uid_tag
                        ??
                        req.body.uid_rfid
                    );

            }


            if (
                req.body?.status !== undefined
            ) {

                const statusNovo =
                    normalizarStatus(
                        req.body.status
                    );


                if (
                    ![
                        "disponivel",
                        "emprestado",
                        "manutencao"
                    ].includes(
                        statusNovo
                    )
                ) {

                    return res.status(400).json({

                        sucesso: false,

                        mensagem:
                            "Status inválido."

                    });

                }


                dados.status =
                    statusNovo;

            }


            if (
                Object.keys(dados).length === 0
            ) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "Nenhum dado para alterar."

                });

            }


            const resultado =
                await supabase

                    .from("equipamentos")

                    .update(dados)

                    .eq(
                        "id",
                        id
                    )

                    .select()

                    .maybeSingle();


            if (resultado.error) {

                throw resultado.error;

            }


            if (!resultado.data) {

                return res.status(404).json({

                    sucesso: false,

                    mensagem:
                        "Equipamento não encontrado."

                });

            }


            res.json({

                sucesso: true,

                equipamento:
                    equipamentoPublico(
                        resultado.data
                    ),

                mensagem:
                    "Equipamento atualizado."

            });


        } catch (erro) {

            responderErro(
                res,
                erro,
                400
            );

        }

    }
);


// ============================================================
// DESATIVAR EQUIPAMENTO
// ============================================================

app.delete(
    "/api/equipamentos/:id",
    async (req, res) => {

        try {

            const id =
                Number(
                    req.params.id
                );


            const emprestimo =
                await emprestimoAtivoEquipamento(
                    id
                );


            if (emprestimo) {

                return res.status(409).json({

                    sucesso: false,

                    mensagem:
                        "Não é possível desativar um equipamento que está emprestado."

                });

            }


            const resultado =
                await supabase

                    .from("equipamentos")

                    .update({

                        ativo: false

                    })

                    .eq(
                        "id",
                        id
                    )

                    .select()

                    .maybeSingle();


            if (resultado.error) {

                throw resultado.error;

            }


            if (!resultado.data) {

                return res.status(404).json({

                    sucesso: false,

                    mensagem:
                        "Equipamento não encontrado."

                });

            }


            res.json({

                sucesso: true,

                mensagem:
                    "Equipamento desativado."

            });


        } catch (erro) {

            responderErro(
                res,
                erro,
                400
            );

        }

    }
);


// ============================================================
// LISTAR EMPRÉSTIMOS
// ============================================================

app.get(
    "/api/emprestimos",
    async (req, res) => {

        try {

            const resultado =
                await supabase

                    .from("emprestimos")

                    .select("*")

                    .order(
                        "id",
                        {
                            ascending: false
                        }
                    );


            if (resultado.error) {

                throw resultado.error;

            }


            const lista =
                resultado.data || [];


            const completa =
                await Promise.all(

                    lista.map(
                        async emprestimo => {

                            const funcionario =
                                await buscarFuncionarioPorId(
                                    emprestimo.funcionario_id
                                );


                            const equipamento =
                                await buscarEquipamentoPorId(
                                    emprestimo.equipamento_id
                                );


                            return {

                                ...emprestimo,

                                funcionario:
                                    funcionarioPublico(
                                        funcionario
                                    ),

                                equipamento:
                                    equipamentoPublico(
                                        equipamento
                                    )

                            };

                        }
                    )

                );


            res.json({

                sucesso: true,

                emprestimos:
                    completa

            });


        } catch (erro) {

            responderErro(
                res,
                erro
            );

        }

    }
);


// ============================================================
// FUNÇÕES PARA BUSCAR FUNCIONÁRIO POR ID
// ============================================================

async function buscarFuncionarioPorId(
    id
) {

    if (!id) {

        return null;

    }


    const resultado =
        await supabase

            .from("funcionarios")

            .select("*")

            .eq(
                "id",
                id
            )

            .maybeSingle();


    if (resultado.error) {

        throw resultado.error;

    }


    return resultado.data || null;

}


// ============================================================
// ÚLTIMOS EMPRÉSTIMOS
// ============================================================

app.get(
    "/api/ultimos-emprestimos",
    async (req, res) => {

        try {

            const resultado =
                await supabase

                    .from("emprestimos")

                    .select("*")

                    .order(
                        "id",
                        {
                            ascending: false
                        }
                    )

                    .limit(10);


            if (resultado.error) {

                throw resultado.error;

            }


            const lista =
                resultado.data || [];


            const completa =
                await Promise.all(

                    lista.map(
                        async emprestimo => {

                            const funcionario =
                                await buscarFuncionarioPorId(
                                    emprestimo.funcionario_id
                                );


                            const equipamento =
                                await buscarEquipamentoPorId(
                                    emprestimo.equipamento_id
                                );


                            return {

                                ...emprestimo,

                                funcionario:
                                    funcionarioPublico(
                                        funcionario
                                    ),

                                equipamento:
                                    equipamentoPublico(
                                        equipamento
                                    )

                            };

                        }
                    )

                );


            res.json({

                sucesso: true,

                emprestimos:
                    completa

            });


        } catch (erro) {

            responderErro(
                res,
                erro
            );

        }

    }
);


// ============================================================
// DASHBOARD
// ============================================================

app.get(
    "/api/dashboard",
    async (req, res) => {

        try {

            const funcionarios =
                await supabase

                    .from("funcionarios")

                    .select(
                        "id",
                        {
                            count: "exact",
                            head: true
                        }
                    )

                    .eq(
                        "ativo",
                        true
                    );


            const equipamentos =
                await supabase

                    .from("equipamentos")

                    .select(
                        "id,status"
                    )

                    .eq(
                        "ativo",
                        true
                    );


            const emprestimos =
                await supabase

                    .from("emprestimos")

                    .select("id")

                    .eq(
                        "status",
                        "emprestado"
                    )

                    .is(
                        "data_devolucao",
                        null
                    );


            if (funcionarios.error) {

                throw funcionarios.error;

            }


            if (equipamentos.error) {

                throw equipamentos.error;

            }


            if (emprestimos.error) {

                throw emprestimos.error;

            }


            const lista =
                equipamentos.data || [];


            res.json({

                sucesso: true,

                funcionarios:
                    funcionarios.count || 0,

                equipamentos:
                    lista.length,

                disponiveis:
                    lista.filter(
                        equipamento =>
                            normalizarStatus(
                                equipamento.status
                            ) ===
                            "disponivel"
                    ).length,

                emprestados:
                    emprestimos.data?.length || 0

            });


        } catch (erro) {

            responderErro(
                res,
                erro
            );

        }

    }
);


// ============================================================
// HISTÓRICO DAS OPERAÇÕES
// ============================================================

app.get(
    "/api/operacoes-rfid",
    async (req, res) => {

        try {

            const resultado =
                await supabase

                    .from("operacoes_rfid")

                    .select("*")

                    .order(
                        "id",
                        {
                            ascending: false
                        }
                    )

                    .limit(100);


            if (resultado.error) {

                throw resultado.error;

            }


            res.json({

                sucesso: true,

                operacoes:
                    resultado.data || []

            });


        } catch (erro) {

            responderErro(
                res,
                erro
            );

        }

    }
);


// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.use(
    (req, res) => {

        res.status(404).json({

            sucesso: false,

            erro:
                "Rota não encontrada.",

            rota:
                req.originalUrl

        });

    }
);


app.use(
    (erro, req, res, next) => {

        console.error(
            "ERRO GERAL:",
            erro
        );


        res.status(500).json({

            sucesso: false,

            erro:
                "Erro interno do servidor."

        });

    }
);


// ============================================================
// START
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "============================================================"
        );

        console.log(
            " INVENTÁRIO RFID - NOVO FLUXO"
        );

        console.log(
            ` Servidor: http://localhost:${PORT}`
        );

        console.log(
            " Banco: Supabase"
        );

        console.log(
            " Uma única caixa"
        );

        console.log(
            " Box/box_id não são usados"
        );

        console.log(
            " Trava física: ainda não conectada"
        );

        console.log(
            "============================================================"
        );

    }
);