(function () {
  "use strict";

  var HERO_POOLS = {
    step1: [
      "https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1529390079861-591de354faf5?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1523050854058-8df90110c9f1?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1517486808906-6ca8b3f04846?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=2000&q=88",
    ],
    step2: [
      "https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1551434678-e076c223a692?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1531482615713-2afd69097998?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1556761175-b413da4baf72?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1553877522-43269d4ea984?auto=format&fit=crop&w=2000&q=88",
    ],
    step3: [
      "https://images.unsplash.com/photo-1497633762265-9d179a990aa6?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1434030216411-0b793f4f4173?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1435529411122-873fa8ed0f94?auto=format&fit=crop&w=2000&q=88",
    ],
    signin: [
      "https://images.unsplash.com/photo-1639762681485-074b7f938ba0?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1557682260-f958ff2dec55?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1618005198919-d3d4b3444434?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1486406146926-c627a92ad31f?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=2000&q=88",
      "https://images.unsplash.com/photo-1518709268805-4e904159af3b?auto=format&fit=crop&w=2000&q=88",
    ],
  };

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function initHeroImage() {
    var img = document.getElementById("signupHeroImg");
    if (!img) return;
    var poolKey = img.getAttribute("data-hero-pool");
    var pool = poolKey && HERO_POOLS[poolKey];
    if (pool && pool.length) {
      img.src = pickRandom(pool);
    }
  }

  function setProgressUI(pct, track) {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    var fill = document.getElementById("signupProgressFill");
    var label = document.getElementById("signupProgressPct");
    if (fill) fill.style.width = pct + "%";
    if (label) label.textContent = pct + "%";
    if (track) {
      track.setAttribute("aria-valuenow", String(pct));
    }
  }

  function validEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }

  function bindFormProgress() {
    var form = document.getElementById("f");
    var track = document.getElementById("signupProgressTrack");
    if (!form || !track) return;

    var mode = document.body.getAttribute("data-progress-mode") || "";

    function compute() {
      if (mode === "step1") {
        var u = document.getElementById("username");
        var n = document.getElementById("fullName");
        var p = 0;
        if (u && u.value.trim().length >= 3 && /^[a-zA-Z0-9._-]+$/.test(u.value.trim())) p += 50;
        if (n && n.value.trim().length >= 2) p += 50;
        return p;
      }
      if (mode === "step2") {
        var em = document.getElementById("email");
        var c = document.getElementById("phoneCountry");
        var ph = document.getElementById("phone");
        var p2 = 0;
        if (em && validEmail(em.value.trim())) p2 += 55;
        if (c && ph) {
          var pv = ph.value.replace(/\s+/g, "").trim();
          if (!pv) p2 += 45;
          else if (c.value && /^\d{4,19}$/.test(pv)) p2 += 45;
        }
        return p2;
      }
      if (mode === "step3") {
        var p1 = document.getElementById("password");
        var p2f = document.getElementById("password2");
        var q = 0;
        if (p1 && p1.value.length >= 8) q += 50;
        if (p2f && p2f.value.length >= 8 && p1 && p1.value === p2f.value) q += 50;
        else if (p2f && p2f.value.length > 0) q += 25;
        return q;
      }
      if (mode === "signin") {
        var e = document.getElementById("email");
        var pw = document.getElementById("password");
        var s = 0;
        if (e && validEmail(e.value.trim())) s += 50;
        if (pw && pw.value.length > 0) s += 50;
        return s;
      }
      return 0;
    }

    function update() {
      setProgressUI(compute(), track);
    }

    form.addEventListener("input", update);
    form.addEventListener("change", update);
    update();
  }

  function initStepDots() {
    var step = parseInt(document.body.getAttribute("data-signup-step") || "0", 10);
    if (!step || step < 1 || step > 3) return;
    var items = document.querySelectorAll(".signup-progress__steps li");
    items.forEach(function (li, i) {
      li.classList.remove("is-done", "is-current");
      if (i + 1 < step) li.classList.add("is-done");
      else if (i + 1 === step) li.classList.add("is-current");
    });
  }

  initHeroImage();
  bindFormProgress();
  initStepDots();
})();
