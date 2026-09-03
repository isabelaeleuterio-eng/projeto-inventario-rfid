require("dotenv").config();
const express=require("express"),path=require("path"),cors=require("cors");
const {createClient}=require("@supabase/supabase-js");
const app=express(),PORT=process.env.PORT||3000;
if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SECRET_KEY){console.error("Configure SUPABASE_URL e SUPABASE_SECRET_KEY");process.exit(1)}
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY);
app.use(cors());app.use(express.json());app.use(express.urlencoded({extended:true}));
const SITE=path.join(__dirname,"SITE");app.use(express.static(SITE));
let esp32=false,lastESP=null;
let event={nova:false,id:0,uid:null,tipo:"idle",modo:"idle",mensagem:"Aguardando tag...",funcionario:null,equipamento:null,equipamentoRecebido:null,equipamentoEsperado:null,box:null,momento:0};
let fluxo={modo:"idle",funcionario:null,acao:null,equipamentoSelecionado:null,expiraEm:0};
let cadastro={ativo:false,tipo:null,expiraEm:0};

const txt=v=>v==null?"":String(v);
const uid=v=>txt(v).toUpperCase().replace(/[^A-Z0-9]/g,"");
const st=v=>txt(v).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
const now=()=>new Date().toISOString();
function fail(res,e,code=500){console.error(e);return res.status(code).json({sucesso:false,erro:e.message||String(e),mensagem:e.message||String(e)})}
function pub(x={}){event={nova:true,id:Date.now(),uid:x.uid||null,tipo:x.tipo||"info",modo:x.modo||fluxo.modo,mensagem:x.mensagem||"",funcionario:x.funcionario||null,equipamento:x.equipamento||null,equipamentoRecebido:x.equipamentoRecebido||null,equipamentoEsperado:x.equipamentoEsperado||null,box:x.box??null,momento:Date.now()};return event}
function clearFlow(){fluxo={modo:"idle",funcionario:null,acao:null,equipamentoSelecionado:null,expiraEm:0}}
function expire(){if(fluxo.expiraEm&&Date.now()>fluxo.expiraEm){clearFlow();pub({tipo:"fluxo_expirado",mensagem:"A operação expirou. Passe novamente a tag do funcionário."})}if(cadastro.expiraEm&&Date.now()>cadastro.expiraEm)cadastro={ativo:false,tipo:null,expiraEm:0}}
async function findF(u){let r=await supabase.from("funcionarios").select("*").order("id");if(r.error)throw r.error;return(r.data||[]).find(x=>uid(x.uid_tag_pessoal)===uid(u))||null}
async function findE(u){let r=await supabase.from("equipamentos").select("*").order("id");if(r.error)throw r.error;return(r.data||[]).find(x=>uid(x.uid_tag)===uid(u))||null}
async function activeF(id){let r=await supabase.from("emprestimos").select("*").eq("funcionario_id",id).eq("status","Ativo").is("data_devolucao",null).order("id",{ascending:false});if(r.error)throw r.error;return r.data||[]}
async function boxUsed(box,ignore){let r=await supabase.from("equipamentos").select("id").eq("box_id",box);if(r.error)throw r.error;return(r.data||[]).some(x=>Number(x.id)!==Number(ignore))}
async function allLoans(){let r=await supabase.from("emprestimos").select("*").order("id",{ascending:false}).limit(200);if(r.error)throw r.error;let a=r.data||[],fs=[...new Set(a.map(x=>x.funcionario_id).filter(Boolean))],es=[...new Set(a.map(x=>x.equipamento_id).filter(Boolean))],fm={},em={};if(fs.length){let q=await supabase.from("funcionarios").select("*").in("id",fs);if(q.error)throw q.error;(q.data||[]).forEach(x=>fm[x.id]=x)}if(es.length){let q=await supabase.from("equipamentos").select("*").in("id",es);if(q.error)throw q.error;(q.data||[]).forEach(x=>em[x.id]=x)}return a.map(x=>({...x,funcionario:fm[x.funcionario_id]||null,equipamento:em[x.equipamento_id]||null}))}
async function recoverPending(){let r=await supabase.from("emprestimos").select("*").eq("status","Pendente RFID").is("data_devolucao",null).order("id",{ascending:false}).limit(1);if(r.error)throw r.error;let p=r.data?.[0];if(!p)return false;let f=await supabase.from("funcionarios").select("*").eq("id",p.funcionario_id).maybeSingle(),e=await supabase.from("equipamentos").select("*").eq("id",p.equipamento_id).maybeSingle();if(f.error)throw f.error;if(e.error)throw e.error;if(!f.data||!e.data)return false;fluxo={modo:"aguardando_tag_retirada",funcionario:{id:f.data.id,nome:f.data.nome,matricula:f.data.matricula,uid_tag_pessoal:f.data.uid_tag_pessoal},acao:"retirada",equipamentoSelecionado:e.data,expiraEm:Date.now()+120000};return true}

