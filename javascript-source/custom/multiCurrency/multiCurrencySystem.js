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
 * multiCurrencySystem.js
 *
 * A generic multi-currency / item layer that sits alongside the stock single "points"
 * currency. Operators define any number of named currencies (gold, gems, ...); each has
 * its own per-user balance table. Commands can be priced in a chosen currency from the
 * panel, charging that currency instead of points.
 *
 * Integration with the stock command-cost path is done by WRAPPING (not editing) the three
 * by-reference $ functions init.js uses for pricing — $.priceCom, $.getCommandPrice and
 * $.returnCommandCost. For a command priced in a custom currency the wrapper gates on that
 * currency and returns -1 ("no points cost") so the hardcoded points deduction in init.js
 * is skipped; the real debit happens once in the 'command' bind below, after init.js has
 * cleared the permission + price + cooldown gates. See the project plan for the full rationale.
 *
 * Exports: $.currencies (see export block at the bottom).
 */
(function () {
    var SCRIPT = './custom/multiCurrency/multiCurrencySystem.js',
        DEFS = 'currencyDefs',              // key: currencyId          value: {name, plural} JSON
        BAL_PREFIX = 'currencyBal_',        // table per currency       key: username  value: amount
        CMD_TYPE = 'commandCurrencyType',   // key: command-key         value: currencyId
        CMD_PRICE = 'commandCurrencyPrice', // key: command-key         value: amount
        MOD_BYPASS = 'commandCurrencyModBypass', // key: command-key    value: boolean (mods bypass the cost)
        maxUpdateRetries = 3;

    /* ------------------------------------------------------------------ *
     * Currency definitions
     * ------------------------------------------------------------------ */

    function currencyExists(id) {
        return $.inidb.exists(DEFS, $.jsString(id).toLowerCase());
    }

    function getDef(id) {
        id = $.jsString(id).toLowerCase();
        if (!$.inidb.exists(DEFS, id)) {
            return null;
        }
        try {
            var obj = JSON.parse($.getIniDbString(DEFS, id, '{}'));
            return {
                id: id,
                name: (obj.name === undefined || obj.name === null || obj.name === '') ? id : $.jsString(obj.name),
                plural: (obj.plural === undefined || obj.plural === null || obj.plural === '') ? ((obj.name === undefined || obj.name === null || obj.name === '') ? id : $.jsString(obj.name)) : $.jsString(obj.plural)
            };
        } catch (ex) {
            return { id: id, name: id, plural: id };
        }
    }

    function listCurrencies() {
        var out = [],
            keys = $.inidb.GetKeyList(DEFS, ''),
            i;
        for (i in keys) {
            var d = getDef($.jsString(keys[i]));
            if (d !== null) {
                out.push(d);
            }
        }
        return out;
    }

    function defineCurrency(id, name, plural) {
        id = $.jsString(id).toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (id === '') {
            return false;
        }
        if (name === undefined || name === null || $.jsString(name).trim() === '') {
            name = id;
        }
        if (plural === undefined || plural === null || $.jsString(plural).trim() === '') {
            plural = name;
        }
        $.inidb.set(DEFS, id, JSON.stringify({ name: $.jsString(name), plural: $.jsString(plural) }));
        return true;
    }

    function removeCurrency(id) {
        id = $.jsString(id).toLowerCase();
        if (!$.inidb.exists(DEFS, id)) {
            return false;
        }
        $.inidb.del(DEFS, id);
        $.inidb.RemoveFile(BAL_PREFIX + id);
        return true;
    }

    function getCurrencyString(id, amount) {
        var def = getDef(id),
            name;
        if (def === null) {
            name = $.jsString(id);
        } else {
            name = (parseInt(amount, 10) === 1 ? def.name : def.plural);
        }
        return amount + ' ' + name;
    }

    /* ------------------------------------------------------------------ *
     * Balances — concurrency-safe via SafeChangeLong CAS, mirroring
     * systems/pointSystem.js. inidb writes are atomic; the CAS retry loop
     * guards read-modify-write against concurrent command dispatch.
     * ------------------------------------------------------------------ */

    function balTable(id) {
        return BAL_PREFIX + $.jsString(id).toLowerCase();
    }

    function getBalance(username, id) {
        return $.getIniDbNumber(balTable(id), $.jsString(username).toLowerCase(), 0);
    }

    function updateBalanceInternal(table, username, orig, value, calcfunc, retry) {
        if (retry === undefined || retry === null || retry < 0) {
            retry = 0;
        }

        if ($.inidb.SafeChangeLong(table, '', username, orig, value)) {
            return value;
        } else if (retry < maxUpdateRetries) {
            return calcfunc(username, $.getIniDbNumber(table, username, 0), value, retry + 1);
        }

        return null;
    }

    function updateBalance(table, username, orig, value, calcfunc) {
        function calcInternal(username, current, value, retry) {
            var newval = calcfunc(username, current, value);
            if (newval !== undefined && newval !== null) {
                return updateBalanceInternal(table, username, current, newval, calcInternal, retry);
            }
            return null;
        }

        return updateBalanceInternal(table, username, orig, value, calcInternal, 0);
    }

    function giveCurrency(username, id, amount) {
        username = $.jsString(username).toLowerCase();
        amount = parseInt(amount, 10);
        if (isNaN(amount)) {
            return null;
        }
        var table = balTable(id),
            current = $.getIniDbNumber(table, username, 0);

        function calc(u, cur, val) {
            return cur + amount;
        }

        return updateBalance(table, username, current, current + amount, calc);
    }

    function takeCurrency(username, id, amount, zero) {
        username = $.jsString(username).toLowerCase();
        amount = parseInt(amount, 10);
        if (isNaN(amount)) {
            return null;
        }
        if (zero === undefined || zero === null) {
            zero = false;
        }
        var table = balTable(id),
            current = $.getIniDbNumber(table, username, 0);

        if (current < amount) {
            if (zero) {
                $.setIniDbNumber(table, username, 0);
                return 0;
            }
            return null;
        }

        function calc(u, cur, val) {
            if (cur < amount) {
                return zero ? 0 : null;
            }
            return cur - amount;
        }

        return updateBalance(table, username, current, current - amount, calc);
    }

    function setBalance(username, id, amount) {
        $.setIniDbNumber(balTable(id), $.jsString(username).toLowerCase(), parseInt(amount, 10));
    }

    /*
     * Affordability check + debit in one call. Returns true if the user could pay (and was
     * charged) or the amount was non-positive; false if they could not afford it or the
     * currency does not exist. This is the helper coded commands call at the top of a handler.
     */
    function chargeCurrency(username, id, amount) {
        amount = parseInt(amount, 10);
        if (isNaN(amount) || amount <= 0) {
            return true;
        }
        if (!currencyExists(id)) {
            return false;
        }
        return takeCurrency(username, id, amount) !== null;
    }

    /* ------------------------------------------------------------------ *
     * Command pricing — mirror the stock pricecom key fallback scheme
     * (core/commandRegister.js getCommandPrice): try 'cmd sub', then 'cmd'.
     * A command is "ours" iff commandCurrencyPrice has a positive entry AND
     * commandCurrencyType names an existing currency. Otherwise null => the
     * wrappers delegate to the stock points path.
     * ------------------------------------------------------------------ */

    function priceOf(command, subCommand) {
        command = $.jsString(command).toLowerCase();
        subCommand = (subCommand === undefined || subCommand === null) ? '' : $.jsString(subCommand).toLowerCase();

        var keys = [];
        if (subCommand !== '') {
            keys.push(command + ' ' + subCommand);
        }
        keys.push(command);

        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if ($.inidb.exists(CMD_PRICE, k)) {
                var id = $.jsString($.getIniDbString(CMD_TYPE, k, '')).toLowerCase();
                if (id !== '' && id !== 'points' && currencyExists(id)) {
                    var amount = $.getIniDbNumber(CMD_PRICE, k, 0);
                    if (amount > 0) {
                        return { id: id, amount: amount, key: k };
                    }
                }
            }
        }
        return null;
    }

    /*
     * Whether mods bypass the cost for a given command. Per-command override stored in the
     * MOD_BYPASS table; defaults to true (mods bypass), preserving the historic default.
     */
    function modBypasses(key) {
        return $.getIniDbBoolean(MOD_BYPASS, key, true);
    }

    /*
     * Whether a charge applies to this user for this command. Non-mods always pay; the bot never
     * pays; mods pay only when the command's per-command mod-bypass toggle is off.
     */
    function chargeApplies(isMod, username, key) {
        if (!isMod) {
            return true;
        }
        if ($.isBot(username)) {
            return false;
        }
        return !modBypasses(key);
    }

    /* ------------------------------------------------------------------ *
     * Wrap the stock by-reference pricing functions (install once; guard
     * against double-wrap on !reloadcustom).
     * ------------------------------------------------------------------ */

    if ($.priceCom !== undefined && $.priceCom.isMultiCurrencyWrapped !== true) {
        var _origPriceCom = $.priceCom;
        var wrappedPriceCom = function (username, command, subCommand, isMod) {
            var cc = priceOf(command, subCommand);
            if (cc === null) {
                return _origPriceCom(username, command, subCommand, isMod);
            }
            if (!chargeApplies(isMod, username, cc.key)) {
                return -1; // mod exempt — allow, no charge
            }
            if (getBalance(username, cc.id) < cc.amount) {
                $.say($.whisperPrefix(username) + $.lang.get('multicurrency.cmd.notenough', getCurrencyString(cc.id, cc.amount)));
                return 1; // block — init.js suppresses the command
            }
            return -1; // afford — return -1 so init.js skips its hardcoded points decr; we debit in the 'command' bind
        };
        wrappedPriceCom.isMultiCurrencyWrapped = true;
        $.priceCom = wrappedPriceCom;
    }

    if ($.returnCommandCost !== undefined && $.returnCommandCost.isMultiCurrencyWrapped !== true) {
        var _origReturnCommandCost = $.returnCommandCost;
        var wrappedReturnCommandCost = function (sender, command, isMod) {
            var cc = priceOf(command, '');
            if (cc === null) {
                _origReturnCommandCost(sender, command, isMod);
                return;
            }
            if (!chargeApplies(isMod, sender, cc.key)) {
                return;
            }
            giveCurrency(sender, cc.id, cc.amount);
        };
        wrappedReturnCommandCost.isMultiCurrencyWrapped = true;
        $.returnCommandCost = wrappedReturnCommandCost;
    }

    /* ------------------------------------------------------------------ *
     * Debit bind — runs once per dispatched command (init.js callHook),
     * only after permission + price + cooldown gates have passed. Mirrors
     * the unconditional points decr at init.js:815 but for our currency.
     * ------------------------------------------------------------------ */

    $.bind('command', function (event) {
        var command = $.jsString(event.getCommand()),
            args = event.getArgs(),
            sub = $.getSubCommandFromArguments(command, args),
            cc = priceOf(command, sub);

        if (cc === null) {
            return;
        }

        var sender = event.getSender(),
            isMod = $.checkUserPermission(sender, event.getTags(), $.PERMISSION.Mod);

        if (!chargeApplies(isMod, sender, cc.key)) {
            return;
        }

        takeCurrency(sender, cc.id, cc.amount);
    });

    // !currency command — balance ops (currency definitions are primarily a panel job).
    // One @commandpath block per path: the doc parser keeps only the last path in a block
    // and closes a block only on a line that is exactly "*/".

    /**
     * @commandpath currency - Show your balances across all defined currencies
     */
    /**
     * @commandpath currency [currencyId] - Show your balance in one currency
     */
    /**
     * @commandpath currency list - List the defined currencies
     */
    /**
     * @commandpath currency give [username] [currencyId] [amount] - Give a user an amount of a currency
     */
    /**
     * @commandpath currency take [username] [currencyId] [amount] - Take an amount of a currency from a user
     */
    /**
     * @commandpath currency set [username] [currencyId] [amount] - Set a user's balance in a currency
     */
    /**
     * @commandpath currency add [currencyId] [name] [plural] - Define a new currency
     */
    /**
     * @commandpath currency remove [currencyId] - Delete a currency and all of its balances
     */
    $.bind('command', function (event) {
        var sender = event.getSender(),
            command = $.jsString(event.getCommand()),
            args = event.getArgs(),
            action = (args[0] !== undefined && args[0] !== null) ? $.jsString(args[0]) : undefined;

        if (!$.equalsIgnoreCase(command, 'currency')) {
            return;
        }

        // No args: list the caller's balances.
        if (action === undefined) {
            var mine = listCurrencies();
            if (mine.length === 0) {
                $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.none'));
                return;
            }
            var parts = [];
            for (var i = 0; i < mine.length; i++) {
                parts.push(getCurrencyString(mine[i].id, getBalance(sender, mine[i].id)));
            }
            $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.balance.self', parts.join(', ')));
            return;
        }

        action = action.toLowerCase();

        if (action === 'list') {
            var defs = listCurrencies();
            if (defs.length === 0) {
                $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.none'));
                return;
            }
            var labels = [];
            for (var j = 0; j < defs.length; j++) {
                labels.push(defs[j].id + ' (' + defs[j].name + ')');
            }
            $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.list', labels.join(', ')));
            return;
        }

        if (action === 'give' || action === 'take' || action === 'set') {
            var tUser = (args[1] !== undefined) ? $.jsString(args[1]).toLowerCase().replace('@', '') : undefined,
                tId = (args[2] !== undefined) ? $.jsString(args[2]).toLowerCase() : undefined,
                tAmt = (args[3] !== undefined) ? parseInt(args[3], 10) : NaN;

            if (tUser === undefined || tId === undefined || isNaN(tAmt) || tAmt < 0) {
                $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.admin.usage', action));
                return;
            }
            if (!currencyExists(tId)) {
                $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.unknown', tId));
                return;
            }

            if (action === 'give') {
                giveCurrency(tUser, tId, tAmt);
            } else if (action === 'take') {
                takeCurrency(tUser, tId, tAmt, true);
            } else {
                setBalance(tUser, tId, tAmt);
            }
            $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.admin.success', action, tUser, getCurrencyString(tId, getBalance(tUser, tId))));
            return;
        }

        if (action === 'add') {
            var aId = (args[1] !== undefined) ? $.jsString(args[1]) : undefined;
            if (aId === undefined) {
                $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.add.usage'));
                return;
            }
            var aName = (args[2] !== undefined) ? $.jsString(args[2]) : aId,
                aPlural = (args[3] !== undefined) ? $.jsString(args[3]) : aName;
            if (!defineCurrency(aId, aName, aPlural)) {
                $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.add.invalid'));
                return;
            }
            $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.add.success', $.jsString(aId).toLowerCase()));
            return;
        }

        if (action === 'remove') {
            var rId = (args[1] !== undefined) ? $.jsString(args[1]).toLowerCase() : undefined;
            if (rId === undefined || !removeCurrency(rId)) {
                $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.remove.fail'));
                return;
            }
            $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.remove.success', rId));
            return;
        }

        // Otherwise treat the first arg as a currency id and show the caller's balance.
        if (currencyExists(action)) {
            $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.balance.one', getCurrencyString(action, getBalance(sender, action))));
            return;
        }

        $.say($.whisperPrefix(sender) + $.lang.get('multicurrency.usage'));
    });

    /* ------------------------------------------------------------------ *
     * Registration
     * ------------------------------------------------------------------ */

    $.bind('initReady', function () {
        $.registerChatCommand(SCRIPT, 'currency', $.PERMISSION.Viewer);
        $.registerChatSubcommand('currency', 'list', $.PERMISSION.Viewer);
        $.registerChatSubcommand('currency', 'give', $.PERMISSION.Admin);
        $.registerChatSubcommand('currency', 'take', $.PERMISSION.Admin);
        $.registerChatSubcommand('currency', 'set', $.PERMISSION.Admin);
        $.registerChatSubcommand('currency', 'add', $.PERMISSION.Admin);
        $.registerChatSubcommand('currency', 'remove', $.PERMISSION.Admin);
    });

    /* ------------------------------------------------------------------ *
     * Exports
     * ------------------------------------------------------------------ */

    $.currencies = {
        list: listCurrencies,
        exists: currencyExists,
        define: defineCurrency,
        remove: removeCurrency,
        get: getBalance,
        give: giveCurrency,
        take: takeCurrency,
        set: setBalance,
        getString: getCurrencyString,
        charge: chargeCurrency,
        priceOf: priceOf
    };
})();
