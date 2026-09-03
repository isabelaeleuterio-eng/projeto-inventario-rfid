
require("dotenv").config();

const express = require("express");
const path = require("path");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_DIR = path.join(__dirname, "SITE");
const PUBLIC_URL = "https://projeto-inventario-rfid.onrender.com";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("ERRO: configure SUPABASE_URL e SUPABASE_SECRET_KEY.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

app.use(cors());
app.use(express.json({limit:"100kb"}));
app.use(express.urlencoded({extended:true, limit:"100kb"}));
app.use(express.static(SITE_DIR, {index:false, maxAge:0}));

let esp32 = { conectado:false, ultimoContato:null, ip:null };

let rfidEvent = {
  nova:false, id:0, uid:null, tipo:"idle", modo:"idle", mensagem:"Passe a tag do funcionário.",
  funcionario:null, equipamento:null, equipamentoRecebido:null, equipamentoEsperado:null,
  box:null, momento:0
};

let fluxo = {
  modo:"idle", // idle | aguardando_equipamento | aguardando_devolucao
  funcionario:null,
  acao:null,
  equipamentoSelecionado:null,
  expiraEm:0
};

function texto(v){ return v === null || v === undefined ? "" : String(v); }

function normalizarUID(uid){
  return texto(uid).toUpperCase().replace(/[^A-Z0-9]/g,"");
}

function statusNormalizado(v){
  return texto(v).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
}

function agora(){ return new Date().toISOString(); }

function erroResposta(res, err, status=500){
  console.error("ERRO:", err);
  return res.status(status).json({sucesso:false, erro:err?.message || texto(err) || "Erro interno."});
}

function publicarRFID(dados){
  rfidEvent = {
    nova:true,
    id:Date.now(),
    uid:dados.uid ?? null,
    tipo:dados.tipo ?? "idle",
    modo:dados.modo ?? fluxo.modo,
    mensagem:dados.mensagem ?? "",
    funcionario:dados.funcionario ?? null,
    equipamento:dados.equipamento ?? null,
    equipamentoRecebido:dados.equipamentoRecebido ?? null,
    equipamentoEsperado:dados.equipamentoEsperado ?? null,
    box:dados.box ?? dados.equipamento?.box_id ?? null,
    momento:Date.now()
  };
  return rfidEvent;
}

function limparFluxo(){
  fluxo = {modo:"idle", funcionario:null, acao:null, equipamentoSelecionado:null, expiraEm:0};
}

function expirarFluxo(){
  if(fluxo.expiraEm && Date.now() > fluxo.expiraEm){
    limparFluxo();
    publicarRFID({
      tipo:"fluxo_expirado",
      modo:"idle",
      mensagem:"A operação expirou. Passe novamente a tag do funcionário."
    });
  }
}

async function buscarFuncionarioPorUID(uid){
  const r = await supabase.from("funcionarios").select("*").eq("uid_tag_pessoal",uid).maybeSingle();
  if(r.error) throw r.error;
  return r.data || null;
}

async function buscarEquipamentoPorUID(uid){
  const r = await supabase.from("equipamentos").select("*").eq("uid_tag",uid).maybeSingle();
  if(r.error) throw r.error;
  return r.data || null;
}

async function listarEmprestimosAtivosDoFuncionario(funcionarioId){
  const r = await supabase.from("emprestimos").select("*").eq("funcionario_id",funcionarioId).is("data_devolucao",null).order("id",{ascending:true});
  if(r.error) throw r.error;
  return r.data || [];
}

async function buscarEmprestimoAtivoEquipamento(equipamentoId){
  const r = await supabase.from("emprestimos").select("*").eq("equipamento_id",equipamentoId).is("data_devolucao",null).limit(1);
  if(r.error) throw r.error;
  return r.data?.[0] || null;
}

/* Uma box comporta EXATAMENTE um objeto. */
async function boxOcupada(boxId, equipamentoIdIgnorar=null){
  if(boxId === null || boxId === undefined || boxId === "") return false;
  const r = await supabase.from("equipamentos").select("id,status,nome,box_id").eq("box_id",Number(boxId));
  if(r.error) throw r.error;
  return (r.data||[]).some(e =>
    Number(e.id) !== Number(equipamentoIdIgnorar) &&
    statusNormalizado(e.status) === "emprestado"
  );
}

async function listarEquipamentosDisponiveisSeguros(){
  const r = await supabase.from("equipamentos").select("*").order("id",{ascending:true});
  if(r.error) throw r.error;
  const lista = r.data || [];
  const ocupadas = new Set();
  for(const e of lista){
    if(statusNormalizado(e.status)==="emprestado" && e.box_id !== null && e.box_id !== undefined){
      ocupadas.add(String(e.box_id));
    }
  }
  return lista.filter(e =>
    statusNormalizado(e.status)==="disponivel" &&
    !ocupadas.has(String(e.box_id))
  );
}

async function verificarUIDEmQualquerCadastro(uid){
  const f = await supabase.from("funcionarios").select("*").eq("uid_tag_pessoal",uid).maybeSingle();
  if(f.error) throw f.error;
  if(f.data) return {encontrado:true,categoria:"funcionario",registro:f.data};
  const e = await supabase.from("equipamentos").select("*").eq("uid_tag",uid).maybeSingle();
  if(e.error) throw e.error;
  if(e.data) return {encontrado:true,categoria:"equipamento",registro:e.data};
  return {encontrado:false};
}

/* ---------------- PÁGINAS ---------------- */
app.get("/",(req,res)=>res.sendFile(path.join(SITE_DIR,"index.html")));
app.get("/cadastro",(req,res)=>res.sendFile(path.join(SITE_DIR,"cadastro.html")));
app.get("/controle",(req,res)=>res.sendFile(path.join(SITE_DIR,"controle.html")));

/* ---------------- SAÚDE ---------------- */
app.get("/health",(req,res)=>res.json({sucesso:true,servidor:"online",banco:"Supabase",horario:agora()}));
app.get("/teste",(req,res)=>res.json({sucesso:true,mensagem:"Servidor RFID funcionando!",banco:"Supabase",servidor:"online",esp32:esp32}));

app.get("/api/status",(req,res)=>{
  expirarFluxo();
  res.set("Cache-Control","no-store");
  res.json({sucesso:true,servidor:"online",banco:"Supabase",esp32,rfid:rfidEvent,fluxo});
});

app.get("/api/esp32/status",(req,res)=>res.json({sucesso:true,...esp32}));

app.post("/api/esp32/online",(req,res)=>{
  esp32={conectado:true,ultimoContato:agora(),ip:texto(req.body?.ip).trim()||null};
  res.json({sucesso:true,mensagem:"ESP32 conectado ao servidor",horario:esp32.ultimoContato});
});

/* ---------------- RFID ESP32 ---------------- */
app.post("/api/esp32/rfid",async(req,res)=>{
  try{
    const uid=normalizarUID(req.body?.uid);
    if(!uid) return res.status(400).json({sucesso:false,erro:"UID não informado."});

    esp32.conectado=true; esp32.ultimoContato=agora();
    expirarFluxo();

    /* 1) Se a interface iniciou cadastro, esta leitura é só cadastro. */
    if(cadastroRFID.ativo && Date.now() < cadastroRFID.expiraEm){
      const existente=await verificarUIDEmQualquerCadastro(uid);
      if(existente.encontrado){
        cadastroRFID={ativo:false,tipo:null,expiraEm:0};
        const ev=publicarRFID({
          uid,tipo:"tag_ja_cadastrada",modo:"cadastro",
          mensagem:`Esta tag já está cadastrada como ${existente.categoria}: ${existente.registro.nome}.`
        });
        return res.status(409).json({sucesso:false,...ev});
      }
      cadastroRFID={ativo:false,tipo:null,expiraEm:0};
      const ev=publicarRFID({uid,tipo:"cadastro_tag",modo:"cadastro",mensagem:"Tag lida com sucesso. UID preenchido."});
      return res.json({sucesso:true,...ev});
    }

    /* 2) Se há fluxo iniciado pela tela, uma tag de equipamento NÃO pode virar funcionário. */
    if(fluxo.modo === "aguardando_equipamento" || fluxo.modo === "aguardando_devolucao"){
      const equipamento=await buscarEquipamentoPorUID(uid);

      if(!equipamento){
        const ev=publicarRFID({
          uid,tipo:"tag_desconhecida",modo:fluxo.modo,
          mensagem:"Tag de equipamento não cadastrada. Passe a tag correta."
        });
        return res.status(404).json({sucesso:false,...ev});
      }

      const esperado=fluxo.equipamentoSelecionado;
      if(!esperado || Number(equipamento.id)!==Number(esperado.id)){
        const ev=publicarRFID({
          uid,tipo:"objeto_incorreto",modo:fluxo.modo,
          mensagem:`Tag incorreta. Passe a tag de "${esperado?.nome || "equipamento selecionado"}".`,
          funcionario:fluxo.funcionario,
          equipamentoRecebido:equipamento.nome,
          equipamentoEsperado:esperado?.nome || "equipamento selecionado",
          equipamento:esperado
        });
        return res.status(409).json({sucesso:false,...ev});
      }

      if(fluxo.modo === "aguardando_devolucao"){
        const ativos=await listarEmprestimosAtivosDoFuncionario(fluxo.funcionario.id);
        const ativo=ativos.find(x=>Number(x.equipamento_id)===Number(equipamento.id));
        if(!ativo){
          limparFluxo();
          const ev=publicarRFID({uid,tipo:"sem_emprestimo",mensagem:"Esse equipamento não está emprestado para este funcionário."});
          return res.status(409).json({sucesso:false,...ev});
        }

        const upd=await supabase.from("emprestimos").update({
          data_devolucao:agora(),
          status:"Devolvido"
        }).eq("id",ativo.id).is("data_devolucao",null).select().single();
        if(upd.error) throw upd.error;

        const liberado=await supabase.from("equipamentos").update({status:"disponivel"}).eq("id",equipamento.id);
        if(liberado.error) throw liberado.error;

        const funcionario=fluxo.funcionario;
        limparFluxo();
        const ev=publicarRFID({
          uid,tipo:"devolucao_concluida",modo:"idle",
          mensagem:`Devolução concluída. ${equipamento.nome} está disponível novamente.`,
          funcionario,equipamento,box:equipamento.box_id
        });
        return res.json({sucesso:true,...ev});
      }

      /* Retirada: valida novamente disponibilidade e box antes de alterar banco. */
      const atual=await supabase.from("equipamentos").select("*").eq("id",equipamento.id).maybeSingle();
      if(atual.error) throw atual.error;
      if(!atual.data || statusNormalizado(atual.data.status)!=="disponivel"){
        const ev=publicarRFID({uid,tipo:"equipamento_emprestado",modo:"idle",mensagem:"Este equipamento não está mais disponível."});
        return res.status(409).json({sucesso:false,...ev});
      }

      if(await boxOcupada(atual.data.box_id,atual.data.id)){
        const ev=publicarRFID({
          uid,tipo:"box_ocupada",modo:"idle",
          mensagem:`A Box ${atual.data.box_id} já contém outro objeto. Uma box comporta apenas um objeto.`
        });
        return res.status(409).json({sucesso:false,...ev});
      }

      const ativosPessoa=await listarEmprestimosAtivosDoFuncionario(fluxo.funcionario.id);
      if(ativosPessoa.length>0){
        const atualEmp=ativosPessoa[0];
        const eq=await supabase.from("equipamentos").select("*").eq("id",atualEmp.equipamento_id).maybeSingle();
        if(eq.error) throw eq.error;
        const ev=publicarRFID({
          uid,tipo:"funcionario_com_emprestimo",modo:"idle",
          mensagem:`Você precisa devolver "${eq.data?.nome || "o equipamento"}" antes de pegar outro objeto.`,
          funcionario:fluxo.funcionario,equipamento:eq.data
        });
        limparFluxo();
        return res.status(409).json({sucesso:false,...ev});
      }

      const novo={
        funcionario_id:Number(fluxo.funcionario.id),
        equipamento_id:Number(atual.data.id),
        box:Number(atual.data.box_id),
        status:"Ativo",
        data_retirada:agora()
      };
      const ins=await supabase.from("emprestimos").insert([novo]).select().single();
      if(ins.error) throw ins.error;

      const updEq=await supabase.from("equipamentos").update({status:"emprestado"}).eq("id",atual.data.id);
      if(updEq.error) throw updEq.error;

      const funcionario=fluxo.funcionario;
      limparFluxo();
      const ev=publicarRFID({
        uid,tipo:"retirada_concluida",modo:"idle",
        mensagem:`${atual.data.nome} está EMPRESTADO para ${funcionario.nome}.`,
        funcionario,equipamento:atual.data,box:atual.data.box_id
      });
      return res.json({sucesso:true,...ev});
    }

    /* 3) Fora de fluxo, primeiro procura funcionário. */
    const funcionario=await buscarFuncionarioPorUID(uid);
    if(funcionario){
      const ativos=await listarEmprestimosAtivosDoFuncionario(funcionario.id);

      if(ativos.length>0){
        const ativo=ativos[0];
        const eq=await supabase.from("equipamentos").select("*").eq("id",ativo.equipamento_id).maybeSingle();
        if(eq.error) throw eq.error;

        fluxo={
          modo:"aguardando_devolucao",
          funcionario:{
            id:funcionario.id,nome:funcionario.nome,matricula:funcionario.matricula,
            uid_tag_pessoal:funcionario.uid_tag_pessoal
          },
          acao:"devolucao",
          equipamentoSelecionado:eq.data || null,
          expiraEm:Date.now()+120000
        };

        const ev=publicarRFID({
          uid,tipo:"funcionario_com_emprestimo",modo:"aguardando_devolucao",
          mensagem:`Você já está com "${eq.data?.nome || "um equipamento"}". Você precisa devolver o que pegou antes de pegar outro objeto.`,
          funcionario:fluxo.funcionario,equipamento:eq.data,box:eq.data?.box_id
        });
        return res.json({sucesso:true,...ev});
      }

      fluxo={
        modo:"aguardando_equipamento",
        funcionario:{id:funcionario.id,nome:funcionario.nome,matricula:funcionario.matricula,uid_tag_pessoal:funcionario.uid_tag_pessoal},
        acao:"retirada",equipamentoSelecionado:null,expiraEm:Date.now()+120000
      };

      const disponiveis=await listarEquipamentosDisponiveisSeguros();
      const ev=publicarRFID({
        uid,tipo:"funcionario_identificado",modo:"aguardando_equipamento",
        mensagem:disponiveis.length
          ? "Funcionário identificado. Selecione o equipamento que deseja retirar."
          : "Funcionário identificado, mas não há equipamentos disponíveis.",
        funcionario:fluxo.funcionario
      });
      return res.json({sucesso:true,...ev,equipamentos:disponiveis,equipamentosDisponiveis:disponiveis});
    }

    /* 4) Tag de equipamento fora do fluxo: recusa. */
    const equipamento=await buscarEquipamentoPorUID(uid);
    if(equipamento){
      const ev=publicarRFID({
        uid,tipo:"equipamento_sem_funcionario",modo:"idle",
        mensagem:"Passe primeiro a tag do funcionário e selecione o equipamento."
      });
      return res.status(409).json({sucesso:false,...ev});
    }

    const ev=publicarRFID({uid,tipo:"tag_nao_cadastrada",modo:"idle",mensagem:"TAG NÃO CADASTRADA. Cadastre a tag antes de utilizar."});
    return res.status(404).json({sucesso:false,...ev});
  }catch(e){ return erroResposta(res,e); }
});

/* Leitura para a interface */
app.get("/rfid/ultima",(req,res)=>{
  expirarFluxo();
  res.set("Cache-Control","no-store, no-cache, must-revalidate");
  res.json(rfidEvent);
});
app.post("/rfid/limpar",(req,res)=>{
  rfidEvent.nova=false;
  res.json({sucesso:true});
});
app.post("/api/rfid/resetar",(req,res)=>{
  limparFluxo();
  cadastroRFID={ativo:false,tipo:null,expiraEm:0};
  rfidEvent={nova:false,id:Date.now(),uid:null,tipo:"idle",modo:"idle",mensagem:"Passe a tag do funcionário.",momento:Date.now()};
  res.json({sucesso:true,mensagem:"Operação reiniciada."});
});

let cadastroRFID={ativo:false,tipo:null,expiraEm:0};
app.post("/api/rfid/cadastro/iniciar",(req,res)=>{
  cadastroRFID={ativo:true,tipo:req.body?.tipo==="equipamento"?"equipamento":"funcionario",expiraEm:Date.now()+30000};
  res.json({sucesso:true,tipo:cadastroRFID.tipo,mensagem:"Aguardando uma tag disponível.",expiraEm:cadastroRFID.expiraEm});
});

/* Seleção feita pela interface. */
app.post("/api/rfid/selecionar",async(req,res)=>{
  try{
    expirarFluxo();
    const funcionarioId=Number(req.body?.funcionario_id);
    const equipamentoId=Number(req.body?.equipamento_id);
    const acao=req.body?.acao==="devolucao"?"devolucao":"retirada";

    if(!Number.isInteger(funcionarioId)||funcionarioId<=0) return res.status(400).json({sucesso:false,erro:"Funcionário inválido."});
    if(!Number.isInteger(equipamentoId)||equipamentoId<=0) return res.status(400).json({sucesso:false,erro:"Equipamento inválido."});
    if(!fluxo.funcionario || Number(fluxo.funcionario.id)!==funcionarioId) return res.status(409).json({sucesso:false,erro:"A identificação expirou. Passe novamente a tag do funcionário."});

    const e=await supabase.from("equipamentos").select("*").eq("id",equipamentoId).maybeSingle();
    if(e.error) throw e.error;
    if(!e.data) return res.status(404).json({sucesso:false,erro:"Equipamento não encontrado."});

    const ativos=await listarEmprestimosAtivosDoFuncionario(funcionarioId);

    if(acao==="retirada"){
      if(ativos.length>0){
        const atual=await supabase.from("equipamentos").select("*").eq("id",ativos[0].equipamento_id).maybeSingle();
        if(atual.error) throw atual.error;
        return res.status(409).json({
          sucesso:false,tipo:"funcionario_com_emprestimo",
          erro:`Você precisa devolver "${atual.data?.nome || "o equipamento"}" antes de pegar outro objeto.`
        });
      }
      if(statusNormalizado(e.data.status)!=="disponivel") return res.status(409).json({sucesso:false,erro:"Esse equipamento não está disponível."});
      if(await boxOcupada(e.data.box_id,e.data.id)) return res.status(409).json({sucesso:false,tipo:"box_ocupada",erro:`A Box ${e.data.box_id} já contém outro objeto. Uma box comporta apenas um objeto.`});
    }else{
      const pertence=ativos.find(x=>Number(x.equipamento_id)===equipamentoId);
      if(!pertence) return res.status(409).json({sucesso:false,erro:"Esse equipamento não está emprestado para este funcionário."});
    }

    fluxo={
      modo:acao==="devolucao"?"aguardando_devolucao":"aguardando_equipamento",
      funcionario:fluxo.funcionario,acao,equipamentoSelecionado:e.data,expiraEm:Date.now()+120000
    };

    const ev=publicarRFID({
      uid:fluxo.funcionario.uid_tag_pessoal,
      tipo:"equipamento_selecionado",modo:fluxo.modo,
      mensagem:`${acao==="devolucao"?"Devolução":"Retirada"}: agora passe a tag de "${e.data.nome}".`,
      funcionario:fluxo.funcionario,equipamento:e.data,box:e.data.box_id
    });
    return res.json({sucesso:true,...ev});
  }catch(e){return erroResposta(res,e,400);}
});

/* ---------------- APIs DE DADOS ---------------- */
app.get("/api/funcionarios",async(req,res)=>{
  try{const r=await supabase.from("funcionarios").select("*").order("id",{ascending:true}); if(r.error)throw r.error; res.json({sucesso:true,funcionarios:r.data||[]});}catch(e){erroResposta(res,e);}
});
app.get("/api/equipamentos",async(req,res)=>{
  try{const r=await supabase.from("equipamentos").select("*").order("id",{ascending:true}); if(r.error)throw r.error; res.json({sucesso:true,equipamentos:r.data||[]});}catch(e){erroResposta(res,e);}
});
app.get("/api/emprestimos",async(req,res)=>{
  try{
    const r=await supabase.from("emprestimos").select("*").order("id",{ascending:false}); if(r.error)throw r.error;
    const rows=r.data||[];
    const fids=[...new Set(rows.map(x=>x.funcionario_id).filter(x=>x!=null))];
    const eids=[...new Set(rows.map(x=>x.equipamento_id).filter(x=>x!=null))];
    const fm={},em={};
    if(fids.length){const f=await supabase.from("funcionarios").select("*").in("id",fids);if(f.error)throw f.error;(f.data||[]).forEach(x=>fm[x.id]=x);}
    if(eids.length){const e=await supabase.from("equipamentos").select("*").in("id",eids);if(e.error)throw e.error;(e.data||[]).forEach(x=>em[x.id]=x);}
    res.json({sucesso:true,emprestimos:rows.map(x=>({...x,funcionario:fm[x.funcionario_id]||null,equipamento:em[x.equipamento_id]||null}))});
  }catch(e){erroResposta(res,e);}
});
app.get("/api/dashboard",async(req,res)=>{
  try{
    const f=await supabase.from("funcionarios").select("*",{count:"exact",head:true});
    const e=await supabase.from("equipamentos").select("*",{count:"exact",head:true});
    const all=await supabase.from("equipamentos").select("id,status,box_id");
    if(f.error)throw f.error;if(e.error)throw e.error;if(all.error)throw all.error;
    const ocupadas=new Set((all.data||[]).filter(x=>statusNormalizado(x.status)==="emprestado").map(x=>String(x.box_id)));
    const disp=(all.data||[]).filter(x=>statusNormalizado(x.status)==="disponivel"&&!ocupadas.has(String(x.box_id))).length;
    const emp=(all.data||[]).filter(x=>statusNormalizado(x.status)==="emprestado").length;
    res.json({sucesso:true,funcionarios:f.count||0,equipamentos:e.count||0,disponiveis:disp,emprestados:emp});
  }catch(e){erroResposta(res,e);}
});

/* Compatibilidade com páginas antigas */
app.get("/funcionarios",async(req,res)=>{const r=await supabase.from("funcionarios").select("*").order("id",{ascending:true});res.json(r.data||[]);});
app.get("/equipamentos",async(req,res)=>{const r=await supabase.from("equipamentos").select("*").order("id",{ascending:true});res.json(r.data||[]);});
app.get("/emprestimos",async(req,res)=>{
  try{
    const r=await supabase.from("emprestimos").select("*").order("id",{ascending:false}); if(r.error)throw r.error;
    const rows=r.data||[];
    const fids=[...new Set(rows.map(x=>x.funcionario_id).filter(x=>x!=null))],eids=[...new Set(rows.map(x=>x.equipamento_id).filter(x=>x!=null))];
    const fm={},em={};
    if(fids.length){const f=await supabase.from("funcionarios").select("*").in("id",fids);if(f.error)throw f.error;(f.data||[]).forEach(x=>fm[x.id]=x);}
    if(eids.length){const e=await supabase.from("equipamentos").select("*").in("id",eids);if(e.error)throw e.error;(e.data||[]).forEach(x=>em[x.id]=x);}
    res.json(rows.map(x=>({...x,funcionario:fm[x.funcionario_id]?.nome||"-",matricula:fm[x.funcionario_id]?.matricula||"-",equipamento:em[x.equipamento_id]?.nome||"-",box_id:em[x.equipamento_id]?.box_id??x.box??"-"})));
  }catch(e){erroResposta(res,e);}
});

/* Cadastro */
app.post("/api/funcionarios",async(req,res)=>{
  try{
    const nome=texto(req.body?.nome).trim(), matricula=texto(req.body?.matricula).trim(), uid=normalizarUID(req.body?.uid_tag_pessoal||req.body?.uid_rfid);
    if(!nome||!matricula||!uid)return res.status(400).json({sucesso:false,erro:"Nome, matrícula e UID RFID são obrigatórios."});
    const ex=await verificarUIDEmQualquerCadastro(uid); if(ex.encontrado)return res.status(409).json({sucesso:false,erro:`Esta tag já está cadastrada como ${ex.categoria}.`});
    const m=await supabase.from("funcionarios").select("id,nome").eq("matricula",matricula).limit(1);if(m.error)throw m.error;if((m.data||[]).length)return res.status(409).json({sucesso:false,erro:"Matrícula já cadastrada."});
    const r=await supabase.from("funcionarios").insert([{nome,matricula,setor:texto(req.body?.setor).trim()||null,uid_tag_pessoal:uid}]).select().single();if(r.error)throw r.error;
    res.status(201).json({sucesso:true,mensagem:"Funcionário cadastrado.",funcionario:r.data});
  }catch(e){erroResposta(res,e,400);}
});
app.post("/api/equipamentos",async(req,res)=>{
  try{
    const nome=texto(req.body?.nome).trim(),uid=normalizarUID(req.body?.uid_rfid||req.body?.uid_tag),box=Number(req.body?.box??req.body?.box_id??1);
    if(!nome||!uid||!Number.isInteger(box)||box<1)return res.status(400).json({sucesso:false,erro:"Nome, UID e Box válida são obrigatórios."});
    const ex=await verificarUIDEmQualquerCadastro(uid);if(ex.encontrado)return res.status(409).json({sucesso:false,erro:"Esta tag já está cadastrada."});
    const mesmo=await supabase.from("equipamentos").select("id,nome,status").eq("box_id",box);
    if(mesmo.error)throw mesmo.error;
    if((mesmo.data||[]).length)return res.status(409).json({sucesso:false,tipo:"box_ocupada",erro:`A Box ${box} já possui um objeto cadastrado. Uma box comporta apenas um objeto.`});
    const r=await supabase.from("equipamentos").insert([{nome,descricao:texto(req.body?.descricao).trim()||null,uid_tag:uid,box_id:box,status:"disponivel"}]).select().single();if(r.error)throw r.error;
    res.status(201).json({sucesso:true,mensagem:"Equipamento cadastrado.",equipamento:r.data});
  }catch(e){erroResposta(res,e,400);}
});
app.put("/api/equipamentos/:id",async(req,res)=>{
  try{
    const dados={};
    if(req.body.nome!==undefined)dados.nome=texto(req.body.nome).trim();
    if(req.body.descricao!==undefined)dados.descricao=req.body.descricao;
    if(req.body.uid_rfid!==undefined)dados.uid_tag=normalizarUID(req.body.uid_rfid);
    if(req.body.box!==undefined){
      const box=Number(req.body.box); if(!Number.isInteger(box)||box<1)return res.status(400).json({sucesso:false,erro:"Box inválida."});
      const outros=await supabase.from("equipamentos").select("id").eq("box_id",box).neq("id",Number(req.params.id));if(outros.error)throw outros.error;
      if((outros.data||[]).length)return res.status(409).json({sucesso:false,erro:`A Box ${box} já possui outro objeto.`});
      dados.box_id=box;
    }
    if(req.body.status!==undefined)dados.status=statusNormalizado(req.body.status);
    const r=await supabase.from("equipamentos").update(dados).eq("id",req.params.id).select().single();if(r.error)throw r.error;
    res.json({sucesso:true,mensagem:"Equipamento atualizado.",equipamento:r.data});
  }catch(e){erroResposta(res,e,400);}
});
app.delete("/api/equipamentos/:id",async(req,res)=>{
  try{
    const ativo=await buscarEmprestimoAtivoEquipamento(Number(req.params.id));if(ativo)return res.status(409).json({sucesso:false,erro:"Não é possível excluir um equipamento emprestado."});
    const r=await supabase.from("equipamentos").delete().eq("id",req.params.id);if(r.error)throw r.error;res.json({sucesso:true,mensagem:"Equipamento excluído."});
  }catch(e){erroResposta(res,e,400);}
});

/* Empréstimo manual, protegido pelas mesmas regras */
app.post("/api/emprestimos",async(req,res)=>{
  try{
    const funcionarioId=Number(req.body?.funcionario_id),equipamentoId=Number(req.body?.equipamento_id);
    const f=await supabase.from("funcionarios").select("*").eq("id",funcionarioId).maybeSingle();if(f.error)throw f.error;
    const e=await supabase.from("equipamentos").select("*").eq("id",equipamentoId).maybeSingle();if(e.error)throw e.error;
    if(!f.data||!e.data)return res.status(404).json({sucesso:false,erro:"Funcionário ou equipamento não encontrado."});
    const ativos=await listarEmprestimosAtivosDoFuncionario(funcionarioId);if(ativos.length)return res.status(409).json({sucesso:false,erro:"Funcionário já possui equipamento emprestado. Deve devolver antes de pegar outro."});
    if(statusNormalizado(e.data.status)!=="disponivel")return res.status(409).json({sucesso:false,erro:"Equipamento indisponível."});
    if(await boxOcupada(e.data.box_id,e.data.id))return res.status(409).json({sucesso:false,erro:"Box ocupada. Uma box comporta apenas um objeto."});
    const r=await supabase.from("emprestimos").insert([{funcionario_id:funcionarioId,equipamento_id:equipamentoId,box:e.data.box_id,status:"Ativo",data_retirada:agora()}]).select().single();if(r.error)throw r.error;
    const u=await supabase.from("equipamentos").update({status:"emprestado"}).eq("id",equipamentoId);if(u.error)throw u.error;
    res.status(201).json({sucesso:true,mensagem:"Empréstimo registrado.",emprestimo:r.data});
  }catch(e){erroResposta(res,e,400);}
});
app.put("/api/emprestimos/:id/devolver",async(req,res)=>{
  try{
    const r=await supabase.from("emprestimos").select("*").eq("id",req.params.id).maybeSingle();if(r.error)throw r.error;if(!r.data)return res.status(404).json({sucesso:false,erro:"Empréstimo não encontrado."});
    const u=await supabase.from("emprestimos").update({status:"Devolvido",data_devolucao:agora()}).eq("id",req.params.id).is("data_devolucao",null).select().single();if(u.error)throw u.error;
    const e=await supabase.from("equipamentos").update({status:"disponivel"}).eq("id",r.data.equipamento_id);if(e.error)throw e.error;
    res.json({sucesso:true,mensagem:"Equipamento devolvido.",emprestimo:u.data});
  }catch(e){erroResposta(res,e,400);}
});

/* Admin: exige palavra de confirmação. */
app.post("/api/admin/limpar-banco",async(req,res)=>{
  try{
    if(texto(req.body?.confirmacao)!=="LIMPAR")return res.status(400).json({sucesso:false,erro:"Confirmação inválida."});
    for(const tabela of ["emprestimos","equipamentos","funcionarios"]){
      const r=await supabase.from(tabela).delete().neq("id",-1);if(r.error)throw r.error;
    }
    limparFluxo(); cadastroRFID={ativo:false,tipo:null,expiraEm:0};
    publicarRFID({tipo:"banco_limpo",modo:"idle",mensagem:"Banco de dados limpo."});
    res.json({sucesso:true,mensagem:"Banco limpo."});
  }catch(e){erroResposta(res,e,400);}
});

app.use((req,res)=>res.status(404).json({sucesso:false,erro:"Rota não encontrada",rota:req.originalUrl}));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({sucesso:false,erro:"Erro interno do servidor."});});

app.listen(PORT,"0.0.0.0",()=>console.log(`Inventário RFID - NUVEM | porta ${PORT}`));