app.get("/",(q,s)=>s.sendFile(path.join(SITE,"index.html")));
app.get("/cadastro",(q,s)=>s.sendFile(path.join(SITE,"cadastro.html")));
app.get("/controle",(q,s)=>s.sendFile(path.join(SITE,"controle.html")));
app.get("/teste",(q,s)=>s.json({sucesso:true,mensagem:"Servidor RFID funcionando!",banco:"Supabase",esp32,horario:now()}));
app.get("/health",(q,s)=>s.json({sucesso:true,servidor:"online",banco:"Supabase",horario:now()}));
app.get("/api/status",async(q,s)=>{try{let r=await supabase.from("funcionarios").select("id").limit(1);if(r.error)throw r.error;s.json({sucesso:true,banco_status:"conectado",esp32,ultimoESP32:lastESP})}catch(e){fail(s,e)}})
app.get("/api/esp32/status",(q,s)=>s.json({sucesso:true,conectado:esp32,ultimoContato:lastESP,ultimoRFID:event}));
app.post("/api/esp32/online",(q,s)=>{esp32=true;lastESP=now();s.json({sucesso:true,mensagem:"ESP32 conectado ao servidor",horario:lastESP})});

app.post("/api/esp32/rfid",async(q,s)=>{try{
 expire();let u=uid(q.body?.uid??q.body?.UID??q.body?.uid_tag??q.body?.tag??q.body?.rfid);if(!u)return s.status(400).json({sucesso:false,erro:"UID não informado"});esp32=true;lastESP=now();console.log("RFID",u,"| leitor=",q.body?.leitor||"entrada");
 if(cadastro.ativo&&Date.now()<=cadastro.expiraEm){let f=await findF(u),e=await findE(u);if(f||e){cadastro.ativo=false;let tipo=f?"funcionário":"equipamento";let ev=pub({uid:u,tipo:"tag_ja_cadastrada",modo:"cadastro",mensagem:`Esta tag já está cadastrada como ${tipo}.`});return s.status(409).json({sucesso:false,...ev})}let tipo=cadastro.tipo==="equipamento"?"equipamento":"funcionario";cadastro.ativo=false;let ev=pub({uid:u,tipo:tipo==="funcionario"?"cadastro_funcionario_tag":"cadastro_equipamento_tag",modo:"cadastro",mensagem:"Tag lida. UID preenchido no cadastro."});return s.json({sucesso:true,...ev})}
 if(fluxo.modo==="aguardando_tag_retirada"||fluxo.modo==="aguardando_devolucao"){let f=fluxo.funcionario,e0=fluxo.equipamentoSelecionado;if(!f||!e0){clearFlow();let ev=pub({uid:u,tipo:"fluxo_expirado",mensagem:"Passe novamente a tag do funcionário."});return s.status(409).json({sucesso:false,...ev})}let e=await findE(u);if(!e){let ev=pub({uid:u,tipo:"tag_nao_cadastrada",mensagem:"Esta tag não está cadastrada como equipamento."});return s.status(404).json({sucesso:false,...ev})}if(Number(e.id)!==Number(e0.id)){let ev=pub({uid:u,tipo:"objeto_incorreto",mensagem:`Tag incorreta. Passe a tag de "${e0.nome}".`,funcionario:f,equipamento:e0,equipamentoEsperado:e0,equipamentoRecebido:e});return s.status(409).json({sucesso:false,...ev})}
 if(fluxo.modo==="aguardando_tag_retirada"){let p=await supabase.from("emprestimos").select("*").eq("funcionario_id",f.id).eq("equipamento_id",e.id).eq("status","Pendente RFID").is("data_devolucao",null).order("id",{ascending:false}).limit(1).maybeSingle();if(p.error)throw p.error;if(!p.data){await recoverPending();let ev=pub({uid:u,tipo:"operacao_conflito",mensagem:"Pendência não encontrada. Selecione o equipamento novamente."});return s.status(409).json({sucesso:false,...ev})}let up=await supabase.from("emprestimos").update({status:"Ativo"}).eq("id",p.data.id).eq("status","Pendente RFID").select().maybeSingle();if(up.error)throw up.error;if(!up.data){clearFlow();let ev=pub({uid:u,tipo:"operacao_conflito",mensagem:"Retirada já processada."});return s.status(409).json({sucesso:false,...ev})}let eq=await supabase.from("equipamentos").update({status:"emprestado"}).eq("id",e.id).eq("status","disponivel").select().maybeSingle();if(eq.error)throw eq.error;if(!eq.data){await supabase.from("emprestimos").delete().eq("id",p.data.id);clearFlow();let ev=pub({uid:u,tipo:"equipamento_emprestado",mensagem:"O equipamento deixou de estar disponível."});return s.status(409).json({sucesso:false,...ev})}let ev=pub({uid:u,tipo:"retirada_concluida",modo:"idle",mensagem:`${e.nome} está EMPRESTADO para ${f.nome}.`,funcionario:f,equipamento:eq.data,box:e.box_id});clearFlow();return s.status(201).json({sucesso:true,...ev,emprestimo:up.data})}
 let a=(await activeF(f.id)).find(x=>Number(x.equipamento_id)===Number(e.id));if(!a){clearFlow();let ev=pub({uid:u,tipo:"sem_emprestimo",mensagem:"Esse equipamento não está emprestado para este funcionário."});return s.status(409).json({sucesso:false,...ev})}let d=await supabase.from("emprestimos").update({status:"Devolvido",data_devolucao:now()}).eq("id",a.id).eq("status","Ativo").is("data_devolucao",null).select().maybeSingle();if(d.error)throw d.error;if(!d.data){clearFlow();let ev=pub({uid:u,tipo:"operacao_conflito",mensagem:"Devolução já registrada."});return s.status(409).json({sucesso:false,...ev})}let eq=await supabase.from("equipamentos").update({status:"disponivel"}).eq("id",e.id).select().maybeSingle();if(eq.error)throw eq.error;let ev=pub({uid:u,tipo:"devolucao_concluida",modo:"idle",mensagem:`${e.nome} foi DEVOLVIDO e está disponível.`,funcionario:f,equipamento:eq.data||e,box:e.box_id});clearFlow();return s.json({sucesso:true,...ev,emprestimo:d.data})}
 let f=await findF(u);if(f){let a=await activeF(f.id);let rf={id:f.id,nome:f.nome,matricula:f.matricula,setor:f.setor??null,uid_tag_pessoal:f.uid_tag_pessoal};if(a.length){let e=await supabase.from("equipamentos").select("*").eq("id",a[0].equipamento_id).maybeSingle();if(e.error)throw e.error;fluxo={modo:"aguardando_devolucao",funcionario:rf,acao:"devolucao",equipamentoSelecionado:e.data,expiraEm:Date.now()+120000};let ev=pub({uid:u,tipo:"funcionario_com_emprestimo",mensagem:`Você já está com ${e.data?.nome||"um equipamento"}.`,funcionario:rf,equipamento:e.data,box:e.data?.box_id});return s.status(409).json({sucesso:false,...ev})}let es=await supabase.from("equipamentos").select("*").order("nome");if(es.error)throw es.error;let disp=(es.data||[]).filter(x=>st(x.status)==="disponivel");let ev=pub({uid:u,tipo:"funcionario_identificado",modo:"selecionar_acao",mensagem:"Funcionário identificado. Escolha a ação.",funcionario:rf});return s.json({sucesso:true,...ev,equipamentos:disp,equipamentosDisponiveis:disp,equipamentosEmprestados:[]})}
 let e=await findE(u);if(e){let ev=pub({uid:u,tipo:"equipamento_sem_funcionario",mensagem:"Passe primeiro a tag do funcionário."});return s.status(409).json({sucesso:false,...ev})}let ev=pub({uid:u,tipo:"tag_nao_cadastrada",mensagem:"TAG NÃO CADASTRADA."});return s.status(404).json({sucesso:false,...ev})
}catch(e){return fail(s,e)}});

