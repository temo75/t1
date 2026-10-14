(() => {
  "use strict";
  const API = "https://dei-bill-sync.temo75elia.workers.dev";
  const SESSION_KEY = "t1.deiBillSession.v1";

  function getSession() {
    try {
      const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      if (!value || !value.token || !value.expiresAt || Date.parse(value.expiresAt) <= Date.now()) {
        sessionStorage.removeItem(SESSION_KEY);
        return null;
      }
      return value;
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  async function api(path, session, options) {
    const config = options || {};
    const headers = { "Accept": "application/json" };
    if (config.body) headers["Content-Type"] = "application/json";
    if (session && session.token) headers.Authorization = "Bearer " + session.token;
    const response = await fetch(API + path, {
      method: config.method || "GET",
      headers,
      body: config.body ? JSON.stringify(config.body) : undefined,
      cache: "no-store"
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      if (response.status === 401 && session) sessionStorage.removeItem(SESSION_KEY);
      throw new Error(data.error || ("Worker returned HTTP " + response.status));
    }
    return data;
  }

  async function exchangeOAuthCode() {
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
    const code = fragment.get("dei_code");
    if (!code) return false;
    history.replaceState(null, "", location.pathname + location.search);
    const result = await api("/api/session/exchange", null, { method: "POST", body: { code } });
    if (!result.sessionToken || !result.expiresAt) throw new Error("Worker returned an incomplete session");
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: result.sessionToken, expiresAt: result.expiresAt }));
    return true;
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
    header.append(element("h2", "", "⚡ ΔΕΗ — მიმდინარე ქვითარი"));
    const badge = element("span", "dei-sync-badge", "სტატუსის შემოწმება…");
    header.append(badge);

    const message = element("p", "dei-sync-message", "ვამოწმებ Gmail კავშირს…");
    const details = element("dl", "dei-sync-details");
    details.hidden = true;
    const fields = [
      ["amount", "თანხა"],
      ["due", "გადახდის ბოლო ვადა"],
      ["payment", "გადახდის სტატუსი"],
      ["email", "ქვითრის წერილი"],
      ["sync", "ბოლო სინქრონიზაცია"]
    ];
    const values = {};
    fields.forEach(([key, label]) => {
      details.append(element("dt", "", label));
      values[key] = element("dd", "dei-sync-" + key, "—");
      details.append(values[key]);
    });

    const actions = element("div", "dei-sync-actions");
    const connect = element("button", "dei-sync-primary", "Gmail-ის უსაფრთხოდ დაკავშირება");
    const sync = element("button", "", "ახლავე სინქრონიზაცია");
    const signOut = element("button", "", "ამ ბრაუზერის სესიის დასრულება");
    sync.hidden = true;
    signOut.hidden = true;
    actions.append(connect, sync, signOut);
    root.append(header, message, details, actions);

    function setStatus(text, good) {
      badge.textContent = text;
      badge.classList.toggle("is-connected", Boolean(good));
      badge.classList.toggle("is-error", good === false);
    }

    function connectGmail() {
      const returnTo = location.origin + location.pathname;
      location.assign(API + "/oauth/start?return_to=" + encodeURIComponent(returnTo));
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

    async function refresh(force) {
      const session = getSession();
      if (!session) {
        sync.hidden = true;
        signOut.hidden = true;
        setStatus("ამ ბრაუზერში Gmail არ არის ავტორიზებული", false);
        message.textContent = "დააკავშირე Google ანგარიში OAuth-ის ოფიციალური თანხმობის გვერდით. პაროლს ან საიდუმლო გასაღებს ეს გვერდი არ ითხოვს.";
        const status = await api("/api/status", null);
        if (status.gmailConnected) message.textContent = "Gmail Worker-თან უკვე დაკავშირებულია. ამ მოწყობილობაზე მონაცემების სანახავად დააჭირე დაკავშირებას.";
        return;
      }
      connect.hidden = true;
      sync.hidden = false;
      signOut.hidden = false;
      setStatus("Gmail ავტორიზებულია ამ ბრაუზერში", true);
      message.textContent = force ? "ვკითხულობ Gmail-იდან ახალ DEI ქვითარს…" : "ვკითხულობ Worker-ში შენახულ ბოლო DEI ქვითარს…";
      const result = force
        ? await api("/api/sync", session, { method: "POST", body: {} })
        : await api("/api/latest", session);
      if (!result.bill || !result.bill.found) {
        details.hidden = true;
        message.textContent = "DEI-ის შესაბამისი წერილი ჯერ ვერ მოიძებნა.";
        window.dispatchEvent(new CustomEvent("t1:dei-bill", { detail: null }));
        return;
      }
      renderBill(result.bill);
      message.textContent = result.cached ? "ბოლო ქვითარი უსაფრთხოდ ჩაიტვირთა KV-დან." : "ბოლო ქვითარი წარმატებით განახლდა Gmail-იდან.";
    }

    connect.addEventListener("click", connectGmail);
    sync.addEventListener("click", async () => {
      sync.disabled = true;
      try { await refresh(true); }
      catch (error) { message.textContent = "სინქრონიზაცია ვერ შესრულდა: " + error.message; setStatus("სინქრონიზაციის შეცდომა", false); }
      finally { sync.disabled = false; }
    });
    signOut.addEventListener("click", () => {
      sessionStorage.removeItem(SESSION_KEY);
      connect.hidden = false;
      refresh(false).catch(error => { message.textContent = error.message; setStatus("სტატუსის შემოწმება ვერ შესრულდა", false); });
    });

    (async () => {
      try {
        await exchangeOAuthCode();
        await refresh(false);
      } catch (error) {
        message.textContent = "კავშირის შემოწმება ვერ შესრულდა: " + error.message;
        setStatus("კავშირი ვერ მოწმდება", false);
      }
    })();
  }

  window.DEIBillSync = { mount };
})();