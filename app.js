(function(){
  "use strict";

  /* ---------- constants ---------- */
  var LS_UNIT_KEY = "thermocline:unit";
  var LS_STATE_KEY = "thermocline:state";
  var FEELINGS = [
    { id: "rough", label: "Rough", emoji: "\u{1F616}" },
    { id: "okay",  label: "Okay",  emoji: "\u{1F610}" },
    { id: "good",  label: "Good",  emoji: "\u{1F642}" },
    { id: "great", label: "Great", emoji: "\u{1F929}" }
  ];

  var root = document.getElementById("root");
  var STATE = loadState();
  var syncNotice = null;

  var ui = {
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
  function computeStats(sessions){
    var dateSet = {};
    var totalSec = 0;
    for (var i = 0; i < sessions.length; i++){
      dateSet[sessions[i].dateISO] = true;
      totalSec += sessions[i].durationSec || 0;
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
      activeDates: dateSet
    };
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

  function persist(newState){
    STATE = newState;
    try {
      localStorage.setItem(LS_STATE_KEY, JSON.stringify(STATE));
      syncNotice = null;
    } catch (e) {
      syncNotice = "Couldn't save to this browser. Export a backup so you don't lose your log.";
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
        persist({ v: 1, sessions: merged });
        syncNotice = "Imported " + added + " session" + (added === 1 ? "" : "s") + ".";
        renderApp();
      } catch (e) {
        syncNotice = "That file isn't a Thermocline backup.";
        renderApp();
      }
    };
    reader.readAsText(file);
  }

  /* ---------- timer ---------- */
  function startTimer(){
    ui.timerRunning = true;
    ui.timerStart = Date.now();
    ui.timerElapsed = 0;
    renderApp();
    tickHandle = setInterval(function(){
      ui.timerElapsed = Math.floor((Date.now() - ui.timerStart) / 1000);
      var el = document.getElementById("timerDigits");
      if (el) el.textContent = fmtClock(ui.timerElapsed);
    }, 500);
  }

  function stopTimer(){
    if (tickHandle){ clearInterval(tickHandle); tickHandle = null; }
    var elapsed = Math.max(1, Math.floor((Date.now() - ui.timerStart) / 1000));
    ui.timerRunning = false;
    ui.sheet = { mode: "new", durationSec: elapsed, id: null };
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

    var sessions = STATE.sessions.slice();

    if (ui.sheet.mode === "edit"){
      for (var i = 0; i < sessions.length; i++){
        if (sessions[i].id === ui.sheet.id){
          sessions[i] = Object.assign({}, sessions[i], {
            durationSec: durationSec,
            tempC: tempC,
            feeling: feeling,
            note: note
          });
          break;
        }
      }
    } else {
      var now = Date.now();
      var startedAt = now - durationSec * 1000;
      sessions.unshift({
        id: uid(),
        startedAt: startedAt,
        dateISO: localDateStr(new Date(startedAt)),
        durationSec: durationSec,
        tempC: tempC,
        feeling: feeling,
        note: note
      });
      sessions.sort(function(a, b){ return b.startedAt - a.startedAt; });
    }

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

  function noticeTpl(){
    if (!syncNotice) return "";
    return '<div class="notice">' + escapeHtml(syncNotice) + '</div>';
  }

  function timerTpl(){
    if (ui.timerRunning){
      return (
        '<section class="timer-card facet running">' +
          '<p class="timer-label">In the water</p>' +
          '<p class="timer-digits" id="timerDigits">' + fmtClock(ui.timerElapsed) + '</p>' +
          '<button class="btn btn-stop facet" data-action="stop-timer" type="button">Stop &amp; log</button>' +
        '</section>'
      );
    }
    return (
      '<section class="timer-card facet">' +
        '<p class="timer-label">Ready when you are</p>' +
        '<p class="timer-digits idle">' + fmtClock(0) + '</p>' +
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

    var chips = FEELINGS.map(function(f){
      var pressed = f.id === feeling;
      return '<button type="button" class="feeling-chip facet feeling-' + f.id + (pressed ? ' active' : '') + '" data-feeling="' + f.id + '" aria-pressed="' + (pressed ? 'true' : 'false') + '" data-action="pick-feeling"><span class="feeling-emoji" aria-hidden="true">' + f.emoji + '</span>' + f.label + '</button>';
    }).join("");

    return (
      '<div class="sheet-overlay" data-action="close-sheet-bg">' +
        '<div class="sheet facet" role="dialog" aria-label="Log a plunge">' +
          '<div class="sheet-handle"></div>' +
          '<h2 class="sheet-title">' + (isEdit ? 'Edit session' : 'Log this plunge') + '</h2>' +
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
          timerTpl() +
          statsTpl(stats) +
          dayStripTpl(stats) +
          chartTpl(STATE.sessions, ui.unit) +
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
      case "export-data": exportData(); break;
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
          renderApp();
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
  renderApp();
  if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0){
    navigator.serviceWorker.register("sw.js").catch(function(){});
  }
})();
