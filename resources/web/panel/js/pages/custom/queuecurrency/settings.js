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

/* global socket, helpers, toastr */

/*
 * Panel UI for the queue-currency bridge. Reads/writes the 'queueCurrencySettings' table and
 * notifies queueCurrencyBridge.js (via wsEvent) to reload + re-register its command on save.
 */
$(function () {
    var SECTION = 'extra',
        SCRIPT = './custom/queueCurrency/queueCurrencyBridge.js',
        T = 'queueCurrencySettings';

    function isWritable() {
        var ns = window.__pbCustomPanel__;
        return (ns && typeof ns.panelSectionCanWrite === 'function') ? ns.panelSectionCanWrite(SECTION) : true;
    }

    function canWrite() {
        var ns = window.__pbCustomPanel__;
        return (ns && typeof ns.requirePanelSectionWrite === 'function') ? ns.requirePanelSectionWrite(SECTION) : true;
    }

    function applyWritable() {
        var w = isWritable();
        $('#mc-readonly-banner').toggle(!w);
        $('#qc-save').prop('disabled', !w);
    }

    function loadCurrencyOptions(selected) {
        socket.getDBTableValues('qc_currencies', 'currencyDefs', function (results) {
            var $sel = $('#qc-currency').empty();
            for (var i = 0; i < results.length; i++) {
                $sel.append($('<option/>', {
                    'value': results[i].key,
                    'text': results[i].key,
                    'selected': String(results[i].key) === String(selected)
                }));
            }
        });
    }

    function load() {
        socket.getDBValues('qc_load', {
            tables: [T, T, T, T, T, T],
            keys: ['enabled', 'currencyId', 'amount', 'timeLeft', 'refundOnReject', 'command']
        }, true, function (e) {
            $('#qc-enabled').prop('checked', helpers.isTrue(e.enabled));
            $('#qc-amount').val((e.amount === null || e.amount === undefined) ? 100 : e.amount);
            $('#qc-timeleft').val((e.timeLeft === null || e.timeLeft === undefined) ? 120 : e.timeLeft);
            $('#qc-refund').prop('checked', (e.refundOnReject === null || e.refundOnReject === undefined) ? true : helpers.isTrue(e.refundOnReject));
            $('#qc-command').val((e.command === null || e.command === undefined) ? 'queueentry' : String(e.command));
            loadCurrencyOptions((e.currencyId === null || e.currencyId === undefined) ? '' : String(e.currencyId));
        });
    }

    function save() {
        if (!canWrite()) {
            return;
        }
        var command = String($('#qc-command').val()).toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (command === '') {
            toastr.error('Enter a command name.');
            return;
        }
        if (!helpers.handleInputNumber($('#qc-amount'), 0) || !helpers.handleInputNumber($('#qc-timeleft'), 1)) {
            return;
        }

        var enabled = $('#qc-enabled').is(':checked'),
            currency = String($('#qc-currency').val()),
            amount = parseInt($('#qc-amount').val(), 10),
            timeLeft = parseInt($('#qc-timeleft').val(), 10),
            refund = $('#qc-refund').is(':checked');

        socket.updateDBValues('qc_save', {
            tables: [T, T, T, T, T, T],
            keys: ['enabled', 'currencyId', 'amount', 'timeLeft', 'refundOnReject', 'command'],
            values: [enabled, currency, amount, timeLeft, refund, command]
        }, function () {
            socket.wsEvent('qc_reload', SCRIPT, null, ['reload'], function () {
                toastr.success('Saved.');
            });
        });
    }

    applyWritable();
    load();
    $('#qc-save').on('click', save);
});
