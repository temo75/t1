(() => {
  "use strict";
  const API = "https://dei-bill-sync.temo75elia.workers.dev";
  let authPromise;
  let firebaseAuth;

  async function initializeAuth() {
    if (authPromise) return authPromise;
    authPromise = (async () => {
      const response = await fetch(API + "/api/config", { cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.firebaseConfig) throw new Error(result.error || "Firebase-ის კონფიგურაცია ვერ ჩაიტვირთა");
      if (!window.firebase || !window.firebase.auth) throw new Error("Firebase Auth SDK ვერ ჩაიტვირთა");
      let app = window.firebase.apps.find(item => item.name === "t1-dei");
      if (!app) app = window.firebase.initializeApp(result.firebaseConfig, "t1-dei");
      firebaseAuth = app.auth();
      await firebaseAuth.setPersistence(window.firebase.auth.Auth.Persistence.SESSION);
      return firebaseAuth;
    })();
    return authPromise;
  }

  async function api(path, options = {}) {
    const headers = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.auth !== false) {
      const user = firebaseAuth && firebaseAuth.currentUser;
      if (!user) throw new Error("პირველ რიგში შედი Firebase ანგარიშში");
      headers.Authorization = "Bearer " + await user.getIdToken();
    }
    const response = await fetch(API + path, {
      method: options.method || "GET", headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || ("Worker returned HTTP " + response.status));
    return data;
  }

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function formatAmount(value) {
    if (value === null || value === undefined || value === "") return "თანხა წერილიდან ვერ ამოვიღე";
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "თანხა წერილიდან ვერ ამოვიღე";
    return new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format(amount);
  }
  function formatDueDate(value) {
    if (!value) return "ვადა წერილში ვერ მოიძებნა";
    const date = new Date(value + "T00:00:00Z");
    return Number.isNaN(date.getTime()) ? "ვადა წერილში ვერ მოიძებნა" : date.toLocaleDateString("ka-GE", { timeZone: "UTC" });
  }
  function paymentLabel(status, dueDate) {
    if (status === "paid") return "გადახდილია";
    if (status === "due") {
      if (dueDate && new Date(dueDate + "T23:59:59Z").getTime() < Date.now()) return "ვადა გადაცილებულია";
      return "გადასახდელია";
    }
    return "წერილში გადახდის სტატუსი ვერ დადგინდა";
  }

  function mount(root) {
    if (!root) return;
    root.replaceChildren();
    root.classList.add("dei-sync-widget");
    const header = element("div", "dei-sync-header");
    header.append(element("h2", "", "⚡ ΔΕΗ — პირადი ქვითრები"));
    const badge = element("span", "dei-sync-badge", "Firebase Auth-ის ჩატვირთვა…");
    header.append(badge);
    const message = element("p", "dei-sync-message", "მომხმარებლის პირადი მონაცემებისთვის საჭიროა დადასტურებული Firebase ანგარიში.");
    const authPanel = element("section", "dei-auth-panel");
    const email = element("input", "dei-auth-input");
    email.type = "email"; email.autocomplete = "username"; email.placeholder = "ელფოსტა"; email.setAttribute("aria-label", "Firebase Auth ელფოსტა");
    const password = element("input", "dei-auth-input");
    password.type = "password"; password.autocomplete = "current-password"; password.placeholder = "Firebase პაროლი"; password.setAttribute("aria-label", "Firebase Auth პაროლი");
    const authActions = element("div", "dei-sync-actions");
    const signIn = element("button", "", "არსებული Firebase ანგარიშით შესვლა");
    const createAccount = element("button", "", "Firebase ანგარიშის შექმნა");
    const signOut = element("button", "", "ამ ბრაუზერიდან გამოსვლა");
    signOut.hidden = true;
    authActions.append(signIn, createAccount, signOut);
    authPanel.append(email, password, authActions);

    const details = element("dl", "dei-sync-details"); details.hidden = true;
    const values = {};
    [["amount", "თანხა"], ["due", "გადახდის ბოლო ვადა"], ["payment", "გადახდის სტატუსი"], ["email", "ქვითრის წერილის თარიღი"], ["sync", "ბოლო სინქრონიზაცია"]].forEach(([key, label]) => {
      details.append(element("dt", "", label));
      values[key] = element("dd", "dei-sync-" + key, "—"); details.append(values[key]);
    });
    const actions = element("div", "dei-sync-actions");
    const connect = element("button", "dei-sync-primary", "Google-თან ჩემი Gmail-ის დაკავშირება");
    const sync = element("button", "", "ახლავე სინქრონიზაცია");
    connect.hidden = true; sync.hidden = true;
    actions.append(connect, sync);
    const historyPanel = element("section", "dei-bill-history");
    const historyTitle = element("h3", "", "შენახული ქვითრების ისტორია");
    const historySummary = element("p", "muted", "პირადი ისტორია ჯერ არ ჩატვირთულა.");
    const annualSummary = element("div", "dei-bill-annual-summary");
    const historyList = element("div", "dei-bill-history-list");
    historyPanel.append(historyTitle, historySummary, annualSummary, historyList);
    root.append(header, message, authPanel, details, actions, historyPanel);

    function setStatus(text, good) {
      badge.textContent = text;
      badge.classList.toggle("is-connected", Boolean(good));
      badge.classList.toggle("is-error", good === false);
    }
    function renderBill(bill) {
      details.hidden = false;
      values.amount.textContent = formatAmount(bill.totalEUR);
      values.due.textContent = formatDueDate(bill.dueDate);
      values.payment.textContent = paymentLabel(bill.paymentStatus, bill.dueDate);
      values.email.textContent = bill.emailDate || "თარიღი არ არის მითითებული";
      values.sync.textContent = bill.fetchedAt ? new Date(bill.fetchedAt).toLocaleString("ka-GE") : "ჯერ არ დასინქრონებულა";
      window.dispatchEvent(new CustomEvent("t1:dei-bill", { detail: bill }));
    }
    async function refreshHistory() {
      const result = await api("/api/history");
      if (result.ok !== true || !Array.isArray(result.bills)) throw new Error("Worker-ის ისტორიის პასუხი არასწორია");
      historyList.replaceChildren();
      historySummary.textContent = "ქვითრები: " + result.count + " · გადახდილი ჯამი: " +
        formatAmount(result.totalPaidEUR) + " · გადასახდელი ჯამი: " + formatAmount(result.totalDueEUR);
      annualSummary.replaceChildren();
      annualSummary.append(element("h4", "", "წლიური ჯამები"));
      if (result.annualTotals?.length) result.annualTotals.forEach(year => {
        const line = element("p", "dei-bill-year-total");
        line.textContent = year.year + " — გადახდილი: " + formatAmount(year.paidEUR) + " · გადასახდელი: " + formatAmount(year.dueEUR);
        annualSummary.append(line);
      });
      else annualSummary.append(element("p", "muted", "წლიური ჯამები ჯერ არ არის."));
      if (!result.bills.length) historyList.append(element("p", "muted", "ჯერ შენახული ქვითრები არ არის."));
      result.bills.forEach(bill => {
        const row = element("article", "dei-bill-history-item");
        row.append(element("strong", "", formatAmount(bill.totalEUR)));
        row.append(element("span", "", paymentLabel(bill.paymentStatus, bill.dueDate)));
        row.append(element("small", "", (bill.emailDate || "თარიღი უცნობია") + " · ვადა: " + formatDueDate(bill.dueDate)));
        historyList.append(row);
      });
    }
    async function syncAllPages() {
      let result = null, continueSync = false, pages = 0;
      do {
        message.textContent = pages ? "Gmail-ის ძველ ქვითრებს ვამოწმებ… გვერდი " + (pages + 1) : "შენს Gmail-ში DEI ქვითრებს ვეძებ…";
        result = await api("/api/sync", { method: "POST", body: { continue: continueSync } });
        pages++;
        continueSync = result.complete === false;
      } while (continueSync);
      result.syncPages = pages;
      return result;
    }
    async function refresh(force = false) {
      const user = firebaseAuth?.currentUser;
      if (!user) {
        authPanel.hidden = false; details.hidden = true; connect.hidden = false; sync.hidden = true;
        signIn.hidden = false; createAccount.hidden = false; email.hidden = false; password.hidden = false;
        signOut.hidden = true;
        setStatus("Firebase ავტორიზაცია საჭიროა", false);
        message.textContent = "დააჭირე დიდ Google ღილაკს: აირჩიე ანგარიში, შემდეგ დაადასტურე მხოლოდ Gmail-ის წაკითხვის ნებართვა.";
        historyList.replaceChildren(); annualSummary.replaceChildren();
        historySummary.textContent = "შესვლის შემდეგ გამოჩნდება მხოლოდ ამ ანგარიშის DEI ქვითრები.";
        return;
      }
      authPanel.hidden = false; signIn.hidden = true; createAccount.hidden = true; signOut.hidden = false;
      email.hidden = true; password.hidden = true;
      const status = await api("/api/status");
      connect.hidden = Boolean(status.gmailConnected); sync.hidden = !status.gmailConnected;
      setStatus(status.gmailConnected ? "შენი Gmail ანგარიში დაკავშირებულია" : "Google ანგარიშში შესული ხარ", Boolean(status.gmailConnected));
      if (!status.gmailConnected) {
        message.textContent = "დააჭირე დიდ ღილაკს და Google-ში აირჩიე Gmail ანგარიში. T1 ითხოვს მხოლოდ Gmail-ის წაკითხვის ნებართვას.";
        historyList.replaceChildren(); annualSummary.replaceChildren();
        historySummary.textContent = "Gmail ჯერ არ არის დაკავშირებული.";
        return;
      }
      message.textContent = force ? "სინქრონიზაცია მიმდინარეობს…" : "შენს Worker სივრცეში შენახულ ბოლო ქვითარს ვკითხულობ…";
      const result = force ? await syncAllPages() : await api("/api/latest");
      if (result.bill?.found) {
        renderBill(result.bill);
        message.textContent = result.cached ? "შენი ბოლო ქვითარი უსაფრთხოდ ჩაიტვირთა." :
          "სინქრონიზაცია დასრულდა. შემოწმებული გვერდები: " + (result.syncPages ?? "—") + ".";
      } else {
        details.hidden = true;
        message.textContent = force ? "სინქრონიზაცია დასრულდა, მაგრამ ამ ანგარიშში ამოსაცნობი DEI ქვითარი ვერ მოიძებნა." :
          "შენახული DEI ქვითარი ჯერ არ არის. დააჭირე სინქრონიზაციას.";
        window.dispatchEvent(new CustomEvent("t1:dei-bill", { detail: null }));
      }
      try { await refreshHistory(); }
      catch (error) {
        historyList.replaceChildren(); annualSummary.replaceChildren();
        historySummary.textContent = "ისტორია ვერ ჩაიტვირთა: " + error.message;
      }
    }
    signIn.addEventListener("click", async () => {
      try {
        await initializeAuth();
        await firebaseAuth.signInWithEmailAndPassword(email.value.trim(), password.value);
        await refresh(false);
      } catch (error) { message.textContent = "Firebase-ში შესვლა ვერ შესრულდა: " + error.message; setStatus("შესვლის შეცდომა", false); }
    });
    createAccount.addEventListener("click", async () => {
      try {
        await initializeAuth();
        await firebaseAuth.createUserWithEmailAndPassword(email.value.trim(), password.value);
        message.textContent = "Firebase ანგარიში შეიქმნა. ახლა Google ღილაკით დააკავშირე Gmail.";
        await refresh(false);
      } catch (error) { message.textContent = "ანგარიშის შექმნა ვერ შესრულდა: " + error.message; setStatus("ანგარიშის შეცდომა", false); }
    });
    signOut.addEventListener("click", async () => {
      if (firebaseAuth) await firebaseAuth.signOut();
      await refresh(false);
    });
    connect.addEventListener("click", async () => {
      connect.disabled = true;
      try {
        await initializeAuth();
        if (!firebaseAuth.currentUser) {
          const provider = new window.firebase.auth.GoogleAuthProvider();
          provider.setCustomParameters({ prompt: "select_account" });
          await firebaseAuth.signInWithPopup(provider);
        }
        const result = await api("/oauth/start", { method: "POST", body: { returnTo: location.origin + location.pathname } });
        location.assign(result.authorizationUrl);
      } catch (error) { message.textContent = "Google/Gmail დაკავშირება ვერ მოხერხდა: " + error.message; setStatus("OAuth შეცდომა", false); connect.disabled = false; }
    });
    sync.addEventListener("click", async () => {
      sync.disabled = true;
      try { await refresh(true); }
      catch (error) { message.textContent = "სინქრონიზაცია ვერ შესრულდა: " + error.message; setStatus("სინქრონიზაციის შეცდომა", false); }
      finally { sync.disabled = false; }
    });

    (async () => {
      try {
        await initializeAuth();
        const callbackStatus = new URLSearchParams(location.hash.replace(/^#/, "")).get("dei_gmail");
        if (callbackStatus) {
          history.replaceState(null, "", location.pathname + location.search);
          if (callbackStatus === "connected") message.textContent = "Gmail OAuth წარმატებულია; ვამოწმებ შენს კავშირს…";
          else if (callbackStatus === "denied") message.textContent = "Google-ის თანხმობა გაუქმდა.";
          else if (callbackStatus === "missing_refresh") message.textContent = "Google-მა განახლების ნებართვა არ დააბრუნა. ხელახლა დაიწყე Gmail-ის დაკავშირება.";
          else message.textContent = "Gmail OAuth ვერ დასრულდა. სცადე თავიდან.";
        }
        firebaseAuth.onAuthStateChanged(() => refresh(false).catch(error => {
          message.textContent = "პირადი სტატუსის ჩატვირთვა ვერ მოხერხდა: " + error.message;
          setStatus("კავშირი ვერ მოწმდება", false);
        }));
      } catch (error) {
        message.textContent = "Firebase Auth-ის კონფიგურაცია ვერ ჩაიტვირთა: " + error.message;
        setStatus("Firebase კონფიგურაცია აკლია", false);
      }
    })();
  }
  window.DEIBillSync = { mount };
})();