app.get("/rfid/ultima",(q,s)=>{expire();s.set("Cache-Control","no-store");s.json(event)});
app.post("/rfid/limpar",(q,s)=>s.json({sucesso:true,nova:event.nova}));
app.post("/api/rfid/resetar",(q,s)=>{clearFlow();cadastro={ativo:false,tipo:null,expiraEm:0};event={...event,nova:false,id:Date.now(),tipo:"idle",modo:"idle",uid:null,mensagem:"Aguardando nova operação.",momento:Date.now()};s.json({sucesso:true,mensagem:"Operação reiniciada."})});
app.post("/api/rfid/cadastro/iniciar",(q,s)=>{let tipo=q.body?.tipo==="equipamento"?"equipamento":"funcionario";cadastro={ativo:true,tipo,expiraEm:Date.now()+30000};s.json({sucesso:true,tipo,mensagem:"Aguardando uma tag."})});

app.post("/api/rfid/selecionar", async (q,s) => {
  try {
    expire();
    const fid=Number(q.body?.funcionario_id);
    const eid=Number(q.body?.equipamento_id);
    const acao=q.body?.acao==="devolucao" ? "devolucao" : "retirada";

    if(!fid || !eid) return s.status(400).json({sucesso:false,erro:"Funcionário ou equipamento inválido."});

    if(!fluxo.funcionario || Number(fluxo.funcionario.id)!==fid) await recoverPending();
    if(!fluxo.funcionario || Number(fluxo.funcionario.id)!==fid)
      return s.status(409).json({sucesso:false,erro:"Identificação expirada. Passe a tag do funcionário novamente."});

    const eq=await supabase.from("equipamentos").select("*").eq("id",eid).maybeSingle();
    if(eq.error) throw eq.error;
    if(!eq.data) return s.status(404).json({sucesso:false,erro:"Equipamento não encontrado."});

    const ativos=await activeF(fid);

    if(acao==="retirada"){
      if(ativos.length) return s.status(409).json({sucesso:false,tipo:"funcionario_com_emprestimo",erro:"Devolva o equipamento atual antes de retirar outro."});
      if(st(eq.data.status)!=="disponivel") return s.status(409).json({sucesso:false,tipo:"equipamento_emprestado",erro:"Esse equipamento não está disponível."});
      if(await boxUsed(eq.data.box_id,eq.data.id))
        return s.status(409).json({sucesso:false,tipo:"box_ocupada",erro:`A Box ${eq.data.box_id} já possui outro equipamento.`});

      const old=await supabase.from("emprestimos").select("id").eq("status","Pendente RFID").is("data_devolucao",null);
      if(old.error) throw old.error;
      for(const x of old.data||[]) await supabase.from("emprestimos").delete().eq("id",x.id);

      const pend=await supabase.from("emprestimos").insert([{
        funcionario_id:fid,equipamento_id:eid,box:Number(eq.data.box_id),
        status:"Pendente RFID",data_retirada:now()
      }]).select().single();
      if(pend.error) throw pend.error;

      fluxo={modo:"aguardando_tag_retirada",funcionario:fluxo.funcionario,acao,
        equipamentoSelecionado:eq.data,expiraEm:Date.now()+120000};
    } else {
      if(!ativos.some(x=>Number(x.equipamento_id)===eid))
        return s.status(409).json({sucesso:false,erro:"Esse equipamento não está emprestado para este funcionário."});

      fluxo={modo:"aguardando_devolucao",funcionario:fluxo.funcionario,acao,
        equipamentoSelecionado:eq.data,expiraEm:Date.now()+120000};
    }

    const ev=pub({
      uid:fluxo.funcionario.uid_tag_pessoal,
      tipo:"equipamento_selecionado",modo:fluxo.modo,
      mensagem:`Agora passe a tag física de "${eq.data.nome}".`,
      funcionario:fluxo.funcionario,equipamento:eq.data,box:eq.data.box_id
    });
    s.json({sucesso:true,...ev});
  } catch(e) {
    fail(s,e,400);
  }
});

