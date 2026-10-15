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

(function () {
    let table = 'countdownTimers',
            timers = Object.create(null),
            lock = new Packages.java.util.concurrent.locks.ReentrantLock();

    function validName(name) {
        return /^[a-zA-Z0-9_-]{1,64}$/.test(name);
    }

    function permitted(args) {
        return args.event && $.checkUserPermission(args.event.getSender(), args.event.getTags(), $.PERMISSION.Mod);
    }

    function save(state) {
        $.inidb.set(table, state.id, JSON.stringify(state));
    }

    // All access to timers and persistent state is protected by lock.
    function remove(id) {
        if (timers[id]) {
            clearTimeout(timers[id].timeout);
            delete timers[id];
        }
        $.inidb.del(table, id);
    }

    function snapshot(event) {
        let tags = Object.create(null),
                iterator = event.getTags().entrySet().iterator();
        while (iterator.hasNext()) {
            let entry = iterator.next();
            tags[$.jsString(entry.getKey())] = $.jsString(entry.getValue());
        }
        return {
            sender: $.jsString(event.getSender()),
            command: $.jsString(event.getCommand()),
            alias: $.jsString(event.getAlias()),
            arguments: $.jsString(event.getArguments()),
            tags: tags
        };
    }

    function restoreEvent(context) {
        let tags = new Packages.java.util.HashMap();
        Object.keys(context.tags).forEach(function (key) {
            tags.put(key, context.tags[key]);
        });
        return new Packages.tv.phantombot.event.command.CommandEvent(
                context.sender, context.command, context.alias, context.arguments, tags);
    }

    /*
     * @localtransformer remaining
     * @formula (remaining) the time remaining until this timer's saved deadline
     * @customarg (remaining:str) formatted remaining time
     * @cached
     */
    function remaining(args) {
        return {result: args.customArgs.remaining, cache: true};
    }

    /*
     * @localtransformer deadline
     * @formula (deadline) this timer's saved deadline as an ISO date/time string, usable with (countdown)
     * @customarg (deadline:str) fixed deadline including a timezone offset
     * @cached
     */
    function deadline(args) {
        return {result: args.customArgs.deadline, cache: true};
    }

    /*
     * @localtransformer timername
     * @formula (timername) this timer's name
     * @customarg (timername:str) timer name
     * @cached
     */
    function timername(args) {
        return {result: args.customArgs.timername, cache: true};
    }

    /*
     * @usestransformers global local twitch commandevent noevent
     * @bind countdownTimerAnnouncement
     */
    function announce(entry) {
        // Enter via a local transformer to take the engine lock before our lock.
        // Nested tag expansion is reentrant. This serializes announcements with
        // start/stop tags, so canceled callbacks cannot execute side-effect tags.
        $.transformers.tags(null, '(timerannouncement)', ['twitch', 'noevent'], {
            localTransformers: {
                timerannouncement: function () {
                    lock.lock();
                    try {
                        let state = entry.state,
                                now = Date.now();
                        if (timers[state.id] !== entry || now >= state.target) {
                            return {result: ''};
                        }
                        let output = $.transformers.tags(restoreEvent(state.context), state.message,
                                ['twitch', ['commandevent', 'noevent']], {
                                    localTransformers: {remaining: remaining, deadline: deadline, timername: timername},
                                    customArgs: {
                                        remaining: $.getCountString(Math.ceil((state.target - now) / 1000), false),
                                        deadline: new Date(state.target).toISOString(),
                                        timername: state.id
                                    }
                                });
                        // Templates can stop/replace themselves or take past the deadline.
                        if (timers[state.id] === entry && Date.now() < state.target && output !== null && output.trim().length > 0) {
                            $.say(output);
                        }
                        return {result: ''};
                    } finally {
                        lock.unlock();
                    }
                }
            }
        });
    }

    function schedule(entry) {
        let state = entry.state,
                delay = Math.max(1, Math.min(state.target, state.nextAnnouncement) - Date.now());
        entry.timeout = setTimeout(function () {
            let shouldAnnounce = false;
            lock.lock();
            try {
                if (timers[state.id] !== entry) {
                    return;
                }
                entry.timeout = null;
                let now = Date.now();
                if (now >= state.target) {
                    remove(state.id);
                    return;
                }
                if (now >= state.nextAnnouncement) {
                    // Never replay missed updates after downtime or a delayed callback.
                    state.nextAnnouncement = now + state.interval;
                    save(state);
                    shouldAnnounce = true;
                }
                schedule(entry);
            } finally {
                lock.unlock();
            }
            if (shouldAnnounce) {
                try {
                    announce(entry);
                } catch (ex) {
                    $.log.error('Countdown timer ' + state.id + ': ' + ex);
                }
            }
        }, delay, 'scripts::core::transformers::timers.js::' + state.id);
    }

    /*
     * @transformer timer
     * @category time
     * @formula (timer name:str datetime:str | message:str) starts or replaces a named countdown to the given future datetime, announcing immediately and then every 10 minutes
     * @formula (timer name:str datetime:str minutes:number | message:str) specifies the announcement interval in minutes (1-1440)
     * @labels twitch commandevent time
     * @notes Requires moderator permission. Names are case-insensitive, 1-64 letters, digits, underscores or hyphens. Different names run independently; reusing a name replaces only that timer. Returns no text on success.
     * @notes Accepts datetime strings supported by Date.parse. Quote datetime strings containing spaces. Include an explicit UTC offset to avoid relying on the Java runtime's timezone and parsing rules. Use (nexttime HH:MM) for the next occurrence in the bot timezone (!timezone). Invalid or past deadlines leave an existing timer unchanged.
     * @notes Saves one absolute deadline. Timers resume after a restart and stop silently at that deadline.
     * @notes Escape every parenthesis in the message's tags as `\(` and `\)` to evaluate them on each announcement. Unescaped tags run when the timer is created. The message supports (remaining), (deadline), (timername), and Twitch command tags, using the original sender, arguments and tags. Side-effect tags such as (command) execute on every announcement, including the first.
     * @notes The generic !timer example takes the message as command arguments, so its message tags need no escaping. For a fixed response containing escaped tags or nested (command), save the response through the panel; !addcom parses backslashes and restricts nested command tags.
     * @example Caster: !addcom !timer (timer (1) (2) | (3>))
     * Caster: !timer raid 2026-12-25T01:30:00+01:00 Raid starts in (remaining)!
     * Caster: !timer break 2026-12-25T02:00:00+01:00 Break in (remaining)!
     * @example Caster: !addcom !timerat (timer (1) (nexttime (2)) | (3>))
     * Caster: !timerat raid 01:30 Raid starts in (remaining)!
     * @example Panel custom-command response: (timer raid (nexttime (1)) 10 | Raid in \(remaining\)! \(command raidstatus\))
     * @example Panel custom-command response: (timer christmas "December 25 2026 00:00:00 GMT+0100" 10 | Christmas in \(remaining\)!)
     */
    function timer(args) {
        if (!permitted(args)) {
            return {result: $.lang.get('countdowntimer.permission')};
        }
        let separator = args.args.indexOf('|'),
                header = separator < 0 ? null : $.parseArgs(args.args.substring(0, separator).trim(), ' ', -1, false),
                message = separator < 0 ? '' : args.args.substring(separator + 1).trim(),
                minutes = header && header.length === 3 ? Number($.jsString(header[2])) : 10;
        if (!header || header.length < 2 || header.length > 3 || !validName($.jsString(header[0]))
                || !isFinite(minutes) || minutes < 1 || minutes > 1440 || !message) {
            return {result: $.lang.get('countdowntimer.usage')};
        }
        let target = Date.parse($.jsString(header[1])),
                now = Date.now();
        if (!isFinite(target) || target <= now) {
            return {result: $.lang.get('countdowntimer.invalid')};
        }
        let state = {
            id: $.jsString(header[0]).toLowerCase(),
            target: target,
            interval: minutes * 60000,
            nextAnnouncement: now,
            message: message,
            context: snapshot(args.event)
        };
        lock.lock();
        try {
            remove(state.id);
            let entry = {state: state, timeout: null};
            timers[state.id] = entry;
            save(state);
            schedule(entry);
        } finally {
            lock.unlock();
        }
        return {result: ''};
    }

    /*
     * @transformer stoptimer
     * @category time
     * @formula (stoptimer name:str) stops the named timer without affecting other timers; returns no text
     * @labels twitch commandevent time
     * @notes Requires moderator permission. Stopping a name that is not active does nothing. Already dispatched commands cannot be recalled.
     * @example Caster: !addcom !stoptimer (stoptimer (1))
     * Caster: !stoptimer raid
     */
    function stoptimer(args) {
        if (!permitted(args)) {
            return {result: $.lang.get('countdowntimer.permission')};
        }
        let id = args.args.trim().toLowerCase();
        if (!validName(id)) {
            return {result: $.lang.get('countdowntimer.stopusage')};
        }
        lock.lock();
        try {
            remove(id);
        } finally {
            lock.unlock();
        }
        return {result: ''};
    }

    /*
     * @transformer timerremaining
     * @category time
     * @formula (timerremaining name:str) shows the named timer's remaining time, or an inactive message if it is not running
     * @labels twitch noevent time
     * @cached
     */
    function timerremaining(args) {
        let id = args.args.trim().toLowerCase();
        lock.lock();
        try {
            let entry = timers[id],
                    now = Date.now();
            return {
                result: entry && entry.state.target > now
                    ? $.getCountString(Math.ceil((entry.state.target - now) / 1000), false)
                    : $.lang.get('countdowntimer.inactive', id),
                cache: true
            };
        } finally {
            lock.unlock();
        }
    }

    /*
     * @event initReady
     */
    $.bind('initReady', function () {
        lock.lock();
        try {
            Object.keys(timers).forEach(function (id) { clearTimeout(timers[id].timeout); });
            timers = Object.create(null);
            let keys = $.inidb.GetKeyList(table, '');
            for (let i = 0; i < keys.length; i++) {
                let id = $.jsString(keys[i]),
                        state = null;
                try {
                    state = JSON.parse($.getIniDbString(table, id));
                } catch (ex) {
                    $.log.error('Unable to restore countdown timer ' + id + ': ' + ex);
                }
                if (!state || !validName(id) || id !== id.toLowerCase() || state.id !== id
                        || !isFinite(state.target) || state.target <= Date.now()
                        || !isFinite(state.interval) || state.interval < 60000 || state.interval > 86400000
                        || !isFinite(state.nextAnnouncement) || typeof state.message !== 'string' || !state.message.trim()
                        || !state.context || typeof state.context.sender !== 'string'
                        || typeof state.context.command !== 'string' || !state.context.command
                        || typeof state.context.alias !== 'string' || typeof state.context.arguments !== 'string'
                        || !state.context.tags || typeof state.context.tags !== 'object') {
                    remove(id);
                    continue;
                }
                let entry = {state: state, timeout: null};
                timers[id] = entry;
                schedule(entry);
            }
        } finally {
            lock.unlock();
        }
    });

    $.transformers.addTransformers([
        new $.transformers.transformer('timer', ['twitch', 'commandevent', 'time'], timer),
        new $.transformers.transformer('stoptimer', ['twitch', 'commandevent', 'time'], stoptimer),
        new $.transformers.transformer('timerremaining', ['twitch', 'noevent', 'time'], timerremaining)
    ]);
})();
