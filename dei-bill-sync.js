(() => {
  "use strict";
  const API = "https://dei-bill-sync.temo75elia.workers.dev";
  let authPromise;
  let firebaseAuth;
  let oauthNotice = "";
  let autoSyncAfterOAuth = false;

  function t1Session() {
    try {
      const storage = window.localStorage;
      if (!storage || storage.getItem("temoWorkTrackerAuthorized") !== "yes") return null;
      const accountId = String(storage.getItem("temoWorkTrackerUserId") || "").trim();
      const name = String(storage.getItem("temoWorkTrackerUser") || "").trim();
      return accountId && name ? { accountId, name } : null;
    } catch { return null; }
  }

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
      if (!user) throw new Error("Firebase Google ავტორიზაცია საჭიროა");
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
    const message = element("p", "dei-sync-message", "შედი არსებული T1 ანგარიშით, შემდეგ დაუკავშირე შენი Gmail.");
    const loginLink = element("a", "dei-sync-login-link", "T1 ანგარიშში შესვლა");
    loginLink.href = "./index.html";
    loginLink.style.display = "inline-block";
    loginLink.style.margin = "8px 0";
    loginLink.style.padding = "10px 14px";
    loginLink.style.borderRadius = "9px";
    loginLink.style.background = "#e6eef5";
    loginLink.style.color = "#17547e";
    loginLink.style.fontWeight = "700";
    loginLink.style.textDecoration = "none";
    loginLink.hidden = true;

    const details = element("dl", "dei-sync-details");
    const values = {};
    [["amount", "თანხა"], ["due", "გადახდის ბოლო ვადა"], ["payment", "გადახდის სტატუსი"], ["email", "ქვითრის წერილის თარიღი"], ["sync", "ბოლო სინქრონიზაცია"]].forEach(([key, label]) => {
      details.append(element("dt", "", label));
      values[key] = element("dd", "dei-sync-" + key, "—");
      details.append(values[key]);
    });
    details.hidden = true;

    const actions = element("div", "dei-sync-actions");
    const connect = element("button", "dei-sync-primary", "Google-თან ჩემი Gmail-ის დაკავშირება");
    const sync = element("button", "", "ახლავე სინქრონიზაცია");
    const firebaseSignOut = element("button", "", "ამ მოწყობილობაზე Google ანგარიშის შეცვლა");
    connect.hidden = true;
    sync.hidden = true;
    firebaseSignOut.hidden = true;
    actions.append(connect, sync, firebaseSignOut);

    const linkPanel = element("section", "dei-link-panel");
    linkPanel.hidden = true;
    linkPanel.append(element("strong", "", "ერთჯერადი, ადმინისტრატორის მიერ დადასტურებული მიბმა"));
    linkPanel.append(element("p", "muted", "შენი Firebase ანგარიში ადმინისტრატორს დასადასტურებლად გაეგზავნება. ადმინისტრატორის მიერ მიბმის დამტკიცების შემდეგ შეიყვანე მიღებული ერთჯერადი კოდი."));
    const claimInput = element("input", "dei-auth-input");
    claimInput.type = "text";
    claimInput.autocomplete = "one-time-code";
    claimInput.maxLength = 64;
    claimInput.placeholder = "ერთჯერადი მიბმის კოდი";
    claimInput.setAttribute("aria-label", "ადმინისტრატორის ერთჯერადი მიბმის კოდი");
    const redeem = element("button", "", "ანგარიშის დადასტურება და გაგრძელება");
    linkPanel.append(claimInput, redeem);

    const historyPanel = element("section", "dei-bill-history");
    const historyTitle = element("h3", "", "შენახული ქვითრების ისტორია");
    const historySummary = element("p", "muted", "პირადი ისტორია ჯერ არ ჩატვირთულა.");
    const annualSummary = element("div", "dei-bill-annual-summary");
    const historyList = element("div", "dei-bill-history-list");
    historyPanel.append(historyTitle, historySummary, annualSummary, historyList);
    root.append(header, message, loginLink, details, actions, linkPanel, historyPanel);

    function setStatus(text, good) {
      badge.textContent = text;
      badge.classList.toggle("is-connected", Boolean(good));
      badge.classList.toggle("is-error", good === false);
    }
    function clearHistory(text) {
      historyList.replaceChildren();
      annualSummary.replaceChildren();
      historySummary.textContent = text;
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
    function sessionMatches(status) {
      const session = t1Session();
      return Boolean(session && status?.linked === true && String(status.t1AccountId || "") === session.accountId);
    }
    async function beginGmailOAuth() {
      const session = t1Session();
      if (!session) throw new Error("ჯერ შედი არსებული T1 ანგარიშით.");
      const status = await api("/api/status");
      if (status.linked !== true) {
        const request = await api("/api/account/link-request", { method: "POST", body: {} });
        linkPanel.hidden = false;
        connect.hidden = true;
        setStatus("ადმინისტრატორის დადასტურება საჭიროა", false);
        message.textContent = request.requested
          ? "მოთხოვნა გაიგზავნა. ადმინისტრატორი შეამოწმებს T1 ანგარიშის მფლობელობას; შემდეგ მიიღებ ერთჯერად კოდს."
          : "ანგარიშის მიბმის მოთხოვნა ვერ გაიგზავნა.";
        return;
      }
      if (!sessionMatches(status)) {
        throw new Error("ამ Google ანგარიშის T1 მიბმა სხვა ანგარიშს ეკუთვნის. შეცვალე Google ანგარიში ამ მოწყობილობაზე.");
      }
      const result = await api("/oauth/start", { method: "POST", body: { returnTo: location.origin + location.pathname } });
      location.assign(result.authorizationUrl);
    }
    async function refresh(force = false) {
      const session = t1Session();
      if (!session) {
        details.hidden = true;
        connect.hidden = true;
        sync.hidden = true;
        linkPanel.hidden = true;
        loginLink.hidden = false;
        firebaseSignOut.hidden = true;
        setStatus("T1 ანგარიშში შესვლა საჭიროა", false);
        message.textContent = "DEI ქვითრების სანახავად ჯერ შედი შენს არსებულ T1 ანგარიშში.";
        clearHistory("T1 ანგარიშში შესვლის შემდეგ გამოჩნდება მხოლოდ ამ ანგარიშთან მიბმული ქვითრები.");
        return;
      }
      loginLink.hidden = true;
      connect.hidden = false;
      const user = firebaseAuth?.currentUser;
      if (!user) {
        details.hidden = true;
        sync.hidden = true;
        linkPanel.hidden = true;
        firebaseSignOut.hidden = true;
        setStatus("T1 ანგარიშით შესული ხარ", true);
        message.textContent = "შედი არსებული T1 ანგარიშით; შემდეგ დააჭირე Gmail-ის დაკავშირებას, აირჩიე Google ანგარიში და დაადასტურე მხოლოდ Gmail-ის წაკითხვის ნებართვა.";
        clearHistory("Google-თან ავტორიზაციის შემდეგ ჩაიტვირთება მხოლოდ ამ T1 ანგარიშთან მიბმული ისტორია.");
        return;
      }
      const status = await api("/api/status");
      if (status.linked !== true) {
        details.hidden = true; sync.hidden = true; connect.hidden = true;
        linkPanel.hidden = false; firebaseSignOut.hidden = false;
        setStatus("ადმინისტრატორის მიბმა საჭიროა", false);
        message.textContent = "Google-ში შესვლა შესრულდა. არსებული T1 ანგარიშის დასაცავად საჭიროა ერთჯერადი ადმინისტრატორის კოდი.";
        clearHistory("ჯერ ანგარიში არ არის მიბმული; ქვითრები არ იტვირთება.");
        return;
      }
      if (!sessionMatches(status)) {
        details.hidden = true; connect.hidden = true; sync.hidden = true; linkPanel.hidden = true;
        firebaseSignOut.hidden = false;
        setStatus("T1 ანგარიში არ ემთხვევა", false);
        message.textContent = "ამ Google UID-ს სხვა T1 ანგარიში აქვს მიბმული. სხვა მომხმარებლის მონაცემების დასაცავად სინქრონიზაცია შეჩერებულია.";
        clearHistory("სხვა T1 ანგარიშის ისტორია ამ გვერდზე არ ჩაიტვირთება.");
        return;
      }
      firebaseSignOut.hidden = false;
      linkPanel.hidden = true;
      connect.hidden = Boolean(status.gmailConnected);
      sync.hidden = !status.gmailConnected;
      setStatus(status.gmailConnected ? "შენი Gmail ანგარიში დაკავშირებულია" : "T1 და Firebase ანგარიშები მიბმულია", Boolean(status.gmailConnected));
      if (!status.gmailConnected) {
        details.hidden = true;
        message.textContent = oauthNotice || "T1 ანგარიშის მიბმა დასრულდა. ახლა დააჭირე Gmail-ის დაკავშირებას და დაადასტურე Gmail-ის წაკითხვის ნებართვა.";
        clearHistory("Gmail ჯერ არ არის დაკავშირებული.");
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

    connect.addEventListener("click", async () => {
      connect.disabled = true; oauthNotice = "";
      try {
        if (!t1Session()) { await refresh(false); return; }
        await initializeAuth();
        if (!firebaseAuth.currentUser) {
          const provider = new window.firebase.auth.GoogleAuthProvider();
          provider.setCustomParameters({ prompt: "select_account" });
          await firebaseAuth.signInWithPopup(provider);
        }
        await beginGmailOAuth();
      } catch (error) {
        message.textContent = "Google/Gmail დაკავშირება ვერ მოხერხდა: " + error.message;
        setStatus("OAuth შეცდომა", false);
      } finally {
        connect.disabled = false;
      }
    });
    redeem.addEventListener("click", async () => {
      redeem.disabled = true;
      try {
        const session = t1Session();
        if (!session) throw new Error("ჯერ შედი არსებული T1 ანგარიშით.");
        const claimCode = String(claimInput.value || "").trim();
        if (!claimCode) throw new Error("შეიყვანე ადმინისტრატორის ერთჯერადი კოდი.");
        await initializeAuth();
        if (!firebaseAuth.currentUser) throw new Error("ჯერ Google ანგარიშით შედი.");
        await api("/api/account/link", { method: "POST", body: { claimCode } });
        claimInput.value = "";
        const status = await api("/api/status");
        if (!sessionMatches(status)) throw new Error("ეს კოდი სხვა T1 ანგარიშზეა მიბმული. სინქრონიზაცია არ დაწყებულა; დაუკავშირდი ადმინისტრატორს.");
        linkPanel.hidden = true;
        setStatus("ანგარიშები მიბმულია", true);
        message.textContent = "T1 ანგარიში დადასტურებულია. ახლა Gmail-ს ვაკავშირებ…";
        await beginGmailOAuth();
      } catch (error) {
        message.textContent = "ანგარიშის მიბმა ვერ შესრულდა: " + error.message;
        setStatus("მიბმის შეცდომა", false);
      } finally { redeem.disabled = false; }
    });
    sync.addEventListener("click", async () => {
      sync.disabled = true;
      try { await refresh(true); }
      catch (error) { message.textContent = "სინქრონიზაცია ვერ შესრულდა: " + error.message; setStatus("სინქრონიზაციის შეცდომა", false); }
      finally { sync.disabled = false; }
    });
    firebaseSignOut.addEventListener("click", async () => {
      try { await firebaseAuth?.signOut(); await refresh(false); }
      catch (error) { message.textContent = "Google ანგარიშიდან გამოსვლა ვერ შესრულდა: " + error.message; }
    });

    (async () => {
      try {
        await initializeAuth();
        const callbackStatus = new URLSearchParams(location.hash.replace(/^#/, "")).get("dei_gmail");
        if (callbackStatus) {
          history.replaceState(null, "", location.pathname + location.search);
          if (callbackStatus === "connected") { autoSyncAfterOAuth = true; oauthNotice = "Gmail OAuth წარმატებულია; ვეძებ DEI ქვითრებს…"; }
          else if (callbackStatus === "denied") oauthNotice = "Google-ის თანხმობა გაუქმდა. შეგიძლია ხელახლა ცადო.";
          else if (callbackStatus === "missing_refresh") oauthNotice = "Google-მა განახლების ნებართვა არ დააბრუნა. ხელახლა სცადე დაკავშირება.";
          else if (callbackStatus === "link_required") oauthNotice = "არსებული T1 ანგარიშის დასაცავად საჭიროა ადმინისტრატორის ერთჯერადი მიბმა.";
          else oauthNotice = "Gmail OAuth ვერ დასრულდა. სცადე თავიდან.";
        }
        firebaseAuth.onAuthStateChanged(() => {
          const runSync = autoSyncAfterOAuth;
          autoSyncAfterOAuth = false;
          return refresh(runSync).catch(error => {
            message.textContent = "პირადი სტატუსის ჩატვირთვა ვერ მოხერხდა: " + error.message;
            setStatus("კავშირი ვერ მოწმდება", false);
          });
        });
      } catch (error) {
        message.textContent = "Firebase Auth-ის კონფიგურაცია ვერ ჩაიტვირთა: " + error.message;
        setStatus("Firebase კონფიგურაცია აკლია", false);
      }
    })();
  }
  window.DEIBillSync = { mount };
})();