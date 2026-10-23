(function () {
  "use strict";

  var header = document.getElementById("site-header");

  /* ----- Header border on scroll (observer, not scroll listener) ----- */

  if (header && "IntersectionObserver" in window) {
    var sentinel = document.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.style.cssText = "position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none";
    document.body.insertBefore(sentinel, document.body.firstChild);
    new IntersectionObserver(function (entries) {
      header.classList.toggle("is-scrolled", !entries[0].isIntersecting);
    }, { threshold: 0 }).observe(sentinel);
  }

  /* ----- Mobile menu ----- */

  var menuButton = document.getElementById("menu-toggle");
  var navLinks = document.getElementById("nav-links");

  function closeMenu() {
    if (!header) return;
    header.classList.remove("menu-open");
    if (menuButton) menuButton.setAttribute("aria-expanded", "false");
  }

  if (menuButton && header) {
    menuButton.addEventListener("click", function () {
      var open = header.classList.toggle("menu-open");
      menuButton.setAttribute("aria-expanded", String(open));
    });
  }

  if (navLinks) {
    navLinks.addEventListener("click", function (event) {
      if (event.target.closest("a")) closeMenu();
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeMenu();
  });

  window.addEventListener("resize", function () {
    if (window.innerWidth > 1080) closeMenu();
  });

  /* ----- Tabs ----- */

  function setupTabs(scope) {
    var buttons = Array.prototype.slice.call(scope.querySelectorAll('[role="tab"]'));
    var panels = Array.prototype.slice.call(scope.querySelectorAll('[role="tabpanel"]'));
    if (!buttons.length || !panels.length) return;

    function select(button, focus) {
      buttons.forEach(function (item) {
        var selected = item === button;
        item.setAttribute("aria-selected", String(selected));
        item.tabIndex = selected ? 0 : -1;
      });
      panels.forEach(function (panel) {
        panel.hidden = panel.id !== button.getAttribute("aria-controls");
      });
      if (focus) button.focus();
    }

    buttons.forEach(function (button, index) {
      button.addEventListener("click", function () { select(button, false); });
      button.addEventListener("keydown", function (event) {
        var next = index;
        if (event.key === "ArrowRight") next = (index + 1) % buttons.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + buttons.length) % buttons.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = buttons.length - 1;
        else return;
        event.preventDefault();
        select(buttons[next], true);
      });
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-tabs]"), setupTabs);

  /* ----- Dashboard viewer ----- */

  var dashImage = document.getElementById("dash-image");
  var viewButtons = Array.prototype.slice.call(document.querySelectorAll("[data-view]"));
  var dashView = "list";

  function renderDashboard() {
    if (!dashImage) return;
    var file = (dashView === "detail" ? "scenario-detail" : "scenario-list") + "-dark.png";
    dashImage.src = "screenshots/" + file;
    dashImage.alt = "Scenarii " + (dashView === "detail" ? "scenario detail" : "scenario list") + " dashboard in dark theme";

    viewButtons.forEach(function (button) {
      button.setAttribute("aria-selected", String(button.getAttribute("data-view") === dashView));
    });
  }

  viewButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      dashView = button.getAttribute("data-view");
      renderDashboard();
    });
  });

  /* ----- Copy buttons ----- */

  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); } catch (error) { /* ignore */ }
    document.body.removeChild(area);
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (button) {
    button.addEventListener("click", function () {
      var target = document.getElementById(button.getAttribute("data-copy"));
      if (!target) return;
      var text = target.textContent.replace(/\u00a0/g, " ");
      var done = function () {
        var original = button.textContent;
        button.textContent = "Copied";
        button.classList.add("copied");
        window.setTimeout(function () {
          button.textContent = original;
          button.classList.remove("copied");
        }, 1600);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
      } else {
        fallbackCopy(text);
        done();
      }
    });
  });

  /* ----- Open reference details from hash links ----- */

  function openHashTarget() {
    if (!window.location.hash) return;
    var target;
    try { target = document.querySelector(window.location.hash); } catch (error) { return; }
    if (!target) return;
    var parent = target.closest("details");
    while (parent) {
      parent.open = true;
      parent = parent.parentElement ? parent.parentElement.closest("details") : null;
    }
  }

  openHashTarget();
  window.addEventListener("hashchange", openHashTarget);

  /* ----- Reveal ----- */

  var reveals = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reduceMotion || !("IntersectionObserver" in window)) {
    reveals.forEach(function (item) { item.classList.add("is-in"); });
  } else {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          revealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.1 });
    reveals.forEach(function (item) { revealObserver.observe(item); });
  }
})();
