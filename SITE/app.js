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
    let mensagem = d.erro || d.mensagem || `Não foi possível concluir a solicitação (${r.status}).`;
    const m = String(mensagem).toLowerCase();
    if (m.includes("duplicate key") || m.includes("unique constraint") || m.includes("23505")) {
      mensagem = m.includes("matricula")
        ? "Essa matrícula já está cadastrada. Informe uma matrícula diferente."
        : (m.includes("uid_tag") || m.includes("tag")
          ? "Essa tag RFID já está vinculada a um cadastro. Use outra tag."
          : "Já existe um registro com esses dados. Confira as informações.");
    } else if (m.includes("foreign key") || m.includes("violates foreign key")) {
      mensagem = "Não é possível excluir este registro porque ele está vinculado a movimentações.";
    } else if (m.includes("timeout") || m.includes("aborted")) {
      mensagem = "O servidor demorou para responder. Aguarde um instante e tente novamente.";
    }
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
  logo: '<img src="/logo.svg" alt="" width="36" height="36" style="display:block;border-radius:10px">'
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
