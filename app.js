(function(){
  "use strict";

  /* ---------- constants ---------- */
  var LS_UNIT_KEY = "thermocline:unit";
  var LS_STATE_KEY = "thermocline:state";
  var LS_SETTINGS_KEY = "thermocline:settings";
  var LS_TIMER_KEY = "thermocline:timer";
  var GOAL_OPTIONS = [0, 60, 120, 180, 300, 480, 600, 900];
  var BREATHE_MS = 30000;   /* guide runs for the first 30 seconds */
  var BREATHE_CYCLE = 10000; /* 4s in, 6s out */
  /* depth: every minute in the water is one metre */
  var LEVELS = [
    { name: "Surface",  at: 0 },
    { name: "Shallows", at: 20 },
    { name: "Deep",     at: 120 },
    { name: "Abyss",    at: 480 },
    { name: "Trench",   at: 1440 }
  ];
  var FEELINGS = [
    { id: "rough", label: "Rough", emoji: "\u{1F616}" },
    { id: "okay",  label: "Okay",  emoji: "\u{1F610}" },
    { id: "good",  label: "Good",  emoji: "\u{1F642}" },
    { id: "great", label: "Great", emoji: "\u{1F929}" }
  ];

  var BADGE_GROUPS = ["Streak", "Longest dip", "Total time", "Cold water", "Sessions"];
  var BADGES = [
    { id: "streak3",  group: "Streak", icon: "\u{1F525}", name: "3-day streak",  metric: "longestStreak", target: 3 },
    { id: "streak7",  group: "Streak", icon: "\u{1F525}", name: "7-day streak",  metric: "longestStreak", target: 7 },
    { id: "streak30", group: "Streak", icon: "\u{1F525}", name: "30-day streak", metric: "longestStreak", target: 30 },
    { id: "dip2",  group: "Longest dip", icon: "\u23F1\uFE0F", name: "2 min dip",  metric: "longestSec", target: 120 },
    { id: "dip5",  group: "Longest dip", icon: "\u23F1\uFE0F", name: "5 min dip",  metric: "longestSec", target: 300 },
    { id: "dip10", group: "Longest dip", icon: "\u23F1\uFE0F", name: "10 min dip", metric: "longestSec", target: 600 },
    { id: "total30m", group: "Total time", icon: "\u{1F30A}", name: "30 min total", metric: "totalSec", target: 1800 },
    { id: "total2h",  group: "Total time", icon: "\u{1F30A}", name: "2 hr total",   metric: "totalSec", target: 7200 },
    { id: "total10h", group: "Total time", icon: "\u{1F30A}", name: "10 hr total",  metric: "totalSec", target: 36000 },
    { id: "temp15", group: "Cold water", icon: "\u2744\uFE0F", name: "", metric: "coldestC", target: 15 },
    { id: "temp10", group: "Cold water", icon: "\u2744\uFE0F", name: "", metric: "coldestC", target: 10 },
    { id: "temp5",  group: "Cold water", icon: "\u{1F9CA}",     name: "", metric: "coldestC", target: 5 },
    { id: "sess1",  group: "Sessions", icon: "\u{1F3C5}", name: "First dip", metric: "sessionCount", target: 1 },
    { id: "sess10", group: "Sessions", icon: "\u{1F3C5}", name: "10 dips",   metric: "sessionCount", target: 10 },
    { id: "sess50", group: "Sessions", icon: "\u{1F3C5}", name: "50 dips",   metric: "sessionCount", target: 50 }
  ];

  var root = document.getElementById("root");
  var STATE = loadState();
  var SETTINGS = loadSettings();
  var syncNotice = null;

  var ui = {
    breatheStart: 0,
    celebrateUntil: 0,
    celebrateMsg: "",
    timerGoalSec: 0,
    timerAlerted: false,
    badgeNotice: null,
    timerRunning: false,
    timerStart: 0,
    timerElapsed: 0,
    sheet: null,        /* null | { mode:"new"|"edit", durationSec, id } */
    unit: "C",
    pendingDelete: null,
    chartTooltip: null  /* null | session id */
  };

  try {
    var savedUnit = localStorage.getItem(LS_UNIT_KEY);
    if (savedUnit === "C" || savedUnit === "F") ui.unit = savedUnit;
  } catch (e) {}

  var tickHandle = null;
  var confirmTimeout = null;
  var badgeTimeout = null;

  /* ---------- helpers ---------- */
  function pad2(n){ return (n < 10 ? "0" : "") + n; }

  function fmtClock(sec){
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (h > 0) return h + ":" + pad2(m) + ":" + pad2(s);
    return m + ":" + pad2(s);
  }

  function fmtDurationLong(sec){
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    if (m <= 0) return s + "s";
    if (s === 0) return m + "m";
    return m + "m " + s + "s";
  }

  function fmtTotalTime(totalSec){
    var h = Math.floor(totalSec / 3600);
    var m = Math.round((totalSec % 3600) / 60);
    if (h <= 0) return m + "m";
    return h + "h " + pad2(m) + "m";
  }

  function cToF(c){ return c * 9 / 5 + 32; }
  function fToC(f){ return (f - 32) * 5 / 9; }

  function tempDisplay(tempC, unit){
    if (tempC == null || isNaN(tempC)) return "—";
    var v = unit === "F" ? cToF(tempC) : tempC;
    var rounded = Math.round(v * 10) / 10;
    return (rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)) + "°" + unit;
  }

  function localDateStr(d){
    var y = d.getFullYear(), m = pad2(d.getMonth() + 1), day = pad2(d.getDate());
    return y + "-" + m + "-" + day;
  }

  function addDays(d, n){
    var r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }

  function escapeHtml(s){
    return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
      return ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" })[c];
    });
  }

  function uid(){
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function feelingLabel(id){
    for (var i = 0; i < FEELINGS.length; i++) if (FEELINGS[i].id === id) return FEELINGS[i].label;
    return "";
  }

  function feelingEmoji(id){
    for (var i = 0; i < FEELINGS.length; i++) if (FEELINGS[i].id === id) return FEELINGS[i].emoji;
    return "";
  }

  /* ---------- stats ---------- */
  function dayDiff(fromISO, toDate){
    var a = new Date(fromISO + "T00:00:00");
    var b = new Date(localDateStr(toDate) + "T00:00:00");
    return Math.max(0, Math.round((b - a) / 86400000));
  }

  function computeStats(sessions){
    var dateSet = {};
    var totalSec = 0;
    var longestSec = 0;
    var coldestC = null; /* coldest water temp, counting dips of 1 min or more */
    var longestSession = null, coldestSession = null;
    for (var i = 0; i < sessions.length; i++){
      var ss = sessions[i];
      dateSet[ss.dateISO] = true;
      totalSec += ss.durationSec || 0;
      if ((ss.durationSec || 0) > longestSec){ longestSec = ss.durationSec; longestSession = ss; }
      if (ss.tempC != null && !isNaN(ss.tempC) && (ss.durationSec || 0) >= 60){
        if (coldestC === null || ss.tempC < coldestC){ coldestC = ss.tempC; coldestSession = ss; }
      }
    }
    var dates = Object.keys(dateSet).sort();

    /* longest streak */
    var longest = 0, run = 0, prev = null;
    for (var j = 0; j < dates.length; j++){
      var d = dates[j];
      if (prev){
        var expected = localDateStr(addDays(new Date(prev + "T00:00:00"), 1));
        run = (d === expected) ? run + 1 : 1;
      } else {
        run = 1;
      }
      if (run > longest) longest = run;
      prev = d;
    }

    /* current streak: walk back from today (or yesterday) while consecutive */
    var current = 0;
    var today = new Date();
    var cursor = localDateStr(today);
    if (!dateSet[cursor]) cursor = localDateStr(addDays(today, -1));
    while (dateSet[cursor]){
      current++;
      cursor = localDateStr(addDays(new Date(cursor + "T00:00:00"), -1));
    }

    return {
      sessionCount: sessions.length,
      totalSec: totalSec,
      currentStreak: current,
      longestStreak: longest,
      longestSec: longestSec,
      coldestC: coldestC,
      longestSession: longestSession,
      coldestSession: coldestSession,
      daysSince: dates.length ? dayDiff(dates[dates.length - 1], new Date()) : null,
      activeDates: dateSet
    };
  }

  /* ---------- badges ---------- */
  function badgeInfo(b, stats){
    var v, earned, prog;
    if (b.metric === "coldestC"){
      v = stats.coldestC;
      earned = v !== null && v <= b.target;
      prog = earned ? 1 : 0;
    } else {
      v = stats[b.metric] || 0;
      earned = v >= b.target;
      prog = Math.min(1, v / b.target);
    }
    return { value: v, earned: earned, prog: prog };
  }

  function badgeName(b){
    return b.metric === "coldestC" ? tempDisplay(b.target, ui.unit) + " or colder" : b.name;
  }

  function badgeCaption(b, info){
    if (info.earned) return "Earned";
    switch (b.metric){
      case "longestStreak": return info.value + " / " + b.target + " days";
      case "sessionCount":  return info.value + " / " + b.target;
      case "longestSec":    return fmtDurationLong(info.value) + " / " + fmtDurationLong(b.target);
      case "totalSec":      return fmtTotalTime(info.value) + " / " + fmtTotalTime(b.target);
      default:              return "Dip 1 min+";
    }
  }

  function depthInfo(totalSec){
    var m = Math.floor(totalSec / 60), idx = 0;
    for (var i = 0; i < LEVELS.length; i++) if (m >= LEVELS[i].at) idx = i;
    return { m: m, index: idx, level: LEVELS[idx], next: LEVELS[idx + 1] || null };
  }

  function weekCountOf(stats){
    var today = new Date(), dow = (today.getDay() + 6) % 7, n = 0;
    for (var i = 0; i < 7; i++) if (stats.activeDates[localDateStr(addDays(today, i - dow))]) n++;
    return n;
  }

  function snapshot(sessions){
    var st = computeStats(sessions), earned = {};
    BADGES.forEach(function(b){ earned[b.id] = badgeInfo(b, st).earned; });
    return { stats: st, earned: earned, level: depthInfo(st.totalSec).index, n: sessions.length };
  }

  function celebrations(before, after){
    var items = [], kind = "";
    BADGES.forEach(function(b){
      if (after.earned[b.id] && !before.earned[b.id]) items.push("\u{1F3C5} New badge: " + badgeName(b));
    });
    if (items.length) kind = "badge";
    var recs = [];
    if (before.n > 0){
      var bs = before.stats, as = after.stats;
      if (as.longestSec > bs.longestSec) recs.push("\u{1F3C6} New record: longest dip " + fmtDurationLong(as.longestSec));
      if (bs.coldestC !== null && as.coldestC !== null && as.coldestC < bs.coldestC) recs.push("\u{1F3C6} New record: coldest dip " + tempDisplay(as.coldestC, ui.unit));
      if (as.longestStreak > bs.longestStreak && as.longestStreak >= 3) recs.push("\u{1F3C6} New record: " + as.longestStreak + "-day streak");
    }
    var lvl = after.level > before.level ? ["\u{1F30A} New depth: " + LEVELS[after.level].name] : [];
    if (lvl.length) kind = "level";
    if (recs.length) kind = "record";
    return { items: recs.concat(lvl, items), kind: kind };
  }

  function last14(activeDates){
    var out = [];
    var today = new Date();
    for (var i = 13; i >= 0; i--){
      var d = addDays(today, -i);
      var key = localDateStr(d);
      out.push({ key: key, active: !!activeDates[key], isToday: i === 0 });
    }
    return out;
  }

  function niceStep(range, targetTicks){
    if (range <= 0) range = 1;
    var rough = range / Math.max(1, targetTicks);
    var mag = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
    var norm = rough / mag;
    var step;
    if (norm < 1.5) step = 1;
    else if (norm < 3) step = 2;
    else if (norm < 7) step = 5;
    else step = 10;
    return step * mag;
  }

  function buildChartSeries(sessions){
    var withTemp = sessions.filter(function(s){ return s.tempC != null && !isNaN(s.tempC); });
    withTemp.sort(function(a, b){ return a.startedAt - b.startedAt; });
    var LIMIT = 20;
    var truncated = withTemp.length > LIMIT;
    var points = truncated ? withTemp.slice(withTemp.length - LIMIT) : withTemp;
    return { points: points, truncated: truncated, totalWithTemp: withTemp.length };
  }

  /* ---------- persistence ---------- */
  function saveUnit(u){
    ui.unit = u;
    try { localStorage.setItem(LS_UNIT_KEY, u); } catch (e) {}
  }

  function loadSettings(){
    var d = { goalSec: 0, sound: true, vibrate: true, weeklyGoal: 3, lastBackup: 0, snoozeUntil: 0, breathe: true };
    try {
      var r = JSON.parse(localStorage.getItem(LS_SETTINGS_KEY) || "null");
      if (r && typeof r === "object") for (var k in d) if (r[k] !== undefined) d[k] = r[k];
    } catch (e) {}
    return d;
  }

  function saveSettings(){
    try { localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch (e) {}
  }

  function loadState(){
    try {
      var raw = localStorage.getItem(LS_STATE_KEY);
      if (raw){
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.sessions)) return parsed;
      }
    } catch (e) {}
    return { v: 1, sessions: [] };
  }

  function dismissBadgeNotice(){
    ui.badgeNotice = null;
    ui.celebrateUntil = 0;
    if (!ui.sheet && !ui.timerRunning){
      renderApp();
    } else {
      var el = document.querySelector(".badge-notice");
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
  }

  function persist(newState, silent){
    var before = silent ? null : snapshot(STATE.sessions);
    STATE = newState;
    try {
      localStorage.setItem(LS_STATE_KEY, JSON.stringify(STATE));
      syncNotice = null;
    } catch (e) {
      syncNotice = "Couldn't save to this browser. Export a backup so you don't lose your log.";
    }
    if (before){
      var c = celebrations(before, snapshot(STATE.sessions));
      if (c.items.length){
        ui.badgeNotice = c.items;
        ui.celebrateUntil = Date.now() + 8000;
        ui.celebrateMsg = c.kind === "record" ? "New record. Look at you." : c.kind === "level" ? "Deeper water. Nice." : "Badge unlocked!";
        if (badgeTimeout) clearTimeout(badgeTimeout);
        badgeTimeout = setTimeout(dismissBadgeNotice, 8000);
      }
    }
    renderApp();
  }

  /* ---------- backup: export / import ---------- */
  function exportData(){
    var blob = new Blob([JSON.stringify(STATE, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "thermocline-" + localDateStr(new Date()) + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    SETTINGS.lastBackup = Date.now();
    saveSettings();
    renderApp();
  }

  function clearAllData(){
    if (!window.confirm("Delete all " + STATE.sessions.length + " sessions? This can't be undone. Export first if you want a copy.")) return;
    if (ui.timerRunning) endTimer();
    clearTimer();
    ui.chartTooltip = null;
    ui.sheet = null;
    persist({ v: 1, sessions: [] }, true);
  }

  function importData(file){
    var reader = new FileReader();
    reader.onload = function(){
      try {
        var parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.sessions)) throw new Error("bad file");
        var known = {};
        STATE.sessions.forEach(function(s){ known[s.id] = true; });
        var merged = STATE.sessions.slice();
        var added = 0;
        parsed.sessions.forEach(function(s){
          if (s && s.id && !known[s.id] && typeof s.startedAt === "number" && s.dateISO){
            merged.push(s); known[s.id] = true; added++;
          }
        });
        merged.sort(function(a, b){ return b.startedAt - a.startedAt; });
        persist({ v: 1, sessions: merged }, true);
        syncNotice = "Imported " + added + " session" + (added === 1 ? "" : "s") + ".";
        renderApp();
      } catch (e) {
        syncNotice = "That file isn't a Thermocline backup.";
        renderApp();
      }
    };
    reader.readAsText(file);
  }

  /* ---------- timer, alerts, screen wake lock ---------- */
  var audioCtx = null;
  var wakeLock = null;

  function getAudio(){
    try {
      if (!audioCtx){
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      }
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) {}
    return audioCtx;
  }

  function beep(){
    var ctx = getAudio();
    if (!ctx) return;
    var t0 = ctx.currentTime + 0.02;
    /* ten pulses, about 5 seconds, alternating two notes */
    for (var i = 0; i < 10; i++){
      var off = i * 0.5;
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = i % 2 === 0 ? 880 : 1175;
      gain.gain.setValueAtTime(0.0001, t0 + off);
      gain.gain.exponentialRampToValueAtTime(0.5, t0 + off + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + off);
      osc.stop(t0 + off + 0.45);
    }
  }

  function canVibrate(){ return typeof navigator.vibrate === "function"; }

  function fireAlert(){
    if (SETTINGS.sound) beep();
    if (SETTINGS.vibrate && canVibrate()){
      try { navigator.vibrate([400, 200, 400, 200, 400, 200, 400, 200, 400, 200, 700]); } catch (e) {}
    }
  }

  function holdScreen(){
    try {
      if (navigator.wakeLock && navigator.wakeLock.request){
        navigator.wakeLock.request("screen").then(function(l){ wakeLock = l; }).catch(function(){});
      }
    } catch (e) {}
  }

  function releaseScreen(){
    try { if (wakeLock){ wakeLock.release(); wakeLock = null; } } catch (e) {}
  }

  function saveTimer(){
    try {
      localStorage.setItem(LS_TIMER_KEY, JSON.stringify({ start: ui.timerStart, goalSec: ui.timerGoalSec, alerted: ui.timerAlerted }));
    } catch (e) {}
  }

  function clearTimer(){
    try { localStorage.removeItem(LS_TIMER_KEY); } catch (e) {}
  }

  function breatheActive(){ return ui.breatheStart > 0 && Date.now() - ui.breatheStart < BREATHE_MS; }
  function breatheText(){ return ((Date.now() - ui.breatheStart) % BREATHE_CYCLE) < 4000 ? "Breathe in" : "Breathe out"; }

  function tick(){
    if (!ui.timerRunning) return;
    ui.timerElapsed = Math.floor((Date.now() - ui.timerStart) / 1000);
    var el = document.getElementById("timerDigits");
    if (el) el.textContent = fmtClock(ui.timerElapsed);
    if (ui.breatheStart){
      if (!breatheActive()){
        ui.breatheStart = 0;
        renderApp();
      } else {
        var bt = document.getElementById("breatheText");
        if (bt) bt.textContent = breatheText();
      }
    }
    if (ui.timerGoalSec){
      var bar = document.getElementById("timerBar");
      if (bar) bar.style.width = Math.min(100, ui.timerElapsed / ui.timerGoalSec * 100) + "%";
      if (!ui.timerAlerted && ui.timerElapsed >= ui.timerGoalSec){
        ui.timerAlerted = true;
        saveTimer();
        fireAlert();
        renderApp();
      }
    }
  }

  function beginTicking(){
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = setInterval(tick, 500);
  }

  function startTimer(){
    getAudio(); /* unlock sound on this tap, browsers require a user gesture */
    ui.timerRunning = true;
    ui.timerStart = Date.now();
    ui.timerElapsed = 0;
    ui.timerGoalSec = SETTINGS.goalSec || 0;
    ui.timerAlerted = false;
    ui.breatheStart = SETTINGS.breathe ? Date.now() : 0;
    saveTimer();
    holdScreen();
    renderApp();
    beginTicking();
  }

  /* pick up a dip that was running when the page was closed or reloaded */
  function resumeTimer(){
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_TIMER_KEY) || "null"); } catch (e) {}
    if (!raw || typeof raw.start !== "number" || raw.start > Date.now()) return;
    ui.timerRunning = true;
    ui.timerStart = raw.start;
    ui.timerGoalSec = raw.goalSec || 0;
    ui.timerAlerted = !!raw.alerted;
    ui.breatheStart = 0;
    ui.timerElapsed = Math.floor((Date.now() - raw.start) / 1000);
    holdScreen();
    beginTicking();
  }

  function endTimer(){
    if (tickHandle){ clearInterval(tickHandle); tickHandle = null; }
    var elapsed = Math.max(1, Math.floor((Date.now() - ui.timerStart) / 1000));
    ui.timerRunning = false;
    ui.breatheStart = 0;
    clearTimer();
    releaseScreen();
    return elapsed;
  }

  function stopTimer(){
    var elapsed = endTimer();
    ui.sheet = { mode: "new", durationSec: elapsed, id: null };
    renderApp();
  }

  function discardTimer(){
    if (!window.confirm("Discard this dip without logging it?")) return;
    endTimer();
    renderApp();
  }

  function openManualLog(){
    ui.sheet = { mode: "new", durationSec: 0, id: null };
    renderApp();
  }

  function openEdit(id){
    var s = null;
    for (var i = 0; i < STATE.sessions.length; i++) if (STATE.sessions[i].id === id) s = STATE.sessions[i];
    if (!s) return;
    ui.sheet = { mode: "edit", durationSec: s.durationSec, id: id };
    renderApp();
  }

  function closeSheet(){
    ui.sheet = null;
    ui.pendingDelete = null;
    renderApp();
  }

  /* ---------- mutations ---------- */
  function saveSessionFromForm(){
    var minEl = document.getElementById("fMinutes");
    var secEl = document.getElementById("fSeconds");
    var tempEl = document.getElementById("fTemp");
    var noteEl = document.getElementById("fNote");
    var feelingEl = document.querySelector('.feeling-chip[aria-pressed="true"]');

    var minutes = Math.max(0, parseInt(minEl.value, 10) || 0);
    var seconds = Math.max(0, Math.min(59, parseInt(secEl.value, 10) || 0));
    var durationSec = minutes * 60 + seconds;
    if (durationSec <= 0) durationSec = 1;

    var tempRaw = parseFloat(tempEl.value);
    var tempC = null;
    if (!isNaN(tempRaw)) tempC = ui.unit === "F" ? fToC(tempRaw) : tempRaw;

    var feeling = feelingEl ? feelingEl.getAttribute("data-feeling") : null;
    var note = (noteEl.value || "").trim().slice(0, 240);

    var dateEl = document.getElementById("fDate");
    var todayStr = localDateStr(new Date());
    var dateStr = (dateEl && /^\d{4}-\d{2}-\d{2}$/.test(dateEl.value)) ? dateEl.value : todayStr;
    if (dateStr > todayStr) dateStr = todayStr;
    var dp = dateStr.split("-");
    var now = Date.now();
    function atDate(h, mi, sec){
      return Math.min(new Date(+dp[0], +dp[1] - 1, +dp[2], h, mi, sec).getTime(), now);
    }

    var sessions = STATE.sessions.slice();

    if (ui.sheet.mode === "edit"){
      for (var i = 0; i < sessions.length; i++){
        if (sessions[i].id === ui.sheet.id){
          var old = sessions[i];
          var startedAt = old.startedAt;
          if (dateStr !== old.dateISO){
            var od = new Date(old.startedAt);
            startedAt = atDate(od.getHours(), od.getMinutes(), od.getSeconds());
          }
          sessions[i] = Object.assign({}, old, {
            startedAt: startedAt,
            dateISO: dateStr,
            durationSec: durationSec,
            tempC: tempC,
            feeling: feeling,
            note: note
          });
          break;
        }
      }
    } else {
      var newStart = (dateStr === todayStr) ? now - durationSec * 1000 : atDate(12, 0, 0);
      sessions.unshift({
        id: uid(),
        startedAt: newStart,
        dateISO: dateStr,
        durationSec: durationSec,
        tempC: tempC,
        feeling: feeling,
        note: note
      });
    }
    sessions.sort(function(a, b){ return b.startedAt - a.startedAt; });

    ui.sheet = null;
    persist({ v: 1, sessions: sessions });
  }

  function requestDelete(id){
    if (ui.pendingDelete === id){
      var sessions = STATE.sessions.filter(function(s){ return s.id !== id; });
      ui.pendingDelete = null;
      ui.sheet = null;
      persist({ v: 1, sessions: sessions });
    } else {
      ui.pendingDelete = id;
      renderApp();
      if (confirmTimeout) clearTimeout(confirmTimeout);
      confirmTimeout = setTimeout(function(){ ui.pendingDelete = null; renderApp(); }, 3000);
    }
  }

  /* ---------- templates ---------- */
  function headerTpl(stats){
    return (
      '<header class="topbar">' +
        '<div class="brand">' +
          '<div class="brand-mark" aria-hidden="true"></div>' +
          '<div>' +
            '<h1 class="brand-title">Thermocline</h1>' +
            '<p class="brand-sub">cold plunge log</p>' +
          '</div>' +
        '</div>' +
        '<div class="streak-badge facet" title="Current streak">' +
          '<span class="streak-num">' + stats.currentStreak + '</span>' +
          '<span class="streak-label">day' + (stats.currentStreak === 1 ? '' : 's') + '</span>' +
        '</div>' +
      '</header>'
    );
  }

  function backupDue(){
    if (!STATE.sessions.length) return false;
    var now = Date.now();
    if (SETTINGS.snoozeUntil > now) return false;
    return !SETTINGS.lastBackup || now - SETTINGS.lastBackup > 14 * 86400000;
  }

  function noticeTpl(){
    var out = "";
    if (backupDue()){
      var days = SETTINGS.lastBackup ? Math.floor((Date.now() - SETTINGS.lastBackup) / 86400000) : null;
      out += '<div class="notice backup-notice"><p>' +
        (days === null ? "You haven&rsquo;t backed up your log yet." : "Your last backup was " + days + " days ago.") +
        ' Export a copy so it can&rsquo;t be lost if your browser clears its data.</p>' +
        '<div class="notice-actions"><button type="button" class="notice-btn" data-action="export-data">Export</button>' +
        '<button type="button" class="notice-btn" data-action="snooze-backup">Later</button></div></div>';
    }
    if (ui.badgeNotice) out += '<div class="notice badge-notice" data-action="dismiss-notice" role="status">' + ui.badgeNotice.map(escapeHtml).join("<br>") + '</div>';
    if (syncNotice) out += '<div class="notice">' + escapeHtml(syncNotice) + '</div>';
    return out;
  }

  function bearSvg(mood, winter){
    var o = [];
    o.push('<svg viewBox="84 12 344 468" width="88" class="bear" role="presentation" focusable="false" xmlns="http://www.w3.org/2000/svg">');
    o.push('<defs><linearGradient id="mb-fur" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dcecf3"/></linearGradient>' +
           '<linearGradient id="mb-lens" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1c26"/><stop offset="0.55" stop-color="#14566f"/><stop offset="1" stop-color="#57d2ec"/></linearGradient></defs>');
    var line = ' stroke="#9fc3d1" stroke-width="3"';
    o.push('<circle cx="148" cy="152" r="50" fill="#f1f8fb"' + line + '/><circle cx="148" cy="154" r="25" fill="#a9cbd8"/>');
    o.push('<circle cx="364" cy="152" r="50" fill="#f1f8fb"' + line + '/><circle cx="364" cy="154" r="25" fill="#a9cbd8"/>');
    o.push('<ellipse cx="256" cy="272" rx="152" ry="140" fill="url(#mb-fur)"' + line + '/>');
    o.push('<ellipse cx="256" cy="336" rx="78" ry="58" fill="#e4f1f6"/>');
    o.push('<ellipse cx="256" cy="310" rx="27" ry="19" fill="#0a2436"/><ellipse cx="248" cy="304" rx="8" ry="4" fill="#fff" opacity="0.45"/>');
    o.push('<circle cx="160" cy="316" r="16" fill="#9fd9e8" opacity="0.4"/><circle cx="352" cy="316" r="16" fill="#9fd9e8" opacity="0.4"/>');
    if (mood === "party"){
      o.push('<path d="M226 348 Q256 400 286 348 Z" fill="#0a2436"/><ellipse cx="256" cy="372" rx="14" ry="9" fill="#e8645a"/><path d="M256 326 V348" stroke="#0a2436" stroke-width="7" stroke-linecap="round"/>');
    } else if (mood === "sleepy"){
      o.push('<path d="M256 326 V342 M240 352 Q256 358 272 352" fill="none" stroke="#0a2436" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>');
    } else {
      o.push('<path d="M256 326 V346 M256 346 Q236 368 214 352 M256 346 Q276 368 298 352" fill="none" stroke="#0a2436" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>');
    }
    if (winter){
      o.push('<path d="M130 386 Q256 426 382 386 L394 428 Q256 472 118 428 Z" fill="#e8645a"/><path d="M122 410 Q256 454 390 410" fill="none" stroke="#f6a39b" stroke-width="8"/>');
    }
    if (mood === "sleepy"){
      o.push('<path d="M164 246 Q190 268 216 246 M296 246 Q322 268 348 246" fill="none" stroke="#0a2436" stroke-width="8" stroke-linecap="round"/>');
      o.push('<text x="368" y="150" font-family="sans-serif" font-size="56" font-weight="800" fill="#57d2ec">z</text><text x="404" y="110" font-family="sans-serif" font-size="38" font-weight="800" fill="#8fe3f5">z</text>');
    } else {
      o.push('<path d="M138 226 L112 220 M374 226 L400 220" stroke="#05121a" stroke-width="9" stroke-linecap="round"/><path d="M242 226 Q256 214 270 226" fill="none" stroke="#05121a" stroke-width="9" stroke-linecap="round"/>');
      o.push('<path d="M136 214 H246 V248 Q246 286 210 286 H172 Q136 286 136 248 Z" fill="url(#mb-lens)" stroke="#05121a" stroke-width="9" stroke-linejoin="round"/>');
      o.push('<path d="M266 214 H376 V248 Q376 286 340 286 H302 Q266 286 266 248 Z" fill="url(#mb-lens)" stroke="#05121a" stroke-width="9" stroke-linejoin="round"/>');
      o.push('<path d="M164 226 L190 226 L166 262 L152 262 Z M294 226 L320 226 L296 262 L282 262 Z" fill="#fff" opacity="0.5"/>');
    }
    if (mood === "party"){
      o.push('<path d="M256 34 L212 150 L300 150 Z" fill="#57d2ec" stroke="#0f7fa3" stroke-width="4" stroke-linejoin="round"/><path d="M224 118 L288 118" stroke="#fff" stroke-width="8" opacity="0.7"/><circle cx="256" cy="32" r="13" fill="#fff"/>');
      o.push('<circle cx="110" cy="120" r="9" fill="#e8645a"/><circle cx="408" cy="132" r="9" fill="#f2c94c"/><circle cx="96" cy="300" r="8" fill="#57d2ec"/><circle cx="418" cy="296" r="8" fill="#e8645a"/><rect x="392" y="64" width="16" height="16" fill="#8fe3f5" transform="rotate(25 400 72)"/><rect x="104" y="190" width="14" height="14" fill="#f2c94c" transform="rotate(-20 111 197)"/>');
    }
    if (mood === "proud"){
      o.push('<path d="M104 96 l7 21 21 7 -21 7 -7 21 -7 -21 -21 -7 21 -7z" fill="#57d2ec"/><path d="M412 86 l5 15 15 5 -15 5 -5 15 -5 -15 -15 -5 15 -5z" fill="#8fe3f5"/><path d="M420 300 l4 11 11 4 -11 4 -4 11 -4 -11 -11 -4 11 -4z" fill="#8fe3f5" opacity="0.8"/>');
    }
    if (mood === "plunge"){
      o.push('<path d="M60 334 Q120 314 180 334 T300 334 T420 334 T540 334 V500 H60 Z" fill="#57d2ec" opacity="0.5"/><path d="M60 352 Q120 334 180 352 T300 352 T420 352 T540 352 V500 H60 Z" fill="#0f7fa3" opacity="0.45"/>');
      o.push('<path d="M92 214 q-12 14 0 28 q12 14 0 28 M420 214 q12 14 0 28 q-12 14 0 28" fill="none" stroke="#8fe3f5" stroke-width="6" stroke-linecap="round"/><circle cx="338" cy="300" r="8" fill="none" stroke="#fff" stroke-width="4" opacity="0.8"/><circle cx="356" cy="278" r="5" fill="none" stroke="#fff" stroke-width="3" opacity="0.7"/>');
    }
    o.push('</svg>');
    return o.join("");
  }

  function mascotTpl(stats){
    var mood, line, sub = "";
    var m = new Date().getMonth(); /* scarf season: Nov to Mar */
    var winter = m >= 10 || m <= 2;
    if (ui.timerRunning){
      mood = "plunge";
      line = ui.timerAlerted ? "Goal reached. Nice work." : "In the water.";
      sub = "Steady breaths, long exhale.";
    } else if (ui.celebrateUntil > Date.now()){
      mood = "party";
      line = ui.celebrateMsg;
    } else if (!STATE.sessions.length){
      mood = "cool";
      line = "Ready for your first dip?";
      sub = "Start the timer, then log it.";
    } else if (stats.daysSince === 0){
      mood = "proud";
      line = stats.currentStreak > 1 ? "Day " + stats.currentStreak + " in a row." : "Nice dip today.";
      sub = weekCountOf(stats) + " of " + SETTINGS.weeklyGoal + " days this week";
    } else if (stats.daysSince >= 3){
      mood = "sleepy";
      line = "It's been " + stats.daysSince + " days.";
      sub = "The water's waiting.";
    } else {
      mood = "cool";
      line = "Ready when you are.";
      sub = "Last dip " + (stats.daysSince === 1 ? "yesterday" : stats.daysSince + " days ago") + ".";
    }
    return (
      '<section class="mascot">' +
        '<div class="mascot-art" aria-hidden="true">' + bearSvg(mood, winter) + '</div>' +
        '<div class="bubble facet" role="status">' +
          '<p class="bubble-main">' + escapeHtml(line) + '</p>' +
          (sub ? '<p class="bubble-sub">' + escapeHtml(sub) + '</p>' : '') +
        '</div>' +
      '</section>'
    );
  }

  function depthTpl(stats){
    var d = depthInfo(stats.totalSec);
    var pct = d.next ? Math.round((d.m - d.level.at) / (d.next.at - d.level.at) * 100) : 100;
    return (
      '<section class="depth-card facet">' +
        '<div class="depth-head">' +
          '<div><p class="section-label">Depth</p><p class="depth-name">' + d.level.name + '</p></div>' +
          '<p class="depth-m"><span class="stat-value">' + d.m + '</span> <span class="stat-unit">m</span></p>' +
        '</div>' +
        '<div class="depth-gauge" role="img" aria-label="' + pct + ' percent of the way to the next depth"><i style="width:' + pct + '%"></i></div>' +
        '<p class="depth-note">' + (d.next ? (d.next.at - d.m) + ' m to ' + d.next.name + '. Every minute in the water is one metre deeper.' : 'You have reached the Trench.') + '</p>' +
      '</section>'
    );
  }

  function recordsTpl(stats){
    var ls = stats.longestSession, cs = stats.coldestSession;
    function dl(x){ return new Date(x.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
    function tile(icon, label, value, sub){
      return '<div class="rec-tile facet"><span class="rec-icon" aria-hidden="true">' + icon + '</span><p class="rec-value">' + escapeHtml(value) + '</p><p class="stat-label">' + label + '</p><p class="stat-unit">' + escapeHtml(sub) + '</p></div>';
    }
    return (
      '<section class="records"><p class="section-label">Personal records</p><div class="rec-grid">' +
        tile("\u23F1\uFE0F", "Longest dip", ls ? fmtDurationLong(ls.durationSec) : "\u2014", ls ? dl(ls) : "no dips yet") +
        tile("\u2744\uFE0F", "Coldest dip", cs ? tempDisplay(cs.tempC, ui.unit) : "\u2014", cs ? dl(cs) : "needs 1 min+") +
        tile("\u{1F525}", "Best streak", stats.longestStreak ? stats.longestStreak + (stats.longestStreak === 1 ? " day" : " days") : "\u2014", stats.longestStreak ? "in a row" : "no streak yet") +
      '</div></section>'
    );
  }

  function goalLabel(sec){ return sec ? (sec / 60) + "m" : "No goal"; }

  function timerTpl(){
    if (ui.timerRunning){
      var g = ui.timerGoalSec;
      var label = g ? (ui.timerAlerted ? "Goal reached" : "Goal " + fmtClock(g)) : "In the water";
      var pct = g ? Math.min(100, ui.timerElapsed / g * 100) : 0;
      return (
        '<section class="timer-card facet running">' +
          '<p class="timer-label">' + label + '</p>' +
          '<p class="timer-digits' + (ui.timerAlerted ? ' reached' : '') + '" id="timerDigits">' + fmtClock(ui.timerElapsed) + '</p>' +
          (breatheActive() ? '<div class="breathe" id="breathe"><div class="breathe-ring" style="animation-delay:' + (-((Date.now() - ui.breatheStart) % BREATHE_CYCLE)) + 'ms"></div><p class="breathe-text" id="breatheText">' + breatheText() + '</p></div>' : '') +
          (g ? '<div class="timer-bar"><i id="timerBar" style="width:' + pct.toFixed(1) + '%"></i></div>' : '') +
          '<button class="btn btn-stop facet" data-action="stop-timer" type="button">Stop &amp; log</button>' +
          (breatheActive() ? '' : '<button class="btn-ghost" data-action="start-breathing" type="button">Breathing guide</button>') +
          '<button class="btn-ghost" data-action="discard-timer" type="button">Discard</button>' +
        '</section>'
      );
    }
    var chips = GOAL_OPTIONS.map(function(g){
      var on = SETTINGS.goalSec === g;
      return '<button type="button" class="goal-chip' + (on ? ' active' : '') + '" aria-pressed="' + on + '" data-action="set-goal" data-goal="' + g + '">' + goalLabel(g) + '</button>';
    }).join("");
    var alertChips =
      '<button type="button" class="goal-chip' + (SETTINGS.sound ? ' active' : '') + '" aria-pressed="' + SETTINGS.sound + '" data-action="toggle-sound">Sound</button>' +
      (canVibrate() ? '<button type="button" class="goal-chip' + (SETTINGS.vibrate ? ' active' : '') + '" aria-pressed="' + SETTINGS.vibrate + '" data-action="toggle-vibrate">Vibrate</button>' : '') +
      '<button type="button" class="goal-chip' + (SETTINGS.breathe ? ' active' : '') + '" aria-pressed="' + SETTINGS.breathe + '" data-action="toggle-breathe">Breathing</button>' +
      '<button type="button" class="goal-chip" data-action="test-alert">Test alert</button>';
    return (
      '<section class="timer-card facet">' +
        '<p class="timer-label">Ready when you are</p>' +
        '<p class="timer-digits idle">' + fmtClock(SETTINGS.goalSec || 0) + '</p>' +
        '<div class="goal-row" role="group" aria-label="Timer goal">' + chips + '</div>' +
        '<div class="goal-row" role="group" aria-label="Alerts and breathing guide">' + alertChips + '</div>' +
        (canVibrate() ? '' : '<p class="goal-note">Vibration isn&rsquo;t available in this browser, so the goal alert is sound only.</p>') +
        '<button class="btn btn-start facet" data-action="start-timer" type="button">Start plunge</button>' +
        '<button class="btn-ghost" data-action="manual-log" type="button">Log without timer</button>' +
      '</section>'
    );
  }

  function statsTpl(stats){
    return (
      '<section class="stats-grid">' +
        statTile("Current streak", stats.currentStreak, "day" + (stats.currentStreak === 1 ? "" : "s")) +
        statTile("Best streak", stats.longestStreak, "day" + (stats.longestStreak === 1 ? "" : "s")) +
        statTile("Sessions", stats.sessionCount, "logged") +
        statTile("Total time", fmtTotalTime(stats.totalSec), "immersed") +
      '</section>'
    );
  }

  function statTile(label, value, unitLabel){
    return (
      '<div class="stat-tile facet">' +
        '<p class="stat-value">' + value + '</p>' +
        '<p class="stat-label">' + escapeHtml(label) + '</p>' +
        '<p class="stat-unit">' + escapeHtml(unitLabel) + '</p>' +
      '</div>'
    );
  }

  function weeklyTpl(stats){
    var today = new Date();
    var dow = (today.getDay() + 6) % 7; /* Monday = 0 */
    var count = 0, cells = "";
    for (var i = 0; i < 7; i++){
      var key = localDateStr(addDays(today, i - dow));
      var active = !!stats.activeDates[key];
      if (active) count++;
      cells += '<span class="day-dot' + (active ? ' active' : '') + (i === dow ? ' today' : '') + '" title="' + key + '"></span>';
    }
    var goal = SETTINGS.weeklyGoal;
    return (
      '<section class="week-card facet">' +
        '<div class="week-head">' +
          '<div><p class="section-label">This week</p>' +
          '<p class="week-count"><span class="stat-value">' + count + ' / ' + goal + '</span> <span class="stat-unit">days' + (count >= goal ? ' &middot; goal met' : '') + '</span></p></div>' +
          '<div class="week-goal">' +
            '<button type="button" data-action="weekly-goal-dec" aria-label="Lower weekly goal">&minus;</button>' +
            '<button type="button" data-action="weekly-goal-inc" aria-label="Raise weekly goal">+</button>' +
          '</div>' +
        '</div>' +
        '<div class="day-strip">' + cells + '</div>' +
      '</section>'
    );
  }

  function dayStripTpl(stats){
    var days = last14(stats.activeDates);
    var dots = days.map(function(d){
      return '<span class="day-dot' + (d.active ? ' active' : '') + (d.isToday ? ' today' : '') + '" title="' + d.key + '"></span>';
    }).join("");
    return (
      '<section class="day-strip-wrap">' +
        '<p class="section-label">Last 14 days</p>' +
        '<div class="day-strip">' + dots + '</div>' +
      '</section>'
    );
  }

  function chartTpl(sessions, unit){
    var series = buildChartSeries(sessions);
    var pts = series.points;

    if (pts.length < 2){
      return (
        '<section class="chart-section">' +
          '<p class="section-label">Temperature trend</p>' +
          '<div class="chart-card facet empty-chart">' +
            '<p>Log water temp on a couple more plunges to see your trend here.</p>' +
          '</div>' +
        '</section>'
      );
    }

    var W = 328, H = 172;
    var padL = 34, padR = 14, padT = 26, padB = 26;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;

    var vals = pts.map(function(p){ return unit === "F" ? cToF(p.tempC) : p.tempC; });
    var rawMin = Math.min.apply(null, vals);
    var rawMax = Math.max.apply(null, vals);
    if (rawMin === rawMax){ rawMin -= 1; rawMax += 1; }
    var step = niceStep(rawMax - rawMin, 4);
    var min = Math.floor(rawMin / step) * step;
    var max = Math.ceil(rawMax / step) * step;
    if (max === min) max = min + step;

    function xFor(i){ return padL + (pts.length === 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW); }
    function yFor(v){ return padT + plotH - ((v - min) / (max - min)) * plotH; }

    var ticks = [];
    for (var t = min; t <= max + step * 0.001; t += step) ticks.push(Math.round(t * 100) / 100);

    var gridSvg = ticks.map(function(tv){
      var y = yFor(tv);
      return '<line class="grid-line" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '"></line>' +
        '<text class="axis-tick" x="' + (padL - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + Math.round(tv) + '&deg;</text>';
    }).join("");

    var linePath = pts.map(function(p, i){
      var x = xFor(i), y = yFor(unit === "F" ? cToF(p.tempC) : p.tempC);
      return (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
    }).join(" ");

    var pointsSvg = pts.map(function(p, i){
      var x = xFor(i), y = yFor(unit === "F" ? cToF(p.tempC) : p.tempC);
      var selected = ui.chartTooltip === p.id;
      var emoji = p.feeling ? feelingEmoji(p.feeling) : "";
      return (
        '<g class="chart-point' + (selected ? ' selected' : '') + '" data-action="chart-point" data-id="' + p.id + '">' +
          '<circle class="hit" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="14"></circle>' +
          '<circle class="dot" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (selected ? 6 : 4) + '"></circle>' +
          (emoji ? '<text class="point-emoji" x="' + x.toFixed(1) + '" y="' + (y - 12).toFixed(1) + '" text-anchor="middle">' + emoji + '</text>' : '') +
        '</g>'
      );
    }).join("");

    var labelIdx = [0, pts.length - 1];
    if (pts.length >= 5) labelIdx.splice(1, 0, Math.floor((pts.length - 1) / 2));
    var seen = {};
    var xLabelsSvg = labelIdx.filter(function(i){
      if (seen[i]) return false;
      seen[i] = true;
      return true;
    }).map(function(i){
      var x = xFor(i);
      var d = new Date(pts[i].startedAt);
      var label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return '<text class="axis-tick x-tick" x="' + x.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + escapeHtml(label) + '</text>';
    }).join("");

    var selectedPoint = null;
    if (ui.chartTooltip){
      for (var i2 = 0; i2 < pts.length; i2++) if (pts[i2].id === ui.chartTooltip) selectedPoint = pts[i2];
    }

    var detail;
    if (selectedPoint){
      var dd = new Date(selectedPoint.startedAt);
      var dLabel = dd.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      detail = (
        '<div class="chart-detail">' +
          '<span class="chart-detail-main">' + escapeHtml(dLabel) + ' &middot; ' + tempDisplay(selectedPoint.tempC, unit) +
            (selectedPoint.feeling ? ' &middot; ' + feelingEmoji(selectedPoint.feeling) + ' ' + feelingLabel(selectedPoint.feeling) : '') +
          '</span>' +
          '<button type="button" class="chart-detail-close" data-action="chart-point" data-id="' + selectedPoint.id + '" aria-label="Close detail">&times;</button>' +
        '</div>'
      );
    } else {
      detail = '<p class="chart-hint">Tap a point for details</p>';
    }

    var note = series.truncated ? '<p class="chart-note">Showing the last ' + pts.length + ' of ' + series.totalWithTemp + ' logged temps</p>' : "";

    return (
      '<section class="chart-section">' +
        '<p class="section-label">Temperature trend</p>' +
        '<div class="chart-card facet">' +
          '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart-svg" role="img" aria-label="Water temperature over time, marked with how each plunge felt">' +
            gridSvg +
            '<path class="chart-line" d="' + linePath + '"></path>' +
            pointsSvg +
            xLabelsSvg +
          '</svg>' +
          detail +
          note +
        '</div>' +
      '</section>'
    );
  }

  function badgesTpl(stats){
    var infos = {}, earnedCount = 0, next = null;
    BADGES.forEach(function(b){
      var info = badgeInfo(b, stats);
      infos[b.id] = info;
      if (info.earned) earnedCount++;
      else if (b.metric !== "coldestC" && (!next || info.prog > next.info.prog)) next = { b: b, info: info };
    });

    var nextTpl = "";
    if (next && earnedCount < BADGES.length){
      nextTpl = (
        '<div class="next-up facet">' +
          '<span class="badge-icon next-icon" aria-hidden="true">' + next.b.icon + '</span>' +
          '<div class="next-text">' +
            '<span class="next-title">Next badge: ' + escapeHtml(badgeName(next.b)) + '</span>' +
            '<span class="badge-cap">' + escapeHtml(badgeCaption(next.b, next.info)) + '</span>' +
            '<span class="badge-bar"><i style="width:' + Math.round(next.info.prog * 100) + '%"></i></span>' +
          '</div>' +
        '</div>'
      );
    }

    var groups = BADGE_GROUPS.map(function(g){
      var tiles = BADGES.filter(function(b){ return b.group === g; }).map(function(b){
        var info = infos[b.id];
        return (
          '<div class="badge facet' + (info.earned ? ' earned' : '') + '" role="listitem" aria-label="' + escapeHtml(badgeName(b)) + (info.earned ? ', earned' : ', not yet earned') + '">' +
            '<span class="badge-icon" aria-hidden="true">' + b.icon + '</span>' +
            '<span class="badge-name">' + escapeHtml(badgeName(b)) + '</span>' +
            '<span class="badge-cap">' + escapeHtml(badgeCaption(b, info)) + '</span>' +
            (info.earned ? '' : '<span class="badge-bar"><i style="width:' + Math.round(info.prog * 100) + '%"></i></span>') +
          '</div>'
        );
      }).join("");
      return '<div class="badge-group"><p class="badge-group-title">' + escapeHtml(g) + '</p><div class="badge-grid" role="list">' + tiles + '</div></div>';
    }).join("");

    return (
      '<section class="badges">' +
        '<p class="section-label">Badges &middot; ' + earnedCount + '/' + BADGES.length + '</p>' +
        nextTpl +
        groups +
      '</section>'
    );
  }

  function historyTpl(){
    if (STATE.sessions.length === 0){
      return (
        '<section class="history">' +
          '<p class="section-label">Log</p>' +
          '<div class="empty-state facet">' +
            '<p>No plunges yet.</p>' +
            '<p class="empty-sub">Start the timer, or log one manually, to begin your streak.</p>' +
          '</div>' +
        '</section>'
      );
    }
    var items = STATE.sessions.map(sessionItemTpl).join("");
    return (
      '<section class="history">' +
        '<p class="section-label">Log &middot; ' + STATE.sessions.length + '</p>' +
        '<div class="session-list">' + items + '</div>' +
      '</section>'
    );
  }

  function sessionItemTpl(s){
    var d = new Date(s.startedAt);
    var dateLabel = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    var weekday = d.toLocaleDateString(undefined, { weekday: "short" });
    var deleting = ui.pendingDelete === s.id;
    return (
      '<div class="session-item facet">' +
        '<button class="session-main" data-action="edit-session" data-id="' + s.id + '" type="button">' +
          '<div class="session-date">' +
            '<span class="session-day">' + dateLabel + '</span>' +
            '<span class="session-weekday">' + weekday + '</span>' +
          '</div>' +
          '<div class="session-mid">' +
            '<span class="session-duration">' + fmtDurationLong(s.durationSec) + '</span>' +
            '<span class="session-temp">' + tempDisplay(s.tempC, ui.unit) + '</span>' +
            (s.note ? '<span class="session-note">' + escapeHtml(s.note) + '</span>' : '') +
          '</div>' +
          (s.feeling ? '<span class="feeling-pill feeling-' + s.feeling + '"><span class="feeling-emoji" aria-hidden="true">' + feelingEmoji(s.feeling) + '</span>' + feelingLabel(s.feeling) + '</span>' : '<span></span>') +
        '</button>' +
        '<button class="session-del' + (deleting ? ' confirm' : '') + '" data-action="delete-session" data-id="' + s.id + '" type="button" aria-label="Delete session">' +
          (deleting ? 'Sure?' : '×') +
        '</button>' +
      '</div>'
    );
  }

  function backupTpl(){
    return (
      '<section class="backup">' +
        '<p class="section-label">Backup</p>' +
        '<div class="backup-row">' +
          '<button type="button" class="backup-btn facet" data-action="export-data">Export log</button>' +
          '<button type="button" class="backup-btn facet" data-action="import-data">Import log</button>' +
          '<input type="file" id="importFile" accept="application/json,.json" hidden>' +
        '</div>' +
        '<p class="backup-note">Your log is stored in this browser only. Export now and then to keep a copy.</p>' +
        (STATE.sessions.length ? '<button type="button" class="btn-ghost danger wipe-btn" data-action="clear-data">Delete all sessions</button>' : '') +
      '</section>'
    );
  }

  function unitToggleTpl(){
    return (
      '<div class="segmented" role="group" aria-label="Temperature unit">' +
        '<button type="button" class="seg-btn' + (ui.unit === 'C' ? ' active' : '') + '" data-action="set-unit" data-unit="C">°C</button>' +
        '<button type="button" class="seg-btn' + (ui.unit === 'F' ? ' active' : '') + '" data-action="set-unit" data-unit="F">°F</button>' +
      '</div>'
    );
  }

  function sheetTpl(){
    if (!ui.sheet) return "";
    var isEdit = ui.sheet.mode === "edit";
    var existing = null;
    if (isEdit){
      for (var i = 0; i < STATE.sessions.length; i++) if (STATE.sessions[i].id === ui.sheet.id) existing = STATE.sessions[i];
    }
    var durationSec = existing ? existing.durationSec : ui.sheet.durationSec;
    var minutes = Math.floor(durationSec / 60);
    var seconds = durationSec % 60;
    var tempVal = "";
    if (existing && existing.tempC != null){
      var t = ui.unit === "F" ? cToF(existing.tempC) : existing.tempC;
      tempVal = Math.round(t * 10) / 10;
    }
    var note = existing ? existing.note : "";
    var feeling = existing ? existing.feeling : null;
    var todayStr = localDateStr(new Date());
    var dateVal = existing ? existing.dateISO : todayStr;

    var chips = FEELINGS.map(function(f){
      var pressed = f.id === feeling;
      return '<button type="button" class="feeling-chip facet feeling-' + f.id + (pressed ? ' active' : '') + '" data-feeling="' + f.id + '" aria-pressed="' + (pressed ? 'true' : 'false') + '" data-action="pick-feeling"><span class="feeling-emoji" aria-hidden="true">' + f.emoji + '</span>' + f.label + '</button>';
    }).join("");

    return (
      '<div class="sheet-overlay" data-action="close-sheet-bg">' +
        '<div class="sheet facet" role="dialog" aria-modal="true" aria-label="Log a plunge">' +
          '<div class="sheet-handle"></div>' +
          '<h2 class="sheet-title">' + (isEdit ? 'Edit session' : 'Log this plunge') + '</h2>' +
          '<label class="field">' +
            '<span class="field-label">Date</span>' +
            '<input id="fDate" type="date" max="' + todayStr + '" value="' + dateVal + '">' +
          '</label>' +
          '<div class="field-row">' +
            '<label class="field">' +
              '<span class="field-label">Minutes</span>' +
              '<input id="fMinutes" type="number" inputmode="numeric" min="0" max="120" value="' + minutes + '">' +
            '</label>' +
            '<label class="field">' +
              '<span class="field-label">Seconds</span>' +
              '<input id="fSeconds" type="number" inputmode="numeric" min="0" max="59" value="' + seconds + '">' +
            '</label>' +
          '</div>' +
          '<div class="field-row">' +
            '<label class="field grow">' +
              '<span class="field-label">Water temp</span>' +
              '<input id="fTemp" type="number" inputmode="decimal" step="0.5" placeholder="e.g. 6" value="' + tempVal + '">' +
            '</label>' +
            unitToggleTpl() +
          '</div>' +
          '<div class="field">' +
            '<span class="field-label">How did it feel?</span>' +
            '<div class="feeling-row">' + chips + '</div>' +
          '</div>' +
          '<label class="field">' +
            '<span class="field-label">Notes <span class="field-optional">optional</span></span>' +
            '<textarea id="fNote" rows="2" maxlength="240" placeholder="Breathing, focus, anything worth remembering&hellip;">' + escapeHtml(note) + '</textarea>' +
          '</label>' +
          '<div class="sheet-actions">' +
            (isEdit ? '<button type="button" class="btn-ghost danger" data-action="delete-session" data-id="' + ui.sheet.id + '">' + (ui.pendingDelete === ui.sheet.id ? 'Tap again to delete' : 'Delete') + '</button>' : '<span></span>') +
            '<button type="button" class="btn btn-save facet" data-action="save-session">Save</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function pageTpl(){
    var stats = computeStats(STATE.sessions);
    return (
      '<div class="page">' +
        headerTpl(stats) +
        noticeTpl() +
        '<main class="main">' +
          mascotTpl(stats) +
          timerTpl() +
          statsTpl(stats) +
          depthTpl(stats) +
          weeklyTpl(stats) +
          dayStripTpl(stats) +
          chartTpl(STATE.sessions, ui.unit) +
          recordsTpl(stats) +
          badgesTpl(stats) +
          historyTpl() +
          backupTpl() +
        '</main>' +
      '</div>' +
      sheetTpl()
    );
  }

  /* ---------- render ---------- */
  function renderApp(){
    root.innerHTML = pageTpl();
    if (document.documentElement){
      document.documentElement.setAttribute("data-depth", String(depthInfo(computeStats(STATE.sessions).totalSec).index));
    }
    if (ui.sheet){
      var mEl = document.getElementById("fMinutes");
      if (mEl) mEl.focus({ preventScroll: true });
    }
  }

  function onRootClick(e){
    var t = e.target.closest("[data-action]");
    if (!t) return;
    var action = t.getAttribute("data-action");
    switch (action){
      case "start-timer": startTimer(); break;
      case "stop-timer": stopTimer(); break;
      case "manual-log": openManualLog(); break;
      case "dismiss-notice": dismissBadgeNotice(); break;
      case "set-goal": SETTINGS.goalSec = parseInt(t.getAttribute("data-goal"), 10) || 0; saveSettings(); renderApp(); break;
      case "toggle-breathe": SETTINGS.breathe = !SETTINGS.breathe; saveSettings(); renderApp(); break;
      case "start-breathing": ui.breatheStart = Date.now(); renderApp(); break;
      case "toggle-sound": SETTINGS.sound = !SETTINGS.sound; saveSettings(); renderApp(); break;
      case "toggle-vibrate": SETTINGS.vibrate = !SETTINGS.vibrate; saveSettings(); renderApp(); break;
      case "test-alert": fireAlert(); break;
      case "discard-timer": discardTimer(); break;
      case "weekly-goal-dec": SETTINGS.weeklyGoal = Math.max(1, SETTINGS.weeklyGoal - 1); saveSettings(); renderApp(); break;
      case "weekly-goal-inc": SETTINGS.weeklyGoal = Math.min(7, SETTINGS.weeklyGoal + 1); saveSettings(); renderApp(); break;
      case "snooze-backup": SETTINGS.snoozeUntil = Date.now() + 3 * 86400000; saveSettings(); renderApp(); break;
      case "export-data": exportData(); break;
      case "clear-data": clearAllData(); break;
      case "import-data": document.getElementById("importFile").click(); break;
      case "edit-session": openEdit(t.getAttribute("data-id")); break;
      case "delete-session": requestDelete(t.getAttribute("data-id")); break;
      case "save-session": saveSessionFromForm(); break;
      case "close-sheet-bg": if (e.target === t) closeSheet(); break;
      case "chart-point":
        var pid = t.getAttribute("data-id");
        ui.chartTooltip = (ui.chartTooltip === pid) ? null : pid;
        renderApp();
        break;
      case "pick-feeling":
        document.querySelectorAll(".feeling-chip").forEach(function(el){
          el.classList.remove("active");
          el.setAttribute("aria-pressed", "false");
        });
        t.classList.add("active");
        t.setAttribute("aria-pressed", "true");
        break;
      case "set-unit":
        var newUnit = t.getAttribute("data-unit");
        if (newUnit !== ui.unit){
          var tempEl = document.getElementById("fTemp");
          if (tempEl && tempEl.value !== ""){
            var v = parseFloat(tempEl.value);
            if (!isNaN(v)){
              var converted = newUnit === "F" ? cToF(ui.unit === "F" ? fToC(v) : v) : (ui.unit === "F" ? fToC(v) : v);
              tempEl.value = Math.round(converted * 10) / 10;
            }
          }
          saveUnit(newUnit);
          if (ui.sheet){
            document.querySelectorAll(".seg-btn").forEach(function(el){
              el.classList.toggle("active", el.getAttribute("data-unit") === newUnit);
            });
          } else {
            renderApp();
          }
        }
        break;
      default: break;
    }
  }

  root.addEventListener("click", onRootClick);
  root.addEventListener("change", function(e){
    if (e.target && e.target.id === "importFile" && e.target.files && e.target.files[0]){
      importData(e.target.files[0]);
    }
  });

  /* ---------- init ---------- */
  document.addEventListener("keydown", function(e){
    if (e.key === "Escape" && ui.sheet) closeSheet();
  });
  document.addEventListener("visibilitychange", function(){
    if (document.visibilityState === "visible" && ui.timerRunning){ holdScreen(); tick(); }
  });
  resumeTimer();
  renderApp();
  if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0){
    navigator.serviceWorker.register("sw.js").catch(function(){});
  }
})();
