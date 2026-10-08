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
        "ERRO: configure SUPABASE_URL e SUPABASE_SECRET_KEY no .env"
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
// EXPRESS
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
// COMANDO PARA O ESP32
// ============================================================

let comandoESP32 = {

    id: 0,

    tipo: "nenhum",

    criadoEm: 0,

    lido: true,

    parametros: {}

};


// ============================================================
// EVENTO RFID
// ============================================================

let rfidEvent = {

    nova: false,

    id: 0,

    uid: null,

    tipo: "idle",

    modo: "idle",

    mensagem:
        "Passe a tag do funcionário.",

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

let fluxo = {

    modo: "idle",

    funcionario: null,

    acao: null,

    equipamentoSelecionado: null,

    emprestimoId: null,

    expiraEm: 0

};


// ============================================================
// CADASTRO RFID
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

    if (
        valor === null ||
        valor === undefined
    ) {

        return fallback;

    }

    return String(valor);

}


function normalizarUID(valor) {

    return texto(valor)
        .toUpperCase()
        .replace(
            /[^A-Z0-9]/g,
            ""
        );

}


function normalizarStatus(valor) {

    return texto(valor)
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(
            /[\u0300-\u036f]/g,
            ""
        );

}


function responderErro(
    res,
    erro,
    codigo = 500
) {

    console.error(
        "ERRO:",
        erro
    );

    return res
        .status(codigo)
        .json({

            sucesso: false,

            mensagem:
                erro?.message ||
                String(erro),

            erro:
                erro?.message ||
                String(erro)

        });

}


// ============================================================
// OBJETOS PÚBLICOS
// ============================================================

function funcionarioPublico(
    funcionario
) {

    if (!funcionario) {

        return null;

    }

    return {

        id:
            funcionario.id,

        nome:
            funcionario.nome,

        matricula:
            funcionario.matricula,

        uid_tag_pessoal:
            funcionario.uid_tag_pessoal,

        setor:
            funcionario.setor ?? null

    };

}


function equipamentoPublico(
    equipamento
) {

    if (!equipamento) {

        return null;

    }

    return {

        id:
            equipamento.id,

        nome:
            equipamento.nome,

        descricao:
            equipamento.descricao ?? null,

        uid_tag:
            equipamento.uid_tag,

        status:
            equipamento.status,

        ativo:
            equipamento.ativo

    };

}


// ============================================================
// PUBLICAR EVENTO RFID
// ============================================================

