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
 * Awards custom currency for supported payment sources. Each source converts
 * its native unit to EUR using an operator-configured constant. Each custom
 * currency then evaluates its own EUR-to-currency arithmetic expression.
 */
(function () {
    var SCRIPT = './custom/giftSubCurrencyRewards/giftSubCurrencyRewards.js',
        SETTINGS = 'giftSubCurrencyRewards',
        FORMULAS = 'giftSubCurrencyRewardFormulas',
        MASS_GIFT_SETTLEMENT_MS = 3000,
        PAYMENT_SOURCES = {
            'giftsub': {'label': 'Gift subs', 'unit': 'gift sub', 'setting': 'giftSubEurPerUnit', 'defaultRate': 1},
            'bits': {'label': 'Bits', 'unit': 'Bit', 'setting': 'bitsEurPerUnit', 'defaultRate': 0.005}
        },
        enabled,
        message,
        sourceRates = {},
        pendingSingleGifts = {},
        pendingSingleGiftsLock = new Packages.java.util.concurrent.locks.ReentrantLock();

    function blank(v) {
        return v === undefined || v === null || $.jsString(v).trim() === '';
    }

    function positiveNumber(v, fallback) {
        var n = parseFloat(v);
        return isNaN(n) || !isFinite(n) || n <= 0 ? fallback : n;
    }

    function parsePositiveInt(v) {
        var n = parseInt(v, 10);
        return isNaN(n) || n <= 0 ? null : n;
    }

    function reloadSettings() {
        var source;
        enabled = $.getSetIniDbBoolean(SETTINGS, 'enabled', true);
        message = $.getSetIniDbString(SETTINGS, 'message', '');
        for (source in PAYMENT_SOURCES) {
            if (PAYMENT_SOURCES.hasOwnProperty(source)) {
                sourceRates[source] = positiveNumber($.getSetIniDbFloat(SETTINGS, PAYMENT_SOURCES[source].setting, PAYMENT_SOURCES[source].defaultRate), PAYMENT_SOURCES[source].defaultRate);
            }
        }
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

    function getFormula(currencyId) {
        currencyId = normalizeCurrencyId(currencyId);
        return currencyId === '' ? '' : $.getIniDbString(FORMULAS, currencyId, '');
    }

    /*
     * Evaluates a deliberately small expression language. The only variable is
     * x (the EUR amount); operators are +, -, *, / and parentheses. Adjacent
     * values multiply, so both "2*x + 1" and "2x + 1" are valid.
     */
    function evaluateFormula(formula, x) {
        var input = $.jsString(formula),
            index = 0,
            length = input.length;

        function skipWhitespace() {
            while (index < length && /\s/.test(input.charAt(index))) {
                index++;
            }
        }

        function factorStarts() {
            skipWhitespace();
            return index < length && (input.charAt(index) === '(' || input.charAt(index) === 'x' || input.charAt(index) === 'X' || input.charAt(index) === '.' || /[0-9]/.test(input.charAt(index)));
        }

        function factor() {
            var sign = 1,
                start,
                match,
                value;

            skipWhitespace();
            while (input.charAt(index) === '+' || input.charAt(index) === '-') {
                if (input.charAt(index) === '-') {
                    sign *= -1;
                }
                index++;
                skipWhitespace();
            }

            if (input.charAt(index) === '(') {
                index++;
                value = expression();
                skipWhitespace();
                if (input.charAt(index) !== ')') {
                    throw 'Missing closing parenthesis';
                }
                index++;
                return sign * value;
            }

            if (input.charAt(index) === 'x' || input.charAt(index) === 'X') {
                index++;
                return sign * x;
            }

            start = input.substring(index);
            match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(start);
            if (match === null) {
                throw 'Expected a number, x, or parenthesis';
            }
            index += match[0].length;
            return sign * parseFloat(match[0]);
        }

        function term() {
            var value = factor(),
                operator;

            while (true) {
                skipWhitespace();
                operator = input.charAt(index);
                if (operator === '*' || operator === '/') {
                    index++;
                    var right = factor();
                    if (operator === '/' && right === 0) {
                        throw 'Division by zero';
                    }
                    value = operator === '*' ? value * right : value / right;
                } else if (factorStarts()) {
                    value *= factor();
                } else {
                    return value;
                }
            }
        }

        function expression() {
            var value = term(),
                operator;

            while (true) {
                skipWhitespace();
                operator = input.charAt(index);
                if (operator !== '+' && operator !== '-') {
                    return value;
                }
                index++;
                value = operator === '+' ? value + term() : value - term();
            }
        }

        try {
            if (input.trim() === '' || !isFinite(x)) {
                return null;
            }
            var result = expression();
            skipWhitespace();
            return index === length && isFinite(result) ? result : null;
        } catch (ex) {
            return null;
        }
    }

    function rewardFor(currencyId, euroAmount) {
        var result = evaluateFormula(getFormula(currencyId), euroAmount);
        return result === null ? 0 : Math.floor(result);
    }

    function currencyName(currencyId, amount) {
        var formatted = $.jsString($.currencies.getString(currencyId, amount));
        return formatted.replace(/^\s*-?\d+\s+/, '');
    }

    function localTransformers(currencyId, payment, granted, balance) {
        /*
         * @localtransformer name
         * @formula (name) the user who made the payment
         * @cached
         */
        function name() { return {result: payment.donor, cache: true}; }
        /*
         * @localtransformer amount
         * @formula (amount) the number of source units paid
         * @cached
         */
        function amount() { return {result: String(payment.units), cache: true}; }
        /*
         * @localtransformer giftedamount
         * @formula (giftedamount) compatibility alias for (amount)
         * @cached
         */
        function giftedamount() { return {result: String(payment.units), cache: true}; }
        /*
         * @localtransformer source
         * @formula (source) the payment source name
         * @cached
         */
        function source() { return {result: PAYMENT_SOURCES[payment.source].label, cache: true}; }
        /*
         * @localtransformer unitamount
         * @formula (unitamount) the number of source units paid
         * @cached
         */
        function unitamount() { return {result: String(payment.units), cache: true}; }
        /*
         * @localtransformer euramount
         * @formula (euramount) the payment value in EUR after the source conversion
         * @cached
         */
        function euramount() { return {result: String(payment.euros), cache: true}; }
        /*
         * @localtransformer currencygranted
         * @formula (currencygranted) the custom currency amount granted for this payment
         * @cached
         */
        function currencygranted() { return {result: String(granted), cache: true}; }
        /*
         * @localtransformer currencyname
         * @formula (currencyname) the custom currency name for the amount granted
         * @cached
         */
        function currencyname() { return {result: currencyName(currencyId, granted), cache: true}; }
        /*
         * @localtransformer currencybal
         * @formula (currencybal) the payer's new formatted custom-currency balance
         * @cached
         */
        function currencybal() { return {result: $.jsString($.currencies.getString(currencyId, balance)), cache: true}; }

        return {
            'name': name,
            'amount': amount,
            'giftedamount': giftedamount,
            'source': source,
            'unitamount': unitamount,
            'euramount': euramount,
            'currencygranted': currencygranted,
            'currencyname': currencyname,
            'currencybal': currencybal
        };
    }

    function eurPerUnit(source) {
        return sourceRates.hasOwnProperty(source) ? sourceRates[source] : null;
    }

    function processPayment(event, source, donor, units) {
        if (!enabled || !customCurrenciesReady() || !PAYMENT_SOURCES.hasOwnProperty(source)) {
            return;
        }

        units = parsePositiveInt(units);
        donor = $.jsString(donor).toLowerCase();
        if (units === null || $.equalsIgnoreCase(donor, 'anonymous')) {
            return;
        }

        var conversion = eurPerUnit(source),
            payment,
            ids,
            i;
        if (conversion === null) {
            return;
        }

        payment = {'source': source, 'donor': donor, 'units': units, 'euros': units * conversion};
        ids = $.inidb.GetKeyList(FORMULAS, '');
        for (i in ids) {
            var currencyId = normalizeCurrencyId(ids[i]),
                granted,
                balance,
                out;

            if (currencyId === '' || !$.currencies.exists(currencyId)) {
                continue;
            }
            granted = rewardFor(currencyId, payment.euros);
            if (granted <= 0) {
                continue;
            }

            balance = $.currencies.give(donor, currencyId, granted);
            if (balance === null || blank(message)) {
                continue;
            }

            out = $.transformers.tags(event, $.jsString(message), ['twitch', 'noevent'], {
                localTransformers: localTransformers(currencyId, payment, granted, balance)
            });
            if (out !== null && $.jsString(out).trim() !== '') {
                $.say(out);
            }
        }
    }

    function gifterKey(event) {
        return $.jsString(event.getUsername()).toLowerCase();
    }

    function removePendingGift(gifter, pending) {
        var gifts = pendingSingleGifts[gifter], index;
        if (gifts === undefined || (index = gifts.indexOf(pending)) === -1) {
            return false;
        }
        gifts.splice(index, 1);
        if (gifts.length === 0) {
            delete pendingSingleGifts[gifter];
        }
        return true;
    }

    /* Hold individual gift events briefly so a following mass-gift can replace them. */
    function queueSingleGift(event) {
        var gifter = gifterKey(event), pending = {'event': event, 'timer': null};
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
                    processPayment(event, 'giftsub', gifter, 1);
                }
            }, MASS_GIFT_SETTLEMENT_MS, SCRIPT);
        } finally {
            pendingSingleGiftsLock.unlock();
        }
    }

    function processMassGift(event) {
        var gifter = gifterKey(event), amount = parsePositiveInt(event.getAmount()), gifts, pending = [], i;
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
        for (i = 0; i < pending.length; i++) {
            clearTimeout(pending[i].timer);
        }
        processPayment(event, 'giftsub', gifter, amount);
    }

    /*
     * @event twitchSubscriptionGift
     * @usestransformers local global twitch noevent
     */
    $.bind('twitchSubscriptionGift', function (event) {
        if (!event.fromBulk()) {
            queueSingleGift(event);
        }
    });

    /*
     * @event twitchMassSubscriptionGifted
     * @usestransformers local global twitch noevent
     */
    $.bind('twitchMassSubscriptionGifted', function (event) {
        processMassGift(event);
    });

    /*
     * @event twitchBits
     * @usestransformers local global twitch noevent
     */
    $.bind('twitchBits', function (event) {
        processPayment(event, 'bits', event.getUsername(), event.getBits());
    });

    /* @event command */
    $.bind('command', function (event) {
        var sender = event.getSender(),
            command = $.jsString(event.getCommand()),
            args = event.getArgs(),
            action = args.length === 0 ? 'list' : $.jsString(args[0]).toLowerCase(),
            currencyId,
            formula,
            source,
            rate,
            ids,
            parts,
            i;

        if (!$.equalsIgnoreCase(command, 'giftcurrencyreward')) {
            return;
        }

        /*
         * @commandpath giftcurrencyreward list - List configured payment custom-currency formulas
         */
        if (action === 'list') {
            ids = $.inidb.GetKeyList(FORMULAS, '');
            parts = [];
            for (i in ids) {
                currencyId = normalizeCurrencyId(ids[i]);
                if (currencyId !== '') {
                    parts.push(currencyId + ': ' + getFormula(currencyId));
                }
            }
            $.say($.whisperPrefix(sender) + (parts.length === 0 ? $.lang.get('giftsubcurrencyrewards.list.none') : $.lang.get('giftsubcurrencyrewards.list.all', parts.join(' | '))));
            return;
        }

        /*
         * @commandpath giftcurrencyreward toggle - Enable or disable payment custom-currency rewards
         */
        if (action === 'toggle') {
            enabled = !enabled;
            $.setIniDbBoolean(SETTINGS, 'enabled', enabled);
            $.say($.whisperPrefix(sender) + (enabled ? $.lang.get('giftsubcurrencyrewards.toggle.on') : $.lang.get('giftsubcurrencyrewards.toggle.off')));
            return;
        }

        /*
         * @commandpath giftcurrencyreward source [giftsub|bits] [EUR per unit] - Set a source conversion rate
         */
        if (action === 'source') {
            source = args.length > 1 ? $.jsString(args[1]).toLowerCase() : '';
            rate = args.length > 2 ? positiveNumber(args[2], null) : null;
            if (!PAYMENT_SOURCES.hasOwnProperty(source) || rate === null) {
                $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.source.usage'));
                return;
            }
            $.setIniDbFloat(SETTINGS, PAYMENT_SOURCES[source].setting, rate);
            reloadSettings();
            $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.source.set', PAYMENT_SOURCES[source].label, rate));
            return;
        }

        /*
         * @commandpath giftcurrencyreward set [currencyId] [formula] - Set an EUR-to-currency formula
         */
        if (action === 'set') {
            currencyId = normalizeCurrencyId(args[1]);
            formula = args.length > 2 ? args.slice(2).join(' ') : '';
            if (currencyId === '' || evaluateFormula(formula, 1) === null) {
                $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.set.usage'));
                return;
            }
            if (!customCurrenciesReady() || !$.currencies.exists(currencyId)) {
                $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.unknown', currencyId));
                return;
            }
            $.setIniDbString(FORMULAS, currencyId, formula);
            $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.set.ok', currencyId, formula));
            return;
        }

        /*
         * @commandpath giftcurrencyreward remove [currencyId] - Remove an EUR-to-currency formula
         */
        if (action === 'remove') {
            currencyId = normalizeCurrencyId(args[1]);
            if (currencyId === '' || !$.inidb.exists(FORMULAS, currencyId)) {
                $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.remove.missing', currencyId));
                return;
            }
            $.inidb.del(FORMULAS, currencyId);
            $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.remove.ok', currencyId));
            return;
        }

        $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.usage'));
    });

    /* @event webPanelSocketUpdate */
    $.bind('webPanelSocketUpdate', function (event) {
        if ($.equalsIgnoreCase(event.getScript(), SCRIPT)) {
            reloadSettings();
        }
    });

    /* @event initReady */
    $.bind('initReady', function () {
        reloadSettings();
        $.registerChatCommand(SCRIPT, 'giftcurrencyreward', $.PERMISSION.Admin);
        $.registerChatSubcommand('giftcurrencyreward', 'list', $.PERMISSION.Admin);
        $.registerChatSubcommand('giftcurrencyreward', 'toggle', $.PERMISSION.Admin);
        $.registerChatSubcommand('giftcurrencyreward', 'source', $.PERMISSION.Admin);
        $.registerChatSubcommand('giftcurrencyreward', 'set', $.PERMISSION.Admin);
        $.registerChatSubcommand('giftcurrencyreward', 'remove', $.PERMISSION.Admin);
    });

    reloadSettings();
    $.giftSubCurrencyRewards = {
        evaluateFormula: evaluateFormula,
        rewardFor: rewardFor,
        processPayment: processPayment
    };
})();
