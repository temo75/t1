(() => {
  "use strict";
  const API = "https://dei-bill-sync.temo75elia.workers.dev";
  const byId = id => document.getElementById(id);
  const panel = byId("deiAdminLink");
  if (!panel) return;

  const signIn = byId("deiAdminSignIn");
  const signOut = byId("deiAdminSignOut");
  const controls = byId("deiAdminControls");
  const requestSelect = byId("deiPendingRequest");
  const legacySelect = byId("deiLegacyUser");
  const verified = byId("deiOwnershipVerified");
  const reference = byId("deiVerificationReference");
  const message = byId("deiAdminMessage");
  const claimOutput = byId("deiClaimCode");
  let auth;
  let pending = [];

  function localLegacyUsers() {
    try {
      const users = JSON.parse(localStorage.getItem("temoWorkTrackerUsers") || "[]");
      if (!Array.isArray(users)) return [];
      return users.filter(user =>
        user && typeof user === "object" && user.id && user.name &&
        String(user.name).trim().toUpperCase() !== "TEMO" &&
        user.admin !== true && user.blocked !== true && user.authorized !== false
      );
    } catch { return []; }
  }

  function populateLegacyUsers() {
    legacySelect.replaceChildren(new Option("მომხმარებელი აირჩიე", ""));
    for (const user of localLegacyUsers()) {
      const option = new Option(String(user.name).trim() + " — T1 ID " + String(user.id), String(user.id));
      legacySelect.add(option);
    }
  }

  async function initializeAuth() {
    if (auth) return auth;
    const response = await fetch(API + "/api/config", { cache: "no-store" });
    const config = await response.json().catch(() => ({}));
    if (!response.ok || !config.firebaseConfig) throw new Error(config.error || "Firebase-ის კონფიგურაცია ვერ ჩაიტვირთა");
    if (!window.firebase?.auth) throw new Error("Firebase Auth SDK ვერ ჩაიტვირთა");
    let app = window.firebase.apps.find(item => item.name === "t1-dei-admin");
    if (!app) app = window.firebase.initializeApp(config.firebaseConfig, "t1-dei-admin");
    auth = app.auth();
    await auth.setPersistence(window.firebase.auth.Auth.Persistence.SESSION);
    return auth;
  }

  async function api(path, options = {}) {
    const user = auth?.currentUser;
    if (!user) throw new Error("ადმინისტრატორის Google ავტორიზაცია საჭიროა");
    const response = await fetch(API + path, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + await user.getIdToken(),
        ...(options.body ? { "Content-Type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || ("Worker returned HTTP " + response.status));
    return data;
  }

  async function refreshRequests() {
    const result = await api("/api/admin/link-requests");
    pending = Array.isArray(result.requests) ? result.requests : [];
    requestSelect.replaceChildren(new Option("მოთხოვნა აირჩიე", ""));
    for (const item of pending) {
      const date = item.requestedAt ? new Date(item.requestedAt).toLocaleString("ka-GE") : "";
      const label = String(item.email || "Google ანგარიში") + (date ? " — " + date : "") +
        " — Firebase UID " + String(item.firebaseUid || "");
      requestSelect.add(new Option(label, item.firebaseUid));
    }
    message.textContent = pending.length
      ? "მოთხოვნები ჩაიტვირთა. ელფოსტა მარტო მიბმის საფუძველი არ არის — მფლობელობა ცალკე გადაამოწმე."
      : "ახალი მიბმის მოთხოვნა არ არის.";
    claimOutput.hidden = true;
    claimOutput.textContent = "";
  }

  async function refreshAuthState() {
    const user = auth?.currentUser;
    if (!user) {
      controls.hidden = true;
      signIn.hidden = false;
      signOut.hidden = true;
      message.textContent = "შედი ადმინისტრატორის წინასწარ დაშვებული Google ანგარიშით.";
      return;
    }
    try {
      await refreshRequests();
      populateLegacyUsers();
      controls.hidden = false;
      signIn.hidden = true;
      signOut.hidden = false;
    } catch (error) {
      controls.hidden = true;
      signIn.hidden = false;
      signOut.hidden = true;
      message.textContent = "ადმინისტრატორის წვდომა ვერ დადასტურდა: " + error.message;
    }
  }

  signIn.addEventListener("click", async () => {
    signIn.disabled = true;
    try {
      await initializeAuth();
      const provider = new window.firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await auth.signInWithPopup(provider);
      await refreshAuthState();
    } catch (error) {
      message.textContent = "ადმინისტრატორთან შესვლა ვერ შესრულდა: " + error.message;
    } finally { signIn.disabled = false; }
  });

  signOut.addEventListener("click", async () => {
    try { await auth?.signOut(); await refreshAuthState(); }
    catch (error) { message.textContent = "Google ანგარიშიდან გამოსვლა ვერ შესრულდა: " + error.message; }
  });

  byId("deiRefreshRequests").addEventListener("click", async () => {
    try { await refreshRequests(); }
    catch (error) { message.textContent = "მოთხოვნები ვერ ჩაიტვირთა: " + error.message; }
  });

  byId("deiIssueClaim").addEventListener("click", async event => {
    const firebaseUid = requestSelect.value;
    const legacyAccountId = legacySelect.value;
    const selected = pending.find(item => item.firebaseUid === firebaseUid);
    if (!selected || !legacyAccountId) { message.textContent = "აირჩიე Google მოთხოვნა და არსებული T1 მომხმარებელი."; return; }
    if (!verified.checked || !reference.value.trim()) {
      message.textContent = "ჯერ დამოუკიდებლად გადაამოწმე მფლობელობა და მიუთითე გადამოწმების ჩანაწერი.";
      return;
    }
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api("/api/admin/link-claim", {
        method: "POST",
        body: {
          firebaseUid,
          legacyAccountId,
          ownershipVerified: true,
          verificationMethod: "owner_review",
          verificationReference: reference.value.trim()
        }
      });
      await refreshRequests();
      claimOutput.textContent = "ერთჯერადი კოდი (მოქმედებს 7 დღე):\n" + result.claimCode +
        "\n\nმიაწოდე მხოლოდ ამ გზით გადამოწმებულ მომხმარებელს. კოდი T1-ის DEI გვერდზე ერთხელ უნდა შეიყვანოს.";
      claimOutput.hidden = false;
      message.textContent = "მიბმის კოდი გაიცა. Firebase UID და T1 ანგარიშის მფლობელობა შენ მიერ უნდა იყოს გადამოწმებული.";
      verified.checked = false;
      reference.value = "";
    } catch (error) {
      message.textContent = "კოდის გაცემა ვერ შესრულდა: " + error.message;
    } finally { button.disabled = false; }
  });

  initializeAuth().then(() => auth.onAuthStateChanged(refreshAuthState)).catch(error => {
    message.textContent = "ადმინისტრატორის პანელი ვერ ჩაიტვირთა: " + error.message;
  });
})();
