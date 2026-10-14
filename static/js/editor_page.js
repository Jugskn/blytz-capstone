/**
 * Editor page wiring: save, payment modal countdown, submit validation.
 */
(function () {
  "use strict";

  function qs(sel, root) {
    return (root || document).querySelector(sel);
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
    const windowMinutes = parseInt(root.dataset.paymentWindowMinutes || "10", 10);
    const proofMaxMb = root.dataset.proofMaxMb || "15";
    const initialJson = root.dataset.canvasJson || "{}";
    const alreadySubmitted = root.dataset.alreadySubmitted === "1";

    const saveBtn = qs("[data-editor-save]", root);
    const submitBtn = qs("[data-editor-submit]", root);
    const statusEl = qs("[data-editor-status]", root);
    const titleInput = qs("[data-editor-title]", root);
    const titleCrumb = qs("[data-editor-title-crumb]");
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

    function updateActionButtons() {
      const allow =
        window.BlytzEditor.canPersist && window.BlytzEditor.canPersist();
      if (saveBtn) saveBtn.disabled = !allow;
      if (submitBtn) submitBtn.disabled = !allow || alreadySubmitted;
    }

    function updateSendEnabled() {
      if (!sendBtn) return;
      const hasAmount = amountInput && parseFloat(amountInput.value) > 0;
      const hasProof = proofInput && proofInput.files && proofInput.files.length > 0;
      const editorOk =
        window.BlytzEditor.canPersist && window.BlytzEditor.canPersist();
      sendBtn.disabled =
        windowExpired || alreadySubmitted || !editorOk || !(hasAmount && hasProof);
    }

    function validateProofClient() {
      if (!window.BlytzPaymentDetails) {
        return "Payment helpers failed to load.";
      }
      if (!proofInput || !proofInput.files || !proofInput.files[0]) {
        return "Choose a proof file.";
      }
      return window.BlytzPaymentDetails.validateProofFile(
        proofInput.files[0],
        proofMaxMb
      );
    }

    function showChannelDetails() {
      if (!channelSelect || !channelDetails || !window.BlytzPaymentDetails) return;
      const opt = channelSelect.options[channelSelect.selectedIndex];
      window.BlytzPaymentDetails.renderChannelDetails(channelDetails, opt || null);
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

    function preparePayloadOrWarn() {
      if (!window.BlytzEditor.preparePersistPayload) {
        return {
          ok: false,
          error: "Editor is not ready.",
        };
      }
      return window.BlytzEditor.preparePersistPayload();
    }

    function dataURLToBlob(dataURL) {
      if (!dataURL || typeof dataURL !== "string" || dataURL.indexOf("data:image/png") !== 0) {
        throw new Error("Invalid preview PNG.");
      }
      var parts = dataURL.split(",");
      var mimeMatch = parts[0].match(/:(.*?);/);
      var mime = mimeMatch ? mimeMatch[1] : "image/png";
      var binary = atob(parts[1] || "");
      var len = binary.length;
      var bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new Blob([bytes], { type: mime });
    }

    function resolvePreview(result) {
      return Promise.resolve(result).then(function (url) {
        if (!url || typeof url !== "string" || url.indexOf("data:image/png") !== 0) {
          throw new Error("Preview generation failed.");
        }
        // Reject the 1×1 fallback stub — not a real mock-up.
        if (url.length < 200) {
          throw new Error("Preview generation failed.");
        }
        return url;
      });
    }

    // Initial load — do not treat sync return as "ready".
    setStatus("Loading design…");
    updateActionButtons();
    try {
      window.BlytzEditor.loadCanvasJSON(JSON.parse(initialJson));
    } catch (e) {
      window.BlytzEditor.loadCanvasJSON({});
    }

    if (window.BlytzEditor.whenReady) {
      window.BlytzEditor.whenReady().then(function (result) {
        updateActionButtons();
        updateSendEnabled();
        if (result && result.state === "error") {
          setStatus(
            (window.BlytzEditor.getPersistBlockReason &&
              window.BlytzEditor.getPersistBlockReason()) ||
              "Design could not be loaded."
          );
        } else if (result && result.canPersist) {
          setStatus("");
        }
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        const prepared = preparePayloadOrWarn();
        if (!prepared.ok) {
          setStatus(prepared.error || "Save blocked.");
          return;
        }
        const body = new FormData();
        body.append("canvas_json", prepared.jsonString);
        body.append("csrfmiddlewaretoken", getCookie("csrftoken"));
        if (titleInput) {
          body.append("title", titleInput.value || "");
        }
        if (window.BlytzEditor && typeof window.BlytzEditor.getGarmentState === "function") {
          const g = window.BlytzEditor.getGarmentState();
          if (g && g.template) body.append("garment_template", g.template);
          if (g && g.color) body.append("garment_color", g.color);
        }
        setStatus("Saving…");
        saveBtn.disabled = true;
        fetch(saveUrl, {
          method: "POST",
          body: body,
          headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" },
          credentials: "same-origin",
        })
          .then(function (r) {
            return r
              .json()
              .then(function (data) {
                return { httpOk: r.ok, data: data };
              })
              .catch(function () {
                return { httpOk: false, data: null };
              });
          })
          .then(function (res) {
            const success = !!(res.httpOk && res.data && res.data.ok);
            if (success && res.data && res.data.title) {
              if (titleInput) titleInput.value = res.data.title;
              if (titleCrumb) titleCrumb.textContent = res.data.title;
              document.title = "Editor · " + res.data.title + " — Blytz";
            }
            setStatus(success ? "Saved." : "Save failed.");
            updateActionButtons();
          })
          .catch(function () {
            setStatus("Save failed.");
            updateActionButtons();
          });
      });
    }

    if (submitBtn) {
      submitBtn.addEventListener("click", function () {
        if (alreadySubmitted) {
          setStatus("Already submitted.");
          return;
        }
        const prepared = preparePayloadOrWarn();
        if (!prepared.ok) {
          setStatus(prepared.error || "Submit blocked.");
          return;
        }
        if (canvasField) {
          canvasField.value = prepared.jsonString;
        }
        const gTpl = document.getElementById("submit-garment-template");
        const gCol = document.getElementById("submit-garment-color");
        if (window.BlytzEditor && typeof window.BlytzEditor.getGarmentState === "function") {
          const g = window.BlytzEditor.getGarmentState();
          if (gTpl && g && g.template) gTpl.value = g.template;
          if (gCol && g && g.color) gCol.value = g.color;
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
        e.preventDefault();
        if (windowExpired) {
          setStatus("Payment window expired. Nothing was recorded.");
          return;
        }
        const prepared = preparePayloadOrWarn();
        if (!prepared.ok) {
          setStatus(prepared.error || "Submit blocked.");
          if (clientError) clientError.textContent = prepared.error || "Submit blocked.";
          return;
        }
        const proofErr = validateProofClient();
        if (proofErr) {
          if (clientError) clientError.textContent = proofErr;
          return;
        }
        if (!amountInput || !(parseFloat(amountInput.value) > 0)) {
          if (clientError) clientError.textContent = "Enter an amount.";
          return;
        }
        if (canvasField) {
          canvasField.value = prepared.jsonString;
        }
        const gTpl2 = document.getElementById("submit-garment-template");
        const gCol2 = document.getElementById("submit-garment-color");
        if (window.BlytzEditor && typeof window.BlytzEditor.getGarmentState === "function") {
          const g2 = window.BlytzEditor.getGarmentState();
          if (gTpl2 && g2 && g2.template) gTpl2.value = g2.template;
          if (gCol2 && g2 && g2.color) gCol2.value = g2.color;
        }
        if (sendBtn) sendBtn.disabled = true;
        if (clientError) clientError.textContent = "";
        setStatus("Generating previews…");

        var getPreview =
          window.BlytzEditor && window.BlytzEditor.getPreviewPNG
            ? window.BlytzEditor.getPreviewPNG.bind(window.BlytzEditor)
            : null;
        if (!getPreview) {
          setStatus("Could not create preview. Please try again.");
          if (clientError) {
            clientError.textContent =
              "Could not create preview. Please try again.";
          }
          if (sendBtn) sendBtn.disabled = false;
          updateSendEnabled();
          return;
        }

        Promise.all([
          resolvePreview(getPreview({ view: "front", includeGarment: true })),
          resolvePreview(getPreview({ view: "back", includeGarment: true })),
        ])
          .then(function (urls) {
            setStatus("Submitting…");
            var body = new FormData(form);
            body.set(
              "preview_image",
              dataURLToBlob(urls[0]),
              "preview_front.png"
            );
            body.set(
              "preview_back_image",
              dataURLToBlob(urls[1]),
              "preview_back.png"
            );
            return fetch(form.action, {
              method: "POST",
              body: body,
              headers: {
                "X-Requested-With": "XMLHttpRequest",
                Accept: "application/json",
              },
              credentials: "same-origin",
            }).then(function (r) {
              return r
                .json()
                .then(function (data) {
                  return { httpOk: r.ok, status: r.status, data: data };
                })
                .catch(function () {
                  return { httpOk: false, status: r.status, data: null };
                });
            });
          })
          .then(function (res) {
            if (res && res.httpOk && res.data && res.data.ok && res.data.redirect) {
              window.location.href = res.data.redirect;
              return;
            }
            var msg = "Submit failed. Please try again.";
            if (res && res.data && res.data.errors) {
              var parts = [];
              Object.keys(res.data.errors).forEach(function (key) {
                var vals = res.data.errors[key];
                if (Array.isArray(vals)) {
                  vals.forEach(function (v) {
                    parts.push(v);
                  });
                } else if (vals) {
                  parts.push(String(vals));
                }
              });
              if (parts.length) msg = parts.join(" ");
            }
            setStatus(msg);
            if (clientError) clientError.textContent = msg;
            if (sendBtn) sendBtn.disabled = false;
            updateSendEnabled();
          })
          .catch(function () {
            var msg =
              "Could not create preview. Please try again.";
            setStatus(msg);
            if (clientError) clientError.textContent = msg;
            if (sendBtn) sendBtn.disabled = false;
            updateSendEnabled();
          });
      });
    }

    updateActionButtons();
    updateSendEnabled();
    showChannelDetails();
  }

  document.addEventListener("DOMContentLoaded", function () {
    const root = qs("[data-editor-page]");
    if (root) initEditorPage(root);
  });
})();
