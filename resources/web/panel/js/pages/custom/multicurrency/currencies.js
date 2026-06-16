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
 * Panel UI for defining currencies (currencyDefs table) and adjusting per-user balances
 * (currencyBal_<id> tables). Reads/writes the DataStore directly; the multiCurrencySystem.js
 * module reads the same tables live, so no module reload is needed.
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
        var w = isWritable();
        $('#mc-readonly-banner').toggle(!w);
        $('#mc-add-currency, #mc-bal-give, #mc-bal-take, #mc-bal-set').prop('disabled', !w);
    }

    /* ---- helpers ---- */

    function parseDef(value) {
        try {
            var o = JSON.parse(value);
            return { name: o.name || '', plural: o.plural || '' };
        } catch (e) {
            return { name: String(value || ''), plural: '' };
        }
    }

    function sanitizeId(raw) {
        return String(raw || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    }

    function populateCurrencyDropdown() {
        socket.getDBTableValues('mc_dropdown', 'currencyDefs', function (results) {
            var $sel = $('#mc-bal-currency').empty();
            for (var i = 0; i < results.length; i++) {
                $sel.append($('<option/>', { 'value': results[i].key, 'text': results[i].key }));
            }
        });
    }

    /* ---- currencies table ---- */

    function loadCurrencies() {
        socket.getDBTableValues('mc_get_defs', 'currencyDefs', function (results) {
            var tableData = [];
            for (var i = 0; i < results.length; i++) {
                var id = results[i].key,
                    def = parseDef(results[i].value);
                tableData.push([
                    id,
                    def.name,
                    def.plural,
                    $('<div/>', { 'class': 'btn-group' })
                        .append($('<button/>', {
                            'type': 'button', 'class': 'btn btn-xs btn-warning btn-editcurrency',
                            'style': 'float: right', 'data-id': id, 'html': $('<i/>', { 'class': 'fa fa-edit' })
                        }))
                        .append($('<button/>', {
                            'type': 'button', 'class': 'btn btn-xs btn-danger btn-deletecurrency',
                            'style': 'float: right', 'data-id': id, 'html': $('<i/>', { 'class': 'fa fa-trash' })
                        })).html()
                ]);
            }

            if ($.fn.DataTable.isDataTable('#currenciesTable')) {
                $('#currenciesTable').DataTable().clear().rows.add(tableData).invalidate().draw(false);
                populateCurrencyDropdown();
                return;
            }

            var table = $('#currenciesTable').DataTable({
                'searching': true,
                'autoWidth': false,
                'data': tableData,
                'columnDefs': [
                    { 'orderable': false, 'targets': [3] }
                ],
                'columns': [
                    { 'title': 'ID' },
                    { 'title': 'Name' },
                    { 'title': 'Plural' },
                    { 'title': 'Actions' }
                ]
            });

            table.on('click', '.btn-editcurrency', function () {
                openCurrencyModal($(this).data('id'));
            });

            table.on('click', '.btn-deletecurrency', function () {
                var id = $(this).data('id');
                if (!canWrite()) {
                    return;
                }
                helpers.getConfirmDeleteModal('mc_del_currency', 'Are you sure you want to remove currency "' + id + '"?', true,
                    'Currency "' + id + '" removed. Existing user balances are left in the database — run "!currency remove ' + id + '" in chat to also wipe them.',
                    function () {
                        socket.removeDBValue('mc_del_currency_do', 'currencyDefs', id, function () {
                            loadCurrencies();
                        });
                    });
            });

            populateCurrencyDropdown();
        });
    }

    function openCurrencyModal(id) {
        if (!canWrite()) {
            return;
        }
        var isEdit = (id !== undefined && id !== null && String(id) !== '');

        var withDef = function (cb) {
            if (!isEdit) {
                cb({ name: '', plural: '' });
                return;
            }
            socket.getDBValue('mc_get_def', 'currencyDefs', id, function (e) {
                cb(parseDef(e.currencyDefs));
            });
        };

        withDef(function (def) {
            helpers.getModal('mc-currency-modal', isEdit ? 'Edit currency' : 'Add currency', 'Save', $('<form/>', { 'role': 'form' })
                .append(helpers.getInputGroup('mc-cur-id', 'text', 'ID', 'gold', isEdit ? String(id) : '',
                    'Lowercase id (letters, digits, underscores). Used in chat and on the pricing page.'))
                .append(helpers.getInputGroup('mc-cur-name', 'text', 'Name (singular)', 'gold', def.name))
                .append(helpers.getInputGroup('mc-cur-plural', 'text', 'Name (plural)', 'gold', def.plural)),
                function () {
                    // On edit the id is fixed — write to the original key, never the field value.
                    // Renaming the id would orphan the currencyBal_<id> table and (previously)
                    // created a second currency row.
                    var cid = isEdit ? String(id) : sanitizeId($('#mc-cur-id').val()),
                        name = $('#mc-cur-name').val(),
                        plural = $('#mc-cur-plural').val();

                    if (cid === '') {
                        toastr.error('Invalid currency id.');
                        return;
                    }
                    if (!helpers.handleInputString($('#mc-cur-name')) || !helpers.handleInputString($('#mc-cur-plural'))) {
                        return;
                    }

                    socket.updateDBValue('mc_def_save', 'currencyDefs', cid,
                        JSON.stringify({ name: String(name), plural: String(plural) }), function () {
                            $('#mc-currency-modal').modal('hide');
                            toastr.success('Currency saved.');
                            loadCurrencies();
                        });
                }
            ).modal('toggle');

            // Prevent renaming the id on edit (would orphan the balance table).
            if (isEdit) {
                $('#mc-cur-id').prop('readonly', true);
            }
        });
    }

    /* ---- balance adjust ---- */

    function refreshBalanceDisplay(user, id) {
        socket.getDBValue('mc_bal_get', 'currencyBal_' + id, user, function (e) {
            var v = e['currencyBal_' + id];
            $('#mc-bal-current').text(user + ': ' + ((v === null || v === undefined || v === '') ? 0 : v) + ' ' + id);
        });
    }

    function adjustBalance(mode) {
        if (!canWrite()) {
            return;
        }
        var user = String($('#mc-bal-user').val()).trim().toLowerCase().replace('@', ''),
            id = String($('#mc-bal-currency').val());

        if (!helpers.handleInputString($('#mc-bal-user'))) {
            return;
        }
        if (id === '') {
            toastr.error('Define and select a currency first.');
            return;
        }
        if (!helpers.handleInputNumber($('#mc-bal-amount'), 0)) {
            return;
        }
        var amount = parseInt($('#mc-bal-amount').val(), 10),
            table = 'currencyBal_' + id,
            done = function () {
                toastr.success('Balance updated.');
                refreshBalanceDisplay(user, id);
            };

        // incr/decr forward the value verbatim over the socket (unlike updateDBValue, which
        // coerces): the bot's dbincr/dbdecr handler reads it with getString(), so a bare number
        // throws "JSONObject[\"value\"] is not a string". Send a string.
        if (mode === 'set') {
            socket.updateDBValue('mc_bal_set', table, user, amount, done);
        } else if (mode === 'give') {
            socket.incrDBValue('mc_bal_give', table, user, String(amount), done);
        } else {
            socket.decrDBValue('mc_bal_take', table, user, String(amount), done);
        }
    }

    /* ---- wire up ---- */

    applyWritable();
    loadCurrencies();

    $('#mc-add-currency').on('click', function () {
        openCurrencyModal();
    });
    $('#mc-bal-give').on('click', function () {
        adjustBalance('give');
    });
    $('#mc-bal-take').on('click', function () {
        adjustBalance('take');
    });
    $('#mc-bal-set').on('click', function () {
        adjustBalance('set');
    });
    $('#mc-bal-lookup').on('click', function () {
        var user = String($('#mc-bal-user').val()).trim().toLowerCase().replace('@', ''),
            id = String($('#mc-bal-currency').val());
        if (user === '' || id === '') {
            return;
        }
        refreshBalanceDisplay(user, id);
    });
});