function publicarEvento(
    dados = {}
) {

    rfidEvent = {

        nova: true,

        id: Date.now(),

        uid:
            dados.uid || null,

        tipo:
            dados.tipo || "idle",

        modo:
            dados.modo || "idle",

        mensagem:
            dados.mensagem || "",

        funcionario:
            dados.funcionario || null,

        equipamento:
            dados.equipamento || null,

        equipamentos:
            dados.equipamentos || [],

        equipamentoRecebido:
            dados.equipamentoRecebido ||
            null,

        equipamentoEsperado:
            dados.equipamentoEsperado ||
            null,

        acaoTrava:
            dados.acaoTrava ||
            null,

        momento:
            Date.now()

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

            tipo:
                "fluxo_expirado",

            modo:
                "idle",

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

function solicitarAbertura(
    motivo,
    equipamento = null
) {

    comandoESP32 = {

        id:
            Date.now(),

        tipo:
            "liberar_caixa",

        criadoEm:
            Date.now(),

        lido:
            false,

        parametros: {

            motivo:
                motivo,

            equipamento_id:
                equipamento?.id ?? null,

            tempo_liberacao_ms:
                5000

        }

    };

    return comandoESP32;

}


// ============================================================
// BUSCAR FUNCIONÁRIO POR UID
// ============================================================

async function buscarFuncionarioPorUID(
    uid
) {

    const resultado =
        await supabase
            .from("funcionarios")
            .select("*")
            .eq(
                "uid_tag_pessoal",
                uid
            )
            .maybeSingle();


    if (resultado.error) {

        throw resultado.error;

    }


    return resultado.data || null;

}


// ============================================================
// BUSCAR FUNCIONÁRIO POR ID
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
// BUSCAR EQUIPAMENTO POR UID
// ============================================================

async function buscarEquipamentoPorUID(
    uid
) {

    const resultado =
        await supabase
            .from("equipamentos")
            .select("*")
            .eq(
                "uid_tag",
                uid
            )
            .maybeSingle();


    if (resultado.error) {

        throw resultado.error;

    }


    return resultado.data || null;

}


// ============================================================
// BUSCAR EQUIPAMENTO POR ID
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
// EMPRÉSTIMOS ATIVOS DO FUNCIONÁRIO
// ============================================================

async function emprestimosAtivosFuncionario(
    funcionarioId
) {

    const resultado =
        await supabase
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

async function emprestimoAtivoEquipamento(
    equipamentoId
) {

    const resultado =
        await supabase
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
// EQUIPAMENTOS DISPONÍVEIS
// ============================================================

async function buscarEquipamentosDisponiveis() {

    const resultado =
        await supabase
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


    return (
        resultado.data || []
    ).filter(

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
        await buscarFuncionarioPorUID(
            uid
        );


    if (funcionario) {

        return {

            encontrado: true,

            categoria:
                "funcionario",

            registro:
                funcionario

        };

    }


    const equipamento =
        await buscarEquipamentoPorUID(
            uid
        );


    if (equipamento) {

        return {

            encontrado: true,

            categoria:
                "equipamento",

            registro:
                equipamento

        };

    }


    return {

        encontrado: false

    };

}


// ============================================================
// CADASTRO RFID
// ============================================================

async function processarCadastroRFID(
    uid,
    res
) {

    if (!cadastroRFID.ativo) {

        return res.json({

            sucesso: false,

            mensagem:
                "Cadastro RFID não está ativo."

        });

    }


    const tipo =
        cadastroRFID.tipo;


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
                "Tipo de cadastro inválido."

        });

    }


    publicarEvento({

        uid:

            uid,

        tipo:

            tipo === "funcionario"
                ? "cadastro_tag_funcionario"
                : "cadastro_tag_equipamento",

        modo:

            "cadastro",

        mensagem:

            "Tag capturada com sucesso."

    });


    cadastroRFID = {

        ativo: false,

        tipo: null,

        expiraEm: 0

    };


    return res.json({

        sucesso: true,

        tipo:

            tipo,

        uid:

            uid,

        mensagem:

            "Tag capturada com sucesso.",

        rfid:

            rfidEvent

    });

}


// ============================================================
// PROCESSAR TAG DO FUNCIONÁRIO
// ============================================================

async function processarTagFuncionario(
    uid,
    funcionario,
    res
) {

    if (!funcionario.ativo) {

        publicarEvento({

            uid:

                uid,

            tipo:

                "funcionario_inativo",

            modo:

                "erro",

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
    // FINALIZAÇÃO DA RETIRADA
    // ========================================================

    if (
        fluxo.modo ===
        "retirada_aguardando_confirmacao"
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
                    "Esta retirada pertence a outro funcionário."

            });

        }


        const equipamento =
            await buscarEquipamentoPorId(
                fluxo.equipamentoSelecionado.id
            );


        publicarEvento({

            uid:

                uid,

            tipo:

                "retirada_concluida",

            modo:

                "concluida",

            funcionario:

                funcionarioPublico(
                    funcionario
                ),

            equipamento:

                equipamentoPublico(
                    equipamento
                ),

            mensagem:

                "Retirada concluída com sucesso. O equipamento está registrado como emprestado."

        });


        limparFluxo();


        return res.json({

            sucesso: true,

            mensagem:
                "Retirada concluída.",

            funcionario:
                funcionarioPublico(
                    funcionario
                ),

            equipamento:
                equipamentoPublico(
                    equipamento
                )

        });

    }


    // ========================================================
    // FINALIZAÇÃO DA DEVOLUÇÃO
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


        const emprestimoId =
            fluxo.emprestimoId;


        const emprestimo =
            await supabase
                .from("emprestimos")
                .update({

                    status:
                        "devolvido",

                    data_devolucao:
                        agora()

                })
                .eq(
                    "id",
                    emprestimoId
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

            return res.status(409).json({

                sucesso: false,

                mensagem:
                    "O empréstimo já foi finalizado ou não existe."

            });

        }


        const equipamento =
            await supabase
                .from("equipamentos")
                .update({

                    status:
                        "disponivel"

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


        publicarEvento({

            uid:

                uid,

            tipo:

                "devolucao_concluida",

            modo:

                "concluida",

            funcionario:

                funcionarioPublico(
                    funcionario
                ),

            equipamento:

                equipamentoPublico(
                    equipamento.data
                ),

            mensagem:

                "Devolução concluída com sucesso."

        });


        limparFluxo();


        return res.json({

            sucesso: true,

            mensagem:
                "Devolução concluída.",

            funcionario:
                funcionarioPublico(
                    funcionario
                ),

            equipamento:
                equipamentoPublico(
                    equipamento.data
                )

        });

    }


    // ========================================================
    // NÃO PODE COMEÇAR OUTRA OPERAÇÃO
    // ========================================================

    if (
        fluxo.modo !==
        "idle"
    ) {

        return res.status(409).json({

            sucesso: false,

            mensagem:
                "Existe uma operação em andamento. Finalize-a antes de iniciar outra."

        });

    }


    // ========================================================
    // VERIFICAR SE POSSUI EMPRÉSTIMO
    // ========================================================

    const ativos =
        await emprestimosAtivosFuncionario(
            funcionario.id
        );


    // ========================================================
    // SE POSSUI EMPRÉSTIMO -> DEVOLUÇÃO
    // ========================================================

    if (
        ativos.length > 0
    ) {

        const primeiro =
            ativos[0];


        const equipamento =
            await buscarEquipamentoPorId(
                primeiro.equipamento_id
            );


        fluxo = {

            modo:
                "devolucao",

            funcionario:
                funcionario,

            acao:
                "devolucao",

            equipamentoSelecionado:
                equipamento,

            emprestimoId:
                primeiro.id,

            expiraEm:
                Date.now() +
                120000

        };


        publicarEvento({

            uid:

                uid,

            tipo:

                "funcionario_identificado",

            modo:

                "devolucao",

            funcionario:

                funcionarioPublico(
                    funcionario
                ),

            equipamento:

                equipamentoPublico(
                    equipamento
                ),

            mensagem:

                `Olá, ${funcionario.nome}. Você deve devolver "${equipamento?.nome || "equipamento"}". Passe a tag do equipamento.`

        });


        return res.json({

            sucesso: true,

            modo:
                "devolucao",

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

            rfid:
                rfidEvent

        });

    }


    // ========================================================
    // NÃO POSSUI EMPRÉSTIMO -> RETIRADA
    // ========================================================

    const disponiveis =
        await buscarEquipamentosDisponiveis();


    fluxo = {

        modo:
            "retirada",

        funcionario:
            funcionario,

        acao:
            "retirada",

        equipamentoSelecionado:
            null,

        emprestimoId:
            null,

        expiraEm:
            Date.now() +
            120000

    };


    publicarEvento({

        uid:

            uid,

        tipo:

            "funcionario_identificado",

        modo:

            "retirada",

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

        modo:
            "retirada",

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

        rfid:
            rfidEvent

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
    // SEM FLUXO
    // ========================================================

    if (
        fluxo.modo ===
        "idle"
    ) {

        publicarEvento({

            uid:

                uid,

            tipo:

                "equipamento_sem_fluxo",

            modo:

                "erro",

            equipamento:

                equipamentoPublico(
                    equipamento
                ),

            mensagem:

                "Primeiro passe a tag do funcionário."

        });


        return res.status(409).json({

            sucesso: false,

            mensagem:
                "Primeiro passe a tag do funcionário."

        });

    }


    // ========================================================
    // RETIRADA
    // ========================================================

    if (
        fluxo.modo ===
        "retirada"
    ) {

        if (
            normalizarStatus(
                equipamento.status
            ) !==
            "disponivel"
        ) {

            return res.status(409).json({

                sucesso: false,

                mensagem:
                    "Esse equipamento não está disponível."

            });

        }


        // ----------------------------------------------------
        // VERIFICAR SE É O EQUIPAMENTO ESCOLHIDO
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

                uid:

                    uid,

                tipo:

                    "equipamento_incorreto",

                modo:

                    "retirada",

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


            return res.status(409).json({

                sucesso: false,

                mensagem:
                    "Equipamento incorreto.",

                equipamentoEsperado:

                    equipamentoPublico(
                        fluxo.equipamentoSelecionado
                    )

            });

        }


        // ----------------------------------------------------
        // VERIFICAR DUPLICIDADE DE EMPRÉSTIMO
        // ----------------------------------------------------

        const ativo =
            await emprestimoAtivoEquipamento(
                equipamento.id
            );


        if (ativo) {

            return res.status(409).json({

                sucesso: false,

                mensagem:
                    "Esse equipamento já possui um empréstimo ativo."

            });

        }


        // ----------------------------------------------------
        // REGISTRAR EMPRÉSTIMO IMEDIATAMENTE
        // ----------------------------------------------------

        const novoEmprestimo =
            await supabase
                .from("emprestimos")
                .insert([{

                    funcionario_id:
                        Number(
                            fluxo.funcionario.id
                        ),

                    equipamento_id:
                        Number(
                            equipamento.id
                        ),

                    data_retirada:
                        agora(),

                    data_devolucao:
                        null,

                    status:
                        "emprestado",

                    criado_em:
                        agora()

                }])
                .select("*")
                .single();


        if (novoEmprestimo.error) {

            throw novoEmprestimo.error;

        }


        // ----------------------------------------------------
        // MARCAR EQUIPAMENTO COMO EMPRESTADO
        // ----------------------------------------------------

        const equipamentoAtualizado =
            await supabase
                .from("equipamentos")
                .update({

                    status:
                        "emprestado"

                })
                .eq(
                    "id",
                    equipamento.id
                )
                .eq(
                    "status",
                    "disponivel"
                )
                .select("*")
                .maybeSingle();


        if (
            equipamentoAtualizado.error
        ) {

            await supabase
                .from("emprestimos")
                .delete()
                .eq(
                    "id",
                    novoEmprestimo.data.id
                );

            throw equipamentoAtualizado.error;

        }


        if (
            !equipamentoAtualizado.data
        ) {

            await supabase
                .from("emprestimos")
                .delete()
                .eq(
                    "id",
                    novoEmprestimo.data.id
                );

            return res.status(409).json({

                sucesso: false,

                mensagem:
                    "O equipamento deixou de estar disponível."

            });

        }


        // ----------------------------------------------------
        // AGORA O EMPRÉSTIMO JÁ ESTÁ REGISTRADO
        // ----------------------------------------------------

        fluxo.equipamentoSelecionado =
            equipamentoAtualizado.data;

        fluxo.emprestimoId =
            novoEmprestimo.data.id;

        fluxo.modo =
            "retirada_aguardando_confirmacao";

        fluxo.expiraEm =
            Date.now() +
            120000;


        // ----------------------------------------------------
        // PEDIR ABERTURA DA CAIXA
        // ----------------------------------------------------

        solicitarAbertura(
            "retirada",
            equipamentoAtualizado.data
        );


        // ----------------------------------------------------
        // EVENTO PARA O SITE
        // ----------------------------------------------------

        publicarEvento({

            uid:

                uid,

            tipo:

                "equipamento_confirmado",

            modo:

                "retirada_aguardando_confirmacao",

            funcionario:

                funcionarioPublico(
                    fluxo.funcionario
                ),

            equipamento:

                equipamentoPublico(
                    equipamentoAtualizado.data
                ),

            acaoTrava:

                "liberar_caixa",

            mensagem:

                `Equipamento "${equipamentoAtualizado.data.nome}" confirmado. O empréstimo já foi registrado. Retire o equipamento e depois passe novamente sua tag.`

        });


        return res.json({

            sucesso: true,

            modo:
                fluxo.modo,

            emprestimoId:
                novoEmprestimo.data.id,

            equipamento:

                equipamentoPublico(
                    equipamentoAtualizado.data
                ),

            comando:
                comandoESP32,

            mensagem:
                "Empréstimo registrado. Caixa liberada por 5 segundos."

        });

    }


    // ========================================================
    // DEVOLUÇÃO
    // ========================================================

    if (
        fluxo.modo ===
        "devolucao"
    ) {

        const esperado =
            fluxo.equipamentoSelecionado;


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

                uid:

                    uid,

                tipo:

                    "equipamento_incorreto",

                modo:

                    "devolucao",

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


            return res.status(409).json({

                sucesso: false,

                mensagem:
                    "Equipamento incorreto.",

                equipamentoEsperado:

                    equipamentoPublico(
                        esperado
                    )

            });

        }


        const emprestimo =
            await emprestimoAtivoEquipamento(
                equipamento.id
            );


        if (
            !emprestimo ||
            Number(
                emprestimo.funcionario_id
            ) !==
            Number(
                fluxo.funcionario.id
            )
        ) {

            return res.status(409).json({

                sucesso: false,

                mensagem:
                    "Esse equipamento não está emprestado para este funcionário."

            });

        }


        // ----------------------------------------------------
        // AGUARDAR SEGUNDA TAG DO FUNCIONÁRIO
        // ----------------------------------------------------

        fluxo.emprestimoId =
            emprestimo.id;

        fluxo.modo =
            "devolucao_aguardando_confirmacao";

        fluxo.expiraEm =
            Date.now() +
            120000;


        // ----------------------------------------------------
        // ABRIR CAIXA
        // ----------------------------------------------------

        solicitarAbertura(
            "devolucao",
            equipamento
        );


        publicarEvento({

            uid:

                uid,

            tipo:

                "equipamento_devolucao_confirmado",

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

                "Equipamento confirmado. Caixa liberada por 5 segundos. Coloque o equipamento dentro, feche a caixa e passe novamente sua tag."

        });


        return res.json({

            sucesso: true,

            modo:

                "devolucao_aguardando_confirmacao",

            equipamento:

                equipamentoPublico(
                    equipamento
                ),

            comando:

                comandoESP32,

            mensagem:

                "Caixa liberada por 5 segundos."

        });

    }


    return res.status(409).json({

        sucesso: false,

        mensagem:
            "Fluxo RFID inválido."

    });

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

            timestamp:
                agora()

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

                esp32:
                    esp32,

                fluxo:
                    fluxo,

                comandoESP32:
                    comandoESP32,

                rfid:
                    rfidEvent

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

        esp32 = {

            conectado:
                true,

            ultimoContato:
                agora(),

            ip:
                req.body?.ip ||
                req.ip ||
                null

        };


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

        esp32.conectado =
            true;

        esp32.ultimoContato =
            agora();


        res.json({

            sucesso: true,

            comando:
                {
                    ...comandoESP32
                }

        });

    }
);


// ============================================================
// ESP32 CONFIRMA COMANDO
// ============================================================

app.post(
    "/api/esp32/comando/confirmar",
    (req, res) => {

        esp32.conectado =
            true;

        esp32.ultimoContato =
            agora();


        const id =
            Number(
                req.body?.id
            );


        if (
            id &&
            id ===
            Number(
                comandoESP32.id
            )
        ) {

            comandoESP32.lido =
                true;

        }


        res.json({

            sucesso: true,

            mensagem:
                "Comando confirmado.",

            comando:
                comandoESP32

        });

    }
);


// ============================================================
// ESP32 ENVIA RFID
// ============================================================

app.post(
    "/api/esp32/rfid",
    async (req, res) => {

        try {

            esp32.conectado =
                true;

            esp32.ultimoContato =
                agora();


            let uid =
                req.body?.uid;


            if (!uid) {
                uid =
                    req.body?.tag;
            }


            if (!uid) {
                uid =
                    req.body?.rfid;
            }


            uid =
                normalizarUID(uid);


            if (!uid) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "UID da tag não informado."

                });

            }


            const agoraMs =
                Date.now();


            if (
                ultimaLeitura.uid === uid &&
                agoraMs -
                    ultimaLeitura.momento <
                    1500
            ) {

                return res.json({

                    sucesso: true,

                    duplicada:
                        true,

                    mensagem:
                        "Leitura duplicada ignorada."

                });

            }


            ultimaLeitura = {

                uid:
                    uid,

                momento:
                    agoraMs

            };


            verificarExpiracao();


            if (
                cadastroRFID.ativo
            ) {

                return processarCadastroRFID(
                    uid,
                    res
                );

            }


            const encontrado =
                await verificarUID(
                    uid
                );


            if (
                !encontrado.encontrado
            ) {

                publicarEvento({

                    uid:

                        uid,

                    tipo:

                        "tag_desconhecida",

                    modo:

                        fluxo.modo,

                    mensagem:

                        "Tag não cadastrada."

                });


                return res.status(404).json({

                    sucesso: false,

                    mensagem:
                        "Tag não cadastrada.",

                    rfid:
                        rfidEvent

                });

            }


            if (
                encontrado.categoria ===
                "funcionario"
            ) {

                return processarTagFuncionario(
                    uid,
                    encontrado.registro,
                    res
                );

            }


            return processarTagEquipamento(
                uid,
                encontrado.registro,
                res
            );

        } catch (erro) {

            return responderErro(
                res,
                erro
            );

        }

    }
);


