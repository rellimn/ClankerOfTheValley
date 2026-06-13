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
 * $.timedEventQueue.add(...); the streamer drives accept/reject/complete from the
 * web panel (Timed Event Queue page) or the !teq test command.
 *
 * Each item carries a sender, content string, sent-timestamp, and a countdown budget
 * ("time left", seconds), plus optional onAccept/onReject/onComplete callbacks.
 *
 * Lifecycle: pending --accept--> active (timer ticking) --timer 0--> expired
 *            --complete--> (removed, onComplete) ; or --reject--> (removed, onReject).
 * Only ONE item may be active/counting down at a time.
 *
 * Callbacks are live JS functions and cannot be persisted, so the queue is in-memory
 * only: on a bot restart it starts empty and consumers re-add. A callback-stripped JSON
 * snapshot is mirrored to the 'timedEventQueue' DataStore table purely so the panel can
 * render the live list and countdown.
 */
(function () {
    var items = [], // ordered queue, oldest first
        activeId = null, // id of the currently counting-down item, or null
        seq = 0, // monotonic id source
        _timerId = null, // JSTimers id of the active countdown
        _lock = new Packages.java.util.concurrent.locks.ReentrantLock(),
        SCRIPT = './custom/timedEventQueue/timedEventQueueSystem.js',
        TABLE = 'timedEventQueue';

    /*
     * The helpers below that read/write `items`, `activeId`, or `_timerId` must be
     * called while holding `_lock`. Consumer callbacks are always invoked AFTER the
     * lock is released (see fire()).
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
     * @function mirror
     *
     * Writes the callback-stripped snapshot to the DataStore for the panel. Active items
     * are augmented with an absolute `expiresAt` so the panel can tick the countdown
     * locally without per-second DB writes. Must hold `_lock`.
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
                expiresAt: (it.state === 'active' && it.acceptedAt !== null ? it.acceptedAt + (it.timeLeft * 1000) : null)
            });
        }
        $.inidb.set(TABLE, 'snapshot', JSON.stringify(view));
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
            acceptedAt: it.acceptedAt
        };
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
            id = 'teq_' + (++seq);
            items.push({
                id: id,
                sender: (opts.sender === undefined ? '' : String(opts.sender)),
                content: (opts.content === undefined ? '' : String(opts.content)),
                sentDate: (opts.sentDate === undefined ? $.systemTime() : parseInt(opts.sentDate, 10)),
                timeLeft: timeLeft,
                state: 'pending',
                acceptedAt: null,
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
            var it = items[idx];
            it.state = 'active';
            it.acceptedAt = $.systemTime();
            activeId = it.id;
            clearActiveTimer();
            _timerId = setTimeout(function () {
                onTimerExpired(it.id);
            }, it.timeLeft * 1000, 'teq-timer-' + it.id);
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
     * Removes an item (default: the oldest pending) without completing it. Invokes onReject.
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
     * Completes an item (default: the active one). Allowed while active or expired. Invokes
     * onComplete and removes the item, freeing the active slot.
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
     * Removes an item by id with NO callback (administrative drop).
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
     * @function clear
     *
     * Empties the queue and cancels any running timer (no callbacks fired).
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
            $.say($.whisperPrefix(sender) + 'Usage: !teq [add / accept / reject / complete / list / clear]');
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
            $.say($.whisperPrefix(sender) + 'Added test item ' + id + '.');
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
        $.registerChatSubcommand('teq', 'list', $.PERMISSION.Mod);
        $.registerChatSubcommand('teq', 'clear', $.PERMISSION.Mod);

        // The in-memory queue is empty on boot; clear any stale snapshot from a previous run
        // (its items referenced callbacks that no longer exist).
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
        clear: clear,
        list: list,
        getActive: getActive
    };
})();
