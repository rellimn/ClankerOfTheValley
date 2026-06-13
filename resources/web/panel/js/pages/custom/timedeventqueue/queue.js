/*
 * Copyright (C) 2016-2026 phantombot.github.io/PhantomBot
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/* global socket, helpers, toastr */

/*
 * Panel UI for the timed event queue. Reads the callback-stripped snapshot the engine
 * mirrors to the 'timedEventQueue' DataStore table ({ accepting, items, history }), renders
 * the live list, ticks the active item's countdown locally, highlights + beeps on expiry,
 * and sends actions back to ./custom/timedEventQueue/timedEventQueueSystem.js. Display
 * settings live in the 'timedEventQueueSettings' table and are read/written here directly.
 */
$(function () {
    var SCRIPT = './custom/timedEventQueue/timedEventQueueSystem.js',
        SECTION = 'extra',
        SETTINGS_TABLE = 'timedEventQueueSettings',
        model = { accepting: true, items: [], history: [] },
        settings = { highlightStyle: 'pulse', soundEnabled: true, soundVolume: 35, soundTone: 'beep', warnThreshold: 10 },
        alerted = {},          // item ids we've already beeped for
        suppressUntil = 0,     // skip overwriting the optimistic model until this time
        dragging = false,      // true while a sortable drag is in progress
        writable = true,       // whether this panel user may control the queue
        audioCtx = null;

    /* ---- write gate ---- */

    // Silent check (no toast) — used to lay out the UI for read-only users.
    function isWritable() {
        var ns = window.__pbCustomPanel__;
        if (ns && typeof ns.panelSectionCanWrite === 'function') {
            return ns.panelSectionCanWrite(SECTION);
        }
        return true;
    }

    // Enforcing check (shows the stock permission toast when denied) — used on click/save.
    function canWrite() {
        var ns = window.__pbCustomPanel__;
        if (ns && typeof ns.requirePanelSectionWrite === 'function') {
            return ns.requirePanelSectionWrite(SECTION);
        }
        return true;
    }

    // Reflect read-only state in the UI: banner + disabled settings controls.
    function applyWritable() {
        writable = isWritable();
        $('#teq-readonly-banner').toggle(!writable);
        $('#teq-accepting-toggle').prop('disabled', !writable);
        $('#teq-set-save, #teq-set-highlight, #teq-set-sound-enabled, #teq-set-tone, #teq-set-volume, #teq-set-warn')
            .prop('disabled', !writable);
    }

    /* ---- expiry sound (WebAudio; no binary asset needed) ---- */

    function ensureAudio() {
        if (audioCtx) {
            return audioCtx;
        }
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) {
            return null;
        }
        audioCtx = new Ctx();
        return audioCtx;
    }

    function resumeAudio() {
        var ctx = ensureAudio();
        if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
            ctx.resume();
        }
    }

    function toneHz(tone) {
        switch (tone) {
            case 'low': return 440;
            case 'high': return 1320;
            default: return 880; // beep / double
        }
    }

    function blip(ctx, freq, startOffset, gainLevel) {
        var o = ctx.createOscillator(),
            g = ctx.createGain(),
            t = ctx.currentTime + startOffset;
        o.type = 'sine';
        o.frequency.value = freq;
        o.connect(g);
        g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainLevel), t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
        o.start(t);
        o.stop(t + 0.5);
    }

    function beep() {
        if (!settings.soundEnabled) {
            return;
        }
        var ctx = ensureAudio();
        if (!ctx) {
            return;
        }
        try {
            if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
                ctx.resume();
            }
            var gainLevel = Math.max(0, Math.min(100, settings.soundVolume)) / 100 * 0.6,
                freq = toneHz(settings.soundTone);
            blip(ctx, freq, 0, gainLevel);
            if (settings.soundTone === 'double') {
                blip(ctx, freq, 0.28, gainLevel);
            }
        } catch (e) {
            // Autoplay policy may block until a user gesture; the visual highlight still fires.
        }
    }

    /* ---- formatting ---- */

    function formatClock(totalSeconds) {
        if (totalSeconds < 0) {
            totalSeconds = 0;
        }
        var m = Math.floor(totalSeconds / 60),
            s = Math.floor(totalSeconds % 60);
        return m + ':' + (s < 10 ? '0' + s : s);
    }

    function formatWhen(epochMs) {
        if (!epochMs) {
            return '';
        }
        try {
            return new Date(epochMs).toLocaleTimeString();
        } catch (e) {
            return '';
        }
    }

    function remainingSeconds(item) {
        if (item.paused) {
            return Math.round((item.remainingMs || 0) / 1000);
        }
        if (item.expiresAt == null) {
            return item.timeLeft;
        }
        return Math.max(0, Math.round((item.expiresAt - Date.now()) / 1000));
    }

    /* ---- actions (optimistic) ---- */

    function findItem(id) {
        for (var i = 0; i < model.items.length; i++) {
            if (model.items[i].id === id) {
                return model.items[i];
            }
        }
        return null;
    }

    function activeItem() {
        for (var i = 0; i < model.items.length; i++) {
            if (model.items[i].state === 'active' || model.items[i].state === 'expired') {
                return model.items[i];
            }
        }
        return null;
    }

    function send(args) {
        suppressUntil = Date.now() + 800;
        socket.wsEvent('teq_' + args[0] + '_' + helpers.getRandomString(3), SCRIPT, '', args, function () {}, false);
    }

    /* mutate the local model immediately, then tell the engine; the poll reconciles later */
    function doAction(optimisticFn, args) {
        if (!canWrite()) {
            return;
        }
        resumeAudio(); // this click is a user gesture: unblock the beep for later
        if (typeof optimisticFn === 'function') {
            optimisticFn();
        }
        render();
        send(args);
    }

    function optAccept(id) {
        if (activeItem()) {
            return;
        }
        var it = findItem(id);
        if (!it || it.state !== 'pending') {
            return;
        }
        var now = Date.now();
        it.state = 'active';
        it.acceptedAt = now;
        it.expiresAt = now + (it.timeLeft * 1000);
        it.paused = false;
        it.remainingMs = it.timeLeft * 1000;
    }

    function optRemove(id) {
        model.items = model.items.filter(function (it) {
            return it.id !== id;
        });
    }

    function optAddTime(delta) {
        var it = activeItem();
        if (!it) {
            return;
        }
        if (it.paused) {
            it.remainingMs = Math.max(0, (it.remainingMs || 0) + delta * 1000);
            it.state = it.remainingMs > 0 ? 'active' : 'expired';
        } else {
            var rem = Math.max(0, (it.expiresAt - Date.now()) + delta * 1000);
            it.remainingMs = rem;
            it.expiresAt = Date.now() + rem;
            it.state = rem > 0 ? 'active' : 'expired';
        }
    }

    function optPause() {
        var it = activeItem();
        if (!it || it.paused || it.state !== 'active') {
            return;
        }
        it.remainingMs = Math.max(0, it.expiresAt - Date.now());
        it.paused = true;
    }

    function optResume() {
        var it = activeItem();
        if (!it || !it.paused) {
            return;
        }
        it.paused = false;
        it.expiresAt = Date.now() + (it.remainingMs || 0);
        it.state = (it.remainingMs || 0) > 0 ? 'active' : 'expired';
    }

    function pendingIds() {
        var out = [];
        model.items.forEach(function (it) {
            if (it.state === 'pending') {
                out.push(it.id);
            }
        });
        return out;
    }

    /* reorder the pending items in the model to match orderedIds (active/expired stay put) */
    function optReorder(orderedIds) {
        var byId = {};
        model.items.forEach(function (it) {
            if (it.state === 'pending') {
                byId[it.id] = it;
            }
        });
        var queue = [],
            used = {};
        orderedIds.forEach(function (id) {
            if (byId[id] && !used[id]) {
                queue.push(byId[id]);
                used[id] = true;
            }
        });
        model.items.forEach(function (it) {
            if (it.state === 'pending' && !used[it.id]) {
                queue.push(it);
            }
        });
        model.items = model.items.map(function (it) {
            return it.state === 'pending' ? queue.shift() : it;
        });
    }

    function moveBy(id, dir) {
        var ids = pendingIds(),
            idx = ids.indexOf(id),
            swap = idx + dir;
        if (idx === -1 || swap < 0 || swap >= ids.length) {
            return;
        }
        var tmp = ids[idx];
        ids[idx] = ids[swap];
        ids[swap] = tmp;
        doAction(function () {
            optReorder(ids);
        }, ['reorder'].concat(ids));
    }

    /* ---- rendering ---- */

    function highlightClass(item) {
        if (item.state === 'active') {
            return 'teq-active';
        }
        if (item.state === 'expired') {
            return settings.highlightStyle === 'none' ? '' : 'teq-hl-' + settings.highlightStyle;
        }
        return '';
    }

    function iconBtn(cssClass, icon, label, handler) {
        var $btn = $('<button/>', {
            'type': 'button',
            'class': 'btn btn-xs teq-no-drag ' + cssClass,
            'style': 'margin-right: 4px;'
        }).append($('<i/>', {'class': 'fa ' + icon }));
        if (label) {
            $btn.append(' ' + label);
        }
        if (!writable) {
            $btn.prop('disabled', true).attr('title', 'Read-only panel user (no changes allowed).');
        } else {
            $btn.on('click', handler);
        }
        return $btn;
    }

    function timeText(item) {
        if (item.state === 'expired') {
            return 'TIME UP';
        }
        if (item.state === 'active') {
            return formatClock(remainingSeconds(item)) + (item.paused ? ' (paused)' : '');
        }
        return formatClock(item.timeLeft);
    }

    function buildRow(item, index, topPid, anyActive) {
        var $tr = $('<tr/>', {'id': 'teq-row-' + item.id, 'data-id': item.id});
        var hl = highlightClass(item);
        if (hl) {
            $tr.addClass(hl);
        }
        if (item.state === 'pending') {
            $tr.addClass('teq-pending');
        }

        // # / drag handle
        var $first = $('<td/>');
        if (item.state === 'pending') {
            $first.append($('<i/>', {'class': 'fa fa-bars teq-drag-handle', 'title': 'Drag to reorder'}));
        }
        $first.append(document.createTextNode(index + 1));
        $tr.append($first);

        $tr.append($('<td/>').text(item.sender));
        $tr.append($('<td/>', {'class': 'teq-content'}).text(item.content));
        $tr.append($('<td/>').text(formatWhen(item.sentDate)));

        var $time = $('<td/>', {'class': 'teq-remaining', 'id': 'teq-remaining-' + item.id}).text(timeText(item));
        if (item.state === 'active' && !item.paused) {
            var rem = remainingSeconds(item);
            if (settings.warnThreshold > 0 && rem > 0 && rem <= settings.warnThreshold) {
                $time.addClass('teq-warn');
            }
        }
        $tr.append($time);

        var $actions = $('<td/>');
        if (item.state === 'pending') {
            $actions.append(iconBtn('btn-default teq-reorder-btn', 'fa-chevron-up', '', function () {
                moveBy(item.id, -1);
            }));
            $actions.append(iconBtn('btn-default teq-reorder-btn', 'fa-chevron-down', '', function () {
                moveBy(item.id, 1);
            }));
            if (item.id === topPid && !anyActive) {
                $actions.append(iconBtn('btn-success', 'fa-check', 'Accept', function () {
                    doAction(function () { optAccept(item.id); }, ['accept', item.id]);
                }));
            }
            $actions.append(iconBtn('btn-danger', 'fa-times', 'Reject', function () {
                doAction(function () { optRemove(item.id); }, ['reject', item.id]);
            }));
        } else {
            // active or expired
            $actions.append(iconBtn('btn-default', 'fa-minus', '30s', function () {
                doAction(function () { optAddTime(-30); }, ['addtime', '-30']);
            }));
            $actions.append(iconBtn('btn-default', 'fa-plus', '30s', function () {
                doAction(function () { optAddTime(30); }, ['addtime', '30']);
            }));
            if (item.paused) {
                $actions.append(iconBtn('btn-warning', 'fa-play', 'Resume', function () {
                    doAction(optResume, ['resume']);
                }));
            } else {
                $actions.append(iconBtn('btn-warning', 'fa-pause', 'Pause', function () {
                    doAction(optPause, ['pause']);
                }));
            }
            $actions.append(iconBtn('btn-primary', 'fa-flag-checkered', 'Complete', function () {
                doAction(function () { optRemove(item.id); }, ['complete', item.id]);
            }));
        }
        $tr.append($actions);

        return $tr;
    }

    function renderAccepting() {
        var $badge = $('#teq-accepting-badge'),
            $toggle = $('#teq-accepting-toggle');
        if (model.accepting) {
            $badge.text('Accepting').removeClass('label-danger').addClass('label-success');
        } else {
            $badge.text('Closed').removeClass('label-success').addClass('label-danger');
        }
        if ($toggle.length && $toggle.prop('checked') !== !!model.accepting) {
            $toggle.prop('checked', !!model.accepting);
        }
    }

    function renderHistory() {
        var $body = $('#teq-history-body');
        if ($body.length === 0) {
            return;
        }
        $body.empty();
        if (!model.history || model.history.length === 0) {
            $body.append($('<tr/>').append($('<td/>', {
                'colspan': '4', 'class': 'text-center text-muted', 'style': 'padding: 14px;'
            }).text('No history yet.')));
            return;
        }
        model.history.forEach(function (h) {
            var $tr = $('<tr/>');
            $tr.append($('<td/>').append($('<span/>', {
                'class': h.outcome === 'completed' ? 'teq-history-completed' : 'teq-history-rejected'
            }).text(h.outcome === 'completed' ? 'Completed' : 'Rejected')));
            $tr.append($('<td/>').text(h.sender));
            $tr.append($('<td/>', {'class': 'teq-content'}).text(h.content));
            $tr.append($('<td/>').text(formatWhen(h.at)));
            $body.append($tr);
        });
    }

    function initSortable() {
        var $body = $('#teq-table-body');
        if (typeof $body.sortable !== 'function') {
            return;
        }
        if ($body.hasClass('ui-sortable')) {
            $body.sortable('destroy');
        }
        if (!writable) {
            return; // read-only users can't reorder
        }

        var reordered = false;

        $body.sortable({
            items: 'tr.teq-pending',
            handle: '.teq-drag-handle',
            cancel: 'button, a, .teq-no-drag',
            axis: 'y',
            containment: 'parent',
            helper: function (e, tr) {
                var $originals = tr.children(),
                    $helper = tr.clone();
                $helper.children().each(function (i) {
                    $(this).width($originals.eq(i).width());
                });
                return $helper;
            },
            start: function () {
                dragging = true;
                reordered = false;
            },
            update: function () {
                // The DOM already reflects the new row order; update the model + notify the
                // engine here, but defer the re-render to stop() so we don't destroy this
                // sortable mid-event.
                if (!canWrite()) {
                    fetchSnapshot(); // read-only: revert to server truth
                    return;
                }
                var ids = [];
                $body.children('tr.teq-pending').each(function () {
                    ids.push($(this).attr('data-id'));
                });
                optReorder(ids);
                send(['reorder'].concat(ids));
                reordered = true;
            },
            stop: function () {
                dragging = false;
                if (reordered) {
                    reordered = false;
                    // Re-render once the drag has fully settled so the position numbers and the
                    // Accept button move to the new top row (optimistic, like the up/down buttons).
                    // Deferred via setTimeout(0) so render()'s sortable teardown doesn't run
                    // inside this sortable's own stop handler.
                    helpers.setTimeout(render, 0);
                }
            }
        });
    }

    function render() {
        renderAccepting();
        renderHistory();

        var $body = $('#teq-table-body');
        if ($body.length === 0) {
            return; // navigated away
        }
        $body.empty();

        $('#teq-count').text(model.items.length + (model.items.length === 1 ? ' item' : ' items'));

        if (model.items.length === 0) {
            $body.append($('<tr/>', {'id': 'teq-empty-row'}).append(
                $('<td/>', {'colspan': '6', 'class': 'text-center text-muted', 'style': 'padding: 18px;'})
                    .text('The queue is empty.')
            ));
            return;
        }

        // top pending id + active presence
        var topPid = null,
            anyActive = false;
        model.items.forEach(function (it) {
            if (topPid === null && it.state === 'pending') {
                topPid = it.id;
            }
            if (it.state === 'active' || it.state === 'expired') {
                anyActive = true;
            }
        });

        // drop alert flags for ids that are gone
        var present = {};
        model.items.forEach(function (it) {
            present[it.id] = true;
        });
        Object.keys(alerted).forEach(function (id) {
            if (!present[id]) {
                delete alerted[id];
            }
        });

        model.items.forEach(function (item, index) {
            $body.append(buildRow(item, index, topPid, anyActive));
            if (item.state === 'expired' && !alerted[item.id]) {
                alerted[item.id] = true;
                beep();
            }
        });

        initSortable();
    }

    /* per-second local countdown for the active item + client-side expiry detection */
    function tick() {
        for (var i = 0; i < model.items.length; i++) {
            var item = model.items[i];
            if (item.state !== 'active' || item.paused) {
                continue;
            }
            var rem = remainingSeconds(item),
                $cell = $('#teq-remaining-' + item.id);
            if ($cell.length === 0) {
                continue;
            }
            if (rem <= 0) {
                $cell.text('TIME UP').removeClass('teq-warn');
                var $row = $('#teq-row-' + item.id).removeClass('teq-active');
                var hl = settings.highlightStyle === 'none' ? '' : 'teq-hl-' + settings.highlightStyle;
                if (hl) {
                    $row.addClass(hl);
                }
                if (!alerted[item.id]) {
                    alerted[item.id] = true;
                    beep();
                }
            } else {
                $cell.text(formatClock(rem));
                if (settings.warnThreshold > 0 && rem <= settings.warnThreshold) {
                    $cell.addClass('teq-warn');
                } else {
                    $cell.removeClass('teq-warn');
                }
            }
        }
    }

    /* ---- data ---- */

    function fetchSnapshot() {
        if (dragging || Date.now() < suppressUntil) {
            return; // keep the optimistic model until the drag / in-flight action settles
        }
        socket.getDBValue('teq_snapshot', 'timedEventQueue', 'snapshot', function (e) {
            if (dragging || Date.now() < suppressUntil) {
                return;
            }
            var raw = e ? e.timedEventQueue : null,
                obj = null;
            if (raw !== undefined && raw !== null && raw !== '') {
                try {
                    obj = JSON.parse(raw);
                } catch (ex) {
                    obj = null;
                }
            }
            if (obj && obj.items !== undefined) {
                model = {
                    accepting: obj.accepting !== false,
                    items: Array.isArray(obj.items) ? obj.items : [],
                    history: Array.isArray(obj.history) ? obj.history : []
                };
            } else {
                model = { accepting: true, items: [], history: [] };
            }
            render();
        });
    }

    /* ---- settings ---- */

    function applySettingsToForm() {
        $('#teq-set-highlight').val(settings.highlightStyle);
        $('#teq-set-sound-enabled').val(settings.soundEnabled ? 'true' : 'false');
        $('#teq-set-tone').val(settings.soundTone);
        $('#teq-set-volume').val(settings.soundVolume);
        $('#teq-set-warn').val(settings.warnThreshold);
    }

    function loadSettings() {
        socket.getDBValues('teq_settings', {
            tables: [SETTINGS_TABLE, SETTINGS_TABLE, SETTINGS_TABLE, SETTINGS_TABLE, SETTINGS_TABLE],
            keys: ['highlightStyle', 'soundEnabled', 'soundVolume', 'soundTone', 'warnThreshold']
        }, true, function (e) {
            if (e.highlightStyle) {
                settings.highlightStyle = String(e.highlightStyle);
            }
            if (e.soundEnabled !== undefined && e.soundEnabled !== null) {
                settings.soundEnabled = helpers.isTrue(e.soundEnabled);
            }
            if (e.soundVolume !== undefined && e.soundVolume !== null && e.soundVolume !== '') {
                settings.soundVolume = Number(e.soundVolume);
            }
            if (e.soundTone) {
                settings.soundTone = String(e.soundTone);
            }
            if (e.warnThreshold !== undefined && e.warnThreshold !== null && e.warnThreshold !== '') {
                settings.warnThreshold = Number(e.warnThreshold);
            }
            applySettingsToForm();
        });
    }

    function saveSettings() {
        if (!canWrite()) {
            return;
        }
        var highlightStyle = $('#teq-set-highlight').val(),
            soundEnabled = $('#teq-set-sound-enabled').val() === 'true',
            soundTone = $('#teq-set-tone').val(),
            soundVolume = Math.max(0, Math.min(100, Number($('#teq-set-volume').val()) || 0)),
            warnThreshold = Math.max(0, Number($('#teq-set-warn').val()) || 0);

        settings.highlightStyle = highlightStyle;
        settings.soundEnabled = soundEnabled;
        settings.soundTone = soundTone;
        settings.soundVolume = soundVolume;
        settings.warnThreshold = warnThreshold;

        socket.updateDBValues('teq_settings_save', {
            tables: [SETTINGS_TABLE, SETTINGS_TABLE, SETTINGS_TABLE, SETTINGS_TABLE, SETTINGS_TABLE],
            keys: ['highlightStyle', 'soundEnabled', 'soundVolume', 'soundTone', 'warnThreshold'],
            values: [highlightStyle, soundEnabled, soundVolume, soundTone, warnThreshold]
        }, function () {
            toastr.success('Saved timed event queue settings.');
            render();
        });
    }

    /* ---- wire up ---- */

    // AdminLTE's box-collapse widget isn't initialized for dynamically-loaded panel pages
    // here, so wire the +/- collapse buttons manually (AdminLTE CSS hides .collapsed-box bodies).
    $('.box [data-widget="collapse"]').on('click', function (e) {
        e.preventDefault();
        var $box = $(this).closest('.box');
        $box.toggleClass('collapsed-box');
        var collapsed = $box.hasClass('collapsed-box');
        $(this).find('i').removeClass('fa-plus fa-minus').addClass(collapsed ? 'fa-plus' : 'fa-minus');
        $(this).attr('title', collapsed ? 'Expand' : 'Collapse');
    });

    $('#teq-set-save').on('click', saveSettings);
    $('#teq-set-test').on('click', function () {
        resumeAudio();
        settings.soundEnabled = true;
        settings.soundTone = $('#teq-set-tone').val();
        settings.soundVolume = Math.max(0, Math.min(100, Number($('#teq-set-volume').val()) || 0));
        beep();
    });
    $('#teq-accepting-toggle').on('change', function () {
        if (!canWrite()) {
            $(this).prop('checked', !!model.accepting); // revert
            return;
        }
        var on = $(this).prop('checked');
        model.accepting = on;
        renderAccepting();
        send(['accepting', on ? '1' : '0']);
    });

    // Initial load + pollers (helpers.setInterval is auto-cleared on panel navigation).
    applyWritable();
    loadSettings();
    fetchSnapshot();
    helpers.setInterval(fetchSnapshot, 2000);
    helpers.setInterval(tick, 1000);
});
