/* utilidades compartilhadas */
const $ = (s, el = document) => el.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const iniciais = n => String(n || "?").trim().split(/\s+/).slice(0, 2).map(p => p[0]).join("").toUpperCase();

function fmtData(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function api(caminho, opcoes = {}) {
  const init = { method: opcoes.method || "GET", headers: {} };
  if (opcoes.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opcoes.body); }
  const r = await fetch(caminho, init);
  let d = {};
  try { d = await r.json(); } catch (e) { }
  if (!r.ok || d.sucesso === false) {
    const mensagensConhecidas = {
      400: "Confira os campos preenchidos e tente novamente.",
      401: "Sua sessão não foi autorizada. Atualize a página.",
      404: "O registro ou recurso solicitado não foi encontrado.",
      409: "Esta informação já existe ou a operação entrou em conflito com o estado atual.",
      500: "Ocorreu um erro interno. Tente novamente em instantes.",
      503: "O serviço está temporariamente indisponível. Tente novamente em instantes."
    };
    const textoServidor = String(d.erro || d.mensagem || "");
    const tecnico = /duplicate key|unique constraint|postgres|supabase|stack|exception|relation .* does not exist/i.test(textoServidor);
    const mensagem = tecnico ? (mensagensConhecidas[r.status] || "Não foi possível concluir a operação. Confira os dados e tente novamente.") : (textoServidor || mensagensConhecidas[r.status] || `Não foi possível concluir (código ${r.status}).`);
    const err = new Error(mensagem);
    err.dados = d; err.status = r.status;
    throw err;
  }
  return d;
}

const ICONES = {
  sinal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.2" r="1.2" fill="currentColor"/><path d="M1.8 9a14.5 14.5 0 0 1 20.4 0"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  sai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/></svg>',
  volta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M8 7V5a4 4 0 0 1 8 0v2"/><path d="M12 12v3"/></svg>'
};

function montarTopo(ativa) {
  const link = (h, t, k) => `<a href="${h}" class="${k === ativa ? "on" : ""}">${t}</a>`;
  document.body.insertAdjacentHTML("afterbegin", `
  <header class="topbar"><div class="topbar-in">
    <div class="brand"><div class="brand-mark">${ICONES.logo}</div>Inventário RFID</div>
    <nav class="nav">${link("/", "Operação", "op")}${link("/cadastro", "Cadastro", "cad")}${link("/controle", "Painel", "pn")}</nav>
    <div class="pills">
      <span class="pill"><span class="dot" id="dotServ"></span><span id="txtServ">servidor…</span></span>
      <span class="pill"><span class="dot" id="dotEsp"></span><span id="txtEsp">leitor…</span></span>
    </div>
  </div></header>`);
}

async function atualizarPills() {
  try {
    const d = await api("/api/esp32/status");
    $("#dotServ").className = "dot on"; $("#txtServ").textContent = "servidor online";
    $("#dotEsp").className = "dot " + (d.conectado ? "on" : "off");
    $("#txtEsp").textContent = d.conectado ? "leitor conectado" : "leitor offline";
  } catch (e) {
    $("#dotServ").className = "dot off"; $("#txtServ").textContent = "sem conexão";
    $("#dotEsp").className = "dot"; $("#txtEsp").textContent = "leitor ?";
  }
}
function iniciarPills() { atualizarPills(); setInterval(atualizarPills, 8000); }

function aviso(el, tipo, msg, ms = 7000) {
  const alvo = typeof el === "string" ? $(el) : el;
  alvo.innerHTML = msg ? `<div class="toast ${tipo}">${esc(msg)}</div>` : "";
  clearTimeout(alvo._t);
  if (msg && ms) alvo._t = setTimeout(() => { alvo.innerHTML = ""; }, ms);
}