app.get("/api/funcionarios",async(q,s)=>{try{let r=await supabase.from("funcionarios").select("*").order("id");if(r.error)throw r.error;s.json({sucesso:true,funcionarios:r.data||[]})}catch(e){fail(s,e)}});
app.get("/funcionarios",async(q,s)=>{try{let r=await supabase.from("funcionarios").select("*").order("id");if(r.error)throw r.error;s.json(r.data||[])}catch(e){fail(s,e)}});
app.post("/api/funcionarios",async(q,s)=>{try{let nome=txt(q.body?.nome).trim(),mat=txt(q.body?.matricula).trim(),setor=txt(q.body?.setor).trim(),u=uid(q.body?.uid_tag_pessoal??q.body?.uid_rfid??q.body?.uid);if(!nome||!mat||!u)return s.status(400).json({sucesso:false,erro:"Nome, matrícula e tag são obrigatórios."});if(await findF(u)||await findE(u))return s.status(409).json({sucesso:false,erro:"Esta tag já está cadastrada."});let m=await supabase.from("funcionarios").select("id").eq("matricula",mat).maybeSingle();if(m.error)throw m.error;if(m.data)return s.status(409).json({sucesso:false,erro:"Esta matrícula já está cadastrada."});let data={nome,matricula:mat,uid_tag_pessoal:u};if(setor)data.setor=setor;let r=await supabase.from("funcionarios").insert([data]).select().single();if(r.error&&setor){delete data.setor;r=await supabase.from("funcionarios").insert([data]).select().single()}if(r.error)throw r.error;s.status(201).json({sucesso:true,mensagem:"Funcionário cadastrado com sucesso!",funcionario:r.data})}catch(e){fail(s,e,400)}});

