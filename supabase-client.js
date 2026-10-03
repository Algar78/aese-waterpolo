(function () {
  const authState = window.AESE_AUTH = {
    ready: false,
    configured: false,
    session: null,
    error: null,
    client: null,
    view: "login",
    resetRequested: new URLSearchParams(window.location.search).get("reset") === "1",
    passwordRecovery: false,
    passwordRecoveryError: "",
    passwordUpdated: false,
    resetEmailSent: false,
    emailDraft: ""
  };

  function refreshView() {
    if (typeof window.render === "function") window.render();
  }

  const config = window.AESE_SUPABASE_CONFIG || {};
  const url = typeof config.url === "string" ? config.url.trim() : "";
  const publishableKey = typeof config.publishableKey === "string" ? config.publishableKey.trim() : "";

  if (!url || !publishableKey) {
    authState.ready = true;
    authState.error = "Falta configurar la URL del proyecto y la clave pública de Supabase en supabase-config.js.";
    refreshView();
    return;
  }

  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    authState.ready = true;
    authState.error = "No se pudo cargar la biblioteca de Supabase. Comprueba la conexión a internet y recarga la página.";
    refreshView();
    return;
  }

  try {
    authState.client = window.supabase.createClient(url, publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
    authState.configured = true;

    authState.client.auth.onAuthStateChange(function (event, session) {
      authState.session = session;
      authState.ready = true;
      authState.error = null;
      if (event === "PASSWORD_RECOVERY") {
        authState.passwordRecovery = true;
        authState.passwordRecoveryError = "";
        authState.passwordUpdated = false;
        authState.view = "recovery";
      } else if (event === "SIGNED_OUT") {
        authState.passwordRecovery = false;
        authState.passwordRecoveryError = "";
        authState.passwordUpdated = false;
        authState.resetEmailSent = false;
        authState.view = "login";
      } else if (event === "SIGNED_IN") {
        authState.view = authState.passwordRecovery ? "recovery" : "app";
      } else if (event === "INITIAL_SESSION" && session) {
        if (authState.resetRequested) {
          authState.passwordRecovery = true;
          authState.view = "recovery";
        } else {
          authState.view = "app";
        }
      }
      refreshView();
    });

    authState.client.auth.getSession().then(function (result) {
      if (result.error) throw result.error;
      authState.session = result.data.session;
      if (authState.session && authState.resetRequested) {
        authState.passwordRecovery = true;
        authState.view = "recovery";
      } else if (authState.session && authState.view === "login") {
        authState.view = "app";
      }
      authState.ready = true;
      refreshView();
    }).catch(function (error) {
      authState.session = null;
      authState.ready = true;
      authState.error = error.message || "No se pudo comprobar la sesión.";
      refreshView();
    });
  } catch (error) {
    authState.ready = true;
    authState.error = error.message || "No se pudo inicializar Supabase.";
    refreshView();
  }
})();

window.aeseSignIn = async function (event) {
  event.preventDefault();
  const authState = window.AESE_AUTH;
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const submit = document.getElementById("authSubmit");
  const errorNode = document.getElementById("authError");
  submit.disabled = true;
  submit.textContent = "ACCEDIENDO…";
  errorNode.textContent = "";

  try {
    const result = await authState.client.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
  } catch (error) {
    errorNode.textContent = error.message || "No se pudo iniciar sesión.";
    submit.disabled = false;
    submit.textContent = "INICIAR SESIÓN";
  }
};

window.aeseShowForgotPassword = function () {
  const authState = window.AESE_AUTH;
  const emailInput = document.getElementById("authEmail");
  authState.emailDraft = emailInput ? emailInput.value.trim() : "";
  authState.error = null;
  authState.resetEmailSent = false;
  authState.view = "forgot";
  if (typeof window.render === "function") window.render();
};

window.aeseRequestPasswordReset = async function (event) {
  event.preventDefault();
  const authState = window.AESE_AUTH;
  const email = document.getElementById("resetEmail").value.trim();
  const submit = document.getElementById("resetSubmit");
  submit.disabled = true;
  submit.textContent = "ENVIANDO…";
  authState.error = null;

  try {
    const result = await authState.client.auth.resetPasswordForEmail(email, {
      redirectTo: "http://localhost:3000/?reset=1"
    });
    if (result.error) throw result.error;
    authState.emailDraft = email;
    authState.resetEmailSent = true;
  } catch (error) {
    authState.error = error.message || "No se pudo enviar el correo de recuperación.";
  }
  if (typeof window.render === "function") window.render();
};

window.aeseUpdatePassword = async function (event) {
  event.preventDefault();
  const authState = window.AESE_AUTH;
  const password = document.getElementById("newPassword").value;
  const repeatedPassword = document.getElementById("repeatPassword").value;
  let errorNode = document.getElementById("passwordRecoveryError");
  let submit = document.getElementById("passwordRecoverySubmit");
  if (password !== repeatedPassword) {
    authState.passwordRecoveryError = "Las contraseñas no coinciden.";
    if (errorNode) errorNode.textContent = authState.passwordRecoveryError;
    return;
  }

  authState.passwordRecoveryError = "";
  if (submit) {
    submit.disabled = true;
    submit.textContent = "GUARDANDO…";
  }
  if (errorNode) errorNode.textContent = "";
  try {
    const result = await authState.client.auth.updateUser({ password: password });
    if (result.error) throw result.error;
  } catch (error) {
    const errorCode = error && (error.code || (error.cause && error.cause.code));
    authState.passwordRecoveryError = errorCode === "same_password"
      ? "La nueva contraseña debe ser diferente de la contraseña anterior."
      : (error && error.message) || "No se pudo cambiar la contraseña.";

    // Reacquire the nodes: Auth may have emitted an event and rerendered the form
    // while updateUser was pending. Do not rerender on failure and risk losing it.
    errorNode = document.getElementById("passwordRecoveryError");
    submit = document.getElementById("passwordRecoverySubmit");
    if (errorNode) errorNode.textContent = authState.passwordRecoveryError;
    if (submit) {
      submit.disabled = false;
      submit.textContent = "GUARDAR NUEVA CONTRASEÑA";
    }
    if (!errorNode && typeof window.render === "function") window.render();
    return;
  }

  authState.passwordRecovery = false;
  authState.passwordRecoveryError = "";
  authState.passwordUpdated = true;
  authState.view = "recovery";
  authState.error = null;
  authState.resetRequested = false;
  try {
    window.history.replaceState({}, document.title, window.location.pathname);
  } catch (_error) {
    // The password update succeeded; URL cleanup must not hide that success.
  }
  if (typeof window.render === "function") window.render();
};

window.aeseReturnToLogin = async function () {
  const authState = window.AESE_AUTH;
  authState.view = "login";
  authState.passwordRecovery = false;
  authState.passwordUpdated = false;
  authState.resetRequested = false;
  authState.resetEmailSent = false;
  authState.error = null;
  window.history.replaceState({}, document.title, window.location.pathname);
  if (authState.client && authState.session) {
    try {
      const result = await authState.client.auth.signOut();
      if (result.error) throw result.error;
    } catch (error) {
      authState.error = error.message || "No se pudo cerrar la sesión de recuperación.";
    }
  }
  if (typeof window.render === "function") window.render();
};

window.aeseSignOut = async function () {
  const authState = window.AESE_AUTH;
  if (!authState || !authState.client) return;
  try {
    const result = await authState.client.auth.signOut();
    if (result.error) throw result.error;
  } catch (error) {
    authState.error = error.message || "No se pudo cerrar sesión.";
    if (typeof window.render === "function") window.render();
  }
};
