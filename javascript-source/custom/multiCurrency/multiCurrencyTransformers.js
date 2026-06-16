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
 * multiCurrencyTransformers.js
 *
 * Command-tag transformers that surface the multi-currency system ($.currencies) inside
 * user-authored template strings (custom commands, welcome/keyword/sub messages, channel-point
 * redemption text). Mirrors the stock core/transformers/points.js pattern: read tags plus
 * state-mutating tags.
 *
 * These wrap the public $.currencies API only; they never touch the module's internals and
 * reference $.currencies lazily (at expansion time), so load order relative to
 * multiCurrencySystem.js does not matter. Re-running this file (e.g. !reloadcustom) just
 * re-registers the tags, which is idempotent.
 *
 * Argument order is currencyId first, then amount, then an optional target user — reading
 * naturally as (addcurrency gold 50) / (addcurrency gold 50 someuser).
 */
(function () {
    /*
     * @function resolveUser
     * @param {String} raw a user token (may have a leading @), or undefined for the sender
     * @param {Object} event the command event (for the sender default)
     * @return {String} a lowercased username, or null if a named user does not exist
     */
    function resolveUser(raw, event) {
        if (raw === undefined || raw === null || $.jsString(raw).trim() === '') {
            return $.jsString(event.getSender()).toLowerCase();
        }
        var user = $.jsString(raw).replace(/^@/, '').toLowerCase();
        return $.username.exists(user) ? user : null;
    }

    /*
     * @transformer currency
     * @formula (currency id:str) the sender's balance in the given currency
     * @formula (currency id:str user:str) the given user's balance in the given currency
     * @labels twitch commandevent currency
     * @example Caster: !addcom !gold You have (currency gold) gold
     * @cached
     */
    function currency(args) {
        var pargs = $.parseArgs(args.args, ' ');
        if (pargs === null || pargs.length === 0) {
            return {result: ''};
        }
        var id = pargs[0].toLowerCase(),
            user = resolveUser(pargs[1], args.event);
        if (user === null) {
            return {result: ''};
        }
        return {result: String($.currencies.get(user, id)), cache: true};
    }

    /*
     * @transformer currencybalstring
     * @formula (currencybalstring id:str) the sender's balance formatted with the currency name
     * @formula (currencybalstring id:str user:str) the given user's balance formatted with the currency name
     * @labels twitch commandevent currency
     * @example Caster: !addcom !bal You have (currencybalstring gold)
     * User: !bal
     * Bot: You have 50 Gold
     * @cached
     */
    function currencybalstring(args) {
        var pargs = $.parseArgs(args.args, ' ');
        if (pargs === null || pargs.length === 0) {
            return {result: ''};
        }
        var id = pargs[0].toLowerCase(),
            user = resolveUser(pargs[1], args.event);
        if (user === null) {
            return {result: ''};
        }
        return {result: $.jsString($.currencies.getString(id, $.currencies.get(user, id))), cache: true};
    }

    /*
     * @transformer currencystring
     * @formula (currencystring id:str amount:int) an amount formatted with the currency's singular/plural name
     * @labels twitch noevent currency
     * @example Caster: !addcom !cost This costs (currencystring gold 100)
     * @cached
     */
    function currencystring(args) {
        var pargs = $.parseArgs(args.args, ' ');
        if (pargs === null || pargs.length < 2 || isNaN(pargs[1])) {
            return {result: ''};
        }
        return {result: $.jsString($.currencies.getString(pargs[0].toLowerCase(), parseInt(pargs[1]))), cache: true};
    }

    /*
     * @transformer currencyname
     * @formula (currencyname id:str amount:int) the currency's name only (singular when amount is 1, otherwise plural)
     * @labels twitch noevent currency
     * @example Caster: !addcom !unit One unit is a (currencyname gold 1)
     * @cached
     */
    function currencyname(args) {
        var pargs = $.parseArgs(args.args, ' ');
        if (pargs === null || pargs.length < 2 || isNaN(pargs[1])) {
            return {result: ''};
        }
        // getString returns "<amount> <name>"; strip the leading amount to leave the name.
        var s = $.jsString($.currencies.getString(pargs[0].toLowerCase(), parseInt(pargs[1])));
        return {result: s.replace(/^\s*-?\d+\s+/, ''), cache: true};
    }

    /*
     * @transformer currencylist
     * @formula (currencylist) a comma-separated list of the defined currencies as "id (name)"
     * @labels twitch noevent currency
     * @example Caster: !addcom !currencies Available currencies: (currencylist)
     * @cached
     */
    function currencylist(args) {
        var defs = $.currencies.list(),
            parts = [];
        for (var i = 0; i < defs.length; i++) {
            parts.push($.jsString(defs[i].id) + ' (' + $.jsString(defs[i].name) + ')');
        }
        return {result: parts.join(', '), cache: true};
    }

    /*
     * @transformer currencyexists
     * @formula (currencyexists id:str) "true" if the currency is defined, otherwise "false"
     * @labels twitch noevent currency
     * @cached
     */
    function currencyexists(args) {
        var pargs = $.parseArgs(args.args, ' ');
        if (pargs === null || pargs.length === 0) {
            return {result: 'false', cache: true};
        }
        return {result: String($.currencies.exists(pargs[0].toLowerCase())), cache: true};
    }

    /*
     * @transformer currencyprice
     * @formula (currencyprice) the custom-currency cost of the current command, formatted, or empty if it is not priced in a currency
     * @formula (currencyprice command:str) the custom-currency cost of the given command, formatted
     * @labels twitch commandevent currency
     * @example Caster: !addcom !spincost A spin costs (currencyprice spin)
     * @cached
     */
    function currencyprice(args) {
        var cmd = $.jsString(args.args).trim();
        if (cmd.length === 0) {
            cmd = $.jsString(args.event.getCommand());
        }
        cmd = cmd.replace(/^!/, '');
        var cc = $.currencies.priceOf(cmd, '');
        return {result: (cc === null ? '' : $.jsString($.currencies.getString(cc.id, cc.amount))), cache: true};
    }

    /*
     * @transformer addcurrency
     * @formula (addcurrency id:str amount:int) give the sender an amount of a currency
     * @formula (addcurrency id:str amount:int user:str) give the given user an amount of a currency
     * @labels twitch commandevent currency
     * @cancels sometimes
     */
    function addcurrency(args) {
        var pargs = $.parseArgs(args.args, ' '),
            cancel = true;
        if (pargs !== null && pargs.length >= 2 && !isNaN(pargs[1])) {
            var id = pargs[0].toLowerCase(),
                amount = parseInt(pargs[1]),
                user = resolveUser(pargs[2], args.event);
            if (user !== null && $.currencies.exists(id)) {
                cancel = $.currencies.give(user, id, amount) === null;
            }
        }
        return {cancel: cancel, result: ''};
    }

    /*
     * @transformer takecurrency
     * @formula (takecurrency id:str amount:int) take an amount of a currency from the sender; zero out if they don't have enough
     * @formula (takecurrency id:str amount:int user:str) take an amount of a currency from the given user; zero out if they don't have enough
     * @labels twitch commandevent currency
     * @cancels sometimes
     */
    function takecurrency(args) {
        var pargs = $.parseArgs(args.args, ' '),
            cancel = true;
        if (pargs !== null && pargs.length >= 2 && !isNaN(pargs[1])) {
            var id = pargs[0].toLowerCase(),
                amount = parseInt(pargs[1]),
                user = resolveUser(pargs[2], args.event);
            if (user !== null && $.currencies.exists(id)) {
                cancel = $.currencies.take(user, id, amount, true) === null;
            }
        }
        return {cancel: cancel, result: ''};
    }

    /*
     * @transformer takecurrencyorcancel
     * @formula (takecurrencyorcancel id:str amount:int) take an amount of a currency from the sender; cancel if they don't have enough
     * @formula (takecurrencyorcancel id:str amount:int user:str) take an amount of a currency from the given user; cancel if they don't have enough
     * @labels twitch commandevent currency
     * @cancels sometimes
     */
    function takecurrencyorcancel(args) {
        var pargs = $.parseArgs(args.args, ' '),
            cancel = true;
        if (pargs !== null && pargs.length >= 2 && !isNaN(pargs[1])) {
            var id = pargs[0].toLowerCase(),
                amount = parseInt(pargs[1]),
                user = resolveUser(pargs[2], args.event);
            if (user !== null && $.currencies.exists(id)) {
                cancel = $.currencies.take(user, id, amount) === null;
            }
        }
        return {cancel: cancel, result: ''};
    }

    /*
     * @transformer setcurrency
     * @formula (setcurrency id:str amount:int) set the sender's balance in a currency
     * @formula (setcurrency id:str amount:int user:str) set the given user's balance in a currency
     * @labels twitch commandevent currency
     * @cancels sometimes
     */
    function setcurrency(args) {
        var pargs = $.parseArgs(args.args, ' '),
            cancel = true;
        if (pargs !== null && pargs.length >= 2 && !isNaN(pargs[1])) {
            var id = pargs[0].toLowerCase(),
                amount = parseInt(pargs[1]),
                user = resolveUser(pargs[2], args.event);
            if (user !== null && $.currencies.exists(id)) {
                $.currencies.set(user, id, amount);
                cancel = false;
            }
        }
        return {cancel: cancel, result: ''};
    }

    /*
     * @transformer chargecurrency
     * @formula (chargecurrency id:str amount:int) charge the sender an amount of a currency; cancel the whole response if they can't afford it
     * @labels twitch commandevent currency
     * @notes Use this to gate a custom command on a currency: put it at the start of the response and the rest only shows if the sender could pay.
     * @example Caster: !addcom !buyvip (chargecurrency gold 500)You are now VIP!
     * @cancels sometimes
     */
    function chargecurrency(args) {
        var pargs = $.parseArgs(args.args, ' '),
            cancel = true;
        if (pargs !== null && pargs.length >= 2 && !isNaN(pargs[1])) {
            var id = pargs[0].toLowerCase(),
                amount = parseInt(pargs[1]),
                user = $.jsString(args.event.getSender());
            cancel = !$.currencies.charge(user, id, amount);
        }
        return {cancel: cancel, result: ''};
    }

    var transformers = [
        new $.transformers.transformer('currency', ['twitch', 'commandevent', 'currency'], currency),
        new $.transformers.transformer('currencybalstring', ['twitch', 'commandevent', 'currency'], currencybalstring),
        new $.transformers.transformer('currencystring', ['twitch', 'noevent', 'currency'], currencystring),
        new $.transformers.transformer('currencyname', ['twitch', 'noevent', 'currency'], currencyname),
        new $.transformers.transformer('currencylist', ['twitch', 'noevent', 'currency'], currencylist),
        new $.transformers.transformer('currencyexists', ['twitch', 'noevent', 'currency'], currencyexists),
        new $.transformers.transformer('currencyprice', ['twitch', 'commandevent', 'currency'], currencyprice),
        new $.transformers.transformer('addcurrency', ['twitch', 'commandevent', 'currency'], addcurrency),
        new $.transformers.transformer('takecurrency', ['twitch', 'commandevent', 'currency'], takecurrency),
        new $.transformers.transformer('takecurrencyorcancel', ['twitch', 'commandevent', 'currency'], takecurrencyorcancel),
        new $.transformers.transformer('setcurrency', ['twitch', 'commandevent', 'currency'], setcurrency),
        new $.transformers.transformer('chargecurrency', ['twitch', 'commandevent', 'currency'], chargecurrency)
    ];

    $.transformers.addTransformers(transformers);
})();
