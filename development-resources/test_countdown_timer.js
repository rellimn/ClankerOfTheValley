/*
 * Run from the repository root after compiling Java classes:
 * java -cp "lib/*;build/classes" org.mozilla.javascript.tools.shell.Main -version 200 -f development-resources/test_countdown_timer.js
 * On Unix, use ':' instead of ';' in the classpath.
 * Uses the real Rhino tag engine, Java CommandEvent, and timezone rules.
 * Chat, storage, scheduling, and command dispatch are deterministic substitutes.
 */
(function () {
    var now = 0, zone = 'Europe/Berlin', hooks = {}, db = Object.create(null), jobs = {},
            messages = [], dispatched = [], errors = [], nextId = 0, checks = 0, liveValue = 'first',
            translations = JSON.parse(readFile('javascript-source/lang/english/core/core-countdownTimers.json')),
            CommandEvent = Packages.tv.phantombot.event.command.CommandEvent;
    Date.now = function () { return now; };
    $ = {
        PERMISSION: {Mod: 2},
        jsString: function (value) { return value === null || value === undefined ? value : String(value); },
        javaString: function (value) { return new java.lang.String(value); },
        replace: function (value, from, to) { return value.split(from).join(to); },
        getCountString: function (seconds) {
            if (seconds <= 0) { throw new Error('Nonpositive countdown'); }
            return String(seconds);
        },
        parseArgs: function (value, delimiter, limit, literal) {
            return CommandEvent.parseArgs(String(value), new java.lang.Character(delimiter.charCodeAt(0)), limit, literal).toArray();
        },
        getLocalTime: function () { return new Date(Math.floor(now / 1000) * 1000).toISOString(); },
        getIniDbString: function (table, key, fallback) {
            return table === 'settings' ? zone : (db[key] === undefined ? fallback : db[key]);
        },
        inidb: {
            set: function (table, key, value) { db[key] = value; },
            del: function (table, key) { delete db[key]; },
            GetKeyList: function () { return Object.keys(db); }
        },
        lang: {get: function (key) {
            if (!translations.hasOwnProperty(key)) { throw new Error('Missing translation: ' + key); }
            var result = translations[key];
            for (var i = 1; i < arguments.length; i++) { result = result.replace('$' + i, arguments[i]); }
            return result;
        }},
        checkUserPermission: function (sender) { return String(sender) === 'moderator'; },
        say: function (message) { messages.push(String(message)); },
        log: {error: function (error) { errors.push(String(error)); }},
        bind: function (event, callback) { hooks[event] = callback; }
    };
    setTimeout = function (callback, delay) {
        jobs[++nextId] = {callback: callback, due: now + delay};
        return nextId;
    };
    clearTimeout = function (id) { delete jobs[id]; };
    load('javascript-source/core/commandTags.js');
    load('javascript-source/core/transformers/nexttime.js');
    load('javascript-source/core/transformers/time.js');
    load('javascript-source/core/transformers/basic.js');
    load('javascript-source/core/transformers/user.js');
    // Exercise the actual command transformer with a captured asynchronous EventBus.
    new Function('Packages', readFile('javascript-source/core/transformers/commands.js'))({
        tv: {phantombot: {event: {
            command: {CommandEvent: CommandEvent},
            EventBus: {instance: function () { return {postAsync: function (event) { dispatched.push(event); }}; }}
        }}}
    });
    $.transformers.addTransformer(new $.transformers.transformer('live', ['twitch', 'noevent'], function () { return {result: liveValue}; }));
    $.transformers.addTransformer(new $.transformers.transformer('canceltest', ['twitch', 'noevent'], function () { return {cancel: true}; }));
    $.transformers.addTransformer(new $.transformers.transformer('failtest', ['twitch', 'noevent'], function () { throw new Error('Expected template failure'); }));

    function eq(actual, expected, label) {
        if (String(actual) !== String(expected)) { throw new Error(label + ': expected ' + expected + ', got ' + actual); }
        checks++;
    }
    function event(arguments, sender) {
        var tags = new java.util.HashMap();
        tags.put('display-name', 'Moderator');
        return new CommandEvent(sender || 'moderator', 'timer', 'alias', arguments || '', tags);
    }
    function expand(template, arguments, sender) {
        return $.transformers.tags(event(arguments, sender), template, ['twitch', ['commandevent', 'noevent']]);
    }
    function create(id, time, template, minutes) {
        // Short test inputs explicitly use nexttime; timer itself only parses datetimes.
        var datetime = /^\d{2}:\d{2}$/.test(time) ? '(nexttime ' + time + ')' : time;
        return expand('(timer ' + id + ' ' + datetime + (minutes === undefined ? '' : ' ' + minutes) + ' | '
                + $.transformers.escapeTags(template) + ')');
    }
    function active(id) { return JSON.parse(db[id]); }
    function jobCount() { return Object.keys(jobs).length; }
    function pending() { return jobs[Object.keys(jobs)[0]]; }
    function startAt(iso) {
        now = Date.parse(iso);
        jobs = {};
        db = Object.create(null);
        messages = [];
        dispatched = [];
        errors = [];
        zone = 'Europe/Berlin';
        liveValue = 'first';
        load('javascript-source/core/transformers/timers.js');
        hooks.initReady();
    }
    function advance(milliseconds) {
        var end = now + milliseconds, steps = 0;
        while (jobCount()) {
            var id = Object.keys(jobs).sort(function (a, b) { return jobs[a].due - jobs[b].due; })[0], job = jobs[id];
            if (job.due > end) { break; }
            if (++steps > 1000) { throw new Error('Runaway scheduler'); }
            now = job.due;
            delete jobs[id];
            job.callback();
        }
        now = end;
    }
    function restart() {
        jobs = {};
        load('javascript-source/core/transformers/timers.js');
        hooks.initReady();
    }

    startAt('2026-10-15T00:00:00+02:00');
    eq(jobCount(), 0, 'idle startup');
    eq(expand('(timer (1) (nexttime (2)) | \\(timername\\): \\(remaining\\) / \\(live\\))', 'raid 01:30'), '', 'documented custom command syntax');
    eq(active('raid').message, '(timername): (remaining) / (live)', 'template is stored unexpanded');
    eq(active('raid').target, Date.parse('2026-10-15T01:30:00+02:00'), 'fixed local deadline');
    eq(active('raid').interval, 600000, 'ten minute default');
    eq(messages.length, 0, 'creation returns no text');
    advance(1);
    eq(messages[0], 'raid: 5400 / first', 'immediate expanded template');
    liveValue = 'second';
    advance(600000);
    eq(messages[1], 'raid: 4800 / second', 'tags reevaluate each time');
    advance(80 * 60000);
    eq(messages.length, 9, 'one announcement per interval before deadline');
    eq(jobCount(), 0, 'stops at deadline');
    eq(db.raid, undefined, 'clears persisted timer');
    advance(86400000);
    eq(messages.length, 9, 'does not start tomorrow');

    startAt('2026-10-15T00:00:00+02:00');
    create('raid', '01:30', 'Raid (remaining)');
    create('break', '02:00', 'Break (remaining)', 1);
    eq(jobCount(), 2, 'independent schedules');
    var oldCallback = pending().callback;
    create('RAID', '03:00', 'Replacement (remaining)');
    eq(jobCount(), 2, 'case-insensitive replacement affects one timer');
    oldCallback();
    eq(messages.length, 0, 'stale callback cannot announce');
    eq(jobCount(), 2, 'stale callback cannot reschedule');
    expand('(stoptimer RAID)');
    eq(jobCount(), 1, 'stops only named timer');
    advance(1);
    eq(messages[0], 'Break 7200', 'other timer continues');
    eq(expand('(timerremaining break)'), '7200', 'remaining outside template');
    eq(expand('(timerremaining raid)'), 'Timer raid is not active.', 'inactive status');
    expand('(stoptimer missing)');
    eq(jobCount(), 1, 'stopping missing timer is harmless');

    var stored = db.break;
    ['(timer break 24:00 | bad)', '(timer break 1:30 | bad)', '(timer break 01:60 | bad)',
        '(timer break 01:30 0 | bad)', '(timer break 01:30 1441 | bad)', '(timer break 01:30 | )',
        '(timer bad/name 01:30 | bad)', '(timer break 01:30 NaN | bad)'].forEach(function (input) {
        eq([translations['countdowntimer.usage'], translations['countdowntimer.invalid']].indexOf(expand(input)) >= 0, true, 'invalid input: ' + input);
        eq(db.break, stored, 'invalid input preserves active timer');
    });
    eq(expand('(timer break 03:00 | stolen)', '', 'viewer'), translations['countdowntimer.permission'], 'start requires moderator');
    eq(expand('(stoptimer break)', '', 'viewer'), translations['countdowntimer.permission'], 'stop requires moderator');
    eq(db.break, stored, 'permission failure preserves state');
    create('__proto__', '01:30', 'Safe name');
    eq(active('__proto__').id, '__proto__', 'prototype-like names are safe');

    startAt('2026-10-15T00:00:00+02:00');
    create('raid', '01:30', '(countdown (deadline)) | (baresender) | (1) | (command probe (remaining))');
    eq(dispatched.length, 0, 'command tag does not execute during creation');
    advance(1);
    eq(errors.length, 0, 'no nested tag errors');
    eq(messages[0], '5400 | moderator |  |', 'nested countdown and sender');
    eq(dispatched.length, 1, 'command executes on first announcement');
    eq(dispatched[0].getCommand(), 'probe', 'dispatch command');
    eq(dispatched[0].getSender(), 'moderator', 'dispatch retains sender');
    eq(dispatched[0].getArguments(), '5400', 'dispatch contains fresh countdown');
    eq(dispatched[0].getTags().get('display-name'), 'Moderator', 'dispatch retains tags');
    advance(600000);
    eq(dispatched[1].getArguments(), '4800', 'command reevaluates countdown');
    restart();
    advance(600000);
    eq(dispatched[2].getSender(), 'moderator', 'restart preserves sender context');
    eq(dispatched[2].getArguments(), '4200', 'restart preserves fixed deadline');
    hooks.initReady();
    eq(jobCount(), 1, 'repeated initialization has one schedule');

    startAt('2026-10-15T00:00:00+02:00');
    expand('(timer (1) (nexttime (2)) | \\(1\\) \\(2\\) \\(remaining\\))', 'raid 01:30');
    restart();
    advance(1);
    eq(messages[0], 'raid 01:30 5400', 'original arguments survive restart');
    zone = 'America/New_York';
    advance(600000);
    eq(messages[1], 'raid 01:30 4800', 'timezone change does not move target');
    now += 25 * 60000;
    restart();
    advance(1);
    eq(messages.length, 3, 'overdue restart announces once');
    now += 2 * 3600000;
    restart();
    eq(jobCount(), 0, 'expired restart stays stopped');
    eq(messages.length, 3, 'expired restart sends no stale message');

    startAt('2026-10-15T00:00:00+02:00');
    create('short', '00:05', '(remaining)');
    now += 6 * 60000;
    var late = pending().callback;
    jobs = {};
    late();
    eq(messages.length, 0, 'late callback never emits negative countdown');
    eq(jobCount(), 0, 'late callback stops');

    startAt('2026-10-15T00:00:00+02:00');
    create('cancel', '01:30', '(canceltest) hidden');
    advance(1);
    eq(messages.length, 0, 'canceling tag suppresses announcement');
    eq(jobCount(), 1, 'canceled announcement keeps timer alive');
    create('selfstop', '01:30', '(stoptimer selfstop) hidden');
    advance(1);
    eq(db.selfstop, undefined, 'template can stop itself');
    eq(messages.length, 0, 'self-stopped timer sends no stale text');
    create('failure', '01:30', '(failtest)');
    advance(1);
    eq(errors.length, 1, 'template errors are logged');
    eq(jobCount(), 2, 'template error does not kill scheduling');

    startAt('2026-10-15T02:00:00+02:00');
    create('tomorrow', '01:30', '(remaining)');
    eq(active('tomorrow').target, Date.parse('2026-10-16T01:30:00+02:00'), 'next day');
    startAt('2026-03-29T00:00:00+01:00');
    create('gap', '02:30', '(remaining)');
    eq(active('gap').target, Date.parse('2026-03-30T02:30:00+02:00'), 'DST gap');
    startAt('2026-10-25T02:45:00+02:00');
    create('overlap', '02:30', '(remaining)');
    eq(active('overlap').target, Date.parse('2026-10-25T02:30:00+01:00'), 'DST overlap');
    db.broken = '{bad json';
    restart();
    eq(db.broken, undefined, 'corrupt timer removed');
    eq(jobCount(), 1, 'corrupt entry does not prevent other timers restoring');

    startAt('2026-10-15T00:00:00+02:00');
    create('race', '01:30', '(command mustnotrun)');
    var originalTags = $.transformers.tags;
    $.transformers.tags = function (event, message, labels, options) {
        if (message === '(timerannouncement)') {
            $.transformers.tags = originalTags;
            expand('(stoptimer race)');
        }
        return originalTags(event, message, labels, options);
    };
    advance(1);
    eq(dispatched.length, 0, 'cancel between scheduling and rendering prevents command side effects');
    eq(jobCount(), 0, 'cancel during pending announcement removes next callback');

    startAt('2026-10-15T00:00:00+02:00');
    create('selfreplace', '01:30', '(timer selfreplace (nexttime 02:00) | Replacement) old message');
    advance(1);
    eq(messages.length, 0, 'self-replacement suppresses stale text');
    eq(active('selfreplace').target, Date.parse('2026-10-15T02:00:00+02:00'), 'self-replacement updates deadline');
    eq(jobCount(), 1, 'self-replacement leaves one schedule');
    advance(1);
    eq(messages[0], 'Replacement', 'self-replacement sends new template');

    startAt('2026-10-15T00:00:00+02:00');
    create('short', '00:03', 'Short', 1);
    create('long', '01:00', 'Long');
    advance(60001);
    eq(messages.filter(function (m) { return m === 'Short'; }).length, 2, 'one minute interval');
    eq(messages.filter(function (m) { return m === 'Long'; }).length, 1, 'other timer retains ten minute interval');
    restart();
    eq(jobCount(), 2, 'multiple timers resume after restart');
    advance(2 * 60000);
    eq(db.short, undefined, 'one timer expires independently');
    eq(jobCount(), 1, 'other timer survives first deadline');

    startAt('2026-10-15T00:00:00+02:00');
    var addEvent = new CommandEvent('moderator', 'addcom', '!timer (timer (1) (nexttime (2)) | (3>))');
    var savedResponse = Array.prototype.slice.call(addEvent.getArgs(), 1).join(' ');
    eq(savedResponse, '(timer (1) (nexttime (2)) | (3>))', 'addcom preserves generic timer response');
    eq(expand(savedResponse, 'raid 01:30 Raid in (remaining)! (command raidstatus (remaining))'), '', 'message supplied as command argument');
    eq(active('raid').message, 'Raid in (remaining)! (command raidstatus (remaining))', 'argument message stored unexpanded');
    eq(dispatched.length, 0, 'argument command tag waits for announcement');
    advance(1);
    eq(messages[0], 'Raid in 5400!', 'argument template expands on announcement');
    eq(dispatched[0].getCommand(), 'raidstatus', 'argument template dispatches nested command');
    advance(600000);
    eq(messages[1], 'Raid in 4800!', 'argument template reevaluates');
    eq(dispatched[1].getArguments(), '4800', 'argument command reevaluates');

    startAt('2026-10-15T00:00:00+02:00');
    eq(create('iso', '2026-12-25T01:30:00+01:00', '(remaining)'), '', 'ISO deadline accepted');
    eq(active('iso').target, Date.parse('2026-12-25T00:30:00Z'), 'ISO offset preserved');
    eq(active('iso').interval, 600000, 'ISO default interval');
    eq(create('utc', '2026-12-25T01:30:00Z', 'UTC', 5), '', 'UTC and explicit interval accepted');
    eq(active('utc').target, Date.parse('2026-12-25T01:30:00Z'), 'UTC instant preserved');
    eq(active('utc').interval, 300000, 'explicit interval preserved');
    eq(create('words', '"December 25 2026 00:00:00 GMT+0100"', 'Christmas (remaining)', 2.5), '', 'quoted multiword datetime');
    eq(active('words').target, Date.parse('2026-12-24T23:00:00Z'), 'quoted datetime offset');
    eq(active('words').interval, 150000, 'fractional interval');
    eq(create('rfc', '"Fri, 25 Dec 2026 00:00:00 GMT"', 'RFC'), '', 'quoted RFC datetime');
    eq(active('rfc').target, Date.parse('2026-12-25T00:00:00Z'), 'RFC instant');
    var originalIso = db.iso;
    ['01:30', 'not-a-date', '2026-10-14T01:30:00+02:00', '2026-10-15T00:00:00+02:00'].forEach(function (datetime) {
        eq(expand('(timer iso ' + datetime + ' | invalid replacement)'), translations['countdowntimer.invalid'], 'reject invalid/nonfuture datetime: ' + datetime);
        eq(db.iso, originalIso, 'invalid deadline preserves existing timer');
    });
    eq(expand('(timer iso December 25 2026 00:00:00 GMT+0100 | unquoted)'), translations['countdowntimer.usage'], 'multiword dates need quotes');
    eq(db.iso, originalIso, 'malformed header preserves timer');
    ['0', '1441', 'NaN', 'Infinity', '-5'].forEach(function (interval) {
        eq(create('iso', '2026-12-25T01:30:00+01:00', 'bad interval', interval), translations['countdowntimer.usage'], 'reject bad interval with valid date');
        eq(db.iso, originalIso, 'bad interval preserves existing timer');
    });
    restart();
    eq(active('iso').target, Date.parse('2026-12-25T00:30:00Z'), 'full datetime survives restart');
    eq(jobCount(), 4, 'all full datetime timers resume');

    startAt('2026-10-15T00:00:00+02:00');
    var isoAddEvent = new CommandEvent('moderator', 'addcom', '!timer (timer (1) (2) | (3>))');
    var isoResponse = Array.prototype.slice.call(isoAddEvent.getArgs(), 1).join(' ');
    eq(expand(isoResponse, 'raid 2026-10-15T01:30:00+02:00 Raid in (remaining)! (command raidstatus)'), '', 'chat command accepts full datetime');
    advance(1);
    eq(messages[0], 'Raid in 5400!', 'full datetime template expands');
    eq(dispatched[0].getCommand(), 'raidstatus', 'full datetime command tag dispatch');
    advance(90 * 60000);
    eq(jobCount(), 0, 'full datetime timer stops at saved deadline');
    print('PASS: ' + checks + ' named countdown tag checks');
})();
