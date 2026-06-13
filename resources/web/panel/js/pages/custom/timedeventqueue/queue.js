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
 * mirrors to the 'timedEventQueue' DataStore table, renders the live list, ticks the
 * active item's countdown locally, highlights + beeps when it expires, and sends
 * accept/reject/complete back to ./custom/timedEventQueue/timedEventQueueSystem.js.
 */
$(function () {
    var SCRIPT = './custom/timedEventQueue/timedEventQueueSystem.js',
        SECTION = 'extra',
        latest = [],        // most recent snapshot (array of items)
        alerted = {},       // item ids we've already beeped for
        audioCtx = null;

    /*
     * Panel-user write gate. Falls back to allow when the custom-panel namespace is
     * unavailable (e.g. older panel build) so the page stays usable.
     */
    function canWrite() {
        var ns = window.__pbCustomPanel__;
        if (ns && typeof ns.requirePanelSectionWrite === 'function') {
            return ns.requirePanelSectionWrite(SECTION);
        }
        return true;
    }

    /* ---- expiry sound (WebAudio beep; no binary asset needed) ---- */

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

    function beep() {
        var ctx = ensureAudio();
        if (!ctx) {
            return;
        }
        try {
            if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
                ctx.resume();
            }
            var o = ctx.createOscillator(),
                g = ctx.createGain(),
                t = ctx.currentTime;
            o.type = 'sine';
            o.frequency.value = 880;
            o.connect(g);
            g.connect(ctx.destination);
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
            o.start(t);
            o.stop(t + 0.6);
        } catch (e) {
            // Autoplay policy may block until a user gesture; the visual pulse still fires.
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

    function formatSent(epochMs) {
        if (!epochMs) {
            return '';
        }
        try {
            return new Date(epochMs).toLocaleTimeString();
        } catch (e) {
            return '';
        }
    }

    /* remaining seconds for an active item, derived from its absolute expiresAt */
    function remainingSeconds(item) {
        if (item.expiresAt == null) {
            return item.timeLeft;
        }
        return Math.max(0, Math.round((item.expiresAt - Date.now()) / 1000));
    }

    /* ---- actions ---- */

    function sendAction(action, id) {
        if (!canWrite()) {
            return;
        }
        resumeAudio(); // this click is a user gesture: unblock the beep for later
        socket.wsEvent('teq_action_' + action, SCRIPT, '', [action, id], function () {
            // Refresh promptly so the streamer sees the result without waiting for the poll.
            fetchSnapshot();
        }, false);
    }

    /* ---- rendering ---- */

    function topPendingId() {
        for (var i = 0; i < latest.length; i++) {
            if (latest[i].state === 'pending') {
                return latest[i].id;
            }
        }
        return null;
    }

    function hasActiveItem() {
        for (var i = 0; i < latest.length; i++) {
            if (latest[i].state === 'active' || latest[i].state === 'expired') {
                return true;
            }
        }
        return false;
    }

    function actionButton(label, cssClass, icon, action, id) {
        var $btn = $('<button/>', {
            'type': 'button',
            'class': 'btn btn-xs ' + cssClass,
            'style': 'margin-right: 4px;'
        }).append($('<i/>', {'class': 'fa ' + icon})).append(' ' + label);
        $btn.on('click', function () {
            sendAction(action, id);
        });
        return $btn;
    }

    function buildRow(item, index, topPid, anyActive) {
        var $tr = $('<tr/>', {'id': 'teq-row-' + item.id});
        if (item.state === 'active') {
            $tr.addClass('teq-active');
        } else if (item.state === 'expired') {
            $tr.addClass('teq-expired');
        }

        $tr.append($('<td/>').text(index + 1));
        $tr.append($('<td/>').text(item.sender));
        $tr.append($('<td/>', {'class': 'teq-content'}).text(item.content));
        $tr.append($('<td/>').text(formatSent(item.sentDate)));

        // Time-left cell (updated each second by tick() for the active item)
        var timeText;
        if (item.state === 'expired') {
            timeText = 'TIME UP';
        } else if (item.state === 'active') {
            timeText = formatClock(remainingSeconds(item));
        } else {
            timeText = formatClock(item.timeLeft);
        }
        $tr.append($('<td/>', {'class': 'teq-remaining', 'id': 'teq-remaining-' + item.id}).text(timeText));

        // Actions
        var $actions = $('<td/>');
        if (item.state === 'pending') {
            if (item.id === topPid && !anyActive) {
                $actions.append(actionButton('Accept', 'btn-success', 'fa-check', 'accept', item.id));
            }
            $actions.append(actionButton('Reject', 'btn-danger', 'fa-times', 'reject', item.id));
        } else {
            // active or expired
            $actions.append(actionButton('Complete', 'btn-primary', 'fa-flag-checkered', 'complete', item.id));
        }
        $tr.append($actions);

        return $tr;
    }

    function render() {
        var $body = $('#teq-table-body');
        if ($body.length === 0) {
            return; // navigated away
        }
        $body.empty();

        $('#teq-count').text(latest.length + (latest.length === 1 ? ' item' : ' items'));

        if (latest.length === 0) {
            $body.append($('<tr/>', {'id': 'teq-empty-row'}).append(
                $('<td/>', {
                    'colspan': '6',
                    'class': 'text-center text-muted',
                    'style': 'padding: 18px;'
                }).text('The queue is empty.')
            ));
            return;
        }

        var topPid = topPendingId(),
            anyActive = hasActiveItem();

        // Drop alert flags for ids that are gone.
        var present = {};
        latest.forEach(function (it) {
            present[it.id] = true;
        });
        Object.keys(alerted).forEach(function (id) {
            if (!present[id]) {
                delete alerted[id];
            }
        });

        latest.forEach(function (item, index) {
            $body.append(buildRow(item, index, topPid, anyActive));
            // If the snapshot already reports expiry, alert once.
            if (item.state === 'expired' && !alerted[item.id]) {
                alerted[item.id] = true;
                beep();
            }
        });
    }

    /* Per-second local countdown for the active item + client-side expiry detection. */
    function tick() {
        for (var i = 0; i < latest.length; i++) {
            var item = latest[i];
            if (item.state !== 'active') {
                continue;
            }
            var rem = remainingSeconds(item),
                $cell = $('#teq-remaining-' + item.id);
            if ($cell.length === 0) {
                continue;
            }
            if (rem <= 0) {
                $cell.text('TIME UP');
                $('#teq-row-' + item.id).removeClass('teq-active').addClass('teq-expired');
                if (!alerted[item.id]) {
                    alerted[item.id] = true;
                    beep();
                }
            } else {
                $cell.text(formatClock(rem));
            }
        }
    }

    /* ---- data ---- */

    function fetchSnapshot() {
        socket.getDBValue('teq_snapshot', 'timedEventQueue', 'snapshot', function (e) {
            var raw = e ? e.timedEventQueue : null,
                arr = [];
            if (raw !== undefined && raw !== null && raw !== '') {
                try {
                    arr = JSON.parse(raw);
                } catch (ex) {
                    arr = [];
                }
            }
            latest = Array.isArray(arr) ? arr : [];
            render();
        });
    }

    // Initial load + pollers (helpers.setInterval is auto-cleared on panel navigation).
    fetchSnapshot();
    helpers.setInterval(fetchSnapshot, 2000);
    helpers.setInterval(tick, 1000);
});