app.delete("/api/funcionarios/:id",async(q,s)=>{try{if((await activeF(Number(q.params.id))).length)return s.status(409).json({sucesso:false,erro:"Funcionário possui empréstimo ativo."});let r=await supabase.from("funcionarios").delete().eq("id",q.params.id);if(r.error)throw r.error;s.json({sucesso:true,mensagem:"Funcionário excluído."})}catch(e){fail(s,e,400)}});

app.get("/api/equipamentos",async(q,s)=>{try{let r=await supabase.from("equipamentos").select("*").order("box_id").order("id");if(r.error)throw r.error;s.json({sucesso:true,equipamentos:r.data||[]})}catch(e){fail(s,e)}});
app.get("/equipamentos",async(q,s)=>{try{let r=await supabase.from("equipamentos").select("*").order("box_id").order("id");if(r.error)throw r.error;s.json(r.data||[])}catch(e){fail(s,e)}});
app.post("/api/equipamentos",async(q,s)=>{try{let nome=txt(q.body?.nome).trim(),desc=txt(q.body?.descricao).trim(),u=uid(q.body?.uid_tag??q.body?.uid_rfid??q.body?.uid),box=Number(q.body?.box_id??q.body?.box);if(!nome||!u||!Number.isInteger(box)||box<1)return s.status(400).json({sucesso:false,erro:"Nome, tag e Box são obrigatórios."});if(await findF(u)||await findE(u))return s.status(409).json({sucesso:false,erro:"Esta tag já está cadastrada."});if(await boxUsed(box))return s.status(409).json({sucesso:false,erro:`A Box ${box} já está ocupada.`});let data={nome,uid_tag:u,box_id:box,status:"disponivel"};if(desc)data.descricao=desc;let r=await supabase.from("equipamentos").insert([data]).select().single();if(r.error&&desc){delete data.descricao;r=await supabase.from("equipamentos").insert([data]).select().single()}if(r.error)throw r.error;s.status(201).json({sucesso:true,mensagem:"Equipamento cadastrado com sucesso!",equipamento:r.data})}catch(e){fail(s,e,400)}});

