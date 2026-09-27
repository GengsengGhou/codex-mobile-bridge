export function initializeLogin({ document, fetchImpl = fetch, navigate = () => { location.href = "/"; } }) {
  const form = document.getElementById("loginForm");
  const password = document.getElementById("password");
  const button = document.getElementById("loginButton");
  const error = document.getElementById("loginError");
  let busy = false;
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !password.value) return;
    busy = true; button.disabled = true; button.textContent = "正在登录…"; error.textContent = "";
    try {
      const response = await fetchImpl("/auth/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Bridge-Client": "mobile-v1" }, body: JSON.stringify({ password: password.value }) });
      password.value = "";
      if (!response.ok) { error.textContent = response.status === 429 ? "尝试次数过多，请稍后再试。" : "无法登录，请检查访问密码后重试。"; return; }
      const body = await response.json();
      if (body.authenticated === true) navigate();
      else error.textContent = "未能确认登录状态，请重试。";
    } catch { password.value = ""; error.textContent = "未能确认登录结果，请检查网络后重新登录。"; }
    finally { busy = false; button.disabled = false; button.textContent = "登录"; }
  });
}
if (typeof document !== "undefined" && document.getElementById("loginForm")) initializeLogin({ document });
