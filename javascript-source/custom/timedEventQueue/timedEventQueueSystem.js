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

/* global Packages */

/**
 * timedEventQueueSystem.js
 *
 * A generic, in-memory timed event queue. Other modules push items in via
 * $.timedEventQueue.add(...); the streamer drives accept/reject/complete/reorder and the
 * active item's timer from the web panel (Timed Event Queue page) or the !teq command.
 *
 * Each item carries a sender, content string, sent-timestamp, and a countdown budget
 * ("time left", seconds), plus optional onAccept/onReject/onComplete callbacks.
 *
 * Lifecycle: pending --accept--> active (timer ticking) --timer 0--> expired
 *            --complete--> (removed, onComplete) ; or --reject--> (removed, onReject).
 * Only ONE item may be active/counting down at a time. The active item can be paused and
 * have time added/removed while it runs.
 *
 * Callbacks are live JS functions and cannot be persisted, so the queue is in-memory
 * only: on a bot restart it starts empty and consumers re-add. A callback-stripped JSON
 * snapshot ({ accepting, items, history }) is mirrored to the 'timedEventQueue' DataStore
 * table purely so the panel can render the live list, countdown, and history.
 */
(function () {
    var items = [],                                                         // ordered queue, oldest first
        activeId = null,                                                    // id of the currently counting-down item, or null
        accepting = true,                                                   // global "accept new items" override
        history = [],                                                       // recent completed/rejected items, newest first
        seq = 0,                                                            // monotonic id source
        _timerId = null,                                                    // JSTimers id of the active countdown
        _lock = new Packages.java.util.concurrent.locks.ReentrantLock(),
        SCRIPT = './custom/timedEventQueue/timedEventQueueSystem.js',
        TABLE = 'timedEventQueue',                                          // snapshot + history live here
        SETTINGS = 'timedEventQueueSettings',                              // panel-shared settings (accepting, display prefs)
        HISTORY_CAP = 20;

    /*
     * The helpers below that read/write `items`, `activeId`, `_timerId`, `accepting`, or
     * `history` must be called while holding `_lock`. Consumer callbacks are always invoked
     * AFTER the lock is released (see fire()).
     */

    /*
     * @function indexById
     * @param {String} id
     * @return {Number} index in `items`, or -1
     */
    function indexById(id) {
        var sid = String(id);
        for (var i = 0; i < items.length; i++) {
            if (String(items[i].id) === sid) {
                return i;
            }
        }
        return -1;
    }

    /*
     * @function topPendingIndex
     * @return {Number} index of the oldest pending item, or -1
     */
    function topPendingIndex() {
        for (var i = 0; i < items.length; i++) {
            if (items[i].state === 'pending') {
                return i;
            }
        }
        return -1;
    }

    /*
     * @function clearActiveTimer
     */
    function clearActiveTimer() {
        if (_timerId !== null) {
            clearTimeout(_timerId);
            _timerId = null;
        }
    }

    /*
     * @function scheduleActiveTimer
     * @param {String} id
     * @param {Number} ms milliseconds until expiry
     */
    function scheduleActiveTimer(id, ms) {
        clearActiveTimer();
        _timerId = setTimeout(function () {
            onTimerExpired(id);
        }, Math.max(0, ms), 'teq-timer-' + id);
    }

    /*
     * @function mirror
     *
     * Writes the callback-stripped snapshot object to the DataStore for the panel. Active
     * items carry an absolute `expiresAt` so the panel can tick the countdown locally;
     * paused items carry the frozen `remainingMs`. Must hold `_lock`.
     */
    function mirror() {
        var view = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            view.push({
                id: it.id,
                sender: it.sender,
                content: it.content,
                sentDate: it.sentDate,
                timeLeft: it.timeLeft,
                state: it.state,
                acceptedAt: it.acceptedAt,
                expiresAt: it.expiresAt,
                paused: it.paused,
                remainingMs: it.remainingMs
            });
        }
        $.inidb.set(TABLE, 'snapshot', JSON.stringify({
            accepting: accepting,
            items: view,
            history: history
        }));
    }

    /*
     * @function publicView
     * @param {Object} it
     * @return {Object} the item without its callbacks (safe to hand to consumers / return)
     */
    function publicView(it) {
        return {
            id: it.id,
            sender: it.sender,
            content: it.content,
            sentDate: it.sentDate,
            timeLeft: it.timeLeft,
            state: it.state,
            acceptedAt: it.acceptedAt,
            expiresAt: it.expiresAt,
            paused: it.paused,
            remainingMs: it.remainingMs
        };
    }

    /*
     * @function pushHistory
     * @param {String} outcome 'completed' or 'rejected'
     * @param {Object} it
     */
    function pushHistory(outcome, it) {
        history.unshift({
            sender: it.sender,
            content: it.content,
            outcome: outcome,
            at: $.systemTime()
        });
        if (history.length > HISTORY_CAP) {
            history = history.slice(0, HISTORY_CAP);
        }
        $.inidb.set(TABLE, 'history', JSON.stringify(history));
    }

    /*
     * @function fire
     *
     * Invokes a consumer callback outside the lock, swallowing errors so a buggy
     * consumer can never wedge the queue.
     *
     * @param {Function} fn
     * @param {Object} view
     */
    function fire(fn, view) {
        if (typeof fn !== 'function') {
            return;
        }
        try {
            fn(view);
        } catch (ex) {
            $.log.error('[timedEventQueue] callback threw: ' + ex);
        }
    }

    /*
     * @function onTimerExpired
     *
     * Fired by the countdown timer. Flips the active item to 'expired' (it still needs a
     * manual complete) and re-mirrors so the panel highlights it.
     *
     * @param {String} id
     */
    function onTimerExpired(id) {
        _lock.lock();
        try {
            var idx = indexById(id);
            if (idx === -1 || items[idx].state !== 'active') {
                return;
            }
            items[idx].state = 'expired';
            items[idx].remainingMs = 0;
            _timerId = null;
            mirror();
        } finally {
            _lock.unlock();
        }
    }

    /*
     * @function add
     *
     * Appends a new pending item. This is the seam the (future) submission mechanism calls.
     * Returns null and does nothing when the global "accepting" override is off.
     *
     * @param {Object} opts {sender, content, sentDate?, timeLeft, onAccept?, onReject?, onComplete?}
     * @return {String} the new item id, or null if rejected
     */
    function add(opts) {
        if (opts === undefined || opts === null) {
            return null;
        }
        var timeLeft = parseInt(opts.timeLeft, 10);
        if (isNaN(timeLeft) || timeLeft <= 0) {
            $.log.error('[timedEventQueue] add() rejected: timeLeft must be a positive number of seconds');
            return null;
        }
        var id;
        _lock.lock();
        try {
            if (!accepting) {
                return null;
            }
            id = 'teq_' + (++seq);
            items.push({
                id: id,
                sender: (opts.sender === undefined ? '' : String(opts.sender)),
                content: (opts.content === undefined ? '' : String(opts.content)),
                sentDate: (opts.sentDate === undefined ? $.systemTime() : parseInt(opts.sentDate, 10)),
                timeLeft: timeLeft,
                state: 'pending',
                acceptedAt: null,
                expiresAt: null,
                paused: false,
                remainingMs: timeLeft * 1000,
                onAccept: opts.onAccept,
                onReject: opts.onReject,
                onComplete: opts.onComplete
            });
            mirror();
        } finally {
            _lock.unlock();
        }
        return id;
    }

    /*
     * @function accept
     *
     * Accepts an item (default: the oldest pending) and starts its countdown. No-ops and
     * returns false if another item is already active (one-at-a-time) or the target is not
     * pending. Invokes onAccept.
     *
     * @param {String} id (optional)
     * @return {Boolean}
     */
    function accept(id) {
        var cb = null, view = null, ok = false;
        _lock.lock();
        try {
            if (activeId !== null) {
                return false;
            }
            var idx = (id === undefined || id === null ? topPendingIndex() : indexById(id));
            if (idx === -1 || items[idx].state !== 'pending') {
                return false;
            }
            var it = items[idx],
                now = $.systemTime();
            it.state = 'active';
            it.acceptedAt = now;
            it.expiresAt = now + (it.timeLeft * 1000);
            it.paused = false;
            it.remainingMs = it.timeLeft * 1000;
            activeId = it.id;
            scheduleActiveTimer(it.id, it.remainingMs);
            cb = it.onAccept;
            view = publicView(it);
            ok = true;
            mirror();
        } finally {
            _lock.unlock();
        }
        if (ok) {
            fire(cb, view);
        }
        return ok;
    }

    /*
     * @function reject
     *
     * Removes an item (default: the oldest pending) without completing it. Records it in
     * history and invokes onReject.
     *
     * @param {String} id (optional)
     * @return {Boolean}
     */
    function reject(id) {
        var cb = null, view = null, ok = false;
        _lock.lock();
        try {
            var idx = (id === undefined || id === null ? topPendingIndex() : indexById(id));
            if (idx === -1) {
                return false;
            }
            var it = items[idx];
            if (it.id === activeId) {
                clearActiveTimer();
                activeId = null;
            }
            cb = it.onReject;
            view = publicView(it);
            pushHistory('rejected', it);
            items.splice(idx, 1);
            ok = true;
            mirror();
        } finally {
            _lock.unlock();
        }
        if (ok) {
            fire(cb, view);
        }
        return ok;
    }

    /*
     * @function complete
     *
     * Completes an item (default: the active one). Allowed while active or expired. Records
     * it in history, invokes onComplete, and removes it, freeing the active slot.
     *
     * @param {String} id (optional)
     * @return {Boolean}
     */
    function complete(id) {
        var cb = null, view = null, ok = false;
        _lock.lock();
        try {
            var idx = (id === undefined || id === null ? (activeId === null ? -1 : indexById(activeId)) : indexById(id));
            if (idx === -1) {
                return false;
            }
            var it = items[idx];
            if (it.state !== 'active' && it.state !== 'expired') {
                return false;
            }
            if (it.id === activeId) {
                clearActiveTimer();
                activeId = null;
            }
            cb = it.onComplete;
            view = publicView(it);
            pushHistory('completed', it);
            items.splice(idx, 1);
            ok = true;
            mirror();
        } finally {
            _lock.unlock();
        }
        if (ok) {
            fire(cb, view);
        }
        return ok;
    }

    /*
     * @function remove
     *
     * Removes an item by id with NO callback and NO history entry (administrative drop).
     *
     * @param {String} id
     * @return {Boolean}
     */
    function remove(id) {
        var ok = false;
        _lock.lock();
        try {
            var idx = indexById(id);
            if (idx === -1) {
                return false;
            }
            if (items[idx].id === activeId) {
                clearActiveTimer();
                activeId = null;
            }
            items.splice(idx, 1);
            ok = true;
            mirror();
        } finally {
            _lock.unlock();
        }
        return ok;
    }

    /*
     * @function reorder
     *
     * Reorders the PENDING items to match the given id order. Active/expired items keep
     * their positions; unknown ids are ignored; any pending item omitted from the list is
     * appended (preserving its prior relative order). No-op effect on the active timer.
     *
     * @param {Array} orderedIds desired order of pending item ids
     */
    function reorder(orderedIds) {
        _lock.lock();
        try {
            var pendingById = {},
                i;
            for (i = 0; i < items.length; i++) {
                if (items[i].state === 'pending') {
                    pendingById[String(items[i].id)] = items[i];
                }
            }

            var ordered = [],
                used = {};
            if (orderedIds) {
                for (i = 0; i < orderedIds.length; i++) {
                    var key = String(orderedIds[i]);
                    if (pendingById[key] !== undefined && used[key] === undefined) {
                        ordered.push(pendingById[key]);
                        used[key] = true;
                    }
                }
            }
            // Append any pending items not named in orderedIds, in their original order.
            for (i = 0; i < items.length; i++) {
                if (items[i].state === 'pending' && used[String(items[i].id)] === undefined) {
                    ordered.push(items[i]);
                }
            }

            // Rebuild: non-pending slots stay put; pending slots are filled in the new order.
            var q = ordered.slice(),
                rebuilt = [];
            for (i = 0; i < items.length; i++) {
                rebuilt.push(items[i].state === 'pending' ? q.shift() : items[i]);
            }
            items = rebuilt;
            mirror();
        } finally {
            _lock.unlock();
        }
    }

    /*
     * @function addTime
     *
     * Adds (or, with a negative value, subtracts) seconds on the active item's countdown.
     * Driving the timer below zero expires it immediately; adding time to an expired item
     * brings it back to active.
     *
     * @param {Number} deltaSeconds may be negative
     * @return {Boolean}
     */
    function addTime(deltaSeconds) {
        var delta = parseInt(deltaSeconds, 10);
        if (isNaN(delta)) {
            return false;
        }
        _lock.lock();
        try {
            if (activeId === null) {
                return false;
            }
            var idx = indexById(activeId);
            if (idx === -1) {
                return false;
            }
            var it = items[idx],
                now = $.systemTime();

            if (it.paused) {
                it.remainingMs = Math.max(0, it.remainingMs + (delta * 1000));
                it.state = (it.remainingMs > 0 ? 'active' : 'expired');
            } else {
                var newRemaining = Math.max(0, (it.expiresAt - now) + (delta * 1000));
                it.remainingMs = newRemaining;
                if (newRemaining <= 0) {
                    it.expiresAt = now;
                    it.state = 'expired';
                    clearActiveTimer();
                } else {
                    it.expiresAt = now + newRemaining;
                    it.state = 'active';
                    scheduleActiveTimer(it.id, newRemaining);
                }
            }
            mirror();
            return true;
        } finally {
            _lock.unlock();
        }
    }

    /*
     * @function pause
     *
     * Freezes the active item's countdown (no expiry fires while paused).
     *
     * @return {Boolean}
     */
    function pause() {
        _lock.lock();
        try {
            if (activeId === null) {
                return false;
            }
            var idx = indexById(activeId);
            if (idx === -1) {
                return false;
            }
            var it = items[idx];
            if (it.paused || it.state !== 'active') {
                return false;
            }
            it.remainingMs = Math.max(0, it.expiresAt - $.systemTime());
            it.paused = true;
            clearActiveTimer();
            mirror();
            return true;
        } finally {
            _lock.unlock();
        }
    }

    /*
     * @function resume
     *
     * Resumes a paused active item from its frozen remaining time.
     *
     * @return {Boolean}
     */
    function resume() {
        _lock.lock();
        try {
            if (activeId === null) {
                return false;
            }
            var idx = indexById(activeId);
            if (idx === -1) {
                return false;
            }
            var it = items[idx];
            if (!it.paused) {
                return false;
            }
            var now = $.systemTime();
            it.paused = false;
            if (it.remainingMs <= 0) {
                it.expiresAt = now;
                it.state = 'expired';
            } else {
                it.expiresAt = now + it.remainingMs;
                it.state = 'active';
                scheduleActiveTimer(it.id, it.remainingMs);
            }
            mirror();
            return true;
        } finally {
            _lock.unlock();
        }
    }

    /*
     * @function setAccepting
     *
     * Toggles the global "accept new items" override and persists it.
     *
     * @param {Boolean} value
     */
    function setAccepting(value) {
        _lock.lock();
        try {
            accepting = (value === true);
            $.setIniDbBoolean(SETTINGS, 'accepting', accepting);
            mirror();
        } finally {
            _lock.unlock();
        }
    }

    /*
     * @function isAccepting
     * @return {Boolean}
     */
    function isAccepting() {
        return accepting;
    }

    /*
     * @function clear
     *
     * Empties the queue and cancels any running timer (no callbacks fired). History is kept.
     */
    function clear() {
        _lock.lock();
        try {
            clearActiveTimer();
            activeId = null;
            items = [];
            mirror();
        } finally {
            _lock.unlock();
        }
    }

    /*
     * @function list
     * @return {Array} callback-stripped copy of the queue, oldest first
     */
    function list() {
        var out = [];
        _lock.lock();
        try {
            for (var i = 0; i < items.length; i++) {
                out.push(publicView(items[i]));
            }
        } finally {
            _lock.unlock();
        }
        return out;
    }

    /*
     * @function getActive
     * @return {Object} the active item (callback-stripped), or null
     */
    function getActive() {
        var view = null;
        _lock.lock();
        try {
            if (activeId !== null) {
                var idx = indexById(activeId);
                if (idx !== -1) {
                    view = publicView(items[idx]);
                }
            }
        } finally {
            _lock.unlock();
        }
        return view;
    }

    /*
     * @function getHistory
     * @return {Array} copy of the recent history, newest first
     */
    function getHistory() {
        _lock.lock();
        try {
            return history.slice();
        } finally {
            _lock.unlock();
        }
    }

    /*
     * @event command
     */
    $.bind('command', function (event) {
        var sender = event.getSender(),
            command = event.getCommand(),
            args = event.getArgs(),
            action = args[0];

        if (!$.equalsIgnoreCase(command, 'teq')) {
            return;
        }

        if (action === undefined) {
            $.say($.whisperPrefix(sender) + 'Usage: !teq [add / accept / reject / complete / list / clear / accepting / pause / resume / addtime]');
            return;
        }

        /*
         * @commandpath teq add [username] [seconds] [content...] - Adds a test item to the timed event queue.
         */
        if ($.equalsIgnoreCase(action, 'add')) {
            var user = args[1],
                seconds = parseInt(args[2], 10),
                content = args.slice(3).join(' ');
            if (user === undefined || isNaN(seconds) || seconds <= 0) {
                $.say($.whisperPrefix(sender) + 'Usage: !teq add [username] [seconds] [content...]');
                return;
            }
            var id = add({
                sender: user,
                content: content,
                timeLeft: seconds,
                onAccept: function (it) {
                    $.say('[TEQ] Accepted ' + it.sender + ' — timer started for ' + it.timeLeft + 's.');
                },
                onReject: function (it) {
                    $.say('[TEQ] Rejected ' + it.sender + '.');
                },
                onComplete: function (it) {
                    $.say('[TEQ] Completed ' + it.sender + '.');
                }
            });
            $.say($.whisperPrefix(sender) + (id === null ? 'Not accepting submissions right now.' : 'Added test item ' + id + '.'));
            return;
        }

        /*
         * @commandpath teq accept [id] - Accepts an item (default: top pending) and starts its timer.
         */
        if ($.equalsIgnoreCase(action, 'accept')) {
            $.say($.whisperPrefix(sender) + (accept(args[1]) ? 'Accepted.' : 'Nothing to accept (an item may already be active).'));
            return;
        }

        /*
         * @commandpath teq reject [id] - Rejects an item (default: top pending) and removes it.
         */
        if ($.equalsIgnoreCase(action, 'reject')) {
            $.say($.whisperPrefix(sender) + (reject(args[1]) ? 'Rejected.' : 'Nothing to reject.'));
            return;
        }

        /*
         * @commandpath teq complete [id] - Completes the active (or specified) item and removes it.
         */
        if ($.equalsIgnoreCase(action, 'complete')) {
            $.say($.whisperPrefix(sender) + (complete(args[1]) ? 'Completed.' : 'Nothing to complete.'));
            return;
        }

        /*
         * @commandpath teq accepting [on/off] - Toggles whether the queue accepts new items.
         */
        if ($.equalsIgnoreCase(action, 'accepting')) {
            if (args[1] === undefined) {
                $.say($.whisperPrefix(sender) + 'Accepting submissions: ' + (isAccepting() ? 'ON' : 'OFF'));
                return;
            }
            setAccepting($.equalsIgnoreCase(args[1], 'on') || $.equalsIgnoreCase(args[1], 'true') || $.jsString(args[1]) === '1');
            $.say($.whisperPrefix(sender) + 'Accepting submissions: ' + (isAccepting() ? 'ON' : 'OFF'));
            return;
        }

        /*
         * @commandpath teq pause - Pauses the active item's timer.
         */
        if ($.equalsIgnoreCase(action, 'pause')) {
            $.say($.whisperPrefix(sender) + (pause() ? 'Paused.' : 'Nothing to pause.'));
            return;
        }

        /*
         * @commandpath teq resume - Resumes the active item's timer.
         */
        if ($.equalsIgnoreCase(action, 'resume')) {
            $.say($.whisperPrefix(sender) + (resume() ? 'Resumed.' : 'Nothing to resume.'));
            return;
        }

        /*
         * @commandpath teq addtime [seconds] - Adds (or subtracts, if negative) seconds on the active item.
         */
        if ($.equalsIgnoreCase(action, 'addtime')) {
            $.say($.whisperPrefix(sender) + (addTime(args[1]) ? 'Adjusted timer.' : 'No active item / invalid amount.'));
            return;
        }

        /*
         * @commandpath teq list - Lists the current timed event queue.
         */
        if ($.equalsIgnoreCase(action, 'list')) {
            var q = list();
            if (q.length === 0) {
                $.say($.whisperPrefix(sender) + 'The timed event queue is empty.');
            } else {
                var parts = [];
                for (var i = 0; i < q.length && i < 10; i++) {
                    parts.push('#' + (i + 1) + ' ' + q[i].sender + ' [' + q[i].state + ']');
                }
                $.say($.whisperPrefix(sender) + parts.join(', '));
            }
            return;
        }

        /*
         * @commandpath teq clear - Clears the entire timed event queue.
         */
        if ($.equalsIgnoreCase(action, 'clear')) {
            clear();
            $.say($.whisperPrefix(sender) + 'Cleared the timed event queue.');
            return;
        }
    });

    /*
     * @event webPanelSocketUpdate
     */
    $.bind('webPanelSocketUpdate', function (event) {
        if (!$.equalsIgnoreCase(event.getScript(), SCRIPT)) {
            return;
        }
        var args = event.getArgs(),
            action = args[0],
            id = args[1];

        if ($.equalsIgnoreCase(action, 'accept')) {
            accept(id);
        } else if ($.equalsIgnoreCase(action, 'reject')) {
            reject(id);
        } else if ($.equalsIgnoreCase(action, 'complete')) {
            complete(id);
        } else if ($.equalsIgnoreCase(action, 'remove')) {
            remove(id);
        } else if ($.equalsIgnoreCase(action, 'clear')) {
            clear();
        } else if ($.equalsIgnoreCase(action, 'accepting')) {
            // args are Java strings; coerce before the strict compare.
            var acceptVal = $.jsString(id);
            setAccepting(acceptVal === '1' || $.equalsIgnoreCase(acceptVal, 'true') || $.equalsIgnoreCase(acceptVal, 'on'));
        } else if ($.equalsIgnoreCase(action, 'reorder')) {
            reorder(args.slice(1));
        } else if ($.equalsIgnoreCase(action, 'addtime')) {
            addTime(id);
        } else if ($.equalsIgnoreCase(action, 'pause')) {
            pause();
        } else if ($.equalsIgnoreCase(action, 'resume')) {
            resume();
        }
    });

    /*
     * @event initReady
     */
    $.bind('initReady', function () {
        $.registerChatCommand(SCRIPT, 'teq', $.PERMISSION.Mod);
        $.registerChatSubcommand('teq', 'add', $.PERMISSION.Mod);
        $.registerChatSubcommand('teq', 'accept', $.PERMISSION.Mod);
        $.registerChatSubcommand('teq', 'reject', $.PERMISSION.Mod);
        $.registerChatSubcommand('teq', 'complete', $.PERMISSION.Mod);
        $.registerChatSubcommand('teq', 'accepting', $.PERMISSION.Mod);
        $.registerChatSubcommand('teq', 'pause', $.PERMISSION.Mod);
        $.registerChatSubcommand('teq', 'resume', $.PERMISSION.Mod);
        $.registerChatSubcommand('teq', 'addtime', $.PERMISSION.Mod);
        $.registerChatSubcommand('teq', 'list', $.PERMISSION.Mod);
        $.registerChatSubcommand('teq', 'clear', $.PERMISSION.Mod);

        // Seed settings defaults so the panel's settings controls have values to read, and
        // load the persisted "accepting" override.
        accepting = $.getSetIniDbBoolean(SETTINGS, 'accepting', true);
        $.getSetIniDbString(SETTINGS, 'highlightStyle', 'pulse');
        $.getSetIniDbBoolean(SETTINGS, 'soundEnabled', true);
        $.getSetIniDbNumber(SETTINGS, 'soundVolume', 35);
        $.getSetIniDbString(SETTINGS, 'soundTone', 'beep');
        $.getSetIniDbNumber(SETTINGS, 'warnThreshold', 10);

        // Restore persisted history; the live queue itself is in-memory and starts empty.
        try {
            var rawHistory = $.getIniDbString(TABLE, 'history', '[]');
            var parsed = JSON.parse(rawHistory);
            history = (parsed && parsed.length !== undefined) ? parsed : [];
        } catch (ex) {
            history = [];
        }

        // The in-memory queue is empty on boot; clear stale items from a previous run's
        // snapshot (their callbacks no longer exist). clear() keeps history and re-mirrors.
        clear();
    });

    /*
     * @event Shutdown
     */
    $.bind('Shutdown', function () {
        clear();
    });

    /* Exports — the public engine API for the (future) add mechanism and other modules. */
    $.timedEventQueue = {
        add: add,
        accept: accept,
        reject: reject,
        complete: complete,
        remove: remove,
        reorder: reorder,
        addTime: addTime,
        pause: pause,
        resume: resume,
        setAccepting: setAccepting,
        isAccepting: isAccepting,
        clear: clear,
        list: list,
        getActive: getActive,
        getHistory: getHistory
    };
})();