app.delete("/api/equipamentos/:id",async(q,s)=>{try{let a=await supabase.from("emprestimos").select("id").eq("equipamento_id",q.params.id).eq("status","Ativo").is("data_devolucao",null);if(a.error)throw a.error;if((a.data||[]).length)return s.status(409).json({sucesso:false,erro:"Equipamento está emprestado."});let r=await supabase.from("equipamentos").delete().eq("id",q.params.id);if(r.error)throw r.error;s.json({sucesso:true,mensagem:"Equipamento excluído."})}catch(e){fail(s,e,400)}});

app.get("/api/emprestimos",async(q,s)=>{try{s.json({sucesso:true,emprestimos:await allLoans()})}catch(e){fail(s,e)}});
app.get("/emprestimos",async(q,s)=>{try{s.json(await allLoans())}catch(e){fail(s,e)}});
app.put("/api/emprestimos/:id/devolver",async(q,s)=>{try{let r=await supabase.from("emprestimos").select("*").eq("id",q.params.id).maybeSingle();if(r.error)throw r.error;if(!r.data)return s.status(404).json({sucesso:false,erro:"Empréstimo não encontrado."});let d=await supabase.from("emprestimos").update({status:"Devolvido",data_devolucao:now()}).eq("id",q.params.id).eq("status","Ativo").is("data_devolucao",null).select().maybeSingle();if(d.error)throw d.error;if(!d.data)return s.status(409).json({sucesso:false,erro:"Empréstimo já devolvido."});let e=await supabase.from("equipamentos").update({status:"disponivel"}).eq("id",r.data.equipamento_id);if(e.error)throw e.error;s.json({sucesso:true,mensagem:"Equipamento devolvido.",emprestimo:d.data})}catch(e){fail(s,e,400)}});

app.get("/api/dashboard",async(q,s)=>{try{let f=await supabase.from("funcionarios").select("id",{count:"exact",head:true}),e=await supabase.from("equipamentos").select("status"),h=await supabase.from("emprestimos").select("status,data_devolucao");if(f.error)throw f.error;if(e.error)throw e.error;if(h.error)throw h.error;let disp=0,emp=0;for(const x of e.data||[]){if(st(x.status)==="disponivel")disp++;if(st(x.status)==="emprestado")emp++}s.json({sucesso:true,funcionarios:f.count||0,equipamentos:(e.data||[]).length,disponiveis:disp,emprestados:emp,emprestimos:(h.data||[]).filter(x=>st(x.status)==="ativo"&&!x.data_devolucao).length})}catch(e){fail(s,e)}});
app.get("/api/ultimos-emprestimos",async(q,s)=>{try{s.json({sucesso:true,emprestimos:(await allLoans()).slice(0,10)})}catch(e){fail(s,e)}});

app.use((q,s)=>s.status(404).json({sucesso:false,erro:"Rota não encontrada",rota:q.originalUrl}));
app.listen(PORT,()=>console.log("Inventário RFID online na porta",PORT));
