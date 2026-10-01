import { createI18n } from "./i18n.js";
export function initializeLogin({ document, fetchImpl = fetch, navigate = () => { location.href = "/"; } }) {
  const i18n = createI18n({ window: document.defaultView, document }), t = i18n.t;
  const form = document.getElementById("loginForm");
  const password = document.getElementById("password");
  const button = document.getElementById("loginButton");
  const error = document.getElementById("loginError");
  let busy = false;
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !password.value) return;
    busy = true; button.disabled = true; i18n.text(button, () => t("正在登录…")); i18n.text(error, () => "");
    try {
      const response = await fetchImpl("/auth/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Bridge-Client": "mobile-v1" }, body: JSON.stringify({ password: password.value }) });
      password.value = "";
      if (!response.ok) { i18n.text(error, () => response.status === 429 ? t("尝试次数过多，请稍后再试。") : t("无法登录，请检查访问密码后重试。")); return; }
      const body = await response.json();
      if (body.authenticated === true) navigate();
      else i18n.text(error, () => t("未能确认登录状态，请重试。"));
    } catch { password.value = ""; i18n.text(error, () => t("未能确认登录结果，请检查网络后重新登录。")); }
    finally { busy = false; button.disabled = false; i18n.text(button, () => t("登录")); }
  });
}
if (typeof document !== "undefined" && document.getElementById("loginForm")) initializeLogin({ document });
