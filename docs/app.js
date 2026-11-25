/* BidChain Gallery — frontend (ethers v6 + MetaMask) */
(() => {
  const { ethers } = window;
  const CFG = window.APP_CONFIG;
  const ABI = window.AUCTION_ABI;
  const NET = CFG.NETWORKS[CFG.CHAIN_ID] || { name: "Chain " + CFG.CHAIN_ID, rpc: "", explorer: "", symbol: "ETH" };
  const ZERO = ethers.ZeroAddress;
  const isZeroAddr = CFG.CONTRACT_ADDRESS === ZERO;

  const ST = { Live: 0, AwaitingPayment: 1, Settled: 2, ReserveNotMet: 3, NoBids: 4, Defaulted: 5, Cancelled: 6 };
  const EVENT_TH = {
    AuctionCreated: "เปิดประมูล",
    BidPlaced: "เสนอราคา",
    OutbidCredited: "บันทึกคืนมัดจำผู้ถูกแซง",
    AuctionFinalized: "ปิดประมูล",
    PaymentSettled: "ชำระเงิน & โอนผู้ขาย",
    DepositRefunded: "คืนมัดจำ (ไม่ถึง Reserve)",
    DepositForfeited: "ยึดมัดจำ (ผู้ชนะไม่ชำระ)",
    AuctionCancelled: "ยกเลิกการประมูล",
    Withdrawn: "ถอนเงิน",
    FeesWithdrawn: "ถอนค่าธรรมเนียม",
  };

  const state = { read: null, browser: null, signer: null, account: null, write: null, owner: null, auctions: [], bids: {}, events: [], refund: 0n, fees: 0n, filter: "all", openId: null };

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "–");
  const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
  const now = () => Math.floor(Date.now() / 1000);
  const eth = (wei) => Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 6 }) + " ETH";
  const ethN = (wei) => Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 6 });
  const lotNo = (id) => "LOT " + String(id).padStart(3, "0");
  const fmtDate = (ts) => new Date(Number(ts) * 1000).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
  const txLink = (h) => (NET.explorer ? `<a class="mono" href="${NET.explorer}/tx/${h}" target="_blank" rel="noopener">${short(h)}</a>` : `<span class="mono">${short(h)}</span>`);
  const addr = (a) => (same(a, state.account) ? "<b>คุณ</b>" : NET.explorer ? `<a class="mono" href="${NET.explorer}/address/${a}" target="_blank" rel="noopener">${short(a)}</a>` : `<span class="mono">${short(a)}</span>`);
  const hasThai = (s) => /[฀-๿]/.test(s);

  function countdown(sec) {
    if (sec <= 0) return "00:00:00";
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = (n) => String(n).padStart(2, "0");
    return (d ? d + "d " : "") + `${p(h)}:${p(m)}:${p(s)}`;
  }

  function artHTML(uri, cls = "") {
    let inner;
    const m = /^gen:(\d+)$/.exec(uri || "");
    if (m || !uri) inner = window.BidArt.artSVG(m ? m[1] : 1);
    else {
      let src = uri.startsWith("ipfs://") ? "https://ipfs.io/ipfs/" + uri.slice(7) : uri;
      inner = /^https?:\/\//i.test(src) ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : window.BidArt.artSVG(1);
    }
    return `<div class="frame ${cls}">${inner}</div>`;
  }

  // สถานะสำหรับแสดงผล (รวมเวลาปัจจุบัน)
  function view(a) {
    const t = now();
    if (a.status === ST.Live && t < a.endTime) return { key: "live", text: "กำลังประมูล", cls: "t-live", step: 0 };
    if (a.status === ST.Live) return { key: "pending", text: "หมดเวลา · รอปิด", cls: "t-wait", step: 1 };
    if (a.status === ST.AwaitingPayment && t <= a.paymentDeadline) return { key: "pending", text: "รอผู้ชนะชำระ", cls: "t-wait", step: 2 };
    if (a.status === ST.AwaitingPayment) return { key: "pending", text: "เลยกำหนดชำระ", cls: "t-wait", step: 2 };
    if (a.status === ST.Settled) return { key: "closed", text: "ขายแล้ว", cls: "t-done", step: 3 };
    if (a.status === ST.ReserveNotMet) return { key: "closed", text: "ไม่ถึง Reserve", cls: "t-off", step: 3 };
    if (a.status === ST.NoBids) return { key: "closed", text: "ไม่มีผู้ประมูล", cls: "t-off", step: 3 };
    if (a.status === ST.Defaulted) return { key: "closed", text: "ยึดมัดจำ", cls: "t-off", step: 3 };
    return { key: "closed", text: "ยกเลิก", cls: "t-off", step: 3 };
  }

  function toast(html, type = "", ms = 7000) {
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.innerHTML = html;
    $("#toasts").appendChild(el);
    if (ms) setTimeout(() => el.remove(), ms);
    return el;
  }
  function notice(html) { const n = $("#notice"); if (!html) return n.classList.add("hidden"); n.innerHTML = html; n.classList.remove("hidden"); }
  function errMsg(e) {
    if (e?.code === "ACTION_REJECTED" || e?.code === 4001) return "ยกเลิกธุรกรรมใน MetaMask";
    return e?.reason || e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
  }

  async function sendTx(label, fn) {
    if (!state.write) throw new Error("กรุณาเชื่อมต่อ MetaMask ก่อน");
    const t = toast(`⏳ ${label} — ยืนยันใน MetaMask…`, "", 0);
    try {
      const tx = await fn(state.write);
      t.innerHTML = `${label} — ส่งธุรกรรมแล้ว รอยืนยัน…<br>Tx ${txLink(tx.hash)}`;
      const r = await tx.wait();
      t.remove();
      toast(`✓ ${label} สำเร็จ<br>Tx ${txLink(tx.hash)}`, "ok", 9000);
      await refresh();
      return r;
    } catch (e) {
      t.remove();
      toast(`✕ ${label} ไม่สำเร็จ: ${esc(errMsg(e))}`, "err", 10000);
      throw e;
    }
  }

  // ---------- wallet ----------
  async function connect() {
    if (!window.ethereum) return toast('ไม่พบ MetaMask — ติดตั้งได้ที่ <a href="https://metamask.io/download/" target="_blank">metamask.io</a>', "err");
    // wallet_requestPermissions เปิดหน้าเลือกบัญชีทุกครั้ง (eth_requestAccounts จะคืนบัญชีเดิมเงียบ ๆ ถ้าเคยเชื่อมแล้ว)
    try { await window.ethereum.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] }); await ensureNetwork(); await setupWallet(); }
    catch (e) { toast("เชื่อมต่อไม่สำเร็จ: " + esc(errMsg(e)), "err"); }
  }
  async function ensureNetwork() {
    const hex = "0x" + CFG.CHAIN_ID.toString(16);
    if (parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16) === CFG.CHAIN_ID) return;
    try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
    catch (e) {
      if (e.code === 4902 && NET.rpc) await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: NET.name, rpcUrls: [NET.rpc], nativeCurrency: { name: NET.symbol, symbol: NET.symbol, decimals: 18 }, blockExplorerUrls: NET.explorer ? [NET.explorer] : [] }] });
      else throw e;
    }
  }
  async function setupWallet() {
    state.browser = new ethers.BrowserProvider(window.ethereum);
    const accts = await state.browser.send("eth_accounts", []);
    if (!accts.length) { state.account = state.signer = state.write = null; uiWallet(false); return refresh(); }
    const net = await state.browser.getNetwork();
    const ok = Number(net.chainId) === CFG.CHAIN_ID;
    state.signer = await state.browser.getSigner();
    state.account = await state.signer.getAddress();
    state.write = ok && !isZeroAddr ? new ethers.Contract(CFG.CONTRACT_ADDRESS, ABI, state.signer) : null;
    if (ok) state.read = state.browser;
    uiWallet(ok);
    if (!ok) notice(`MetaMask อยู่บนเครือข่ายอื่น <button class="btn small" id="switchBtn">สลับไป ${esc(NET.name)}</button>`);
    $("#switchBtn")?.addEventListener("click", () => ensureNetwork().catch((e) => toast(esc(errMsg(e)), "err")));
    await refresh();
  }
  function uiWallet(ok) {
    $("#connectBtn").textContent = state.account ? short(state.account) : "เชื่อมต่อ MetaMask";
    const b = $("#netBadge");
    b.textContent = state.account ? (ok ? NET.name : "ผิดเครือข่าย") : "ยังไม่เชื่อมต่อ";
    b.className = "net " + (state.account ? (ok ? "ok" : "bad") : "");
  }

  // ---------- data ----------
  function contract() {
    if (!state.read) state.read = new ethers.JsonRpcProvider(NET.rpc, CFG.CHAIN_ID, { staticNetwork: true });
    return new ethers.Contract(CFG.CONTRACT_ADDRESS, ABI, state.read);
  }
  const toAuction = (r) => ({
    id: Number(r.id), seller: r.seller, title: r.title, description: r.description, imageURI: r.imageURI,
    startPrice: r.startPrice, reservePrice: r.reservePrice, minIncrement: r.minIncrement, deposit: r.deposit,
    endTime: Number(r.endTime), paymentWindow: Number(r.paymentWindow), paymentDeadline: Number(r.paymentDeadline),
    highestBidder: r.highestBidder, highestBid: r.highestBid, bidCount: Number(r.bidCount), status: Number(r.status), createdAt: Number(r.createdAt),
  });

  async function loadEvents(c) {
    const p = c.runner.provider || c.runner;
    const latest = await p.getBlockNumber();
    const from = CFG.DEPLOY_BLOCK || Math.max(0, latest - 50000);
    const logs = [];
    let step = latest - from + 1;
    for (let s = from; s <= latest; ) {
      const e = Math.min(latest, s + step - 1);
      try { logs.push(...(await c.queryFilter("*", s, e))); s = e + 1; }
      catch (err) { if (step <= 500) throw err; step = Math.floor(step / 4); }
    }
    const times = {};
    await Promise.all([...new Set(logs.map((l) => l.blockNumber))].map(async (b) => { times[b] = (await p.getBlock(b))?.timestamp; }));
    return logs.filter((l) => l.fragment).map((l) => ({ name: l.fragment.name, args: l.args, hash: l.transactionHash, block: l.blockNumber, time: times[l.blockNumber] })).reverse();
  }

  async function refresh() {
    if (isZeroAddr) { notice("ยังไม่ได้ตั้งค่า <b>CONTRACT_ADDRESS</b> ใน <code>docs/config.js</code>"); return; }
    try {
      const c = contract();
      const n = Number(await c.auctionCount());
      const ids = Array.from({ length: n }, (_, i) => i + 1);
      const list = [];
      for (let i = 0; i < ids.length; i += 15) list.push(...(await Promise.all(ids.slice(i, i + 15).map((id) => c.getAuction(id)))).map(toAuction));
      state.auctions = list.reverse();
      const bidArrs = await Promise.all(ids.map((id) => c.getBids(id)));
      state.bids = {};
      ids.forEach((id, i) => { state.bids[id] = bidArrs[i].map((b) => ({ bidder: b.bidder, amount: b.amount, time: Number(b.time) })).reverse(); });
      const [fees, owner] = await Promise.all([c.feesAccrued(), c.owner()]);
      state.fees = fees; state.owner = owner;
      state.refund = state.account ? await c.pendingWithdrawals(state.account) : 0n;
      renderAll();
      if (state.openId) openLot(state.openId, true);
      state.events = await loadEvents(c);
      renderLedger();
    } catch (e) {
      console.error(e);
      notice("โหลดข้อมูลจาก contract ไม่สำเร็จ: " + esc(errMsg(e)));
    }
  }

  // ---------- render ----------
  function renderAll() {
    const A = state.auctions;
    $("#stLive").textContent = A.filter((a) => view(a).key === "live").length;
    $("#stLots").textContent = A.length;
    $("#stBids").textContent = A.reduce((s, a) => s + a.bidCount, 0);
    const locked = A.filter((a) => (a.status === ST.Live && a.bidCount > 0) || a.status === ST.AwaitingPayment).reduce((s, a) => s + a.deposit, 0n);
    $("#stLocked").textContent = ethN(locked);
    $("#contractLink").innerHTML = NET.explorer ? `Contract <a class="mono" href="${NET.explorer}/address/${CFG.CONTRACT_ADDRESS}" target="_blank" rel="noopener">${short(CFG.CONTRACT_ADDRESS)}</a>` : "";

    // hero = live lot with highest bid, else latest
    const live = A.filter((a) => view(a).key === "live").sort((x, y) => (y.highestBid > x.highestBid ? 1 : -1));
    const hero = live[0] || A[0];
    $("#heroArt").innerHTML = hero ? `${artHTML(hero.imageURI)}<figcaption><span><span class="lot-no">${lotNo(hero.id)}</span><br><b class="${hasThai(hero.title) ? "th" : ""}">${esc(hero.title)}</b></span><span class="tag ${view(hero).cls}">${view(hero).text}</span></figcaption>` : `<div class="frame">${window.BidArt.artSVG(2024)}</div>`;
    $("#heroArt").dataset.id = hero ? hero.id : "";

    const f = state.filter;
    // ปุ่มกรองตามสถานะใน contract ทั้ง 7 แบบ (data-f = เลข Status) พร้อมจำนวน
    $$("#filters .chip").forEach((b) => { b.querySelector("b").textContent = b.dataset.f === "all" ? A.length : A.filter((a) => a.status === Number(b.dataset.f)).length; });
    const shown = A.filter((a) => f === "all" || a.status === Number(f));
    $("#lots").innerHTML = shown.length ? shown.map(lotCard).join("") : `<div class="empty">ยังไม่มีผลงานในหมวดนี้</div>`;

    const isOwner = same(state.owner, state.account);
    $("#navPlatform").classList.toggle("hidden", !isOwner);
    $("#fees").textContent = eth(state.fees);
    $("#feesBtn").disabled = !isOwner || state.fees === 0n;

    $("#myRefund").textContent = state.account ? eth(state.refund) : "–";
    $("#withdrawBtn").disabled = !state.write || state.refund === 0n;
    $("#navRefund").textContent = state.refund > 0n ? ethN(state.refund) : "";
    $("#navRefund").classList.toggle("hidden", !(state.refund > 0n));

    const me = state.account;
    const mineBid = me ? A.filter((a) => (state.bids[a.id] || []).some((b) => same(b.bidder, me))) : [];
    const mineLots = me ? A.filter((a) => same(a.seller, me)) : [];
    $("#myBids").innerHTML = me ? (mineBid.length ? mineBid.map(item).join("") : `<div class="empty">ยังไม่เคยประมูล</div>`) : `<div class="empty">เชื่อมต่อ MetaMask</div>`;
    $("#myLots").innerHTML = me ? (mineLots.length ? mineLots.map(item).join("") : `<div class="empty">ยังไม่มีผลงานที่ฝากขาย</div>`) : `<div class="empty">เชื่อมต่อ MetaMask</div>`;
    tick();
  }

  function lotCard(a) {
    const v = view(a);
    const priceLabel = a.bidCount ? (v.key === "live" ? "ราคาสูงสุด" : "ราคาปิด") : "ราคาเริ่มต้น";
    const price = a.bidCount ? a.highestBid : a.startPrice;
    const reserve = a.bidCount ? (a.highestBid >= a.reservePrice ? `<span class="reserve met">✓ ถึง Reserve</span>` : `<span class="reserve unmet">ยังไม่ถึง Reserve</span>`) : `<span class="reserve unmet">${a.bidCount} bids</span>`;
    const right = v.key === "live" ? `<span class="label">ปิดใน</span><span class="count" data-end="${a.endTime}"></span>` : `<span class="tag ${v.cls}">${v.text}</span>`;
    return `<article class="lot" data-open="${a.id}">
      ${artHTML(a.imageURI)}
      <div class="lot-meta"><span class="lot-no">${lotNo(a.id)}</span>${v.key === "live" ? `<span class="tag ${v.cls}">LIVE</span>` : ""}
        <h3 class="${hasThai(a.title) ? "th" : ""}">${esc(a.title)}</h3>
        <span class="by">${esc((a.description || "").split("\n")[0]).slice(0, 70)}</span></div>
      <div class="lot-foot"><div><span class="label">${priceLabel}</span><span class="price">${ethN(price)} <small>ETH</small></span><br>${reserve}</div><div class="right">${right}</div></div>
    </article>`;
  }

  function item(a) {
    const v = view(a);
    let note = v.text;
    if (a.status === ST.AwaitingPayment && same(a.highestBidder, state.account)) note = `<b style="color:var(--red)">คุณชนะ — ชำระ ${eth(a.highestBid - a.deposit)}</b>`;
    else if (v.key === "live" && same(a.highestBidder, state.account)) note = "คุณเป็นผู้นำ";
    else if (v.key === "live" && (state.bids[a.id] || []).some((b) => same(b.bidder, state.account))) note = "ถูกแซงแล้ว";
    return `<div class="item" data-open="${a.id}">${artHTML(a.imageURI, "sm")}<div><b class="${hasThai(a.title) ? "th" : ""}">${esc(a.title)}</b><small>${lotNo(a.id)} · ${a.bidCount ? eth(a.highestBid) : "ยังไม่มีผู้ประมูล"}</small></div><span class="tag ${v.cls}">${note}</span></div>`;
  }

  function evDetail(e) {
    const a = e.args;
    switch (e.name) {
      case "AuctionCreated": return `${esc(a.title)} · เริ่ม ${eth(a.startPrice)} · มัดจำ ${eth(a.deposit)} · โดย ${addr(a.seller)}`;
      case "BidPlaced": return `${addr(a.bidder)} เสนอ ${eth(a.amount)}${a.depositPaid > 0n ? ` (วางมัดจำ ${eth(a.depositPaid)})` : " (ขึ้นราคาเอง)"}`;
      case "OutbidCredited": return `${addr(a.bidder)} ได้ยอดคืน ${eth(a.amount)}`;
      case "AuctionFinalized": return ["", "ถึง Reserve — รอผู้ชนะชำระ", "", "ไม่ถึง Reserve", "ไม่มีผู้ประมูล"][Number(a.status)] + (a.winner !== ZERO ? ` · ผู้ชนะ ${addr(a.winner)} ${eth(a.highestBid)}` : "");
      case "PaymentSettled": return `รวม ${eth(a.total)} · ค่าธรรมเนียม ${eth(a.fee)} · ผู้ขายได้ ${eth(a.sellerAmount)}`;
      case "DepositRefunded": return `คืน ${eth(a.amount)} ให้ ${addr(a.bidder)}`;
      case "DepositForfeited": return `ยึดมัดจำ ${eth(a.amount)} จาก ${addr(a.winner)} · ผู้ขายได้ ${eth(a.sellerAmount)} · ค่าธรรมเนียม ${eth(a.fee)}`;
      case "AuctionCancelled": return "ผู้ขายยกเลิก";
      case "Withdrawn": return `${addr(a.account)} ถอน ${eth(a.amount)}`;
      case "FeesWithdrawn": return `${eth(a.amount)} → ${addr(a.to)}`;
      default: return "";
    }
  }
  function involvesMe(e) {
    const me = state.account;
    if (!me) return false;
    if (e.args.auctionId !== undefined) {
      const a = state.auctions.find((x) => x.id === Number(e.args.auctionId));
      if (a && (same(a.seller, me) || (state.bids[a.id] || []).some((b) => same(b.bidder, me)))) return true;
    }
    return Object.values(e.args.toObject ? e.args.toObject() : {}).some((v) => typeof v === "string" && same(v, me));
  }
  function renderLedger() {
    const only = $("#onlyMine").checked;
    const rows = state.events.filter((e) => !only || involvesMe(e));
    $("#ledger").innerHTML = rows.length ? rows.map((e) => `<tr><td>${e.time ? fmtDate(e.time) : "–"}<br><span class="mono" style="color:var(--muted)">#${e.block}</span></td><td>${EVENT_TH[e.name] || e.name}</td><td class="mono">${e.args.auctionId !== undefined ? lotNo(e.args.auctionId) : "–"}</td><td>${evDetail(e)}</td><td>${txLink(e.hash)}</td></tr>`).join("") : `<tr><td colspan="5" class="empty">ยังไม่มีธุรกรรม</td></tr>`;
  }

  // ---------- lot detail ----------
  const dlg = $("#lotDialog");
  dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest("[data-close]")) { dlg.close(); state.openId = null; } });
  dlg.addEventListener("close", () => { state.openId = null; });

  function openLot(id, keep) {
    const a = state.auctions.find((x) => x.id === id);
    if (!a) return;
    state.openId = id;
    const v = view(a), me = state.account, t = now();
    const bids = state.bids[id] || [];
    const isSeller = same(a.seller, me), isLead = same(a.highestBidder, me);
    const minNext = a.bidCount ? a.highestBid + a.minIncrement : a.startPrice;
    const reserveMet = a.bidCount && a.highestBid >= a.reservePrice;

    let timeBox;
    if (v.key === "live") timeBox = `<div class="label">ปิดประมูลใน</div><div class="v count" data-end="${a.endTime}"></div>`;
    else if (a.status === ST.AwaitingPayment) timeBox = `<div class="label">${t <= a.paymentDeadline ? "เหลือเวลาชำระ" : "เลยกำหนดชำระ"}</div><div class="v count" data-end="${a.paymentDeadline}"></div>`;
    else timeBox = `<div class="label">สถานะ</div><div class="v" style="font-size:26px">${v.text}</div>`;

    const steps = ["เปิดประมูล", "ปิดประมูล", "รอชำระ", "เสร็จสิ้น"].map((s, i) => `<li class="${i < v.step ? "done" : i === v.step ? "now" : ""}">${s}</li>`).join("");

    // actions by role
    let act = "";
    if (state.write) {
      if (v.key === "live" && !isSeller) {
        act += `<form class="bidbox" id="bidForm">
          <label class="label" style="font-size:13px">เสนอราคา (ขั้นต่ำ ${eth(minNext)})</label>
          <div class="row"><input name="amount" type="number" step="any" min="0" value="${ethers.formatEther(minNext)}" required /><button class="btn red" type="submit">เสนอราคา</button></div>
          <p class="hint">${isLead ? "คุณเป็นผู้นำอยู่ — ขึ้นราคาได้โดยไม่ต้องวางมัดจำเพิ่ม" : `ต้องวางมัดจำ <b>${eth(a.deposit)}</b> พร้อมการเสนอราคา · ถูกแซงเมื่อไหร่ได้มัดจำคืนทันที (ถอนได้ที่ "กระเป๋าของฉัน")`}</p>
        </form>`;
      }
      if (v.key === "live" && isSeller && a.bidCount === 0) act += `<button class="btn" data-act="cancel">ยกเลิกการประมูล</button>`;
      if (a.status === ST.Live && t >= a.endTime && (same(a.seller, me) || t >= a.endTime + 86400)) act += `<button class="btn ink" data-act="finalize">ปิดประมูล</button>`;
      if (a.status === ST.AwaitingPayment && isLead && t <= a.paymentDeadline) act += `<button class="btn red big" data-act="pay">ชำระส่วนที่เหลือ ${eth(a.highestBid - a.deposit)}</button>`;
      if (a.status === ST.AwaitingPayment && t > a.paymentDeadline) act += `<button class="btn ink" data-act="forfeit">ยึดมัดจำให้ผู้ขาย</button>`;
    } else if (v.key === "live") {
      act = `<p class="hint">เชื่อมต่อ MetaMask เพื่อเสนอราคา</p>`;
    }

    let outcome = "";
    if (a.status === ST.Settled) {
      const fee = (a.highestBid * 250n) / 10000n;
      outcome = `<dt>ผลการขาย</dt><dd>ขาย ${eth(a.highestBid)} · ค่าธรรมเนียม 2.5% = ${eth(fee)} · ผู้ขายได้ ${eth(a.highestBid - fee)}</dd>`;
    } else if (a.status === ST.Defaulted) {
      const fee = (a.deposit * 250n) / 10000n;
      outcome = `<dt>ผลการขาย</dt><dd>ผู้ชนะไม่ชำระ → ยึดมัดจำ ${eth(a.deposit)} · ผู้ขายได้ ${eth(a.deposit - fee)}</dd>`;
    } else if (a.status === ST.ReserveNotMet) outcome = `<dt>ผลการขาย</dt><dd>ไม่ถึง Reserve → คืนมัดจำผู้ประมูลสูงสุดเต็มจำนวน</dd>`;

    $("#lotBody").innerHTML = `<div class="detail">
      <div class="detail-art">${artHTML(a.imageURI)}</div>
      <div class="detail-info">
        <button class="close" data-close aria-label="ปิด">×</button>
        <div><p class="kicker">${lotNo(a.id)} · <span class="tag ${v.cls}">${v.text}</span></p>
        <h2 class="${hasThai(a.title) ? "th" : ""}">${esc(a.title)}</h2></div>
        ${a.description ? `<p class="desc">${esc(a.description)}</p>` : ""}
        <div class="current">
          <div><div class="label">${a.bidCount ? (v.key === "live" ? "ราคาสูงสุดปัจจุบัน" : "ราคาปิด") : "ราคาเริ่มต้น"}</div><div class="v">${eth(a.bidCount ? a.highestBid : a.startPrice)}</div>
            <div class="reserve ${reserveMet ? "met" : "unmet"}">${a.bidCount ? (reserveMet ? "✓ ถึง Reserve แล้ว" : "ยังไม่ถึง Reserve") : "ยังไม่มีผู้ประมูล"}</div></div>
          <div>${timeBox}</div>
        </div>
        <ol class="steps">${steps}</ol>
        ${act ? `<div class="actions">${act}</div>` : ""}
        <dl class="facts">
          <dt>ผู้ขาย</dt><dd>${addr(a.seller)}</dd>
          <dt>ราคาเริ่มต้น</dt><dd>${eth(a.startPrice)}</dd>
          <dt>Reserve Price</dt><dd>${eth(a.reservePrice)}</dd>
          <dt>เพิ่มราคาขั้นต่ำ</dt><dd>${eth(a.minIncrement)}</dd>
          <dt>มัดจำ</dt><dd>${eth(a.deposit)}</dd>
          <dt>ปิดประมูล</dt><dd>${fmtDate(a.endTime)}</dd>
          <dt>เวลาให้ชำระ</dt><dd>${Math.round(a.paymentWindow / 60)} นาทีหลังปิด${a.paymentDeadline ? ` (ภายใน ${fmtDate(a.paymentDeadline)})` : ""}</dd>
          ${a.bidCount ? `<dt>ผู้นำ / ผู้ชนะ</dt><dd>${addr(a.highestBidder)}</dd>` : ""}
          ${outcome}
        </dl>
        <div><h3 class="sub">ประวัติการเสนอราคา</h3>
        ${bids.length ? `<table class="history"><thead><tr><th>ผู้ประมูล</th><th>ราคา</th><th>เวลา</th></tr></thead><tbody>${bids.map((b, i) => `<tr><td>${addr(b.bidder)}${i === 0 ? '<span class="lead-badge">LEAD</span>' : ""}</td><td>${eth(b.amount)}</td><td>${fmtDate(b.time)}</td></tr>`).join("")}</tbody></table>` : `<p class="hint">ยังไม่มีการเสนอราคา</p>`}</div>
      </div></div>`;
    if (!dlg.open && !keep) dlg.showModal();
    else if (!dlg.open && keep) return;
    $("#bidForm")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        const amount = ethers.parseEther(String(new FormData(ev.target).get("amount")));
        if (amount < minNext) throw new Error("ราคาต่ำกว่าขั้นต่ำ " + eth(minNext));
        await sendTx(`เสนอราคา ${lotNo(a.id)}`, (c) => c.placeBid(a.id, amount, { value: isLead ? 0n : a.deposit }));
      } catch (e) { if (!e?.code) toast("✕ " + esc(errMsg(e)), "err"); }
    });
    tick();
  }

  async function act(name, id) {
    const a = state.auctions.find((x) => x.id === id);
    try {
      if (name === "finalize") await sendTx(`ปิดประมูล ${lotNo(id)}`, (c) => c.finalize(id));
      if (name === "pay") await sendTx(`ชำระเงิน ${lotNo(id)}`, (c) => c.completePayment(id, { value: a.highestBid - a.deposit }));
      if (name === "forfeit") await sendTx(`ยึดมัดจำ ${lotNo(id)}`, (c) => c.claimForfeit(id));
      if (name === "cancel" && confirm("ยืนยันยกเลิกการประมูลนี้?")) await sendTx(`ยกเลิก ${lotNo(id)}`, (c) => c.cancelAuction(id));
    } catch (_) {}
  }

  // ---------- sell ----------
  function sellPreview() {
    const f = new FormData($("#sellForm"));
    const mode = f.get("imgMode");
    $(".imgSeed").classList.toggle("hidden", mode !== "gen");
    $(".imgUrl").classList.toggle("hidden", mode !== "url");
    const uri = mode === "gen" ? "gen:" + (f.get("seed") || 1) : f.get("url");
    const title = f.get("title") || "Untitled";
    let start = 0n; try { start = ethers.parseEther(String(f.get("start") || "0")); } catch {}
    $("#sellPreview").innerHTML = `<article class="lot">${artHTML(uri)}<div class="lot-meta"><span class="lot-no">LOT ${String(state.auctions.length + 1).padStart(3, "0")}</span><h3 class="${hasThai(title) ? "th" : ""}">${esc(title)}</h3><span class="by">${esc(f.get("description") || "")}</span></div><div class="lot-foot"><div><span class="label">ราคาเริ่มต้น</span><span class="price">${ethN(start)} <small>ETH</small></span></div></div></article>`;
  }
  async function submitSell(ev) {
    ev.preventDefault();
    const f = new FormData(ev.target);
    try {
      if (!state.write) throw new Error("กรุณาเชื่อมต่อ MetaMask บนเครือข่ายที่ถูกต้อง");
      const P = (k) => ethers.parseEther(String(f.get(k)));
      const p = {
        title: f.get("title").trim(), description: f.get("description").trim(),
        imageURI: f.get("imgMode") === "gen" ? "gen:" + f.get("seed") : f.get("url").trim(),
        startPrice: P("start"), reservePrice: P("reserve"), minIncrement: P("inc"), deposit: P("dep"),
        endTime: Math.floor(new Date(f.get("end")).getTime() / 1000), paymentWindow: Number(f.get("win")),
      };
      if (p.reservePrice < p.startPrice) throw new Error("Reserve ต้องไม่ต่ำกว่าราคาเริ่มต้น");
      if (p.deposit <= 0n || p.deposit > p.startPrice) throw new Error("มัดจำต้องมากกว่า 0 และไม่เกินราคาเริ่มต้น");
      if (p.endTime < now() + 60) throw new Error("เวลาปิดประมูลต้องอยู่ในอนาคตอย่างน้อย 1 นาที");
      await sendTx("ฝากขายผลงาน", (c) => c.createAuction(p));
      ev.target.reset(); defaultEnd(); sellPreview(); go("collection");
    } catch (e) { if (!e?.code) toast("✕ " + esc(errMsg(e)), "err"); }
  }
  function defaultEnd() {
    const d = new Date(Date.now() + 3 * 864e5);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    $("#sellForm [name=end]").value = d.toISOString().slice(0, 16);
    $("#sellForm [name=seed]").value = Math.floor(Math.random() * 9000) + 1;
  }

  // ---------- nav / ticking ----------
  function go(name) {
    $$(".view").forEach((v) => v.classList.toggle("hidden", v.id !== "view-" + name));
    $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function tick() {
    const t = now();
    $$("[data-end]").forEach((el) => { el.textContent = countdown(Number(el.dataset.end) - t); });
  }
  // ดึงข้อมูลใหม่ทุก 15 วิ ให้เห็น bid ของคนอื่นและเวลาที่ถูกต่อ (ข้ามตอนกำลังพิมพ์ จะได้ไม่ล้างช่องราคา)
  // shortcut: refresh โหลด event ทั้งหมดใหม่ทุกรอบ, ถ้า RPC ช้า/โดนจำกัดให้เปลี่ยนเป็นโหลดเฉพาะ block ใหม่
  setInterval(() => { if (!document.activeElement?.matches("input, textarea, select")) refresh(); }, 15000);
  let lastKeys = "";
  setInterval(() => {
    tick();
    // ถ้ามีงานที่เพิ่งหมดเวลา ให้วาดใหม่เพื่อเปลี่ยนปุ่ม/สถานะ
    const keys = state.auctions.map((a) => view(a).text).join("|");
    if (keys !== lastKeys) { lastKeys = keys; if (state.auctions.length) { renderAll(); if (state.openId && dlg.open) openLot(state.openId, true); } }
  }, 1000);

  function init() {
    $$("[data-view]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); go(a.dataset.view); }));
    $$("#filters .chip").forEach((b) => b.addEventListener("click", () => { $$("#filters .chip").forEach((x) => x.classList.toggle("active", x === b)); state.filter = b.dataset.f; renderAll(); }));
    $("#connectBtn").addEventListener("click", connect);
    $("#withdrawBtn").addEventListener("click", () => sendTx("ถอนเงินคืน", (c) => c.withdraw()).catch(() => {}));
    $("#feesBtn").addEventListener("click", () => sendTx("ถอนค่าธรรมเนียม", (c) => c.withdrawFees(state.account)).catch(() => {}));
    $("#onlyMine").addEventListener("change", renderLedger);
    $("#sellForm").addEventListener("input", sellPreview);
    $("#sellForm").addEventListener("submit", submitSell);
    $("#heroArt").addEventListener("click", () => { const id = Number($("#heroArt").dataset.id); if (id) openLot(id); });
    document.addEventListener("click", (e) => {
      const o = e.target.closest("[data-open]");
      if (o) return openLot(Number(o.dataset.open));
      const b = e.target.closest("[data-act]");
      if (b && state.openId) act(b.dataset.act, state.openId);
    });
    defaultEnd(); sellPreview();
    if (window.ethereum) {
      window.ethereum.on?.("accountsChanged", () => setupWallet());
      window.ethereum.on?.("chainChanged", () => location.reload());
      window.ethereum.request({ method: "eth_accounts" }).then((a) => (a.length ? setupWallet() : refresh())).catch(refresh);
    } else refresh();
  }
  init();
})();
