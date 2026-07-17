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
 * Awards custom currency for supported payment sources. Every source and
 * custom-currency pair has its own formula, evaluated directly against the
 * source amount without an intermediate fiat-currency conversion.
 */
(function () {
    var SCRIPT = './custom/giftSubCurrencyRewards/giftSubCurrencyRewards.js',
        SETTINGS = 'giftSubCurrencyRewards',
        FORMULAS = 'giftSubCurrencyRewardFormulas',
        PROCESSED_PAYMENTS = 'giftSubCurrencyRewardPayments',
        MASS_GIFT_SETTLEMENT_MS = 3000,
        PAYMENT_SOURCES = {
            'giftsub': {'label': 'Gift Subs', 'unit': 'gift sub'},
            'bits': {'label': 'Bits', 'unit': 'Bit'},
            'streamelements': {'label': 'StreamElements', 'unit': 'donation unit'}
        },
        enabled,
        message,
        pendingSingleGifts = {},
        pendingSingleGiftsLock = new Packages.java.util.concurrent.locks.ReentrantLock(),
        processedPaymentsLock = new Packages.java.util.concurrent.locks.ReentrantLock();

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

    function parsePositiveAmount(v) {
        return positiveNumber(v, null);
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

    function normalizeSource(source) {
        source = blank(source) ? '' : $.jsString(source).toLowerCase();
        return PAYMENT_SOURCES.hasOwnProperty(source) ? source : '';
    }

    function formulaKey(source, currencyId) {
        source = normalizeSource(source);
        currencyId = normalizeCurrencyId(currencyId);
        return source === '' || currencyId === '' ? '' : source + ':' + currencyId;
    }

    function getFormula(source, currencyId) {
        var key = formulaKey(source, currencyId);
        return key === '' ? '' : $.getIniDbString(FORMULAS, key, '');
    }

    /*
     * Evaluates a deliberately small expression language. The only variable is
     * x (the source amount); operators are +, -, *, / and parentheses. Adjacent
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

    function floorReward(value) {
        var tolerance = Math.max(1, Math.abs(value)) * 1e-12;
        return Math.floor(value + tolerance);
    }

    function rewardFor(source, currencyId, sourceAmount) {
        var result = evaluateFormula(getFormula(source, currencyId), sourceAmount);
        return result === null ? 0 : floorReward(result);
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
            'currencygranted': currencygranted,
            'currencyname': currencyname,
            'currencybal': currencybal
        };
    }

    function processPayment(event, source, donor, units) {
        if (!enabled || !customCurrenciesReady() || !PAYMENT_SOURCES.hasOwnProperty(source)) {
            return;
        }

        units = parsePositiveAmount(units);
        donor = $.jsString(donor).toLowerCase();
        if (units === null || $.equalsIgnoreCase(donor, 'anonymous')) {
            return;
        }

        var payment = {'source': source, 'donor': donor, 'units': units},
            currencies = $.currencies.list(),
            i;
        for (i = 0; i < currencies.length; i++) {
            var currencyId = normalizeCurrencyId(currencies[i].id),
                granted,
                balance,
                out;

            if (currencyId === '' || !$.currencies.exists(currencyId)) {
                continue;
            }
            granted = rewardFor(source, currencyId, units);
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

    /*
     * StreamElements formulas receive the donation amount exactly as reported.
     * No fiat exchange-rate conversion is performed.
     *
     * @event streamElementsDonation
     * @usestransformers local global twitch noevent
     */
    $.bind('streamElementsDonation', function (event) {
        var data,
            donation,
            donationId,
            shouldProcess = false;

        try {
            data = JSON.parse(event.getJsonString());
            donation = data.donation;
            if (donation === undefined || donation.user === undefined || blank(donation.user.username) || parsePositiveAmount(donation.amount) === null) {
                return;
            }
            donationId = String(data._id);
            if (donationId === '') {
                return;
            }
        } catch (ex) {
            return;
        }

        processedPaymentsLock.lock();
        try {
            if (!$.inidb.exists(PROCESSED_PAYMENTS, 'streamelements:' + donationId)) {
                $.inidb.set(PROCESSED_PAYMENTS, 'streamelements:' + donationId, 'true');
                shouldProcess = true;
            }
        } finally {
            processedPaymentsLock.unlock();
        }

        if (shouldProcess) {
            processPayment(event, 'streamelements', donation.user.username, donation.amount);
        }
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
            key,
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
                key = $.jsString(ids[i]).toLowerCase();
                if (/^(giftsub|bits|streamelements):[a-z0-9_]+$/.test(key)) {
                    parts.push(key + ': ' + $.getIniDbString(FORMULAS, key, ''));
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
         * @commandpath giftcurrencyreward set [giftsub|bits|streamelements] [currencyId] [formula] - Set a direct source-to-currency formula
         */
        if (action === 'set') {
            source = normalizeSource(args[1]);
            currencyId = normalizeCurrencyId(args[2]);
            formula = args.length > 3 ? args.slice(3).join(' ') : '';
            if (source === '' || currencyId === '' || evaluateFormula(formula, 1) === null) {
                $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.set.usage'));
                return;
            }
            if (!customCurrenciesReady() || !$.currencies.exists(currencyId)) {
                $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.unknown', currencyId));
                return;
            }
            $.setIniDbString(FORMULAS, formulaKey(source, currencyId), formula);
            $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.set.ok', source, currencyId, formula));
            return;
        }

        /*
         * @commandpath giftcurrencyreward remove [giftsub|bits|streamelements] [currencyId] - Remove a direct source-to-currency formula
         */
        if (action === 'remove') {
            source = normalizeSource(args[1]);
            currencyId = normalizeCurrencyId(args[2]);
            key = formulaKey(source, currencyId);
            if (key === '' || !$.inidb.exists(FORMULAS, key)) {
                $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.remove.missing', source, currencyId));
                return;
            }
            $.inidb.del(FORMULAS, key);
            $.say($.whisperPrefix(sender) + $.lang.get('giftsubcurrencyrewards.remove.ok', source, currencyId));
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
