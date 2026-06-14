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
 * Panel UI for pricing custom commands in a currency. "points" writes the stock pricecom
 * table (the existing built-in path); a custom currency writes commandCurrencyType +
 * commandCurrencyPrice, which multiCurrencySystem.js reads live. The two representations are
 * mutually exclusive per command — saving one clears the other.
 */
$(function () {
    var SECTION = 'extra';

    /* ---- write gate ---- */

    function isWritable() {
        var ns = window.__pbCustomPanel__;
        return (ns && typeof ns.panelSectionCanWrite === 'function') ? ns.panelSectionCanWrite(SECTION) : true;
    }

    function canWrite() {
        var ns = window.__pbCustomPanel__;
        return (ns && typeof ns.requirePanelSectionWrite === 'function') ? ns.requirePanelSectionWrite(SECTION) : true;
    }

    function applyWritable() {
        $('#mc-readonly-banner').toggle(!isWritable());
    }

    /* ---- helpers ---- */

    function currencyOptions(cb) {
        socket.getDBTableValues('pr_currencies', 'currencyDefs', function (results) {
            var opts = ['points'];
            for (var i = 0; i < results.length; i++) {
                opts.push(results[i].key);
            }
            cb(opts);
        });
    }

    function priceLabel(key, pricecom, ccType, ccPrice, ccBypass) {
        if (ccPrice[key] !== undefined && ccType[key] !== undefined && String(ccType[key]) !== 'points' && Number(ccPrice[key]) > 0) {
            var bypass = (ccBypass[key] === undefined) ? true : helpers.isTrue(ccBypass[key]);
            return ccPrice[key] + ' ' + ccType[key] + (bypass ? '' : ' (mods pay)');
        }
        if (pricecom[key] !== undefined && Number(pricecom[key]) > 0) {
            return pricecom[key] + ' points';
        }
        return 'Free';
    }

    /* ---- table ---- */

    function loadCommands() {
        socket.getDBTablesValues('pr_load', [
            { table: 'command' },
            { table: 'pricecom' },
            { table: 'commandCurrencyType' },
            { table: 'commandCurrencyPrice' },
            { table: 'commandCurrencyModBypass' }
        ], function (results) {
            var commands = [], pricecom = {}, ccType = {}, ccPrice = {}, ccBypass = {};
            for (var i = 0; i < results.length; i++) {
                var r = results[i];
                switch (r.table) {
                    case 'command': commands.push(r.key); break;
                    case 'pricecom': pricecom[r.key] = r.value; break;
                    case 'commandCurrencyType': ccType[r.key] = r.value; break;
                    case 'commandCurrencyPrice': ccPrice[r.key] = r.value; break;
                    case 'commandCurrencyModBypass': ccBypass[r.key] = r.value; break;
                }
            }

            var tableData = [];
            for (var c = 0; c < commands.length; c++) {
                var key = commands[c];
                tableData.push([
                    '!' + key,
                    priceLabel(key, pricecom, ccType, ccPrice, ccBypass),
                    $('<div/>', { 'class': 'btn-group' })
                        .append($('<button/>', {
                            'type': 'button', 'class': 'btn btn-xs btn-warning btn-editprice',
                            'style': 'float: right', 'data-command': key, 'html': $('<i/>', { 'class': 'fa fa-edit' })
                        })).html()
                ]);
            }

            if ($.fn.DataTable.isDataTable('#commandPricingTable')) {
                $('#commandPricingTable').DataTable().clear().rows.add(tableData).invalidate().draw(false);
                return;
            }

            var table = $('#commandPricingTable').DataTable({
                'searching': true,
                'autoWidth': false,
                'data': tableData,
                'columnDefs': [
                    { 'orderable': false, 'targets': [2] }
                ],
                'columns': [
                    { 'title': 'Command' },
                    { 'title': 'Price' },
                    { 'title': 'Actions' }
                ]
            });

            table.on('click', '.btn-editprice', function () {
                openPriceModal($(this).data('command'));
            });
        });
    }

    function openPriceModal(command) {
        if (!canWrite()) {
            return;
        }
        currencyOptions(function (opts) {
            // Three different tables, same key — store by table name (omit the storeKey arg).
            socket.getDBValues('pr_get', {
                tables: ['pricecom', 'commandCurrencyType', 'commandCurrencyPrice'],
                keys: [command, command, command]
            }, function (e) {
                var curCurrency = 'points', curAmount = '0', curBypass = true;
                if (e.commandCurrencyPrice !== null && e.commandCurrencyType !== null && String(e.commandCurrencyType) !== 'points') {
                    curCurrency = String(e.commandCurrencyType);
                    curAmount = String(e.commandCurrencyPrice);
                    curBypass = (e.commandCurrencyModBypass === null) ? true : helpers.isTrue(e.commandCurrencyModBypass);
                } else if (e.pricecom !== null) {
                    curCurrency = 'points';
                    curAmount = String(e.pricecom);
                }

                helpers.getModal('pr-modal', 'Set price: !' + command, 'Save', $('<form/>', { 'role': 'form' })
                    .append(helpers.getDropdownGroup('pr-currency', 'Currency', curCurrency, opts,
                        'Charge this currency when the command runs. "points" uses the built-in currency.'))
                    .append(helpers.getInputGroup('pr-amount', 'number', 'Amount', '0', curAmount,
                        'Cost taken from the user. Set 0 to make the command free.'))
                    .append(helpers.getCheckBox('pr-modbypass', curBypass, 'Mods bypass this cost',
                        'Custom currencies only. When unchecked, moderators are charged too. (Points pricing follows the global pricecomMods setting.)')),
                    function () {
                        if (!helpers.handleInputNumber($('#pr-amount'), 0)) {
                            return;
                        }
                        var currency = String($('#pr-currency').find(':selected').text()),
                            amount = parseInt($('#pr-amount').val(), 10),
                            bypass = $('#pr-modbypass').is(':checked');
                        savePrice(command, currency, amount, bypass);
                    }
                ).modal('toggle');
            });
        });
    }

    function savePrice(command, currency, amount, bypass) {
        var finish = function () {
            $('#pr-modal').modal('hide');
            toastr.success('Price updated.');
            loadCommands();
        };

        // Clear both representations first, then write the chosen one (mutually exclusive).
        socket.removeDBValues('pr_clear', {
            tables: ['pricecom', 'commandCurrencyType', 'commandCurrencyPrice', 'commandCurrencyModBypass'],
            keys: [command, command, command, command]
        }, function () {
            if (amount <= 0) {
                finish();
            } else if (currency === 'points') {
                socket.updateDBValue('pr_save_points', 'pricecom', command, amount, finish);
            } else {
                socket.updateDBValues('pr_save_currency', {
                    tables: ['commandCurrencyType', 'commandCurrencyPrice', 'commandCurrencyModBypass'],
                    keys: [command, command, command],
                    values: [currency, amount, bypass]
                }, finish);
            }
        });
    }

    /* ---- wire up ---- */

    applyWritable();
    loadCommands();
});
