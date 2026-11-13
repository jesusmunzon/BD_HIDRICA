import { GOOGLE_DATABASE } from "./config.js";
import { loadGoogleSheet } from "./google-sheets.js";
import { norm } from "./formats.js";
import { sheetRows } from "./table-utils.js";

const SESSION_KEY = "control-red-auth-session";
const TEMPLATE = `
<div class="auth-modal" id="authModal" role="dialog" aria-modal="true" aria-labelledby="authTitle" hidden>
  <div class="auth-backdrop" data-close-auth></div>
  <section class="auth-dialog">
    <header class="auth-dialog-head">
      <div><h2 id="authTitle">Identificación de usuario</h2><p>Acceso al modo administrador</p></div>
      <button class="auth-close" id="authClose" type="button" aria-label="Cerrar"><i data-lucide="x"></i></button>
    </header>
    <form id="authForm" novalidate>
      <label class="auth-field"><span>Nombre de usuario</span><div><i data-lucide="user"></i><input id="authUser" autocomplete="username" required></div></label>
      <label class="auth-field"><span>Contraseña</span><div><i data-lucide="lock-keyhole"></i><input id="authPassword" type="password" autocomplete="current-password" required></div></label>
      <p class="auth-message" id="authMessage" aria-live="polite"></p>
      <div class="auth-guest-row"><button class="auth-guest" id="guestModeButton" type="button"><i data-lucide="user-round"></i>Continuar como Invitado</button></div>
      <div class="auth-actions"><button class="auth-cancel" id="authCancel" type="button">Cancelar</button><button class="auth-submit" type="submit">Iniciar sesión</button></div>
    </form>
  </section>
</div>`;

const guestSession = () => ({ name: "Invitado", administrator: false });
function readSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)) || guestSession(); } catch { return guestSession(); } }
function writeSession(session) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {} }
function applySession(session) {
  const current = { ...guestSession(), ...session };
  document.querySelectorAll("#headerUserName").forEach((node) => { node.textContent = current.name; });
  const sidebarName = document.getElementById("sidebarUserName");
  const sidebarMode = document.getElementById("sidebarUserMode");
  if (sidebarName) sidebarName.textContent = current.name;
  if (sidebarMode) sidebarMode.textContent = current.administrator ? "Modo Administrador" : "Modo Lectura";
  window.dispatchEvent(new CustomEvent("control-red-auth-change", { detail: current }));
}
function parseUsers(workbook) {
  return sheetRows(workbook).slice(1).map((row) => ({
    user: String(row[0] ?? "").trim(),
    password: String(row[1] ?? "").trim(),
    name: String(row[2] ?? row[0] ?? "").trim(),
  })).filter((record) => record.user);
}
async function validateAdministrator(user, password) {
  const workbook = await loadGoogleSheet(GOOGLE_DATABASE.sheets.cfgUsuarios, 0);
  return parseUsers(workbook).find((record) => norm(record.user) === norm(user) && record.password === password) || null;
}
function initializeAuthComponent() {
  document.getElementById("authModal")?.remove();
  document.body.insertAdjacentHTML("beforeend", TEMPLATE);
  const modal = document.getElementById("authModal");
  const form = document.getElementById("authForm");
  const user = document.getElementById("authUser");
  const password = document.getElementById("authPassword");
  const message = document.getElementById("authMessage");
  const close = () => { modal.hidden = true; message.textContent = ""; message.className = "auth-message"; form.reset(); };
  const open = () => { modal.hidden = false; user.focus(); window.lucide?.createIcons(); };
  document.querySelectorAll("#identityButton").forEach((button) => button.addEventListener("click", open));
  document.getElementById("authClose").addEventListener("click", close);
  document.getElementById("authCancel").addEventListener("click", close);
  modal.querySelector("[data-close-auth]").addEventListener("click", close);
  document.getElementById("guestModeButton").addEventListener("click", () => { const session = guestSession(); writeSession(session); applySession(session); close(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); message.textContent = "Comprobando identificación..."; message.className = "auth-message";
    try {
      const record = await validateAdministrator(user.value, password.value);
      if (!record) { message.textContent = "No existe registro de usuario."; message.className = "auth-message error"; return; }
      const session = { name: record.name, administrator: true }; writeSession(session); applySession(session);
      message.textContent = "Usuario administrador iniciado correctamente."; message.className = "auth-message success"; setTimeout(close, 900);
    } catch (error) { console.error(error); message.textContent = "No se pudo consultar CFG_Usuarios."; message.className = "auth-message error"; }
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !modal.hidden) close(); });
  applySession(readSession()); window.lucide?.createIcons();
  window.AuthSession = { open, close, get: readSession, isAdministrator: () => Boolean(readSession().administrator) };
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializeAuthComponent, { once: true }); else initializeAuthComponent();
