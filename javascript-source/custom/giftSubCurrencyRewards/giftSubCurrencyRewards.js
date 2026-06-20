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
 * giftSubCurrencyRewards.js
 *
 * Awards custom multi-currency balances to gift-sub gifters. Operators configure
 * per-currency breakpoints: the highest breakpoint <= the number of gifted subs
 * decides the amount granted for that currency.
 */
(function () {
    var SCRIPT = './custom/giftSubCurrencyRewards/giftSubCurrencyRewards.js',
        SETTINGS = 'giftSubCurrencyRewards',
        REWARDS = 'giftSubCurrencyRewardBreakpoints',
        MASS_GIFT_SETTLEMENT_MS = 3000,
        enabled = $.getSetIniDbBoolean(SETTINGS, 'enabled', true),
        message = $.getSetIniDbString(SETTINGS, 'message', ''),
        pendingSingleGifts = {},
        pendingSingleGiftsLock = new Packages.java.util.concurrent.locks.ReentrantLock();

    function blank(v) {
        return v === undefined || v === null || $.jsString(v).trim() === '';
    }

    function reloadSettings() {
        enabled = $.getSetIniDbBoolean(SETTINGS, 'enabled', true);
        message = $.getSetIniDbString(SETTINGS, 'message', '');
    }

    function customCurrenciesReady() {
        return $.currencies !== undefined && $.currencies !== null;
    }

    function normalizeCurrencyId(id) {
        if (blank(id)) {
            return '';
        }
        return $.jsString(id).toLowerCase().replace(/[^a-z0-9_]/g, '');
    }

    function parsePositiveInt(v) {
        var n = parseInt(v, 10);
        return isNaN(n) || n <= 0 ? null : n;
    }

    function getRewardMap(currencyId) {
        currencyId = normalizeCurrencyId(currencyId);
        if (currencyId === '' || !$.inidb.exists(REWARDS, currencyId)) {
            return {};
        }

        try {
            var obj = JSON.parse($.getIniDbString(REWARDS, currencyId, '{}'));
            return obj === null ? {} : obj;
        } catch (ex) {
            return {};
        }
    }

    function saveRewardMap(currencyId, map) {
        currencyId = normalizeCurrencyId(currencyId);
        var hasAny = false,
            k;

        for (k in map) {
            if (map.hasOwnProperty(k)) {
                hasAny = true;
                break;
            }
        }

        if (hasAny) {
            $.inidb.set(REWARDS, currencyId, JSON.stringify(map));
        } else {
            $.inidb.del(REWARDS, currencyId);
        }
    }

    function setBreakpoint(currencyId, giftedSubs, currencyAmount) {
        currencyId = normalizeCurrencyId(currencyId);
        var map = getRewardMap(currencyId);
        map[String(giftedSubs)] = currencyAmount;
        saveRewardMap(currencyId, map);
    }

    function removeBreakpoint(currencyId, giftedSubs) {
        currencyId = normalizeCurrencyId(currencyId);
        var map = getRewardMap(currencyId),
            key = String(giftedSubs);

        if (!map.hasOwnProperty(key)) {
            return false;
        }

        delete map[key];
        saveRewardMap(currencyId, map);
        return true;
    }

    function sortedBreakpoints(map) {
        var out = [],
            k;

        for (k in map) {
            if (map.hasOwnProperty(k) && parsePositiveInt(k) !== null && parsePositiveInt(map[k]) !== null) {
                out.push(parseInt(k, 10));
            }
        }

        out.sort(function (a, b) {
            return a - b;
        });
        return out;
    }

    function rewardFor(currencyId, giftedSubs) {
        var map = getRewardMap(currencyId),
            points = sortedBreakpoints(map),
            reward = 0;

        for (var i = 0; i < points.length; i++) {
            if (points[i] <= giftedSubs) {
                reward = parseInt(map[String(points[i])], 10);
            } else {
                break;
            }
        }

        return reward;
    }

    function currencyName(currencyId, amount) {
        var formatted = $.jsString($.currencies.getString(currencyId, amount));
        return formatted.replace(/^\s*-?\d+\s+/, '');
    }

    function localTransformers(currencyId, giftedSubs, granted, balance) {
        /*
         * @localtransformer name
         * @formula (name) the user who gifted the subscription(s)
         * @cached
         */
        function name(args) {
            return {result: args.event.getUsername(), cache: true};
        }

        /*
         * @localtransformer giftedamount
         * @formula (giftedamount) the number of subscriptions gifted by this gift event
         * @cached
         */
        function giftedamount(args) {
            return {result: String(giftedSubs), cache: true};
        }

        /*
         * @localtransformer amount
         * @formula (amount) the number of subscriptions gifted by this gift event
         * @cached
         */
        function amount(args) {
            return {result: String(giftedSubs), cache: true};
        }

        /*
         * @localtransformer currencygranted
         * @formula (currencygranted) the amount of custom currency granted by this gift event
         * @cached
         */
        function currencygranted(args) {
            return {result: String(granted), cache: true};
        }

        /*
         * @localtransformer currencyname
         * @formula (currencyname) the custom currency name for the amount granted
         * @cached
         */
        function currencyname(args) {
            return {result: currencyName(currencyId, granted), cache: true};
        }

        /*
         * @localtransformer currencybal
         * @formula (currencybal) the gifter's new balance, formatted with the custom currency name
         * @cached
         */
        function currencybal(args) {
            return {result: $.jsString($.currencies.getString(currencyId, balance)), cache: true};
        }

        return {
            'name': name,
            'giftedamount': giftedamount,
            'amount': amount,
            'currencygranted': currencygranted,
            'currencyname': currencyname,
            'currencybal': currencybal
        };
    }

    function processGift(event, giftedSubs) {
        if (!enabled || !customCurrenciesReady()) {
            return;
        }

        giftedSubs = parsePositiveInt(giftedSubs);
        if (giftedSubs === null) {
            return;
        }

        var gifter = $.jsString(event.getUsername()).toLowerCase(),
            ids = $.inidb.GetKeyList(REWARDS, '');

        if ($.equalsIgnoreCase(gifter, 'anonymous')) {
            return;
        }

        for (var i in ids) {
            var currencyId = normalizeCurrencyId(ids[i]);
            if (currencyId === '' || !$.currencies.exists(currencyId)) {
                continue;
            }

            var granted = rewardFor(currencyId, giftedSubs);
            if (granted <= 0) {
                continue;
            }

            var balance = $.currencies.give(gifter, currencyId, granted);
            if (balance === null) {
                continue;
            }

            if (!blank(message)) {
                var out = $.transformers.tags(event, $.jsString(message), ['twitch', 'noevent'], {
                    localTransformers: localTransformers(currencyId, giftedSubs, granted, balance)
                });
                if (out !== null && $.jsString(out).trim() !== '') {
                    $.say(out);
                }
            }
        }
    }

    function gifterKey(event) {
        return $.jsString(event.getUsername()).toLowerCase();
    }

    function removePendingGift(gifter, pending) {
        var gifts = pendingSingleGifts[gifter],
            index;

        if (gifts === undefined) {
            return false;
        }

        index = gifts.indexOf(pending);
        if (index === -1) {
            return false;
        }

        gifts.splice(index, 1);
        if (gifts.length === 0) {
            delete pendingSingleGifts[gifter];
        }
        return true;
    }

    /*
     * Live Twitch delivery can publish the recipient subgift USERNOTICEs before
     * the submysterygift USERNOTICE. The Java event's fromBulk flag cannot be
     * set in that ordering, so hold individual rewards briefly for reconciliation
     * with a following mass-gift event.
     */
    function queueSingleGift(event) {
        var gifter = gifterKey(event),
            pending = {
                'event': event,
                'timer': null
            };

        pendingSingleGiftsLock.lock();
        try {
            if (pendingSingleGifts[gifter] === undefined) {
                pendingSingleGifts[gifter] = [];
            }
            pendingSingleGifts[gifter].push(pending);
            pending.timer = setTimeout(function () {
                var shouldProcess;

                pendingSingleGiftsLock.lock();
                try {
                    shouldProcess = removePendingGift(gifter, pending);
                } finally {
                    pendingSingleGiftsLock.unlock();
                }

                if (shouldProcess) {
                    processGift(event, 1);
                }
            }, MASS_GIFT_SETTLEMENT_MS, SCRIPT);
        } finally {
            pendingSingleGiftsLock.unlock();
        }
    }

    function processMassGift(event) {
        var gifter = gifterKey(event),
            amount = parsePositiveInt(event.getAmount()),
            gifts,
            pending = [];

        if (amount === null) {
            return;
        }

        pendingSingleGiftsLock.lock();
        try {
            gifts = pendingSingleGifts[gifter];
            if (gifts !== undefined) {
                pending = gifts.splice(Math.max(0, gifts.length - amount), amount);
                if (gifts.length === 0) {
                    delete pendingSingleGifts[gifter];
                }
            }
        } finally {
            pendingSingleGiftsLock.unlock();
        }

        for (var i = 0; i < pending.length; i++) {
            clearTimeout(pending[i].timer);
        }
        processGift(event, amount);
    }

    function listCurrency(currencyId) {
        var map = getRewardMap(currencyId),
            points = sortedBreakpoints(map),
            parts = [];

        for (var i = 0; i < points.length; i++) {
            parts.push(points[i] + '=>' + map[String(points[i])]);
        }

        return parts.join(', ');
    }

    function allConfiguredCurrencies() {
        var ids = $.inidb.GetKeyList(REWARDS, ''),
            out = [];

        for (var i in ids) {
            out.push($.jsString(ids[i]));
        }

        out.sort();
        return out;
    }

    /*
     * @event twitchSubscriptionGift
     * @usestransformers local global twitch noevent
     */
    $.bind('twitchSubscriptionGift', function (event) {
        if (event.fromBulk()) {
            return;
        }
        queueSingleGift(event);
    });

    /*
     * @event twitchMassSubscriptionGifted
     * @usestransformers local global twitch noevent
     */
    $.bind('twitchMassSubscriptionGifted', function (event) {
        processMassGift(event);
    });

    /*
     * @event command
     */
    $.bind('command', function (event) {
        var sender = event.getSender(),
            command = $.jsString(event.getCommand()),
            args = event.getArgs(),
            argsString = event.getArguments(),
            action = args.length > 0 ? $.jsString(args[0]).toLowerCase() : 'list';

        if (!$.equalsIgnoreCase(command, 'giftcurrencyreward')) {
            return;
        }

        if (!customCurrenciesReady()) {
            $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.missing.multicurrency'));
            return;
        }

        /*
         * @commandpath giftcurrencyreward - List configured gift-sub custom-currency rewards
         */
        /*
         * @commandpath giftcurrencyreward list (currencyId) - List configured gift-sub custom-currency rewards
         */
        if (action === 'list') {
            if (args.length > 1) {
                var lId = normalizeCurrencyId(args[1]),
                    list = listCurrency(lId);
                $.say($.whisperPrefix(sender) + (list === '' ? $.lang.get('giftsubcurrencyrewards.list.empty', lId) : $.lang.get('giftsubcurrencyrewards.list.one', lId, list)));
                return;
            }

            var ids = allConfiguredCurrencies();
            if (ids.length === 0) {
                $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.list.none'));
                return;
            }

            var parts = [];
            for (var i = 0; i < ids.length; i++) {
                parts.push(ids[i] + ': ' + listCurrency(ids[i]));
            }
            $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.list.all', parts.join(' | ')));
            return;
        }

        /*
         * @commandpath giftcurrencyreward toggle - Enable or disable gift-sub custom-currency rewards
         */
        if (action === 'toggle') {
            enabled = !enabled;
            $.setIniDbBoolean(SETTINGS, 'enabled', enabled);
            $.say($.whisperPrefix(sender) + (enabled ? $.lang.get('giftsubcurrencyrewards.toggle.on') : $.lang.get('giftsubcurrencyrewards.toggle.off')));
            return;
        }

        /*
         * @commandpath giftcurrencyreward message [message] - Set the gift-sub custom-currency reward message
         */
        if (action === 'message') {
            if (args.length < 2) {
                $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.message.usage'));
                return;
            }
            message = $.parseArgs(argsString, ' ', 2, true)[1];
            $.setIniDbString(SETTINGS, 'message', message);
            $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.message.set'));
            return;
        }

        /*
         * @commandpath giftcurrencyreward clearmsg - Clear the gift-sub custom-currency reward message
         */
        if (action === 'clearmsg') {
            message = '';
            $.setIniDbString(SETTINGS, 'message', message);
            $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.message.clear'));
            return;
        }

        /*
         * @commandpath giftcurrencyreward set [currencyId] [subsGifted] [currencyAmount] - Set a gift-sub reward breakpoint
         */
        if (action === 'set') {
            var sId = normalizeCurrencyId(args[1]),
                sSubs = parsePositiveInt(args[2]),
                sAmount = parsePositiveInt(args[3]);

            if (sId === '' || sSubs === null || sAmount === null) {
                $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.set.usage'));
                return;
            }
            if (!$.currencies.exists(sId)) {
                $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.unknown', sId));
                return;
            }

            setBreakpoint(sId, sSubs, sAmount);
            $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.set.ok', sId, sSubs, sAmount));
            return;
        }

        /*
         * @commandpath giftcurrencyreward remove [currencyId] [subsGifted] - Remove a gift-sub reward breakpoint
         */
        if (action === 'remove') {
            var rId = normalizeCurrencyId(args[1]),
                rSubs = parsePositiveInt(args[2]);

            if (rId === '' || rSubs === null) {
                $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.remove.usage'));
                return;
            }
            if (!removeBreakpoint(rId, rSubs)) {
                $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.remove.missing', rId, rSubs));
                return;
            }
            $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.remove.ok', rId, rSubs));
            return;
        }

        /*
         * @commandpath giftcurrencyreward clear [currencyId] - Remove all gift-sub reward breakpoints for one currency
         */
        if (action === 'clear') {
            var cId = normalizeCurrencyId(args[1]);
            if (cId === '') {
                $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.clear.usage'));
                return;
            }
            $.inidb.del(REWARDS, cId);
            $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.clear.ok', cId));
            return;
        }

        $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.usage'));
    });

    /*
     * @event webPanelSocketUpdate
     */
    $.bind('webPanelSocketUpdate', function (event) {
        if ($.equalsIgnoreCase(event.getScript(), SCRIPT)) {
            reloadSettings();
        }
    });

    /*
     * @event initReady
     */
    $.bind('initReady', function () {
        reloadSettings();
        $.registerChatCommand(SCRIPT, 'giftcurrencyreward', $.PERMISSION.Admin);
        $.registerChatSubcommand('giftcurrencyreward', 'list', $.PERMISSION.Admin);
        $.registerChatSubcommand('giftcurrencyreward', 'toggle', $.PERMISSION.Admin);
        $.registerChatSubcommand('giftcurrencyreward', 'message', $.PERMISSION.Admin);
        $.registerChatSubcommand('giftcurrencyreward', 'clearmsg', $.PERMISSION.Admin);
        $.registerChatSubcommand('giftcurrencyreward', 'set', $.PERMISSION.Admin);
        $.registerChatSubcommand('giftcurrencyreward', 'remove', $.PERMISSION.Admin);
        $.registerChatSubcommand('giftcurrencyreward', 'clear', $.PERMISSION.Admin);
    });

    $.giftSubCurrencyRewards = {
        setBreakpoint: setBreakpoint,
        removeBreakpoint: removeBreakpoint,
        rewardFor: rewardFor,
        processGift: processGift
    };
})();
