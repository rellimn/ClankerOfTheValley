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
 * queueCurrencyBridge.js
 *
 * Bridges the multi-currency system ($.currencies) and the timed event queue
 * ($.timedEventQueue): users spend a configured currency to add an entry to the queue.
 * If a mod rejects the entry, the currency is refunded via the queue's onReject callback.
 * Everyone pays (mods included); the stock !teq commands are untouched and remain free/mod-only.
 *
 * Talks only to the public $ APIs of both modules — neither module is edited. Settings live
 * in the 'queueCurrencySettings' table and are managed from the panel.
 */
(function () {
    var SCRIPT = './custom/queueCurrency/queueCurrencyBridge.js',
        SETTINGS = 'queueCurrencySettings',
        enabled = false,
        currencyId = '',
        amount = 100,
        timeLeft = 120,
        refundOnReject = true,
        submitCommand = '',        // configured viewer command name (matched in the handler)
        registeredCommand = '';    // what we actually registered (for clean unregister on change)

    /*
     * Re-reads settings and keeps the chat command registration in sync with the configured
     * name + enabled flag. Called at initReady and whenever the panel saves.
     */
    function reloadSettings() {
        enabled = $.getIniDbBoolean(SETTINGS, 'enabled', false);
        currencyId = $.jsString($.getIniDbString(SETTINGS, 'currencyId', '')).toLowerCase();
        amount = $.getIniDbNumber(SETTINGS, 'amount', 100);
        timeLeft = $.getIniDbNumber(SETTINGS, 'timeLeft', 120);
        refundOnReject = $.getIniDbBoolean(SETTINGS, 'refundOnReject', true);
        submitCommand = $.jsString($.getIniDbString(SETTINGS, 'command', 'queueentry')).toLowerCase();

        var desired = enabled ? submitCommand : '';
        if (desired !== registeredCommand) {
            if (registeredCommand !== '' && $.commandExists(registeredCommand)) {
                $.unregisterChatCommand(registeredCommand);
            }
            registeredCommand = '';
            if (desired !== '') {
                if (!$.commandExists(desired)) {
                    $.registerChatCommand(SCRIPT, desired, $.PERMISSION.Viewer);
                }
                registeredCommand = desired;
            }
        }
    }

    /*
     * @commandpath queueentry [your submission] - Spend the configured currency to add an entry to the timed event queue (command name and cost are configurable on the panel)
     */
    $.bind('command', function (event) {
        var command = $.jsString(event.getCommand());

        if (!enabled || submitCommand === '' || !$.equalsIgnoreCase(command, submitCommand)) {
            return;
        }

        var sender = event.getSender();

        if ($.currencies === undefined || $.timedEventQueue === undefined) {
            $.say($.whisperPrefix(sender) + $.lang.get('queuecurrency.noqueue'));
            return;
        }
        if (currencyId === '' || !$.currencies.exists(currencyId)) {
            $.say($.whisperPrefix(sender) + $.lang.get('queuecurrency.misconfigured'));
            return;
        }

        var content = event.getArguments();
        content = (content === undefined || content === null) ? '' : $.jsString(content);
        if (content.trim() === '') {
            $.say($.whisperPrefix(sender) + $.lang.get('queuecurrency.usage', submitCommand));
            return;
        }

        // Everyone pays for a submission, regardless of role. The free path is the mod-only
        // stock !teq commands, which this bridge does not touch.
        if (!$.currencies.charge(sender, currencyId, amount)) {
            $.say($.whisperPrefix(sender) + $.lang.get('queuecurrency.notenough', $.currencies.getString(currencyId, amount)));
            return;
        }
        var charged = (amount > 0);

        // Capture the cost so a later refund uses the price paid, not whatever is configured then.
        var capturedCurrency = currencyId,
            capturedAmount = amount,
            doRefund = refundOnReject;

        var id = $.timedEventQueue.add({
            sender: $.jsString(sender),
            content: content,
            timeLeft: timeLeft,
            onReject: function (item) {
                if (charged && doRefund) {
                    $.currencies.give(item.sender, capturedCurrency, capturedAmount);
                    $.say($.whisperPrefix(item.sender) + $.lang.get('queuecurrency.refunded', $.currencies.getString(capturedCurrency, capturedAmount)));
                }
            }
        });

        // Not enqueued (queue closed / invalid) — refund immediately so nothing is kept.
        if (id === null) {
            if (charged) {
                $.currencies.give(sender, capturedCurrency, capturedAmount);
            }
            $.say($.whisperPrefix(sender) + $.lang.get('queuecurrency.closed'));
            return;
        }

        if (charged) {
            $.say($.whisperPrefix(sender) + $.lang.get('queuecurrency.submitted', $.currencies.getString(capturedCurrency, capturedAmount)));
        } else {
            $.say($.whisperPrefix(sender) + $.lang.get('queuecurrency.submitted.free'));
        }
    });

    // Panel save → reload settings and re-register the command if the name/enabled changed.
    $.bind('webPanelSocketUpdate', function (event) {
        if ($.equalsIgnoreCase(event.getScript(), SCRIPT)) {
            reloadSettings();
        }
    });

    $.bind('initReady', function () {
        // Seed defaults so the panel can discover them.
        $.getSetIniDbBoolean(SETTINGS, 'enabled', false);
        $.getSetIniDbString(SETTINGS, 'currencyId', '');
        $.getSetIniDbNumber(SETTINGS, 'amount', 100);
        $.getSetIniDbNumber(SETTINGS, 'timeLeft', 120);
        $.getSetIniDbBoolean(SETTINGS, 'refundOnReject', true);
        $.getSetIniDbString(SETTINGS, 'command', 'queueentry');

        reloadSettings();
    });
})();
