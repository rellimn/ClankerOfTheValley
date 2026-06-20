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

/*
 * timedEventQueueTransformers.js
 *
 * Command-tag transformers that surface the timed event queue ($.timedEventQueue) inside
 * user-authored template strings (custom commands, channel-point redemption text, etc.).
 * Read tags expose queue state for chat announcements; control tags let a moderator wire a
 * custom command or channel-point redemption to a queue action.
 *
 * These wrap the public $.timedEventQueue API only and reference it lazily (at expansion
 * time), so load order relative to timedEventQueueSystem.js does not matter. Re-running this
 * file (e.g. !reloadcustom) just re-registers the tags, which is idempotent.
 */
(function () {
    /*
     * @transformer queuelength
     * @formula (queuelength) the total number of items in the timed event queue
     * @labels twitch noevent queue
     * @example Caster: !addcom !queue There are (queuelength) items in the queue
     * @cached
     */
    function queuelength(args) {
        return {result: String($.timedEventQueue.list().length), cache: true};
    }

    /*
     * @transformer queuepending
     * @formula (queuepending) the number of pending (not yet accepted) items in the queue
     * @labels twitch noevent queue
     * @cached
     */
    function queuepending(args) {
        var q = $.timedEventQueue.list(),
            n = 0;
        for (var i = 0; i < q.length; i++) {
            if (q[i].state === 'pending') {
                n++;
            }
        }
        return {result: String(n), cache: true};
    }

    /*
     * @transformer queueposition
     * @formula (queueposition) the 1-based position of the sender's first item in the queue, or 0 if they have none
     * @formula (queueposition user:str) the 1-based position of the given user's first item in the queue, or 0
     * @labels twitch commandevent queue
     * @example Caster: !addcom !pos You are at position (queueposition) in the queue
     * @cached
     */
    function queueposition(args) {
        var user = $.jsString(args.args).trim();
        if (user.length === 0) {
            user = $.jsString(args.event.getSender());
        }
        user = user.replace(/^@/, '').toLowerCase();
        var q = $.timedEventQueue.list();
        for (var i = 0; i < q.length; i++) {
            if ($.jsString(q[i].sender).toLowerCase() === user) {
                return {result: String(i + 1), cache: true};
            }
        }
        return {result: '0', cache: true};
    }

    /*
     * @transformer queueactive
     * @formula (queueactive) the content of the currently active queue item, or empty if none is active
     * @labels twitch noevent queue
     * @cached
     */
    function queueactive(args) {
        var a = $.timedEventQueue.getActive();
        return {result: (a === null ? '' : $.jsString(a.content)), cache: true};
    }

    /*
     * @transformer queueactivesender
     * @formula (queueactivesender) the sender of the currently active queue item, or empty if none is active
     * @labels twitch noevent queue
     * @cached
     */
    function queueactivesender(args) {
        var a = $.timedEventQueue.getActive();
        return {result: (a === null ? '' : $.jsString(a.sender)), cache: true};
    }

    /*
     * @transformer queueactivetimeleft
     * @formula (queueactivetimeleft) the seconds remaining on the active item's countdown, or 0 if none is active
     * @labels twitch noevent queue
     * @cached
     */
    function queueactivetimeleft(args) {
        var a = $.timedEventQueue.getActive();
        if (a === null) {
            return {result: '0', cache: true};
        }
        var ms = a.paused ? a.remainingMs : (a.expiresAt - $.systemTime());
        return {result: String(Math.max(0, Math.ceil(ms / 1000))), cache: true};
    }

    /*
     * @transformer queueaccepting
     * @formula (queueaccepting) "on" if the queue is accepting new items, otherwise "off"
     * @labels twitch noevent queue
     * @cached
     */
    function queueaccepting(args) {
        return {result: ($.timedEventQueue.isAccepting() ? 'on' : 'off'), cache: true};
    }

    /*
     * @transformer queueadd
     * @formula (queueadd seconds:int content:str) add an item to the queue from the sender with the given countdown and content; result is the new item id
     * @labels twitch commandevent queue
     * @example Caster: !addcom !request (queueadd 120 (query))
     * @cancels sometimes
     */
    function queueadd(args) {
        var pargs = $.parseArgs(args.args, ' ', 2),
            cancel = true,
            result = '';
        if (pargs !== null && !isNaN(pargs[0]) && parseInt(pargs[0]) > 0) {
            var id = $.timedEventQueue.add({
                sender: $.jsString(args.event.getSender()),
                content: (pargs.length > 1 ? pargs[1] : ''),
                timeLeft: parseInt(pargs[0])
            });
            if (id !== null) {
                cancel = false;
                result = $.jsString(id);
            }
        }
        return {cancel: cancel, result: result};
    }

    /*
     * @transformer queueaddfor
     * @formula (queueaddfor user:str seconds:int content:str) add an item to the queue for the specified user with the given countdown and content
     * @labels twitch commandevent queue
     * @example Caster: !addcom !request (queueaddfor (user) 120 (query))
     * @notes Requires a moderator-context command event. It sends submission and lifecycle status messages directly, then cancels the enclosing command response.
     * @cancels
     */
    function queueaddfor(args) {
        var pargs = $.parseArgs(args.args, ' ', 3, true),
            requester = $.jsString(args.event.getSender());

        if (!$.checkUserPermission(requester, args.event.getTags(), $.PERMISSION.Mod)) {
            $.returnCommandCost(requester, args.event.getCommand(), false);
            $.say($.whisperPrefix(requester) + $.lang.get('timedeventqueue.tagadd.permission'));
            return {cancel: true, result: ''};
        }

        if (pargs === null || pargs.length < 3 || isNaN(pargs[1]) || parseInt(pargs[1]) <= 0) {
            $.say($.whisperPrefix(requester) + $.lang.get('timedeventqueue.tagadd.usage'));
            return {cancel: true, result: ''};
        }

        var user = $.jsString(pargs[0]),
            seconds = parseInt(pargs[1]),
            content = pargs[2],
            id = $.timedEventQueue.add({
                sender: user,
                content: content,
                timeLeft: seconds,
                onAccept: function (it) {
                    $.say($.lang.get('timedeventqueue.tagadd.accepted', it.sender, it.content, it.timeLeft));
                },
                onReject: function (it) {
                    $.say($.lang.get('timedeventqueue.tagadd.rejected', it.sender, it.content));
                },
                onComplete: function (it) {
                    $.say($.lang.get('timedeventqueue.tagadd.completed', it.sender, it.content));
                }
            });

        if (id === null) {
            $.say($.whisperPrefix(requester) + $.lang.get('timedeventqueue.tagadd.closed', user));
        } else {
            $.say($.whisperPrefix(requester) + $.lang.get('timedeventqueue.tagadd.added', user, seconds, content));
        }

        return {cancel: true, result: ''};
    }

    /*
     * @transformer queueaccept
     * @formula (queueaccept) accept the oldest pending item and start its timer; cancel if there is nothing to accept or one is already active
     * @formula (queueaccept id:str) accept the item with the given id
     * @labels twitch noevent queue
     * @cancels sometimes
     */
    function queueaccept(args) {
        var id = $.jsString(args.args).trim();
        var ok = $.timedEventQueue.accept(id.length === 0 ? undefined : id);
        return {cancel: !ok, result: ''};
    }

    /*
     * @transformer queuereject
     * @formula (queuereject) reject the oldest pending item; cancel if there is nothing to reject
     * @formula (queuereject id:str) reject the item with the given id
     * @labels twitch noevent queue
     * @cancels sometimes
     */
    function queuereject(args) {
        var id = $.jsString(args.args).trim();
        var ok = $.timedEventQueue.reject(id.length === 0 ? undefined : id);
        return {cancel: !ok, result: ''};
    }

    /*
     * @transformer queuecomplete
     * @formula (queuecomplete) complete the active item; cancel if there is nothing to complete
     * @formula (queuecomplete id:str) complete the item with the given id
     * @labels twitch noevent queue
     * @cancels sometimes
     */
    function queuecomplete(args) {
        var id = $.jsString(args.args).trim();
        var ok = $.timedEventQueue.complete(id.length === 0 ? undefined : id);
        return {cancel: !ok, result: ''};
    }

    /*
     * @transformer queueclear
     * @formula (queueclear) clear the entire timed event queue
     * @labels twitch noevent queue
     */
    function queueclear(args) {
        $.timedEventQueue.clear();
        return {result: ''};
    }

    /*
     * @transformer queuesetaccepting
     * @formula (queuesetaccepting state:str) set whether the queue accepts new items; state is on/off (also true/false or 1/0)
     * @labels twitch noevent queue
     * @cancels sometimes
     */
    function queuesetaccepting(args) {
        var v = $.jsString(args.args).trim().toLowerCase();
        if (v === '') {
            return {cancel: true, result: ''};
        }
        $.timedEventQueue.setAccepting(v === 'on' || v === 'true' || v === '1');
        return {result: ''};
    }

    /*
     * @transformer queueaddtime
     * @formula (queueaddtime seconds:int) add (or, if negative, subtract) seconds on the active item's countdown; cancel if there is no active item
     * @labels twitch noevent queue
     * @cancels sometimes
     */
    function queueaddtime(args) {
        var v = $.jsString(args.args).trim();
        if (v === '' || isNaN(v)) {
            return {cancel: true, result: ''};
        }
        return {cancel: !$.timedEventQueue.addTime(parseInt(v)), result: ''};
    }

    /*
     * @transformer queuepause
     * @formula (queuepause) pause the active item's countdown; cancel if there is no active item to pause
     * @labels twitch noevent queue
     * @cancels sometimes
     */
    function queuepause(args) {
        return {cancel: !$.timedEventQueue.pause(), result: ''};
    }

    /*
     * @transformer queueresume
     * @formula (queueresume) resume the active item's countdown; cancel if there is no paused item to resume
     * @labels twitch noevent queue
     * @cancels sometimes
     */
    function queueresume(args) {
        return {cancel: !$.timedEventQueue.resume(), result: ''};
    }

    var transformers = [
        new $.transformers.transformer('queuelength', ['twitch', 'noevent', 'queue'], queuelength),
        new $.transformers.transformer('queuepending', ['twitch', 'noevent', 'queue'], queuepending),
        new $.transformers.transformer('queueposition', ['twitch', 'commandevent', 'queue'], queueposition),
        new $.transformers.transformer('queueactive', ['twitch', 'noevent', 'queue'], queueactive),
        new $.transformers.transformer('queueactivesender', ['twitch', 'noevent', 'queue'], queueactivesender),
        new $.transformers.transformer('queueactivetimeleft', ['twitch', 'noevent', 'queue'], queueactivetimeleft),
        new $.transformers.transformer('queueaccepting', ['twitch', 'noevent', 'queue'], queueaccepting),
        new $.transformers.transformer('queueadd', ['twitch', 'commandevent', 'queue'], queueadd),
        new $.transformers.transformer('queueaddfor', ['twitch', 'commandevent', 'queue'], queueaddfor),
        new $.transformers.transformer('queueaccept', ['twitch', 'noevent', 'queue'], queueaccept),
        new $.transformers.transformer('queuereject', ['twitch', 'noevent', 'queue'], queuereject),
        new $.transformers.transformer('queuecomplete', ['twitch', 'noevent', 'queue'], queuecomplete),
        new $.transformers.transformer('queueclear', ['twitch', 'noevent', 'queue'], queueclear),
        new $.transformers.transformer('queuesetaccepting', ['twitch', 'noevent', 'queue'], queuesetaccepting),
        new $.transformers.transformer('queueaddtime', ['twitch', 'noevent', 'queue'], queueaddtime),
        new $.transformers.transformer('queuepause', ['twitch', 'noevent', 'queue'], queuepause),
        new $.transformers.transformer('queueresume', ['twitch', 'noevent', 'queue'], queueresume)
    ];

    $.transformers.addTransformers(transformers);
})();
