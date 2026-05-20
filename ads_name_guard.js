// ads_name_guard.js (CONTENT SCRIPT) — modal giữa màn hình + pill trạng thái, 1 scrollbar duy nhất
(function () {
  const BOX_ID = "lng-ads-guard";
  const MODAL_ID = BOX_ID + "__modal";
  const PILL_ID = "lng-ads-guard-pill";
  const STATE_KEY = "lng-ads-guard:minimized"; // "1" | "0"

  // ---------- helpers ----------
  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    Object.assign(e, attrs);
    (Array.isArray(children) ? children : [children]).forEach((c) =>
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
    );
    return e;
  }
  function normReply(reply) {
    if (reply?.skipped === true && reply?.reason === "ADS_TASK_ALREADY_RUNNING") {
      return {
        ok: false,
        skipped: true,
        reason: "ADS_TASK_ALREADY_RUNNING",
        total: 0,
        invalidCount: 0,
        invalidList: [],
        message: "Ads task đang chạy, tạm bỏ qua Campaign Guard để tránh lỗi 401.",
      };
    }

    const invalidList = Array.isArray(reply?.invalidList)
      ? reply.invalidList
      : Array.isArray(reply?.invalid)
      ? reply.invalid
      : [];
    const invalidCount =
      typeof reply?.invalidCount === "number"
        ? reply.invalidCount
        : invalidList.length;
    return {
      ok: !!reply?.ok,
      total: Number(reply?.totalChecked ?? reply?.total ?? 0),
      invalidCount: Number(invalidCount),
      invalidList,
      message: reply?.message || "",
    };
  }

  // ---------- pill ----------
  function ensurePill() {
    let pill = document.getElementById(PILL_ID);
    if (!pill) {
      pill = el("div", { id: PILL_ID });
      document.body.appendChild(pill);
      pill.addEventListener("click", () => {
        sessionStorage.setItem(STATE_KEY, "0");
        showPanel(true);
      });
    }
    pill.style.cssText = `
      position:fixed; top:96px; right:12px; z-index:999999;
      display:inline-flex; align-items:center; gap:8px;
      padding:8px 12px; border-radius:18px;
      font:12px/1.2 monospace; cursor:pointer; user-select:none;
      border:1px solid #24314a; box-shadow:0 8px 22px rgba(0,0,0,.35);
      background:#0f1629; color:#cde3ff;
    `;
    return pill;
  }
  function updatePill(res) {
    const pill = ensurePill();
    if (!res || !res.ok) {
      pill.textContent = "Campaign Guard";
      pill.style.background = "#0f1629";
      pill.style.color = "#cde3ff";
      return;
    }
    if (res.invalidCount > 0) {
      pill.textContent = `Invalid • ${res.invalidCount}`;
      pill.style.background = "#2a1111";
      pill.style.color = "#ffb3b3";
    } else {
      pill.textContent = "All valid ✓";
      pill.style.background = "#0f2a1a";
      pill.style.color = "#9ff0c5";
    }
  }

  // ---------- modal ----------
  function ensurePanel() {
    let box = document.getElementById(BOX_ID);
    if (!box) {
      box = el("div", { id: BOX_ID });
      const backdrop = el("div", {
        style: `position:fixed; inset:0; z-index:999998; background:rgba(0,0,0,.35);`,
        onclick: () => setMinimized(true),
      });
      const modal = el("div", { id: MODAL_ID });
      box.appendChild(backdrop);
      box.appendChild(modal);
      document.body.appendChild(box);
    }
    const modal = document.getElementById(MODAL_ID);
    modal.style.cssText = `
      position: fixed; z-index: 999999;
      left: 50%; top: 12vh; transform: translateX(-50%);
      width: min(920px, 92vw); max-height: 76vh; overflow: hidden;
      background: #0b1220; color: #d4f1ff; border: 1px solid #233;
      border-radius: 12px; box-shadow: 0 14px 36px rgba(0,0,0,.55);
      display: flex; flex-direction: column;
    `;
    return modal;
  }
  function btnStyle(bg, color) {
    return `
      border:none; border-radius:8px; padding:8px 14px; font-size:12px;
      font-weight:600; cursor:pointer; transition:all .2s ease;
      background:${bg || "linear-gradient(135deg,#1a2a40 0%,#203b5a 100%)"};
      color:${color || "#d4f1ff"};
    `;
  }
  function renderPanel(res) {
    const modal = ensurePanel();
    modal.innerHTML = "";

    const header = el(
      "div",
      {
        style: `
          display:flex; align-items:center; justify-content:space-between;
          padding:12px 14px; border-bottom:1px solid #223; font-weight:700;
          background:#0e1629;
        `,
      },
      [
        el("span", { textContent: "Extension Check Campaign Name" }),
        el("div", { style: "display:flex; gap:8px" }, [
          el("button", {
            innerText: "Re-check",
            onclick: run,
            style: btnStyle(),
          }),
          el("button", {
            innerText: "Close",
            onclick: () => setMinimized(true),
            style: btnStyle("#2b1a1a", "#ffbaba"),
          }),
        ]),
      ]
    );

    // CHỈ body được cuộn → 1 scrollbar duy nhất
    const body = el("div", {
      style: "padding:12px 14px; flex:1; overflow:auto;",
    });

    if (!res) {
      body.appendChild(el("div", { textContent: "Loading..." }));
    } else if (!res.ok && res.skipped) {
      body.appendChild(
        el(
          "div",
          { style: "color:#cde3ff" },
          res.message || "Ads task đang chạy, tạm bỏ qua Campaign Guard để tránh lỗi 401."
        )
      );
    } else if (!res.ok) {
      body.appendChild(
        el(
          "div",
          { style: "color:#ff9c9c" },
          `Error: ${res.message || "Unknown"}`
        )
      );
    } else {
      body.appendChild(
        el("div", { style: "margin-bottom:8px" }, [
          el("div", {}, `Checked: ${res.total}`),
          el(
            "div",
            { style: res.invalidCount ? "color:#ffbf69" : "color:#8ef88e" },
            `Campaign Invalid: ${res.invalidCount}`
          ),
        ])
      );

      // listWrap KHÔNG cuộn, không max-height → dùng scrollbar của body
      const listWrap = el("div", {
        style: "margin-top:8px; border-top:1px dashed #244; padding-top:8px",
      });

      if (res.invalidCount === 0) {
        listWrap.appendChild(
          el("div", { style: "opacity:.85" }, "No invalid campaigns 🎉")
        );
      } else {
        res.invalidList.forEach((i) =>
          listWrap.appendChild(
            el(
              "div",
              {
                style:
                  "white-space:nowrap; text-overflow:ellipsis; overflow:hidden; margin:2px 0",
                title: i.name || "",
              },
              `• ${i.name || "(no name)"}${
                i.state ? "  [" + i.state + "]" : ""
              }`
            )
          )
        );
      }
      body.appendChild(listWrap);

      if (res.invalidCount > 0) {
        body.appendChild(
          el(
            "div",
            {
              style:
                "margin-top:12px; padding:10px; border-top:1px solid #422; color:#ff9c9c; text-align:center;",
            },
            "Please change the campaign name to avoid affecting the reporting."
          )
        );
      }
    }

    modal.appendChild(header);
    modal.appendChild(body);
  }

  // ---------- minimize / show ----------
  function lockPageScroll(lock) {
    const root = document.documentElement;
    if (lock) {
      if (!root.dataset._lngGuardLocked) {
        root.dataset._lngGuardLocked = "1";
        root.style.overflow = "hidden";
      }
    } else {
      if (root.dataset._lngGuardLocked) {
        delete root.dataset._lngGuardLocked;
        root.style.overflow = "";
      }
    }
  }
  function setMinimized(min) {
    sessionStorage.setItem(STATE_KEY, min ? "1" : "0");
    const box = document.getElementById(BOX_ID);
    const pill = ensurePill();
    if (min) {
      if (box) box.style.display = "none";
      pill.style.display = "inline-flex";
      lockPageScroll(false);
    } else {
      if (box) box.style.display = "block";
      pill.style.display = "inline-flex";
      lockPageScroll(true);
    }
  }
  function showPanel(show) {
    const box = document.getElementById(BOX_ID);
    if (show) {
      if (box) box.style.display = "block";
      sessionStorage.setItem(STATE_KEY, "0");
      lockPageScroll(true);
    } else {
      if (box) box.style.display = "none";
      sessionStorage.setItem(STATE_KEY, "1");
      lockPageScroll(false);
    }
  }

  // ---------- chạy kiểm tra ----------
  function run() {
    chrome.runtime.sendMessage({ type: "ADS_CHECK_NAMES" }, (reply) => {
      if (chrome.runtime.lastError) {
        const res = { ok: false, message: chrome.runtime.lastError.message };
        updatePill(res);
        renderPanel(res);
        showPanel(true);
        return;
      }
      const res = normReply(reply);
      updatePill(res);
      // mở modal khi có invalid; nếu không thì chỉ hiện pill
      if (res.ok && res.invalidCount > 0) {
        renderPanel(res);
        showPanel(true);
      } else {
        renderPanel(res); // để người dùng có thể Re-check thủ công
        showPanel(false); // đóng modal, chỉ để pill (All valid ✓)
      }
    });
  }

  // ---------- boot ----------
  ensurePill();
  setMinimized(true);
  run();

  // ESC toggle
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      const minimized = sessionStorage.getItem(STATE_KEY) === "1";
      setMinimized(!minimized);
      if (!minimized) showPanel(false);
    }
  });
})();
