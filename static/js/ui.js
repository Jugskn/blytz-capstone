/**
 * Blytz UI — Modal, Drawer, Tabs
 */
(function () {
  "use strict";

  function openOverlay(el) {
    if (!el) return;
    el.classList.remove("hidden");
    el.classList.add("flex");
    document.body.classList.add("overflow-hidden");
    const focusable = el.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable) focusable.focus();
  }

  function closeOverlay(el) {
    if (!el) return;
    el.classList.add("hidden");
    el.classList.remove("flex");
    if (!document.querySelector("[data-modal].flex, [data-drawer]:not(.hidden)")) {
      document.body.classList.remove("overflow-hidden");
    }
  }

  document.addEventListener("click", function (e) {
    const openModal = e.target.closest("[data-modal-open]");
    if (openModal) {
      e.preventDefault();
      openOverlay(document.getElementById(openModal.getAttribute("data-modal-open")));
      return;
    }
    const closeModal = e.target.closest("[data-modal-close]");
    if (closeModal) {
      closeOverlay(closeModal.closest("[data-modal]"));
      return;
    }
    const openDrawer = e.target.closest("[data-drawer-open]");
    if (openDrawer) {
      e.preventDefault();
      const drawer = document.getElementById(openDrawer.getAttribute("data-drawer-open"));
      if (drawer) {
        drawer.classList.remove("hidden");
        document.body.classList.add("overflow-hidden");
      }
      return;
    }
    const closeDrawer = e.target.closest("[data-drawer-close]");
    if (closeDrawer) {
      const drawer = closeDrawer.closest("[data-drawer]");
      if (drawer) {
        drawer.classList.add("hidden");
        document.body.classList.remove("overflow-hidden");
      }
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    document.querySelectorAll("[data-modal].flex").forEach(closeOverlay);
    document.querySelectorAll("[data-drawer]:not(.hidden)").forEach(function (d) {
      d.classList.add("hidden");
      document.body.classList.remove("overflow-hidden");
    });
  });

  function activateTab(root, key) {
    root.querySelectorAll("[data-tab]").forEach(function (btn) {
      const active = btn.getAttribute("data-tab") === key;
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
      btn.classList.toggle("border-ink", active);
      btn.classList.toggle("text-ink", active);
      btn.classList.toggle("border-transparent", !active);
      btn.classList.toggle("text-ink-muted", !active);
    });
    root.querySelectorAll("[data-tab-panel]").forEach(function (panel) {
      const active = panel.getAttribute("data-tab-panel") === key;
      panel.classList.toggle("hidden", !active);
      if (active) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    });
  }

  document.addEventListener("click", function (e) {
    const tab = e.target.closest("[data-tab]");
    if (!tab) return;
    const root = tab.closest("[data-tabs]");
    if (!root) return;
    activateTab(root, tab.getAttribute("data-tab"));
  });
})();
