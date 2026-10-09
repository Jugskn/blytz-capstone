/**
 * Editor page wiring: save, payment modal countdown, submit validation.
 */
(function () {
  "use strict";

  const ALLOWED_EXT = [".png", ".jpg", ".jpeg", ".pdf"];
  const MAX_BYTES = 5 * 1024 * 1024;

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }

  function qsa(sel, root) {
    return Array.from((root || document).querySelectorAll(sel));
  }

  function getCookie(name) {
    const match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
    return match ? decodeURIComponent(match[2]) : "";
  }

  function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("hidden");
    el.classList.add("flex");
    document.body.classList.add("overflow-hidden");
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add("hidden");
    el.classList.remove("flex");
    document.body.classList.remove("overflow-hidden");
  }

  function formatMMSS(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  function initEditorPage(root) {
    if (!root || !window.BlytzEditor) return;

    const saveUrl = root.dataset.saveUrl;
    const submitUrl = root.dataset.submitUrl;
    const windowMinutes = parseInt(root.dataset.paymentWindowMinutes || "10", 10);
    const initialJson = root.dataset.canvasJson || "{}";
    const alreadySubmitted = root.dataset.alreadySubmitted === "1";

    try {
      window.BlytzEditor.loadCanvasJSON(JSON.parse(initialJson));
    } catch (e) {
      window.BlytzEditor.loadCanvasJSON({});
    }

    const saveBtn = qs("[data-editor-save]", root);
    const submitBtn = qs("[data-editor-submit]", root);
    const statusEl = qs("[data-editor-status]", root);
    const modalId = "payment-modal";
    const form = qs("#payment-submit-form");
    const amountInput = qs("#payment-amount");
    const proofInput = qs("#payment-proof");
    const channelSelect = qs("#payment-channel");
    const channelDetails = qs("[data-channel-details]");
    const sendBtn = qs("#payment-sent-btn");
    const cancelBtn = qs("#payment-cancel-btn");
    const timerEl = qs("[data-payment-timer]");
    const windowStartedInput = qs("#window-started-at");
    const canvasField = qs("#submit-canvas-json");
    const clientError = qs("[data-payment-client-error]");

    let timerId = null;
    let remaining = 0;
    let windowExpired = false;

    function setStatus(msg) {
      if (statusEl) statusEl.textContent = msg || "";
    }

    function updateSendEnabled() {
      if (!sendBtn) return;
      const hasAmount = amountInput && parseFloat(amountInput.value) > 0;
      const hasProof = proofInput && proofInput.files && proofInput.files.length > 0;
      sendBtn.disabled = windowExpired || alreadySubmitted || !(hasAmount && hasProof);
    }

    function validateProofClient() {
      if (!proofInput || !proofInput.files || !proofInput.files[0]) {
        return "Choose a proof file.";
      }
      const file = proofInput.files[0];
      const name = (file.name || "").toLowerCase();
      const okExt = ALLOWED_EXT.some(function (ext) {
        return name.endsWith(ext);
      });
      if (!okExt) {
        return "Proof must be PNG, JPG, JPEG, or PDF.";
      }
      if (file.size > MAX_BYTES) {
        return "Proof file must be 5 MB or smaller.";
      }
      return "";
    }

    function showChannelDetails() {
      if (!channelSelect || !channelDetails) return;
      const opt = channelSelect.options[channelSelect.selectedIndex];
      if (!opt) {
        channelDetails.innerHTML = "";
        return;
      }
      const name = opt.dataset.accountName || "";
      const number = opt.dataset.accountNumber || "";
      const qr = opt.dataset.qrUrl || "";
      const instructions = opt.dataset.instructions || "";
      channelDetails.innerHTML =
        '<dl class="mt-3 space-y-2 text-sm">' +
        '<div><dt class="text-ink-subtle">Account name</dt><dd class="font-medium text-ink">' +
        name +
        "</dd></div>" +
        '<div><dt class="text-ink-subtle">Account number</dt><dd class="font-mono text-ink">' +
        number +
        "</dd></div>" +
        (instructions
          ? '<div><dt class="text-ink-subtle">Instructions</dt><dd class="text-ink-muted">' +
            instructions +
            "</dd></div>"
          : "") +
        "</dl>" +
        (qr
          ? '<img src="' +
            qr +
            '" alt="Payment QR" class="mt-3 max-h-48 max-w-full w-40 rounded-md border border-border object-contain bg-surface">'
          : '<p class="mt-3 text-sm text-ink-subtle">No QR image uploaded.</p>');
    }

    function stopTimer() {
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
    }

    function expireWindow() {
      windowExpired = true;
      stopTimer();
      if (timerEl) timerEl.textContent = "00:00";
      updateSendEnabled();
      closeModal(modalId);
      setStatus("Payment window expired. Nothing was recorded.");
    }

    function startPaymentWindow() {
      windowExpired = false;
      remaining = Math.max(1, windowMinutes * 60);
      if (windowStartedInput) {
        windowStartedInput.value = new Date().toISOString();
      }
      if (timerEl) timerEl.textContent = formatMMSS(remaining);
      stopTimer();
      timerId = setInterval(function () {
        remaining -= 1;
        if (timerEl) timerEl.textContent = formatMMSS(Math.max(0, remaining));
        if (remaining <= 0) {
          expireWindow();
        }
      }, 1000);
      updateSendEnabled();
    }

    function cancelPayment() {
      stopTimer();
      windowExpired = false;
      if (form) form.reset();
      if (windowStartedInput) windowStartedInput.value = "";
      if (clientError) clientError.textContent = "";
      closeModal(modalId);
      setStatus("Payment cancelled. Nothing was recorded.");
      updateSendEnabled();
    }

    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        const body = new FormData();
        body.append("canvas_json", JSON.stringify(window.BlytzEditor.getCanvasJSON()));
        body.append("csrfmiddlewaretoken", getCookie("csrftoken"));
        setStatus("Saving…");
        fetch(saveUrl, {
          method: "POST",
          body: body,
          headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" },
          credentials: "same-origin",
        })
          .then(function (r) {
            return r.json().then(function (data) {
              return { ok: r.ok, data: data };
            });
          })
          .then(function (res) {
            setStatus(res.ok ? "Saved." : "Save failed.");
          })
          .catch(function () {
            setStatus("Save failed.");
          });
      });
    }

    if (submitBtn) {
      submitBtn.addEventListener("click", function () {
        if (alreadySubmitted) {
          setStatus("Already submitted.");
          return;
        }
        if (canvasField) {
          canvasField.value = JSON.stringify(window.BlytzEditor.getCanvasJSON());
        }
        openModal(modalId);
        showChannelDetails();
        startPaymentWindow();
      });
    }

    if (channelSelect) {
      channelSelect.addEventListener("change", showChannelDetails);
    }
    if (amountInput) amountInput.addEventListener("input", updateSendEnabled);
    if (proofInput) {
      proofInput.addEventListener("change", function () {
        if (clientError) {
          clientError.textContent = validateProofClient() || "";
        }
        updateSendEnabled();
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener("click", function (e) {
        e.preventDefault();
        cancelPayment();
      });
    }

    // Intercept modal backdrop close as cancel (no records)
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.querySelectorAll("[data-modal-close]").forEach(function (el) {
        el.addEventListener("click", function () {
          cancelPayment();
        });
      });
    }

    if (form) {
      form.addEventListener("submit", function (e) {
        if (windowExpired) {
          e.preventDefault();
          setStatus("Payment window expired. Nothing was recorded.");
          return;
        }
        const proofErr = validateProofClient();
        if (proofErr) {
          e.preventDefault();
          if (clientError) clientError.textContent = proofErr;
          return;
        }
        if (!amountInput || !(parseFloat(amountInput.value) > 0)) {
          e.preventDefault();
          if (clientError) clientError.textContent = "Enter an amount.";
          return;
        }
        if (canvasField) {
          canvasField.value = JSON.stringify(window.BlytzEditor.getCanvasJSON());
        }
        sendBtn.disabled = true;
        setStatus("Submitting…");
      });
    }

    updateSendEnabled();
    showChannelDetails();
  }

  document.addEventListener("DOMContentLoaded", function () {
    const root = qs("[data-editor-page]");
    if (root) initEditorPage(root);
  });
})();