// ============================================================
// ESTADO RFID
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

            rfid:
                rfidEvent,

            comandoESP32:
                comandoESP32

        });

    }
);


// ============================================================
// EVENTO RFID
// ============================================================

app.get(
    "/api/rfid/evento",
    (req, res) => {

        res.json({

            sucesso: true,

            evento:
                rfidEvent

        });

    }
);


app.post(
    "/api/rfid/evento/ler",
    (req, res) => {

        rfidEvent.nova =
            false;


        res.json({

            sucesso: true

        });

    }
);


// ============================================================
// INICIAR CADASTRO FUNCIONÁRIO
// ============================================================

app.post(
    "/api/rfid/cadastro/funcionario",
    (req, res) => {

        cadastroRFID = {

            ativo:
                true,

            tipo:
                "funcionario",

            expiraEm:
                Date.now() +
                120000

        };


        publicarEvento({

            tipo:
                "cadastro_funcionario",

            modo:
                "cadastro",

            mensagem:
                "Passe a tag do novo funcionário."

        });


        res.json({

            sucesso:
                true,

            mensagem:
                "Passe a tag do novo funcionário."

        });

    }
);


// ============================================================
// INICIAR CADASTRO EQUIPAMENTO
// ============================================================

app.post(
    "/api/rfid/cadastro/equipamento",
    (req, res) => {

        cadastroRFID = {

            ativo:
                true,

            tipo:
                "equipamento",

            expiraEm:
                Date.now() +
                120000

        };


        publicarEvento({

            tipo:
                "cadastro_equipamento",

            modo:
                "cadastro",

            mensagem:
                "Passe a tag do novo equipamento."

        });


        res.json({

            sucesso:
                true,

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

            ativo:
                false,

            tipo:
                null,

            expiraEm:
                0

        };


        res.json({

            sucesso:
                true,

            mensagem:
                "Cadastro RFID cancelado."

        });

    }
);


// ============================================================
// ESCOLHER EQUIPAMENTO
// ============================================================

app.post(
    "/api/retirada/escolher",
    async (req, res) => {

        try {

            if (
                fluxo.modo !==
                "retirada"
            ) {

                return res.status(409).json({

                    sucesso: false,

                    mensagem:
                        "Não existe uma retirada em andamento."

                });

            }


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
                !equipamento.ativo ||
                normalizarStatus(
                    equipamento.status
                ) !==
                "disponivel"
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


            publicarEvento({

                tipo:
                    "equipamento_escolhido",

                modo:
                    "retirada",

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


            res.json({

                sucesso:
                    true,

                equipamento:
                    equipamentoPublico(
                        equipamento
                    ),

                mensagem:
                    "Passe a tag do equipamento."

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
// FUNCIONÁRIOS
// ============================================================

app.get(
    "/api/funcionarios",
    async (req, res) => {

        try {

            const resultado =
                await supabase
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

                sucesso:
                    true,

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


            const uid =
                normalizarUID(
                    req.body?.uid_tag_pessoal ||
                    req.body?.uid
                );


            if (
                !nome ||
                !matricula ||
                !uid
            ) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "Nome, matrícula e UID são obrigatórios."

                });

            }


            const resultado =
                await supabase
                    .from("funcionarios")
                    .insert([{

                        nome:
                            nome,

                        matricula:
                            matricula,

                        uid_tag_pessoal:
                            uid,

                        ativo:
                            true

                    }])
                    .select()
                    .single();


            if (resultado.error) {

                throw resultado.error;

            }


            res.status(201).json({

                sucesso:
                    true,

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


            if (
                ativos.length
            ) {

                return res.status(409).json({

                    sucesso: false,

                    mensagem:
                        "Não é possível desativar funcionário com equipamento emprestado."

                });

            }


            const resultado =
                await supabase
                    .from("funcionarios")
                    .update({

                        ativo:
                            false

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

                sucesso:
                    true,

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
// EQUIPAMENTOS
// ============================================================

app.get(
    "/api/equipamentos",
    async (req, res) => {

        try {

            const resultado =
                await supabase
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

                sucesso:
                    true,

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


            const uid =
                normalizarUID(
                    req.body?.uid_tag ||
                    req.body?.uid
                );


            if (
                !nome ||
                !uid
            ) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "Nome e UID são obrigatórios."

                });

            }


            const resultado =
                await supabase
                    .from("equipamentos")
                    .insert([{

                        nome:
                            nome,

                        descricao:
                            descricao ||
                            null,

                        uid_tag:
                            uid,

                        status:
                            "disponivel",

                        ativo:
                            true

                    }])
                    .select()
                    .single();


            if (resultado.error) {

                throw resultado.error;

            }


            res.status(201).json({

                sucesso:
                    true,

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
                        "Não é possível desativar equipamento emprestado."

                });

            }


            const resultado =
                await supabase
                    .from("equipamentos")
                    .update({

                        ativo:
                            false

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

                sucesso:
                    true,

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
// EMPRÉSTIMOS
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

                sucesso:
                    true,

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
                            count:
                                "exact",

                            head:
                                true

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


            if (
                funcionarios.error
            ) {

                throw funcionarios.error;

            }


            if (
                equipamentos.error
            ) {

                throw equipamentos.error;

            }


            if (
                emprestimos.error
            ) {

                throw emprestimos.error;

            }


            const lista =
                equipamentos.data || [];


            res.json({

                sucesso:
                    true,

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
                    emprestimos.data?.length ||
                    0

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

                sucesso:
                    true,

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
// INICIAR SERVIDOR
// ============================================================

app.listen(
    PORT,
    () => {

        console.log(
            "===================================="
        );

        console.log(
            " INVENTÁRIO RFID"
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
            " Tranca: GPIO 4 no ESP32"
        );

        console.log(
            " Abertura: 5 segundos"
        );

        console.log(
            "===================================="
        );

    }
);